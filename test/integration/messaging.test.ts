import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { Database } from '../../src/infrastructure/database';
import { FinancialService } from '../../src/application/financial-service';
import { AppError } from '../../src/application/errors';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain';
import { SqsConsumer } from '../../src/messaging/sqs-consumer';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';
import { SqsGateway } from '../../src/messaging/sqs-gateway';
import { PendingReferenceWorker } from '../../src/messaging/pending-reference-worker';
import {
  command, drainOutbox, newWallet, openMessagingDatabase, queueFixture, receiveOne, receivedEvents,
  reconciliation, sendBody, sendInput,
} from '../messaging/support';

async function killedWorker(gateway: SqsGateway, environment: Record<string, string>): Promise<void> {
  const child = Bun.spawn([process.execPath, 'test/messaging/crash-worker.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: 'test', ALLOW_INTEGRATION_TESTS: '1',
      SQS_ENDPOINT: gateway.config.endpoint, SQS_QUEUE_URL: gateway.urls.queue,
      SQS_DLQ_URL: gateway.urls.dlq, SQS_EVENTS_QUEUE_URL: gateway.urls.events,
      SQS_POLL_WAIT_SECONDS: '0', SQS_VISIBILITY_TIMEOUT_SECONDS: '6', ...environment,
    }, stdout: 'ignore', stderr: 'pipe',
  });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
  try {
    await child.exited;
    const stderr = await new Response(child.stderr).text();
    if (timedOut) throw new Error('Worker never reached its configured crash point');
    if (child.signalCode !== 'SIGKILL') throw new Error(`Worker did not crash at the requested point: ${stderr}`);
  } finally { clearTimeout(timeout); }
}

describe('PostgreSQL and LocalStack: transactional messaging and failure recovery', () => {
  let db: Database;
  let fixture: Awaited<ReturnType<typeof queueFixture>>;
  beforeAll(async () => { db = await openMessagingDatabase(); });
  beforeEach(async () => { fixture = await queueFixture(); });
  afterEach(async () => { await fixture?.close(); });
  afterAll(async () => { await db?.close(); });

  test('persists inbox, finance, ledger and outbox; real redelivery has one effect and conflicts go to DLQ', async () => {
    const wallet = await newWallet(db);
    const input = command(wallet);
    const messageId = randomUUID();
    const body = await sendInput(fixture.gateway, input, messageId);
    const consumer = new SqsConsumer(fixture.gateway, wallet.service);
    await consumer.handleMessage(await receiveOne(fixture.gateway));
    await sendBody(fixture.gateway, body, wallet.walletId); // Distinct broker deduplication ID, same application message.
    await consumer.handleMessage(await receiveOne(fixture.gateway));
    const result = await reconciliation(db, wallet.walletId);
    expect(result).toEqual({ stored: '90.00', calculated: '90.00', entries: '2' });
    const inbox = await db.query<{ transaction_id: string; processed_at: Date }>(
      'select transaction_id,processed_at from inbox_messages where consumer_name=? and message_id=?', [consumer.consumerName, messageId]);
    expect(inbox.length).toBe(1);
    expect(inbox[0]?.processed_at).not.toBeNull();
    const events = await db.query<{ count: string }>('select count(*)::text as count from outbox_messages where transaction_id=?', [inbox[0]!.transaction_id]);
    expect(events[0]?.count).toBe('2');

    const changed = command(wallet, { money: { amount: '20.00', currency: 'BRL' } });
    const conflictBody = await sendInput(fixture.gateway, changed, messageId);
    await consumer.handleMessage(await receiveOne(fixture.gateway));
    const dead = await receiveOne(fixture.gateway, fixture.gateway.urls.dlq);
    expect(dead.Body).toBe(conflictBody);
    expect(dead.MessageAttributes?.failureCode?.StringValue).toBe('INBOX_PAYLOAD_CONFLICT');
    expect((await reconciliation(db, wallet.walletId)).stored).toBe('90.00');
    expect((await db.query('select id from wager_transactions where idempotency_key=?', [changed.idempotencyKey])).length).toBe(0);
  }, 30000);

  test('an unavailable DLQ does not erase a malformed real SQS message', async () => {
    const wallet = await newWallet(db);
    await sendBody(fixture.gateway, '{malformed');
    const delivery = await receiveOne(fixture.gateway);
    const broken = new SqsGateway({ ...fixture.gateway.config,
      dlqUrl: fixture.gateway.config.endpoint + '/000000000000/does-not-exist.fifo' });
    try {
      await new SqsConsumer(broken, wallet.service).handleMessage(delivery);
      await fixture.gateway.changeVisibility(delivery.ReceiptHandle!, 0);
      const redelivery = await receiveOne(fixture.gateway);
      expect(redelivery.Body).toBe('{malformed');
      expect(Number(redelivery.Attributes?.ApproximateReceiveCount)).toBeGreaterThan(1);
      await new SqsConsumer(fixture.gateway, wallet.service).handleMessage(redelivery);
      const dead = await receiveOne(fixture.gateway, fixture.gateway.urls.dlq);
      expect(dead.Body).toBe('{malformed');
      expect(dead.MessageAttributes?.failureCode?.StringValue).toBe('INVALID_MESSAGE_ENVELOPE');
      expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '100.00', calculated: '100.00', entries: '1' });
    } finally { broken.close(); }
  }, 30000);

  test('real retries roll back all effects, then persist FAILED before sending to DLQ', async () => {
    const wallet = await newWallet(db);
    const failingService = new FinancialService(db, { beforeCommit: async () => {
      throw new AppError(503, 'INJECTED_TRANSIENT_FAILURE', 'Injected test fault', true);
    } });
    const input = command(wallet);
    await sendInput(fixture.gateway, input);
    const consumer = new SqsConsumer(fixture.gateway, failingService);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const delivery = await receiveOne(fixture.gateway);
      expect(Number(delivery.Attributes?.ApproximateReceiveCount)).toBe(attempt);
      await consumer.handleMessage(delivery);
      if (attempt < 3) {
        expect((await db.query('select id from wager_transactions where idempotency_key=?', [input.idempotencyKey])).length).toBe(0);
        await fixture.gateway.changeVisibility(delivery.ReceiptHandle!, 0);
      }
    }
    const [failed] = await db.query<{ id: string; status: string; failure_code: string }>(
      'select id,status,failure_code from wager_transactions where idempotency_key=?', [input.idempotencyKey]);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.failure_code).toBe('PROCESSING_RETRY_EXHAUSTED');
    const dead = await receiveOne(fixture.gateway, fixture.gateway.urls.dlq);
    expect(dead.MessageAttributes?.failureCode?.StringValue).toBe('PROCESSING_RETRY_EXHAUSTED');
    expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '100.00', calculated: '100.00', entries: '1' });
    expect((await db.query('select id from outbox_messages where transaction_id=? and event_type=?', [failed!.id, 'WagerTransactionFailed'])).length).toBe(1);
  }, 30000);

  test('two publishers claim different rows and deliver every committed event through real SQS', async () => {
    await drainOutbox(db, fixture.gateway);
    const wallet = await newWallet(db);
    await wallet.service.submit(command(wallet));
    const expected = new Set((await db.query<{ id: string }>('select id from outbox_messages where aggregate_id=?', [wallet.walletId])).map(row => row.id));
    const attempts: string[] = [];
    class CountingGateway extends SqsGateway {
      override async publish(event: { id: string; aggregateId: string; payload: unknown }, signal?: AbortSignal): Promise<void> {
        await super.publish(event, signal);
        attempts.push(event.id);
      }
    }
    const counting = new CountingGateway(fixture.gateway.config);
    const secondConnection = await Database.connect();
    try {
      const counts = await Promise.all([
        new OutboxPublisher(db, counting).publishBatch(100),
        new OutboxPublisher(secondConnection, counting).publishBatch(100),
      ]);
      expect(counts[0]! + counts[1]!).toBe(expected.size);
      for (const id of expected) expect(attempts.filter(value => value === id).length).toBe(1);
      expect(await receivedEvents(fixture.gateway, expected)).toEqual(expected);
      expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '90.00', calculated: '90.00', entries: '2' });
    } finally { counting.close(); await secondConnection.close(); }
  }, 30000);

  test('failed publication keeps the original event durable and another publisher resumes it', async () => {
    await drainOutbox(db, fixture.gateway);
    const wallet = await newWallet(db);
    const bad = new SqsGateway({ ...fixture.gateway.config,
      eventsUrl: fixture.gateway.config.endpoint + '/000000000000/missing-events.fifo' });
    try {
      expect(await new OutboxPublisher(db, bad).publishBatch(100)).toBe(0);
      const failed = await db.query<{ id: string; attempts: number; published_at: Date | null; lease_owner: string | null }>(
        'select id,attempts,published_at,lease_owner from outbox_messages where aggregate_id=?', [wallet.walletId]);
      expect(failed.length).toBe(2);
      expect(failed.every(row => row.attempts === 1 && row.published_at === null && row.lease_owner === null)).toBe(true);
      await db.query('update outbox_messages set next_attempt_at=clock_timestamp() where aggregate_id=? and published_at is null returning id', [wallet.walletId]);
      expect(await new OutboxPublisher(db, fixture.gateway).publishBatch(100)).toBe(2);
      const ids = new Set(failed.map(row => row.id));
      expect(await receivedEvents(fixture.gateway, ids)).toEqual(ids);
      expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '100.00', calculated: '100.00', entries: '1' });
    } finally { bad.close(); }
  }, 30000);

  test('an old publisher cannot mark a row after its lease is replaced', async () => {
    await drainOutbox(db, fixture.gateway);
    const wallet = await newWallet(db);
    let eventId = '';
    let arrived!: () => void;
    let release!: () => void;
    const atPublication = new Promise<void>(resolve => { arrived = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const stale = new OutboxPublisher(db, fixture.gateway, { afterPublishBeforeMark: async event => {
      eventId = event.id; arrived(); await hold;
    } });
    const first = stale.publishBatch(1);
    await atPublication;
    const replacement = randomUUID();
    await db.query("update outbox_messages set lease_owner=?::uuid, lease_until=clock_timestamp()+interval '1 minute' where id=? returning id", [replacement, eventId]);
    release();
    expect(await first).toBe(0);
    const row = (await db.query<{ published_at: Date | null; lease_owner: string }>('select published_at,lease_owner from outbox_messages where id=?', [eventId]))[0];
    expect(row?.published_at).toBeNull();
    expect(row?.lease_owner).toBe(replacement);
    await db.query("update outbox_messages set lease_until=clock_timestamp()-interval '1 second' where id=? returning id", [eventId]);
    await new OutboxPublisher(db, fixture.gateway).publishBatch(100);
    expect((await db.query<{ published_at: Date | null }>('select published_at from outbox_messages where id=?', [eventId]))[0]?.published_at).not.toBeNull();
    expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '100.00', calculated: '100.00', entries: '1' });
  }, 30000);

  test('a worker killed after SQL commit and before ACK survives real SQS redelivery without another debit', async () => {
    const wallet = await newWallet(db);
    const input = command(wallet);
    await sendInput(fixture.gateway, input);
    const delivery = await receiveOne(fixture.gateway);
    await killedWorker(fixture.gateway, { TEST_MESSAGE_JSON: JSON.stringify(delivery), TEST_CRASH_AFTER_COMMIT: '1' });
    expect((await db.query<{ status: string }>('select status from wager_transactions where idempotency_key=?', [input.idempotencyKey]))[0]?.status).toBe('PROCESSED');
    await fixture.gateway.changeVisibility(delivery.ReceiptHandle!, 0);
    const redelivery = await receiveOne(fixture.gateway);
    await new SqsConsumer(fixture.gateway, new FinancialService(db)).handleMessage(redelivery);
    expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '90.00', calculated: '90.00', entries: '2' });
    const empty = await fixture.gateway.client.send(new ReceiveMessageCommand({ QueueUrl: fixture.gateway.urls.queue, WaitTimeSeconds: 0 }));
    expect(empty.Messages?.length ?? 0).toBe(0);
  }, 30000);

  test('a publisher killed after SQS accepts an event recovers the same eventId after lease expiry', async () => {
    await drainOutbox(db, fixture.gateway);
    const wallet = await newWallet(db);
    const ids = new Set((await db.query<{ id: string }>('select id from outbox_messages where aggregate_id=?', [wallet.walletId])).map(row => row.id));
    await killedWorker(fixture.gateway, { TEST_WORKER_MODE: 'publisher', TEST_CRASH_AFTER_PUBLISH: '1' });
    const claimed = await db.query<{ id: string; attempts: number }>('select id,attempts from outbox_messages where aggregate_id=? and lease_owner is not null and published_at is null', [wallet.walletId]);
    expect(claimed.length).toBe(1);
    await db.query("update outbox_messages set lease_until=clock_timestamp()-interval '1 second' where aggregate_id=? and published_at is null returning id", [wallet.walletId]);
    await new OutboxPublisher(db, fixture.gateway).publishBatch(100);
    expect(await receivedEvents(fixture.gateway, ids)).toEqual(ids);
    expect((await db.query<{ attempts: number }>('select attempts from outbox_messages where id=?', [claimed[0]!.id]))[0]!.attempts).toBeGreaterThanOrEqual(2);
    expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '100.00', calculated: '100.00', entries: '1' });
  }, 30000);

  test('an out-of-order REFUND is ACKed as pending, then three workers apply it only once', async () => {
    const wallet = await newWallet(db);
    const bet = command(wallet);
    const refund = command(wallet, { kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    await sendInput(fixture.gateway, refund);
    await new SqsConsumer(fixture.gateway, wallet.service).handleMessage(await receiveOne(fixture.gateway));
    const [pending] = await db.query<{ id: string; status: string }>('select id,status from wager_transactions where idempotency_key=?', [refund.idempotencyKey]);
    expect(pending?.status).toBe(WagerTransactionStatus.PendingReference);
    await wallet.service.submit(bet);
    await db.query('update wager_transactions set next_attempt_at=clock_timestamp() where id=? returning id', [pending!.id]);
    await Promise.all([1, 2, 3].map(() => new PendingReferenceWorker(new FinancialService(db)).tick()));
    expect((await db.query<{ status: string }>('select status from wager_transactions where id=?', [pending!.id]))[0]?.status).toBe('PROCESSED');
    expect((await db.query('select id from wallet_ledger_entries where transaction_id=?', [pending!.id])).length).toBe(1);
    expect((await db.query('select id from outbox_messages where transaction_id=?', [pending!.id])).length).toBe(3);
    expect(await reconciliation(db, wallet.walletId)).toEqual({ stored: '100.00', calculated: '100.00', entries: '3' });
  }, 30000);
});

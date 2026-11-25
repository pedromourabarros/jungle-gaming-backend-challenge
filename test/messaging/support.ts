import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand,
  ReceiveMessageCommand, SendMessageCommand, type Message,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { Database } from '../../src/infrastructure/database';
import { FinancialService } from '../../src/application/financial-service';
import { Money, WagerTransactionKind } from '../../src/domain';
import type { SubmitInput } from '../../src/application/contracts';
import { SqsGateway } from '../../src/messaging/sqs-gateway';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';

export async function openMessagingDatabase(): Promise<Database> {
  if (process.env.ALLOW_INTEGRATION_TESTS !== '1' || !process.env.DATABASE_URL
    || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
    throw new Error('Integration tests require ALLOW_INTEGRATION_TESTS=1 and DATABASE_URL targeting a _test database');
  }
  process.env.NODE_ENV = 'test';
  const db = await Database.connect();
  await db.migrate();
  return db;
}

export async function newWallet(db: Database, amount = '100.00') {
  const service = new FinancialService(db);
  const playerId = randomUUID();
  const wallet = await service.createWallet(playerId, Money.from({ amount, currency: 'BRL' }));
  if (typeof wallet.id !== 'string') throw new Error('Wallet was not created');
  return { service, playerId, walletId: wallet.id };
}

export function command(wallet: { walletId: string; playerId: string }, overrides: Partial<SubmitInput> = {}): SubmitInput {
  const id = randomUUID();
  return {
    providerId: 'integration-messaging', externalTransactionId: id, idempotencyKey: `integration:${id}`,
    walletId: wallet.walletId, playerId: wallet.playerId, roundId: `round-${wallet.walletId}`, gameId: 'test-game',
    kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' }, ...overrides,
  };
}

export async function queueFixture(): Promise<{ gateway: SqsGateway; close: () => Promise<void> }> {
  const setup = new SqsGateway({ pollWaitSeconds: 0, visibilityTimeoutSeconds: 6, maxReceiveCount: 3, requestTimeoutMs: 5000 });
  const prefix = `test-${randomUUID()}`;
  const attributes = { FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '60' };
  const dlq = await setup.client.send(new CreateQueueCommand({ QueueName: `${prefix}-dlq.fifo`, Attributes: attributes }));
  if (!dlq.QueueUrl) throw new Error('No test DLQ');
  const metadata = await setup.client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
  const queue = await setup.client.send(new CreateQueueCommand({ QueueName: `${prefix}-input.fifo`, Attributes: {
    ...attributes, VisibilityTimeout: '6',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: metadata.Attributes?.QueueArn, maxReceiveCount: 3 }),
  } }));
  const events = await setup.client.send(new CreateQueueCommand({ QueueName: `${prefix}-events.fifo`, Attributes: attributes }));
  if (!queue.QueueUrl || !events.QueueUrl) throw new Error('No test queue URL');
  const gateway = new SqsGateway({ ...setup.config, queueUrl: queue.QueueUrl, dlqUrl: dlq.QueueUrl, eventsUrl: events.QueueUrl });
  setup.close();
  return {
    gateway,
    close: async () => {
      await Promise.allSettled(Object.values(gateway.urls).map(QueueUrl => gateway.client.send(new DeleteQueueCommand({ QueueUrl }))));
      gateway.close();
    },
  };
}

export async function sendInput(gateway: SqsGateway, input: SubmitInput, messageId: string = randomUUID()): Promise<string> {
  const body = JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: input });
  await sendBody(gateway, body, input.walletId);
  return body;
}

export async function sendBody(gateway: SqsGateway, body: string, group: string = randomUUID()): Promise<void> {
  await gateway.client.send(new SendMessageCommand({
    QueueUrl: gateway.urls.queue, MessageBody: body, MessageGroupId: group, MessageDeduplicationId: randomUUID(),
  }));
}

export async function receiveOne(gateway: SqsGateway, url = gateway.urls.queue): Promise<Message> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await gateway.client.send(new ReceiveMessageCommand({
      QueueUrl: url, MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: 6,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'], MessageAttributeNames: ['All'],
    }));
    const message = result.Messages?.[0];
    if (message) return message;
  }
  throw new Error('Timed out waiting for the real SQS message');
}

export async function drainOutbox(db: Database, gateway: SqsGateway): Promise<void> {
  const publisher = new OutboxPublisher(db, gateway);
  for (let i = 0; i < 20; i++) {
    await publisher.publishBatch(100);
    const pending = await db.query<{ count: string }>('select count(*)::text as count from outbox_messages where published_at is null');
    if (pending[0]?.count === '0') return;
    // Leases and retry schedules are not bypassed by this helper.
    await Bun.sleep(100);
  }
  throw new Error('Could not drain previously committed outbox rows');
}

export async function receivedEvents(gateway: SqsGateway, expectedIds: Set<string>): Promise<Set<string>> {
  const found = new Set<string>();
  const deadline = Date.now() + 10000;
  while (found.size < expectedIds.size && Date.now() < deadline) {
    const response = await gateway.client.send(new ReceiveMessageCommand({
      QueueUrl: gateway.urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
    }));
    for (const message of response.Messages ?? []) {
      const data: unknown = JSON.parse(message.Body ?? '{}');
      if (data && typeof data === 'object' && 'eventId' in data && typeof data.eventId === 'string' && expectedIds.has(data.eventId)) found.add(data.eventId);
      if (message.ReceiptHandle) await gateway.client.send(new DeleteMessageCommand({ QueueUrl: gateway.urls.events, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return found;
}

export async function reconciliation(db: Database, walletId: string): Promise<{ stored: string; calculated: string; entries: string }> {
  const rows = await db.query<{ stored: string; calculated: string; entries: string }>(`
    SELECT w.balance::text AS stored,
      COALESCE(sum(CASE WHEN l.direction='CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(28,2)::text AS calculated,
      count(l.id)::text AS entries
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id=w.id
    WHERE w.id=? GROUP BY w.id
  `, [walletId]);
  if (!rows[0]) throw new Error('Missing test wallet');
  return rows[0];
}

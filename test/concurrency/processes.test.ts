import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { Database } from '../../src/infrastructure/database';
import { WagerTransactionKind as Kind } from '../../src/domain';
import { connectTestDatabase, createTestWallet, inputFor, assertReconciled } from '../helpers/setup';
import { eventually, startApplication, submitHttp, type ApplicationProcess } from '../helpers/processes';
import { isolatedQueues } from './queues';

setDefaultTimeout(120_000);

describe('real PostgreSQL/SQS with independent Bun application processes', () => {
  let db: Database;
  let queues: Awaited<ReturnType<typeof isolatedQueues>> | undefined;
  const applications: ApplicationProcess[] = [];
  const walletIds: string[] = [];

  beforeAll(async () => { db = await connectTestDatabase(); });
  afterEach(async () => {
    await Promise.all(applications.splice(0).map(app => app.stop()));
    for (const walletId of walletIds.splice(0)) await assertReconciled(db, walletId);
    await queues?.close();
    queues = undefined;
  });
  afterAll(async () => { await db?.close(); });

  async function fixture(amount = '100.00') {
    const wallet = await createTestWallet(db, amount);
    walletIds.push(wallet.walletId);
    return wallet;
  }
  async function launch(env: Record<string, string> = {}) {
    if (!queues) throw new Error('Create isolated queues before starting an application');
    const app = await startApplication({
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
      ...queues.env,
      ...env,
    });
    applications.push(app);
    return app;
  }
  async function balance(walletId: string) {
    return (await db.query<{ balance: string }>('select balance::text from wallets where id = ?', [walletId]))[0]!.balance;
  }
  async function debits(walletId: string) {
    return (await db.query<{ count: number }>("select count(*)::int as count from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'", [walletId]))[0]!.count;
  }

  it('runs 3 separate APIs, deduplicates 50 simultaneous requests, and allows exactly one competing BET 80.00', async () => {
    queues = await isolatedQueues();
    const apps = await Promise.all([launch(), launch(), launch()]);
    expect(new Set(apps.map(app => app.pid)).size).toBe(3);

    const wallet = await fixture();
    const bet = inputFor(wallet);
    const replies = await Promise.all(Array.from({ length: 50 }, (_, index) => submitHttp(apps[index % apps.length]!, bet)));
    expect(replies.every(reply => reply.status === 200 && reply.result.status === 'PROCESSED')).toBe(true);
    expect(replies.filter(reply => !reply.result.idempotentReplay)).toHaveLength(1);
    expect(new Set(replies.map(reply => reply.result.transactionId)).size).toBe(1);
    expect(replies.every(reply => reply.result.balance.amount === '90.00')).toBe(true);
    expect(await debits(wallet.walletId)).toBe(1);

    // A later credit must not change the balance snapshot returned by the original key.
    const win = inputFor(wallet, { kind: Kind.Win, money: { amount: '7.50', currency: 'BRL' } });
    expect((await submitHttp(apps[1]!, win)).status).toBe(200);
    const replay = await submitHttp(apps[2]!, bet);
    expect(replay.result.idempotentReplay).toBe(true);
    expect(replay.result.balance.amount).toBe('90.00');
    expect(await balance(wallet.walletId)).toBe('97.50');

    const contested = await fixture();
    const a = inputFor(contested, { money: { amount: '80.00', currency: 'BRL' } });
    const b = inputFor(contested, { money: { amount: '80.00', currency: 'BRL' } });
    const race = await Promise.all([submitHttp(apps[0]!, a), submitHttp(apps[1]!, b)]);
    expect(race.filter(reply => reply.result.status === 'PROCESSED')).toHaveLength(1);
    expect(race.filter(reply => reply.result.status === 'REJECTED')).toHaveLength(1);
    expect(race.find(reply => reply.result.status === 'REJECTED')?.status).toBe(422);
    expect(race.find(reply => reply.result.status === 'REJECTED')?.result.failureCode).toBe('INSUFFICIENT_FUNDS');
    const repeated = await Promise.all([submitHttp(apps[2]!, a), submitHttp(apps[0]!, b)]);
    expect(repeated.every(reply => reply.result.idempotentReplay)).toBe(true);
    expect(await balance(contested.walletId)).toBe('20.00');
    expect(await debits(contested.walletId)).toBe(1);
  });

  it('lets another wallet progress while a real row lock blocks the first wallet', async () => {
    queues = await isolatedQueues();
    const [first, second] = await Promise.all([launch(), launch()]);
    const [a, b] = await Promise.all([fixture(), fixture()]);
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holdLock = db.transaction(async em => {
      await em.execute('select id from wallets where id = ? for update', [a.walletId]);
      locked();
      await released;
    });
    await acquired;
    let firstCompleted = false;
    const blocked = submitHttp(first, inputFor(a)).finally(() => { firstCompleted = true; });
    try {
      await eventually('a second PostgreSQL connection waiting for the wallet row lock', async () => {
        const row = (await db.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and position('for update' in lower(query)) > 0`))[0]!;
        return row.count > 0;
      }, 5000);
      const independent = await submitHttp(second, inputFor(b));
      expect(independent.status).toBe(200);
      expect(independent.result.balance.amount).toBe('90.00');
      expect(firstCompleted).toBe(false);
    } finally {
      release();
      await holdLock;
    }
    expect((await blocked).status).toBe(200);
    expect(await balance(a.walletId)).toBe('90.00');
    expect(await balance(b.walletId)).toBe('90.00');
  });

  it('rolls everything back when a process is killed before COMMIT, then applies the same command after restart', async () => {
    queues = await isolatedQueues();
    const wallet = await fixture();
    const input = inputFor(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const crash = await launch({ TEST_CRASH_BEFORE_COMMIT: '1' });
    const interrupted = submitHttp(crash, input).catch(() => undefined);
    expect(await crash.waitForExit()).not.toBe(0);
    await interrupted;

    expect(await balance(wallet.walletId)).toBe('100.00');
    expect(await debits(wallet.walletId)).toBe(0);
    expect(await db.query('select id from wager_transactions where provider_id = ? and external_transaction_id = ?',
      [input.providerId, input.externalTransactionId])).toHaveLength(0);
    expect((await db.query<{ count: number }>('select count(*)::int as count from outbox_messages where aggregate_id = ?', [wallet.walletId]))[0]!.count).toBe(2);

    const restarted = await launch();
    const result = await submitHttp(restarted, input);
    expect(result.status).toBe(200);
    expect(result.result.idempotentReplay).toBe(false);
    expect(result.result.balance.amount).toBe('75.00');
    expect((await submitHttp(restarted, input)).result.idempotentReplay).toBe(true);
    expect(await debits(wallet.walletId)).toBe(1);
  });

  it('resolves both REFUND and ROLLBACK delivered before their references after a complete application restart', async () => {
    queues = await isolatedQueues();
    const beforeRestart = await launch();
    const wallet = await fixture();
    const bet = inputFor(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    const win = inputFor(wallet, { kind: Kind.Win, money: { amount: '20.00', currency: 'BRL' } });
    const refund = inputFor(wallet, { kind: Kind.Refund, money: bet.money, referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = inputFor(wallet, { kind: Kind.Rollback, money: win.money, referenceExternalTransactionId: win.externalTransactionId });
    const pending = await Promise.all([submitHttp(beforeRestart, refund), submitHttp(beforeRestart, rollback)]);
    expect(pending.every(reply => reply.status === 202 && reply.result.status === 'PENDING_REFERENCE')).toBe(true);
    expect((await submitHttp(beforeRestart, bet)).status).toBe(200);
    expect((await submitHttp(beforeRestart, win)).status).toBe(200);
    expect(await balance(wallet.walletId)).toBe('110.00');
    await beforeRestart.stop();

    const recovered = await launch({
      MESSAGING_ENABLED: 'true', PENDING_REFERENCE_ENABLED: 'true',
      REFERENCE_RETRY_BASE_MS: '25', REFERENCE_RETRY_MAX_MS: '100',
    });
    await eventually('persisted out-of-order reversals to be processed by the restarted worker', async () => {
      const rows = await db.query<{ status: string }>('select status from wager_transactions where id in (?,?)',
        pending.map(reply => reply.result.transactionId));
      return rows.length === 2 && rows.every(row => row.status === 'PROCESSED');
    });
    expect(await balance(wallet.walletId)).toBe('100.00');
    expect(await debits(wallet.walletId)).toBe(2);
    await recovered.stop();

    const restartedAgain = await launch();
    const repeat = await Promise.all([submitHttp(restartedAgain, refund), submitHttp(restartedAgain, rollback)]);
    expect(repeat.every(reply => reply.status === 200 && reply.result.idempotentReplay)).toBe(true);
    expect(await balance(wallet.walletId)).toBe('100.00');
    expect(await debits(wallet.walletId)).toBe(2);
  });

  it('runs two publisher processes concurrently and delivers every committed event with its original eventId', async () => {
    queues = await isolatedQueues();
    const publishers = await Promise.all([
      launch({ MESSAGING_ENABLED: 'true', OUTBOX_ENABLED: 'true' }),
      launch({ MESSAGING_ENABLED: 'true', OUTBOX_ENABLED: 'true' }),
    ]);
    expect(publishers[0]!.pid).not.toBe(publishers[1]!.pid);
    // Drain older fixtures first; the production publisher intentionally serves the whole outbox.
    await eventually('older committed outbox rows to publish', async () =>
      (await db.query<{ count: number }>('select count(*)::int as count from outbox_messages where published_at is null'))[0]!.count === 0,
    60_000);
    const wallets = await Promise.all(Array.from({ length: 10 }, () => fixture()));
    const placeholders = wallets.map(() => '?').join(',');
    const expected = await db.query<{ id: string; payload: Record<string, unknown> }>(
      `select id, payload from outbox_messages where aggregate_id in (${placeholders})`, wallets.map(wallet => wallet.walletId));
    expect(expected).toHaveLength(20);
    await eventually('both publishers to drain the committed events', async () => {
      const rows = await db.query<{ published_at: Date | null; attempts: number }>(
        `select published_at, attempts from outbox_messages where aggregate_id in (${placeholders})`, wallets.map(wallet => wallet.walletId));
      return rows.length === expected.length && rows.every(row => row.published_at !== null && row.attempts === 1);
    });
    const expectedById = new Map(expected.map(row => [row.id, row.payload]));
    const delivered = new Map<string, Record<string, unknown>>();
    await eventually('all outbox envelopes in the real event queue', async () => {
      const result = await queues!.gateway.client.send(new ReceiveMessageCommand({
        QueueUrl: queues!.gateway.urls.events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1,
      }));
      for (const message of result.Messages ?? []) {
        const event = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
        if (typeof event.eventId === 'string' && expectedById.has(event.eventId)) {
          expect(event).toEqual(expectedById.get(event.eventId)!);
          delivered.set(event.eventId, event);
        }
        if (message.ReceiptHandle) await queues!.gateway.client.send(new DeleteMessageCommand({
          QueueUrl: queues!.gateway.urls.events, ReceiptHandle: message.ReceiptHandle,
        }));
      }
      return delivered.size === expected.length;
    }, 60_000);
    expect(delivered.size).toBe(20);
    expect(publishers.every(app => app.isRunning())).toBe(true);
  });
});

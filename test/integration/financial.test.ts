import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { FinancialService } from '../../src/application/financial-service';
import { QueryService } from '../../src/application/query-service';
import { AppError, databaseCode } from '../../src/application/errors';
import type { SubmitInput } from '../../src/application/contracts';
import { Money, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../src/domain';
import { config } from '../../src/infrastructure/config';
import { Database, sql } from '../../src/infrastructure/database';
import { createApplication } from '../../src/main';
import { assertReconciled, connectTestDatabase, createTestWallet, inputFor } from '../helpers/setup';
import { queueFixture } from '../messaging/support';

let db: Database;
let financial: FinancialService;
let queries: QueryService;
let app: INestApplication;
let queues: Awaited<ReturnType<typeof queueFixture>>;
let baseUrl: string;
const touched = new Set<string>();
const amount = (value: string, currency = 'BRL') => ({ amount: value, currency });

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  db = await connectTestDatabase();
  financial = new FinancialService(db);
  queries = new QueryService(db);
  queues = await queueFixture();
  app = await createApplication(db, financial, queues.gateway);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 60_000);

afterEach(async () => {
  // The final invariant is checked for every wallet created by every test, including rejected writes.
  for (const id of touched) await assertReconciled(db, id);
  touched.clear();
});

afterAll(async () => {
  await app?.close();
  await queues?.close();
  await db?.close();
});

async function seed(initial = '100.00') {
  const value = await createTestWallet(db, initial);
  touched.add(value.walletId);
  return value;
}

async function balance(walletId: string): Promise<string> {
  return (await db.query<{ balance: string }>('select balance::text as balance from wallets where id = ?', [walletId]))[0]!.balance;
}
async function count(statement: string, params: unknown[] = []): Promise<number> {
  return Number((await db.query<{ count: string }>(statement, params))[0]!.count);
}
async function events(transactionId: string): Promise<string[]> {
  return (await db.query<{ event_type: string }>('select event_type from outbox_messages where transaction_id = ? order by event_type', [transactionId])).map(row => row.event_type);
}
async function expectAppError(work: Promise<unknown>, status: number, code: string): Promise<void> {
  try { await work; throw new Error('Expected an application error'); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).httpStatus).toBe(status); expect((error as AppError).code).toBe(code); }
}
async function expectSqlError(work: Promise<unknown>, allowed: string[] = ['23514']): Promise<void> {
  try { await work; throw new Error('Expected PostgreSQL to reject the write'); }
  catch (error) {
    const code = databaseCode(error);
    expect(typeof code).toBe('string');
    expect(allowed).toContain(code!);
  }
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(baseUrl + path, options);
  return { response, status: response.status, body: await response.json() as Record<string, unknown> };
}
async function postTransaction(input: SubmitInput, overrides: Record<string, unknown> = {}, key: string | null = input.idempotencyKey) {
  const { idempotencyKey: _key, ...body } = input;
  return request('/wagering/transactions', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'Idempotency-Key': key }), 'x-correlation-id': 'financial-http-test' },
    body: JSON.stringify({ ...body, ...overrides }) });
}

describe('Real PostgreSQL financial operations', () => {
  test('positive opening is atomic with OPENING, credit ledger, version 1 and two integration events', async () => {
    const w = await seed('1000.00');
    const row = (await db.query<{ id: string; kind: string; status: string; observed_balance: string }>('select * from wager_transactions where wallet_id = ?', [w.walletId]))[0]!;
    expect(row.kind).toBe('OPENING');
    expect(row.status).toBe('PROCESSED');
    expect(row.observed_balance).toBe('1000.00');
    expect(await events(row.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const ledger = (await db.query<{ direction: string; balance_before: string; balance_after: string; wallet_version: number }>('select * from wallet_ledger_entries where wallet_id = ?', [w.walletId]))[0]!;
    expect(ledger).toMatchObject({ direction: 'CREDIT', balance_before: '0.00', balance_after: '1000.00', wallet_version: 1 });
    expect((await queries.wallet(w.walletId)).version).toBe(1);
  });

  test('zero opening has no artificial movement; first credit uses version 2', async () => {
    const w = await seed('0.00');
    expect(await count('select count(*)::text as count from wager_transactions where wallet_id = ?', [w.walletId])).toBe(0);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where wallet_id = ?', [w.walletId])).toBe(0);
    const credit = await financial.submit(inputFor(w, { kind: K.Win, money: amount('0.01') }));
    expect(credit.balance.amount).toBe('0.01');
    expect((await queries.wallet(w.walletId)).version).toBe(2);
  });

  test('wallet uniqueness is enforced on player and currency; distinct currency is independent', async () => {
    const w = await seed();
    await expectAppError(financial.createWallet(w.playerId, Money.from(amount('1.00'))), 409, 'WALLET_ALREADY_EXISTS');
    const usd = await financial.createWallet(w.playerId, Money.from(amount('2.00', 'USD')));
    touched.add(usd.id as string);
    expect(usd.balance).toEqual(amount('2.00', 'USD'));
    expect(await balance(w.walletId)).toBe('100.00');
  });

  test('BET and WIN change the balance; LOSS leaves version and ledger unchanged', async () => {
    const w = await seed();
    const betInput = inputFor(w, { money: amount('25.00') });
    const bet = await financial.submit(betInput);
    expect(bet).toMatchObject({ status: S.Processed, balance: amount('75.00'), idempotentReplay: false });
    const win = await financial.submit(inputFor(w, { kind: K.Win, money: amount('40.00'), referenceExternalTransactionId: betInput.externalTransactionId }));
    expect(win.balance).toEqual(amount('115.00'));
    const prior = await queries.wallet(w.walletId);
    const loss = await financial.submit(inputFor(w, { kind: K.Loss, money: amount('25.00'), referenceExternalTransactionId: betInput.externalTransactionId }));
    expect(loss.status).toBe(S.Processed);
    expect(loss.balance).toEqual(amount('115.00'));
    expect((await queries.wallet(w.walletId)).version).toBe(prior.version);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [loss.transactionId])).toBe(0);
    expect(await events(loss.transactionId)).toEqual(['WagerTransactionProcessed']);
  });

  test('insufficient BET is rejected without a debit and keeps its failure code on replay', async () => {
    const w = await seed('1.00');
    const input = inputFor(w, { money: amount('1.01') });
    const result = await financial.submit(input);
    expect(result).toMatchObject({ status: S.Rejected, failureCode: 'INSUFFICIENT_FUNDS', balance: amount('1.00') });
    expect(await events(result.transactionId)).toEqual(['WagerTransactionRejected']);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [result.transactionId])).toBe(0);
    expect(await financial.submit(input)).toEqual({ ...result, idempotentReplay: true });
    expect((await queries.wallet(w.walletId)).version).toBe(1);
  });

  test('refund and rollback uniqueness is per type; rollback of a refund debits', async () => {
    const w = await seed();
    const betInput = inputFor(w, { money: amount('20.00') });
    await financial.submit(betInput);
    const refundInput = inputFor(w, { kind: K.Refund, money: amount('20.00'), referenceExternalTransactionId: betInput.externalTransactionId });
    expect((await financial.submit(refundInput)).balance).toEqual(amount('100.00'));
    const duplicateRefund = await financial.submit(inputFor(w, { kind: K.Refund, money: amount('20.00'), referenceExternalTransactionId: betInput.externalTransactionId }));
    expect(duplicateRefund.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const rollbackBet = await financial.submit(inputFor(w, { kind: K.Rollback, money: amount('20.00'), referenceExternalTransactionId: betInput.externalTransactionId }));
    expect(rollbackBet.balance).toEqual(amount('120.00'));
    const duplicateRollback = await financial.submit(inputFor(w, { kind: K.Rollback, money: amount('20.00'), referenceExternalTransactionId: betInput.externalTransactionId }));
    expect(duplicateRollback.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const rollbackRefund = await financial.submit(inputFor(w, { kind: K.Rollback, money: amount('20.00'), referenceExternalTransactionId: refundInput.externalTransactionId }));
    expect(rollbackRefund.balance).toEqual(amount('100.00'));
    expect((await db.query<{ direction: string }>('select direction from wallet_ledger_entries where transaction_id = ?', [rollbackRefund.transactionId]))[0]!.direction).toBe('DEBIT');
  });

  test('rejected reversal does not reserve the reference; a fresh operation succeeds once funded', async () => {
    const w = await seed('0.00');
    const winInput = inputFor(w, { kind: K.Win, money: amount('50.00') });
    await financial.submit(winInput);
    await financial.submit(inputFor(w, { money: amount('50.00') }));
    const firstInput = inputFor(w, { kind: K.Rollback, money: amount('50.00'), referenceExternalTransactionId: winInput.externalTransactionId });
    const first = await financial.submit(firstInput);
    expect(first).toMatchObject({ status: S.Rejected, failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: amount('0.00') });
    expect(await count('select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [first.transactionId])).toBe(0);
    await financial.submit(inputFor(w, { kind: K.Win, money: amount('50.00') }));
    expect((await financial.submit(firstInput)).status).toBe(S.Rejected);
    const second = await financial.submit(inputFor(w, { kind: K.Rollback, money: amount('50.00'), referenceExternalTransactionId: winInput.externalTransactionId }));
    expect(second.status).toBe(S.Processed);
    expect(second.balance).toEqual(amount('0.00'));
  });

  test('wallet owner and currency violations are audited as rejected business outcomes', async () => {
    const w = await seed();
    const player = await financial.submit(inputFor(w, { playerId: randomUUID() }));
    const currency = await financial.submit(inputFor(w, { money: amount('10.00', 'USD') }));
    expect(player.failureCode).toBe('PLAYER_MISMATCH');
    expect(currency.failureCode).toBe('CURRENCY_MISMATCH');
    expect(currency.balance).toEqual(amount('100.00', 'BRL'));
    expect(await balance(w.walletId)).toBe('100.00');
    expect(await events(currency.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test('references reject different round, wallet, amount, kind and rejected targets', async () => {
    const a = await seed();
    const b = await seed();
    const betInput = inputFor(a, { money: amount('20.00') });
    await financial.submit(betInput);
    const round = await financial.submit(inputFor(a, { kind: K.Refund, money: amount('20.00'), roundId: 'another-round', referenceExternalTransactionId: betInput.externalTransactionId }));
    const walletMismatch = await financial.submit(inputFor(b, { kind: K.Refund, money: amount('20.00'), referenceExternalTransactionId: betInput.externalTransactionId }));
    const partial = await financial.submit(inputFor(a, { kind: K.Refund, money: amount('10.00'), referenceExternalTransactionId: betInput.externalTransactionId }));
    expect(round.failureCode).toBe('REFERENCE_MISMATCH');
    expect(walletMismatch.failureCode).toBe('REFERENCE_MISMATCH');
    expect(partial.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    const winInput = inputFor(a, { kind: K.Win, money: amount('5.00') });
    await financial.submit(winInput);
    const invalidKind = await financial.submit(inputFor(a, { kind: K.Refund, money: amount('5.00'), referenceExternalTransactionId: winInput.externalTransactionId }));
    expect(invalidKind.failureCode).toBe('REFERENCE_INVALID_KIND');
    const rejectedInput = inputFor(a, { money: amount('1000.00') });
    await financial.submit(rejectedInput);
    const invalidStatus = await financial.submit(inputFor(a, { kind: K.Refund, money: amount('1000.00'), referenceExternalTransactionId: rejectedInput.externalTransactionId }));
    expect(invalidStatus.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });

  test('provider-scoped reference lookup cannot use another provider transaction', async () => {
    const w = await seed();
    const original = inputFor(w);
    await financial.submit(original);
    const other = await financial.submit(inputFor(w, { providerId: 'provider-b', kind: K.Refund, referenceExternalTransactionId: original.externalTransactionId }));
    expect(other.status).toBe(S.PendingReference);
    expect(other.balance).toEqual(amount('90.00'));
    const independent = await financial.submit({ ...original, providerId: 'provider-b', idempotencyKey: `provider-b:${original.externalTransactionId}` });
    expect(independent.status).toBe(S.Processed);
    expect(independent.transactionId).not.toBe((await queries.providerTransaction('provider-a', original.externalTransactionId)).transactionId);
  });

  test('overflow is a stable audited rejection, never rounded or partially committed', async () => {
    const w = await seed('99999999999999999999999999.99');
    const result = await financial.submit(inputFor(w, { kind: K.Win, money: amount('0.01') }));
    expect(result.status).toBe(S.Rejected);
    expect(result.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await balance(w.walletId)).toBe('99999999999999999999999999.99');
  });
});

describe('Persistent idempotency, inbox and out-of-order references', () => {
  test('replay returns its original balance after later operations and after reconnecting', async () => {
    const w = await seed();
    const input = inputFor(w, { money: amount('25.00') });
    const first = await financial.submit(input);
    await financial.submit(inputFor(w, { kind: K.Win, money: amount('200.00') }));
    const connection = await Database.connect(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL);
    try {
      expect(await new FinancialService(connection).submit(input)).toEqual({ ...first, idempotentReplay: true });
    } finally { await connection.close(); }
    expect(first.balance.amount).toBe('75.00');
    expect(await balance(w.walletId)).toBe('275.00');
  });

  test('same key with different payload or another wallet conflicts; alternate key for same external id conflicts', async () => {
    const a = await seed();
    const b = await seed();
    const original = inputFor(a);
    await financial.submit(original);
    await expectAppError(financial.submit({ ...original, money: amount('11.00') }), 409, 'IDEMPOTENCY_CONFLICT');
    await expectAppError(financial.submit(inputFor(b, { idempotencyKey: original.idempotencyKey })), 409, 'IDEMPOTENCY_CONFLICT');
    await expectAppError(financial.submit({ ...original, idempotencyKey: randomUUID() }), 409, 'EXTERNAL_ID_KEY_CONFLICT');
    expect(await balance(a.walletId)).toBe('90.00');
    expect(await balance(b.walletId)).toBe('100.00');
  });

  test('inbox replays the committed effect and rejects reused message identity with changed content', async () => {
    const w = await seed();
    const input = inputFor(w);
    const context = { consumerName: 'integration-financial', messageId: randomUUID(), correlationId: randomUUID() };
    const first = await financial.submit(input, context);
    expect(await financial.submit(input, context)).toEqual({ ...first, idempotentReplay: true });
    await expectAppError(financial.submit(inputFor(w), context), 409, 'INBOX_PAYLOAD_CONFLICT');
    expect(await count('select count(*)::text as count from inbox_messages where consumer_name = ? and message_id = ?', [context.consumerName, context.messageId])).toBe(1);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where transaction_id = ?', [first.transactionId])).toBe(1);
    await expectSqlError(db.query('update inbox_messages set payload_hash = ? where consumer_name = ? and message_id = ?', ['0'.repeat(64),context.consumerName,context.messageId]));
    await expectSqlError(db.query('delete from inbox_messages where consumer_name = ? and message_id = ?', [context.consumerName,context.messageId]));
  });

  test('before-commit failure rolls back wallet, transaction, ledger, inbox and outbox; redelivery succeeds once', async () => {
    const w = await seed();
    const input = inputFor(w);
    const context = { consumerName: 'integration-atomicity', messageId: randomUUID() };
    let hookCalls = 0;
    const failing = new FinancialService(db, { beforeCommit: async () => {
      hookCalls++;
      // A different connection cannot see the transaction or its outbox before commit.
      expect(await count('select count(*)::text as count from wager_transactions where idempotency_key = ?',[input.idempotencyKey])).toBe(0);
      expect(await count('select count(*)::text as count from outbox_messages where aggregate_id = ?',[w.walletId])).toBe(2);
      expect(await balance(w.walletId)).toBe('100.00');
      throw new Error('Injected failure before commit');
    } });
    await expect(failing.submit(input, context)).rejects.toThrow('Injected failure before commit');
    expect(hookCalls).toBe(1);
    expect(await balance(w.walletId)).toBe('100.00');
    expect((await queries.wallet(w.walletId)).version).toBe(1);
    expect(await count('select count(*)::text as count from wager_transactions where idempotency_key = ?', [input.idempotencyKey])).toBe(0);
    expect(await count('select count(*)::text as count from inbox_messages where consumer_name = ? and message_id = ?', [context.consumerName, context.messageId])).toBe(0);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where wallet_id = ?', [w.walletId])).toBe(1);
    expect(await count('select count(*)::text as count from outbox_messages where aggregate_id = ?', [w.walletId])).toBe(2);
    const replay = await financial.submit(input, context);
    expect(replay.status).toBe(S.Processed);
    expect(replay.balance).toEqual(amount('90.00'));
    expect(await events(replay.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('a PostgreSQL serialization abort before commit retries with fresh state and applies one debit', async () => {
    const w = await seed();
    const input = inputFor(w);
    const context = {consumerName:'integration-retry',messageId:randomUUID()};
    let attempts = 0;
    const service = new FinancialService(db, {beforeCommit:async()=>{
      attempts++;
      if (attempts === 1) await db.query("do $$ begin raise exception 'test serialization abort' using errcode = '40001'; end $$");
    }});
    const result = await service.submit(input,context);
    expect(attempts).toBe(2);
    expect(result.status).toBe(S.Processed);
    expect(result.balance).toEqual(amount('90.00'));
    expect(await count('select count(*)::text as count from wager_transactions where idempotency_key = ?',[input.idempotencyKey])).toBe(1);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where transaction_id = ?',[result.transactionId])).toBe(1);
    expect(await count('select count(*)::text as count from inbox_messages where consumer_name = ? and message_id = ?',[context.consumerName,context.messageId])).toBe(1);
    expect(await events(result.transactionId)).toEqual(['WagerTransactionProcessed','WalletBalanceChanged']);
  });

  test('identifiable permanent failure is audited as FAILED and cannot overwrite a terminal result', async () => {
    const w = await seed();
    const input = inputFor(w);
    await financial.recordFailed(input,{correlationId:randomUUID()},'INFRASTRUCTURE_PERMANENT');
    const failed = await queries.providerTransaction(input.providerId,input.externalTransactionId);
    expect(failed.status).toBe(S.Failed);
    expect(failed.failureCode).toBe('INFRASTRUCTURE_PERMANENT');
    expect(await events(failed.transactionId as string)).toEqual(['WagerTransactionFailed']);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where transaction_id = ?',[failed.transactionId])).toBe(0);
    await financial.recordFailed(input,{},'ANOTHER_FAILURE');
    expect((await queries.transaction(failed.transactionId as string)).failureCode).toBe('INFRASTRUCTURE_PERMANENT');
    expect((await financial.submit(input)).status).toBe(S.Failed);
    expect(await balance(w.walletId)).toBe('100.00');
  });

  test.each([K.Refund, K.Rollback, K.Win, K.Loss])('%s delivered before its optional/required BET reference is deferred then processed', async kind => {
    const w = await seed();
    const betInput = inputFor(w);
    const dependent = inputFor(w, { kind, money: amount(kind === K.Loss ? '0.00' : '10.00'), referenceExternalTransactionId: betInput.externalTransactionId });
    const pending = await financial.submit(dependent);
    expect(pending.status).toBe(S.PendingReference);
    expect(await balance(w.walletId)).toBe('100.00');
    await financial.submit(betInput);
    await db.query("update wager_transactions set next_attempt_at = now() - interval '1 second' where id = ?", [pending.transactionId]);
    await financial.retryPendingBatch(100);
    const processed = await queries.transaction(pending.transactionId);
    expect(processed.status).toBe(S.Processed);
    expect(processed.referenceTransactionId).toBe((await queries.providerTransaction(betInput.providerId, betInput.externalTransactionId)).transactionId);
    expect(await balance(w.walletId)).toBe(kind === K.Loss ? '90.00' : '100.00');
    expect(await events(pending.transactionId)).toEqual(kind === K.Loss
      ? ['WagerTransactionPendingReference', 'WagerTransactionProcessed']
      : ['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('pending worker respects due time, persists exponential retry and terminates exhausted reference', async () => {
    const w = await seed();
    const pending = await financial.submit(inputFor(w, { kind: K.Refund, referenceExternalTransactionId: randomUUID() }));
    await db.query("update wager_transactions set next_attempt_at = now() + interval '1 hour' where id = ?", [pending.transactionId]);
    const before = await queries.transaction(pending.transactionId);
    await financial.retryPendingBatch(100);
    expect((await queries.transaction(pending.transactionId)).pendingAttempts).toBe(before.pendingAttempts);
    await db.query("update wager_transactions set next_attempt_at = now() - interval '1 second' where id = ?", [pending.transactionId]);
    const retryStartedAt = Date.now();
    await financial.retryPendingBatch(100);
    const retried = await queries.transaction(pending.transactionId);
    expect(retried.pendingAttempts).toBe((before.pendingAttempts as number) + 1);
    expect(new Date(retried.nextAttemptAt as string).getTime()).toBeGreaterThanOrEqual(retryStartedAt + config.referenceRetryBaseMs);
    expect(await events(pending.transactionId)).toEqual(['WagerTransactionPendingReference']);
    await db.query("update wager_transactions set pending_attempts = ?, next_attempt_at = now() - interval '1 second' where id = ?", [config.referenceMaxAttempts, pending.transactionId]);
    await financial.retryPendingBatch(100);
    const exhausted = await queries.transaction(pending.transactionId);
    expect(exhausted.status).toBe(S.Rejected);
    expect(exhausted.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(exhausted.nextAttemptAt).toBeNull();
    expect(await events(pending.transactionId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await balance(w.walletId)).toBe('100.00');
  });
});

describe('PostgreSQL invariants reject direct SQL corruption', () => {
  test('balance changes without ledger, negative/NaN balances, and invalid version changes cannot commit', async () => {
    const w = await seed();
    for (const statement of [
      'update wallets set balance = balance + 1, version = version + 1 where id = ?',
      'update wallets set balance = -1, version = version + 1 where id = ?',
      "update wallets set balance = 'NaN'::numeric, version = version + 1 where id = ?",
      'update wallets set version = version + 1 where id = ?',
      'update wallets set balance = balance + 1 where id = ?',
    ]) await expectSqlError(db.transaction(em => sql(em, statement, [w.walletId])));
    expect(await balance(w.walletId)).toBe('100.00');
    expect((await queries.wallet(w.walletId)).version).toBe(1);
  });

  test('positive wallet without its OPENING ledger is rejected at commit', async () => {
    const id = randomUUID();
    await expectSqlError(db.transaction(em => sql(em,
      "insert into wallets(id,player_id,currency,balance,version,created_at,updated_at) values (?,?,'BRL',100,1,now(),now())", [id,randomUUID()])));
    expect(await count('select count(*)::text as count from wallets where id = ?', [id])).toBe(0);
  });

  test('ledger cannot be updated, deleted, truncated, forged or duplicated', async () => {
    const w = await seed();
    const tx = await financial.submit(inputFor(w));
    await expectSqlError(db.query('update wallet_ledger_entries set amount = amount where transaction_id = ?', [tx.transactionId]));
    await expectSqlError(db.query('delete from wallet_ledger_entries where transaction_id = ?', [tx.transactionId]));
    await expectSqlError(db.query('truncate wallet_ledger_entries'));
    await expectSqlError(db.transaction(em => sql(em, `insert into wallet_ledger_entries
      (id,wallet_id,transaction_id,wallet_version,direction,amount,currency,balance_before,balance_after,created_at)
      values (?,?,?,2,'DEBIT',11,'BRL',101,90,now())`, [randomUUID(),w.walletId,tx.transactionId])));
    await expectSqlError(db.transaction(em => sql(em, `insert into wallet_ledger_entries
      select ?,wallet_id,transaction_id,wallet_version,direction,amount,currency,balance_before,balance_after,created_at
      from wallet_ledger_entries where transaction_id = ?`, [randomUUID(),tx.transactionId])), ['23514','23505']);
  });

  test('terminal transactions and outbox business payloads are immutable', async () => {
    const w = await seed();
    const tx = await financial.submit(inputFor(w));
    await expectSqlError(db.query("update wager_transactions set status = 'PENDING' where id = ?", [tx.transactionId]));
    await expectSqlError(db.query('update wager_transactions set observed_balance = 0 where id = ?', [tx.transactionId]));
    await expectSqlError(db.query('delete from wager_transactions where id = ?', [tx.transactionId]));
    await expectSqlError(db.query("update outbox_messages set payload = '{}'::jsonb where transaction_id = ?", [tx.transactionId]));
    await expectSqlError(db.query('delete from outbox_messages where transaction_id = ?', [tx.transactionId]));
    expect((await queries.transaction(tx.transactionId)).status).toBe(S.Processed);
  });

  test('processed transactions require ledger and outbox, and OPENING is unique per wallet', async () => {
    const w = await seed();
    const tx = await financial.submit(inputFor(w));
    const copiedId = randomUUID();
    await expectSqlError(db.transaction(em => sql(em, `insert into wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,
       kind,amount,currency,status,observed_balance,observed_currency,created_at,processed_at,correlation_id)
      select ?,provider_id,?,?,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,
       status,observed_balance,observed_currency,created_at,processed_at,correlation_id from wager_transactions where id = ?`,
    [copiedId,randomUUID(),randomUUID(),tx.transactionId])));
    expect(await count('select count(*)::text as count from wager_transactions where id = ?', [copiedId])).toBe(0);
    await expectSqlError(db.transaction(em => sql(em, `insert into wager_transactions
      (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,
       kind,amount,currency,status,observed_balance,observed_currency,created_at,processed_at,correlation_id)
      select ?,provider_id,?,?,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,
       status,observed_balance,observed_currency,created_at,processed_at,correlation_id from wager_transactions where wallet_id = ? and kind = 'OPENING'`,
    [randomUUID(),randomUUID(),randomUUID(),w.walletId])), ['23505']);
  });

  test('runtime database role can process finances but cannot alter, delete or truncate ledger/schema', async () => {
    const url = process.env.APP_DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('APP_DATABASE_URL must identify the restricted role in a _test database');
    const runtime = await Database.connect(url);
    try {
      const privilege = (await runtime.query<{ superuser: boolean; ledger_update: boolean; ledger_delete: boolean; ledger_truncate: boolean }>(
        `select r.rolsuper as superuser, has_table_privilege(current_user,'wallet_ledger_entries','UPDATE') as ledger_update,
         has_table_privilege(current_user,'wallet_ledger_entries','DELETE') as ledger_delete,
         has_table_privilege(current_user,'wallet_ledger_entries','TRUNCATE') as ledger_truncate from pg_roles r where rolname = current_user`))[0]!;
      expect(privilege).toEqual({ superuser: false, ledger_update: false, ledger_delete: false, ledger_truncate: false });
      const w = await createTestWallet(runtime);
      touched.add(w.walletId);
      const result = await w.service.submit(inputFor(w));
      expect(result.balance).toEqual(amount('90.00'));
      await expectSqlError(runtime.query('update wallet_ledger_entries set amount = 1 where transaction_id = ?', [result.transactionId]), ['42501']);
      await expectSqlError(runtime.query('truncate wallet_ledger_entries'), ['42501']);
      await expectSqlError(runtime.query('alter table wallet_ledger_entries disable trigger all'), ['42501']);
      await assertReconciled(runtime, w.walletId);
    } finally { await runtime.close(); }
  });
});

describe('Real HTTP API and consistent query snapshots', () => {
  test('create/read/reconcile/transaction lookup/health expose their documented contracts', async () => {
    const playerId = randomUUID();
    const created = await request('/wallets', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ playerId, initialBalance:amount('100.00') }) });
    expect(created.status).toBe(201);
    const walletId = created.body.id as string;
    touched.add(walletId);
    expect(created.body).toMatchObject({ playerId, balance:amount('100.00'), version:1 });
    const input = inputFor({ walletId,playerId });
    const submitted = await postTransaction(input);
    expect(submitted.status).toBe(200);
    expect(submitted.response.headers.get('x-correlation-id')).toBe('financial-http-test');
    const id = submitted.body.transactionId as string;
    expect((await request(`/wagering/transactions/${id}`)).body).toMatchObject({ transactionId:id,status:'PROCESSED',money:amount('10.00'),balance:amount('90.00') });
    expect((await request(`/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`)).body.transactionId).toBe(id);
    expect((await request(`/wallets/${walletId}`)).body.balance).toEqual(amount('90.00'));
    expect((await request(`/wallets/${walletId}/reconciliation`,{method:'POST'})).body).toMatchObject({ consistent:true,storedBalance:amount('90.00'),calculatedBalance:amount('90.00'),difference:amount('0.00'),checkedEntries:2 });
    expect((await request('/health/live')).status).toBe(200);
    expect((await request('/health/ready')).body).toEqual({status:'ready',checks:{postgres:true,sqs:true}});
    expect((await fetch(baseUrl+'/metrics')).headers.get('content-type')).toContain('text/plain');
  });

  test('400 invalid, 409 conflict, 422 business rejection, 202 pending and 404 missing are distinct', async () => {
    const w = await seed();
    const input = inputFor(w);
    expect((await postTransaction(input,{},null)).status).toBe(400);
    expect((await postTransaction(input,{money:{amount:10,currency:'BRL'}})).status).toBe(400);
    expect((await postTransaction(input,{kind:'OPENING'})).status).toBe(400);
    expect((await postTransaction(input,{idempotencyKey:'body-key'})).status).toBe(400);
    expect((await request('/wagering/transactions',{method:'POST',headers:{'content-type':'application/json'},body:'{invalid-json'})).status).toBe(400);
    expect((await postTransaction(input)).status).toBe(200);
    expect((await postTransaction(input,{money:amount('11.00')})).status).toBe(409);
    const rejected = await postTransaction(inputFor(w,{money:amount('1000.00')}));
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    const pending = await postTransaction(inputFor(w,{kind:K.Refund,referenceExternalTransactionId:randomUUID()}));
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
    expect((await request(`/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await request(`/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await request('/wallets/not-a-uuid')).status).toBe(400);
    expect((await request(`/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
  });

  test('malformed JSON is INVALID_REQUEST and oversized JSON is PAYLOAD_TOO_LARGE, without side effects', async () => {
    const w = await seed();
    const input = inputFor(w);
    const headers = {'content-type':'application/json','idempotency-key':input.idempotencyKey};
    const malformed = await request('/wagering/transactions',{method:'POST',headers,body:'{"providerId":'});
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({code:'INVALID_REQUEST',retryable:false});
    const {idempotencyKey:_key,...business} = input;
    const oversized = await request('/wagering/transactions',{method:'POST',headers,
      body:JSON.stringify({...business,padding:'x'.repeat(256 * 1024)})});
    expect(oversized.status).toBe(413);
    expect(oversized.body).toMatchObject({code:'PAYLOAD_TOO_LARGE',retryable:false});
    expect(await count('select count(*)::text as count from wager_transactions where idempotency_key = ?',[input.idempotencyKey])).toBe(0);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where wallet_id = ?',[w.walletId])).toBe(1);
    expect(await count('select count(*)::text as count from outbox_messages where aggregate_id = ?',[w.walletId])).toBe(2);
    expect(await balance(w.walletId)).toBe('100.00');
  });

  test('null, primitive, array, missing and unsupported content-type bodies cannot reach financial processing', async () => {
    const w = await seed();
    const input = inputFor(w);
    const cases: Array<{contentType:string;body?:string}> = [
      {contentType:'application/json',body:'null'},
      {contentType:'application/json',body:'"not-an-object"'},
      {contentType:'application/json',body:'[]'},
      {contentType:'application/json'},
      {contentType:'text/plain',body:JSON.stringify(input)},
    ];
    for (const value of cases) {
      const invalid = await request('/wagering/transactions',{method:'POST',
        headers:{'content-type':value.contentType,'idempotency-key':input.idempotencyKey},body:value.body});
      expect(invalid.status).toBe(400);
      expect(invalid.body.retryable).toBe(false);
    }
    expect(await count('select count(*)::text as count from wager_transactions where idempotency_key = ?',[input.idempotencyKey])).toBe(0);
    expect(await count('select count(*)::text as count from wallet_ledger_entries where wallet_id = ?',[w.walletId])).toBe(1);
    expect((await queries.wallet(w.walletId)).version).toBe(1);
    expect(await balance(w.walletId)).toBe('100.00');
  });

  test('real lock timeout yields retryable HTTP 503; same key succeeds after releasing the lock', async () => {
    const w = await seed();
    const input = inputFor(w);
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async em => { await db.lockWallet(em,w.walletId); locked(); await release; });
    await acquired;
    try {
      const failed = await postTransaction(input);
      expect(failed.status).toBe(503);
      expect(failed.body).toMatchObject({code:'INFRASTRUCTURE_UNAVAILABLE',retryable:true});
      expect(failed.response.headers.get('retry-after')).toBe('1');
      expect(await balance(w.walletId)).toBe('100.00');
      expect(await count('select count(*)::text as count from wager_transactions where idempotency_key = ?',[input.idempotencyKey])).toBe(0);
    } finally { unlock(); await holder; }
    expect((await postTransaction(input)).status).toBe(200);
    expect(await balance(w.walletId)).toBe('90.00');
  }, 90_000);

  test('ledger cursor freezes a high watermark while concurrent inserts occur; tampering and cross-wallet reuse fail', async () => {
    const w = await seed();
    const other = await seed();
    for (let i=0;i<3;i++) await financial.submit(inputFor(w,{money:amount('1.00')}));
    const first = await request(`/wallets/${w.walletId}/ledger?limit=2`);
    const items = first.body.items as Array<{id:string;walletVersion:number}>;
    const cursor = first.body.nextCursor as string;
    expect(items.map(item=>item.walletVersion)).toEqual([1,2]);
    expect(cursor).toBeString();
    const [, second] = await Promise.all([
      financial.submit(inputFor(w,{kind:K.Win,money:amount('5.00')})),
      request(`/wallets/${w.walletId}/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`),
    ]);
    expect((second.body.items as Array<{walletVersion:number}>).map(item=>item.walletVersion)).toEqual([3,4]);
    expect(second.body.nextCursor).toBeNull();
    const fresh = await request(`/wallets/${w.walletId}/ledger?limit=200`);
    expect((fresh.body.items as unknown[]).length).toBe(5);
    const tampered = (cursor[0] === 'a' ? 'b' : 'a') + cursor.slice(1);
    expect((await request(`/wallets/${w.walletId}/ledger?cursor=${encodeURIComponent(tampered)}`)).status).toBe(400);
    expect((await request(`/wallets/${other.walletId}/ledger?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    expect((await request(`/wallets/${w.walletId}/ledger?limit=201`)).status).toBe(400);
    expect((await request(`/wallets/${w.walletId}/ledger?limit=1&limit=2`)).status).toBe(400);
  });
});

import { randomUUID } from 'node:crypto';
import type { SqlEntityManager } from '@mikro-orm/postgresql';
import {
  DomainError, LedgerDirection, Money, Wallet, WalletLedgerEntry, WagerTransaction,
  WagerTransactionKind as Kind, WagerTransactionStatus as Status,
  WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionFailed,
  WagerTransactionPendingReference, WalletBalanceChanged, InboxMessage, OutboxMessage, type IntegrationEvent,
} from '../domain';
import { Database, sql, WalletRecord } from '../infrastructure/database';
import { config } from '../infrastructure/config';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { AppError, databaseCode, isTransient } from './errors';
import { businessPayload, canonicalHash, parseSubmission, type SubmissionContext, type SubmitInput, type TransactionResult } from './contracts';

export interface TransactionRow {
  id: string; provider_id: string; external_transaction_id: string; idempotency_key: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string; kind: Kind; amount: string; currency: string;
  reference_external_transaction_id: string | null; reference_transaction_id: string | null;
  status: Status; failure_code: string | null; observed_balance: string | null; observed_currency: string | null;
  created_at: Date; processed_at: Date | null; correlation_id: string; causation_id: string | null;
  pending_attempts: number; next_attempt_at: Date | null;
}
interface ProcessingState { isNew: boolean; attempts: number; nextAt: Date | null; correlationId: string; causationId?: string }
interface InboxRow { payload_hash: string; transaction_id: string | null; received_at: Date; processed_at: Date | null }
export interface FinancialHooks { beforeCommit?: () => Promise<void> }

export function hydrateTransaction(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key, payloadHash: row.payload_hash, walletId: row.wallet_id, playerId: row.player_id,
    roundId: row.round_id, gameId: row.game_id, kind: row.kind, money: Money.rehydrate(row.amount, row.currency),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    status: row.status, failureCode: row.failure_code ?? undefined,
    createdAt: new Date(row.created_at), processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
    observedBalance: row.observed_balance !== null && row.observed_currency !== null
      ? Money.rehydrate(row.observed_balance, row.observed_currency) : undefined,
  });
}
function hydrateWallet(row: WalletRecord): Wallet {
  return Wallet.rehydrate({ ...row, balance: Money.rehydrate(row.balance, row.currency) });
}

export class FinancialService {
  constructor(public readonly db: Database, private readonly hooks: FinancialHooks = {}) {
    if (hooks.beforeCommit && process.env.NODE_ENV !== 'test') throw new Error('Failure hooks are restricted to NODE_ENV=test');
  }

  async createWallet(playerId: string, initialBalance: Money, correlationId: string = randomUUID()): Promise<Record<string, unknown>> {
    const at = new Date();
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance, at });
    try {
      await this.db.transaction(async em => {
        await em.insert(WalletRecord, {
          id: wallet.id, playerId, currency: wallet.currency, balance: initialBalance.toString(),
          version: 1, createdAt: at, updatedAt: at,
        });
        if (!initialBalance.isZero()) {
          const tx = WagerTransaction.opening({
            id: randomUUID(), providerId: '__system__', externalTransactionId: wallet.id,
            idempotencyKey: `opening:${wallet.id}`, payloadHash: canonicalHash({ walletId: wallet.id, playerId, initialBalance: initialBalance.toJSON() }),
            walletId: wallet.id, playerId, roundId: '__opening__', gameId: '__opening__', money: initialBalance, createdAt: at,
          });
          tx.markProcessed(undefined, at, initialBalance);
          const state: ProcessingState = { isNew: true, attempts: 0, nextAt: null, correlationId };
          await this.saveTransaction(em, tx, state);
          const entry = WalletLedgerEntry.create({
            id: randomUUID(), walletId: wallet.id, transactionId: tx.id, walletVersion: 1,
            direction: LedgerDirection.Credit, money: initialBalance, balanceBefore: Money.zero(wallet.currency),
            balanceAfter: initialBalance, createdAt: at,
          });
          await this.insertLedger(em, entry);
          await this.emitResult(em, tx, state, entry);
        }
      });
    } catch (error) {
      if (databaseCode(error) === '23505') throw new AppError(409, 'WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency');
      throw error;
    }
    if (!initialBalance.isZero()) metrics.inc('transactions_total', { status: Status.Processed, kind: Kind.Opening });
    return { id: wallet.id, playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  async submit(raw: SubmitInput, context: SubmissionContext = {}): Promise<TransactionResult> {
    const started = performance.now();
    const input = parseSubmission(raw, raw.idempotencyKey);
    if (input.referenceExternalTransactionId === input.externalTransactionId) throw new AppError(400,'SELF_REFERENCE','A transaction cannot reference itself');
    const payloadHash = canonicalHash(businessPayload(input));
    const correlationId = context.correlationId ?? randomUUID();
    let draft: WagerTransaction;
    try {
      draft = WagerTransaction.create({ ...input, id: randomUUID(), money: Money.from(input.money), payloadHash, createdAt: new Date() });
    } catch (error) {
      if (error instanceof DomainError) throw new AppError(400, error.code, error.message);
      throw error;
    }

    const result = await this.withRetries(async () => this.db.transaction(async em => {
      // A rolled-back attempt must never leak a mutated domain instance into its retry.
      const attemptDraft = WagerTransaction.create({ ...input, id: draft.id, money: Money.from(input.money), payloadHash, createdAt: draft.createdAt });
      const inbox = await this.reserveInbox(em, input, context, payloadHash);
      if (inbox?.processed_at) {
        const row = (await sql<TransactionRow>(em, 'select * from wager_transactions where id = ?', [inbox.transaction_id]))[0];
        if (!row) throw new AppError(500, 'INBOX_INVARIANT_VIOLATION', 'Committed inbox has no transaction');
        this.assertReplay(row, input, payloadHash);
        return this.result(hydrateTransaction(row), true);
      }

      // Fast replay does not require locking the wallet; terminal snapshots are immutable in PostgreSQL.
      let existing = await this.findExisting(em, input);
      if (existing) {
        this.assertReplay(existing, input, payloadHash);
        await this.finishInbox(em, context, existing.id);
        return this.result(hydrateTransaction(existing), true);
      }
      const record = await this.db.lockWallet(em, input.walletId);
      if (!record) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet does not exist');
      existing = await this.findExisting(em, input);
      if (existing) {
        this.assertReplay(existing, input, payloadHash);
        await this.finishInbox(em, context, existing.id);
        return this.result(hydrateTransaction(existing), true);
      }
      const state: ProcessingState = { isNew: true, attempts: 0, nextAt: null, correlationId, causationId: context.messageId };
      await this.evaluate(em, record, attemptDraft, state);
      await this.finishInbox(em, context, attemptDraft.id);
      await this.hooks.beforeCommit?.();
      if (process.env.NODE_ENV === 'test' && process.env.TEST_CRASH_BEFORE_COMMIT === '1') process.kill(process.pid, 'SIGKILL');
      return this.result(attemptDraft, false);
    }));
    if (result.idempotentReplay) metrics.inc('duplicates_total', { source: context.messageId ? 'inbox_or_business' : 'http' });
    else metrics.inc('transactions_total', { status: result.status, kind: input.kind });
    metrics.observe('transaction_processing_seconds', (performance.now() - started) / 1000);
    log('info', 'transaction.completed', {
      correlationId, messageId: context.messageId, transactionId: result.transactionId, walletId: input.walletId,
      providerId: input.providerId, status: result.status, failureCode: result.failureCode, idempotentReplay: result.idempotentReplay,
    });
    return result;
  }

  async retryPendingBatch(limit = 20): Promise<number> {
    const candidates = await this.db.query<{ id: string; wallet_id: string }>(
      `select id, wallet_id from wager_transactions where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
       order by next_attempt_at, id limit ?`, [Math.max(1, Math.min(limit, 100))]);
    let handled = 0;
    for (const candidate of candidates) {
      const output = await this.withRetries(() => this.db.transaction(async em => {
        // Consistent lock order: wallet first, then its pending transaction. Recheck due time after acquiring both.
        const record = await this.db.lockWallet(em, candidate.wallet_id);
        if (!record) return null;
        const row = (await sql<TransactionRow>(em,
          `select * from wager_transactions where id = ? and status = 'PENDING_REFERENCE'
           and next_attempt_at <= now() for update`, [candidate.id]))[0];
        if (!row) return null;
        const tx = hydrateTransaction(row);
        await this.evaluate(em, record, tx, { isNew: false, attempts: row.pending_attempts, nextAt: null,
          correlationId: row.correlation_id, causationId: row.causation_id ?? undefined });
        return { status: tx.status, kind: tx.kind };
      }));
      if (output) {
        handled++;
        metrics.inc('retries_total', { worker: 'pending_reference' });
        if (output.status !== Status.PendingReference) metrics.inc('transactions_total', output);
      }
    }
    return handled;
  }

  /** Audit identifiable permanent processing failures without overwriting any committed terminal outcome. */
  async recordFailed(input: SubmitInput, context: SubmissionContext, code: string): Promise<void> {
    const accepted = parseSubmission(input, input.idempotencyKey);
    const hash = canonicalHash(businessPayload(accepted));
    const newlyFailed = await this.withRetries(() => this.db.transaction(async em => {
      if (context.messageId && context.consumerName) {
        await sql(em, `insert into failed_messages(consumer_name,message_id,payload_hash,failure_code)
          values (?,?,?,?) on conflict (consumer_name,message_id) do nothing`,
          [context.consumerName,context.messageId,hash,code]);
      }
      const known = await sql<{id:string}>(em,'select id from wallets where id = ?',[accepted.walletId]);
      if (!known.length) return false;
      await this.reserveInbox(em,accepted,context,hash);
      const record = await this.db.lockWallet(em, accepted.walletId);
      if (!record) return false;
      const existing = await this.findExisting(em, accepted);
      if (existing) this.assertReplay(existing, accepted, hash);
      const tx = existing ? hydrateTransaction(existing) : WagerTransaction.create({ ...accepted,
        id: randomUUID(), payloadHash: hash, money: Money.from(accepted.money), createdAt: new Date() });
      if (tx.isTerminal()) { await this.finishInbox(em,context,tx.id); return false; }
      tx.fail(code, new Date(), Money.rehydrate(record.balance, record.currency));
      const state: ProcessingState = { isNew: !existing, attempts: existing?.pending_attempts ?? 0,
        nextAt: null, correlationId: existing?.correlation_id ?? context.correlationId ?? randomUUID(), causationId: context.messageId };
      await this.saveTransaction(em, tx, state);
      await this.emitResult(em, tx, state);
      await this.finishInbox(em,context,tx.id);
      return true;
    }));
    if (newlyFailed) metrics.inc('transactions_total',{status:Status.Failed,kind:accepted.kind});
  }

  private async evaluate(em: SqlEntityManager, record: WalletRecord, tx: WagerTransaction, state: ProcessingState): Promise<void> {
    const wallet = hydrateWallet(record);
    const now = new Date();
    const reject = async (code: string) => {
      tx.reject(code, now, wallet.balance);
      state.nextAt = null;
      await this.saveTransaction(em, tx, state);
      await this.emitResult(em, tx, state);
    };
    if (tx.playerId !== wallet.playerId) return reject('PLAYER_MISMATCH');
    if (tx.money.currency !== wallet.currency) return reject('CURRENCY_MISMATCH');

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      const row = (await sql<TransactionRow>(em,
        'select * from wager_transactions where provider_id = ? and external_transaction_id = ?',
        [tx.providerId, tx.referenceExternalTransactionId]))[0];
      if (!row || row.status === Status.Pending || row.status === Status.PendingReference) {
        if (state.attempts >= config.referenceMaxAttempts || now.getTime() - tx.createdAt.getTime() >= config.referenceTtlMs) {
          return reject('REFERENCE_NOT_FOUND');
        }
        const firstPending = tx.status !== Status.PendingReference;
        tx.markPendingReference(wallet.balance);
        const delay = Math.min(config.referenceRetryMaxMs, config.referenceRetryBaseMs * 2 ** Math.min(state.attempts, 20));
        state.attempts++;
        state.nextAt = new Date(now.getTime() + delay);
        await this.saveTransaction(em, tx, state);
        if (firstPending) await this.emitResult(em, tx, state);
        return;
      }
      reference = hydrateTransaction(row);
      try { tx.validateReference(reference); }
      catch (error) { if (error instanceof DomainError) return reject(error.code); throw error; }
      if (tx.requiresReference()) {
        const prior = await sql<{ id: string }>(em,
          `select id from wager_transactions where reference_transaction_id = ? and kind = ? and status = 'PROCESSED'`,
          [reference.id, tx.kind]);
        if (prior.length) return reject('REFERENCE_ALREADY_REVERSED');
      }
    }
    let entry: WalletLedgerEntry | undefined;
    if (tx.affectsBalance()) {
      try {
        const movement = { entryId: randomUUID(), transactionId: tx.id, money: tx.money, at: now,
          insufficientFundsCode: tx.kind === Kind.Bet ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS' };
        entry = tx.ledgerDirectionFor(reference) === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      } catch (error) { if (error instanceof DomainError) return reject(error.code); throw error; }
    }
    tx.markProcessed(reference?.id, now, wallet.balance);
    state.nextAt = null;
    await this.saveTransaction(em, tx, state);
    if (entry) {
      record.balance = wallet.balance.toString();
      record.version = wallet.version;
      record.updatedAt = wallet.updatedAt;
      await em.flush();
      await this.insertLedger(em, entry);
    }
    await this.emitResult(em, tx, state, entry);
  }

  private async findExisting(em: SqlEntityManager, input: SubmitInput): Promise<TransactionRow | undefined> {
    const rows = await sql<TransactionRow>(em,
      'select * from wager_transactions where idempotency_key = ? or (provider_id = ? and external_transaction_id = ?)',
      [input.idempotencyKey, input.providerId, input.externalTransactionId]);
    if (rows.length > 1) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Key and external identity refer to different transactions');
    return rows[0];
  }

  private assertReplay(row: TransactionRow, input: SubmitInput, hash: string): void {
    if (row.payload_hash !== hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Identity already belongs to a different business payload');
    if (row.idempotency_key !== input.idempotencyKey) throw new AppError(409, 'EXTERNAL_ID_KEY_CONFLICT', 'The external transaction must retain its original Idempotency-Key');
  }

  private async reserveInbox(em: SqlEntityManager, input: SubmitInput, context: SubmissionContext, hash: string): Promise<InboxRow | undefined> {
    if (!context.messageId) return;
    if (!context.consumerName) throw new AppError(500, 'INVALID_CONSUMER_CONTEXT', 'Consumer identity is required');
    const inboxHash = canonicalHash({ payloadHash: hash, idempotencyKey: input.idempotencyKey });
    const received = InboxMessage.receive({ consumerName:context.consumerName,messageId:context.messageId,
      payloadHash:inboxHash,receivedAt:new Date() });
    await sql(em, `insert into inbox_messages(consumer_name,message_id,payload_hash,received_at)
      values (?,?,?,?) on conflict (consumer_name,message_id) do nothing`,
      [received.consumerName,received.messageId,received.payloadHash,received.receivedAt]);
    const inbox = (await sql<InboxRow>(em,
      'select payload_hash,transaction_id,received_at,processed_at from inbox_messages where consumer_name = ? and message_id = ? for update',
      [context.consumerName, context.messageId]))[0];
    if (!inbox) throw new AppError(500,'INBOX_INVARIANT_VIOLATION','Reserved inbox message is missing');
    const persisted = InboxMessage.rehydrate({consumerName:context.consumerName,messageId:context.messageId,
      payloadHash:inbox.payload_hash,receivedAt:new Date(inbox.received_at),
      processedAt:inbox.processed_at ? new Date(inbox.processed_at) : undefined});
    if (!persisted.matchesPayload(inboxHash)) throw new AppError(409, 'INBOX_PAYLOAD_CONFLICT', 'Message identity already belongs to another payload');
    return inbox;
  }

  private async finishInbox(em: SqlEntityManager, context: SubmissionContext, transactionId: string): Promise<void> {
    if (!context.messageId) return;
    const row = (await sql<InboxRow>(em,'select payload_hash,transaction_id,received_at,processed_at from inbox_messages where consumer_name = ? and message_id = ? for update',
      [context.consumerName,context.messageId]))[0];
    if (!row || !context.consumerName) throw new AppError(500,'INBOX_INVARIANT_VIOLATION','Cannot acknowledge an unreserved inbox message');
    const inbox = InboxMessage.rehydrate({consumerName:context.consumerName,messageId:context.messageId,
      payloadHash:row.payload_hash,receivedAt:new Date(row.received_at),processedAt:row.processed_at ? new Date(row.processed_at) : undefined});
    if (inbox.isProcessed()) return;
    inbox.markProcessed(new Date());
    await sql(em, 'update inbox_messages set transaction_id = ?, processed_at = ? where consumer_name = ? and message_id = ? and processed_at is null',
      [transactionId,inbox.processedAt,context.consumerName,context.messageId]);
  }

  private async saveTransaction(em: SqlEntityManager, tx: WagerTransaction, state: ProcessingState): Promise<void> {
    const resultFields = [tx.status, tx.referenceTransactionId ?? null, tx.failureCode ?? null,
      tx.processedAt ?? null, tx.observedBalance?.toString() ?? null, tx.observedBalance?.currency ?? null,
      state.attempts, state.nextAt];
    if (state.isNew) {
      await sql(em, `insert into wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,
         amount,currency,reference_external_transaction_id,created_at,correlation_id,causation_id,
         status,reference_transaction_id,failure_code,processed_at,observed_balance,observed_currency,pending_attempts,next_attempt_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tx.id,tx.providerId,tx.externalTransactionId,tx.idempotencyKey,tx.payloadHash,tx.walletId,tx.playerId,tx.roundId,
        tx.gameId,tx.kind,tx.money.toString(),tx.money.currency,tx.referenceExternalTransactionId ?? null,tx.createdAt,
        state.correlationId,state.causationId ?? null,...resultFields]);
    } else {
      await sql(em, `update wager_transactions set status=?,reference_transaction_id=?,failure_code=?,processed_at=?,
        observed_balance=?,observed_currency=?,pending_attempts=?,next_attempt_at=? where id=?`, [...resultFields,tx.id]);
    }
  }

  private async insertLedger(em: SqlEntityManager, entry: WalletLedgerEntry): Promise<void> {
    await sql(em, `insert into wallet_ledger_entries
      (id,wallet_id,transaction_id,wallet_version,direction,amount,currency,balance_before,balance_after,created_at)
      values (?,?,?,?,?,?,?,?,?,?)`, [entry.id,entry.walletId,entry.transactionId,entry.walletVersion,entry.direction,
      entry.money.toString(),entry.money.currency,entry.balanceBefore.toString(),entry.balanceAfter.toString(),entry.createdAt]);
  }

  private async emitResult(em: SqlEntityManager, tx: WagerTransaction, state: ProcessingState, entry?: WalletLedgerEntry): Promise<void> {
    const base = { eventId: randomUUID(), aggregateId: tx.walletId, correlationId: state.correlationId,
      causationId: state.causationId ?? tx.id, occurredAt: tx.processedAt ?? new Date(),
      data: { transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
        kind: tx.kind, status: tx.status, money: tx.money.toJSON(), balance: tx.observedBalance!.toJSON(),
        ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
        ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}) } };
    const event = tx.status === Status.Processed ? WagerTransactionProcessed.create(base)
      : tx.status === Status.Rejected ? WagerTransactionRejected.create(base)
      : tx.status === Status.Failed ? WagerTransactionFailed.create(base) : WagerTransactionPendingReference.create(base);
    await this.insertEvent(em, tx.id, event);
    if (entry) {
      await this.insertEvent(em, tx.id, WalletBalanceChanged.create({ ...base, eventId: randomUUID(), data: {
        walletId: tx.walletId, transactionId: tx.id, direction: entry.direction, money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: entry.walletVersion,
      } }));
    }
  }

  private async insertEvent<T>(em: SqlEntityManager, transactionId: string, event: IntegrationEvent<T>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    await sql(em, `insert into outbox_messages(id,transaction_id,aggregate_id,event_type,payload,occurred_at)
      values (?,?,?,?,?::jsonb,?)`, [message.id,transactionId,message.aggregateId,message.eventType,JSON.stringify(message.payload),message.occurredAt]);
  }

  private result(tx: WagerTransaction, replay: boolean): TransactionResult {
    if (!tx.observedBalance) throw new AppError(500, 'MISSING_RESULT_SNAPSHOT', 'Transaction has no persisted result snapshot');
    return { transactionId: tx.id, status: tx.status, balance: tx.observedBalance.toJSON(),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}), idempotentReplay: replay };
  }

  private async withRetries<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await work(); }
      catch (error) {
        const code = databaseCode(error);
        if (attempt < 2 && code && ['23505','40001','40P01','55P03'].includes(code)) {
          metrics.inc('lock_conflicts_total', { sqlState: code });
          metrics.inc('retries_total', { worker: 'sql_transaction' });
          await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt + Math.floor(Math.random() * 10)));
          continue;
        }
        if (isTransient(error)) throw new AppError(503,'INFRASTRUCTURE_UNAVAILABLE','Temporary infrastructure failure; retry with the same key',true);
        throw error;
      }
    }
  }
}

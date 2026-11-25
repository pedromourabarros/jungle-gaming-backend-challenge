import { createHmac, timingSafeEqual } from 'node:crypto';
import { Money } from '../domain';
import { config } from '../infrastructure/config';
import { Database } from '../infrastructure/database';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { AppError } from './errors';
import { hydrateTransaction, type TransactionRow } from './financial-service';

interface WalletRow { id: string; player_id: string; currency: string; balance: string; version: number; created_at: Date; updated_at: Date }
interface LedgerRow { id: string; wallet_id: string; transaction_id: string; wallet_version: number; direction: string;
  amount: string; currency: string; balance_before: string; balance_after: string; created_at: Date }
interface Cursor { v: 1; walletId: string; after: number; ceiling: number }

export class QueryService {
  constructor(private readonly db: Database) {}

  async wallet(id: string): Promise<Record<string, unknown>> {
    const row = (await this.db.query<WalletRow>('select * from wallets where id = ?', [id]))[0];
    if (!row) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet does not exist');
    return { id: row.id, playerId: row.player_id, balance: Money.rehydrate(row.balance,row.currency).toJSON(),
      version: row.version, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  }

  async transaction(id: string): Promise<Record<string, unknown>> {
    const row = (await this.db.query<TransactionRow>('select * from wager_transactions where id = ?', [id]))[0];
    return this.transactionView(row);
  }

  async providerTransaction(providerId: string, externalId: string): Promise<Record<string, unknown>> {
    if (providerId.length > 100 || externalId.length > 200) throw new AppError(400,'INVALID_ID','Identifier exceeds maximum length');
    const row = (await this.db.query<TransactionRow>(
      'select * from wager_transactions where provider_id = ? and external_transaction_id = ?', [providerId,externalId]))[0];
    return this.transactionView(row);
  }

  private transactionView(row?: TransactionRow): Record<string, unknown> {
    if (!row) throw new AppError(404,'TRANSACTION_NOT_FOUND','Transaction does not exist');
    const tx = hydrateTransaction(row);
    return { transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
      walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId, kind: tx.kind,
      money: tx.money.toJSON(), status: tx.status, balance: tx.observedBalance?.toJSON(),
      ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
      ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      createdAt: tx.createdAt.toISOString(), processedAt: tx.processedAt?.toISOString(),
      pendingAttempts: row.pending_attempts, nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null };
  }

  async ledger(walletId: string, cursorRaw?: string, limitRaw = '50'): Promise<Record<string, unknown>> {
    if (!/^\d+$/.test(limitRaw)) throw new AppError(400,'INVALID_LIMIT','Limit must be an integer between 1 and 200');
    const limit = Number(limitRaw);
    if (limit < 1 || limit > 200) throw new AppError(400,'INVALID_LIMIT','Limit must be between 1 and 200');
    const wallet = await this.wallet(walletId);
    const cursor: Cursor = cursorRaw ? this.decodeCursor(cursorRaw, walletId)
      : { v: 1, walletId, after: 0, ceiling: wallet.version as number };
    const rows = await this.db.query<LedgerRow>(`select * from wallet_ledger_entries where wallet_id = ?
      and wallet_version > ? and wallet_version <= ? order by wallet_version asc limit ?`,
      [walletId,cursor.after,cursor.ceiling,limit + 1]);
    const page = rows.slice(0,limit);
    const last = page.at(-1);
    return { items: page.map(row => ({ id: row.id, walletId: row.wallet_id, transactionId: row.transaction_id,
      walletVersion: row.wallet_version, direction: row.direction, money: Money.rehydrate(row.amount,row.currency).toJSON(),
      balanceBefore: Money.rehydrate(row.balance_before,row.currency).toJSON(),
      balanceAfter: Money.rehydrate(row.balance_after,row.currency).toJSON(), createdAt: new Date(row.created_at).toISOString() })),
      nextCursor: rows.length > limit && last ? this.encodeCursor({ ...cursor, after: last.wallet_version }) : null };
  }

  async reconciliation(walletId: string, correlationId: string): Promise<Record<string, unknown>> {
    const row = (await this.db.query<{wallet_id:string;currency:string;stored_balance:string;calculated_balance:string;
      difference:string;checked_entries:string}>(`select w.id as wallet_id,w.currency,w.balance::text as stored_balance,
      coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end),0)::numeric(28,2)::text as calculated_balance,
      (w.balance - coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end),0))::numeric(28,2)::text as difference,
      count(l.id)::text as checked_entries from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id`, [walletId]))[0];
    if (!row) throw new AppError(404,'WALLET_NOT_FOUND','Wallet does not exist');
    const difference = Money.rehydrate(row.difference,row.currency);
    const consistent = difference.isZero();
    if (!consistent) {
      metrics.inc('reconciliation_mismatches_total');
      log('error','wallet.reconciliation_mismatch',{correlationId,walletId,code:'LEDGER_BALANCE_MISMATCH'});
    }
    return { walletId, storedBalance: Money.rehydrate(row.stored_balance,row.currency).toJSON(),
      calculatedBalance: Money.rehydrate(row.calculated_balance,row.currency).toJSON(), difference: difference.toJSON(),
      consistent, checkedEntries: Number(row.checked_entries) };
  }

  private encodeCursor(value: Cursor): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256',config.cursorSecret).update(body).digest('base64url')}`;
  }
  private decodeCursor(raw: string, walletId: string): Cursor {
    try {
      if (raw.length > 1024) throw new Error();
      const pieces = raw.split('.');
      if (pieces.length !== 2) throw new Error();
      const body = pieces[0]!;
      const supplied = Buffer.from(pieces[1]!, 'base64url');
      const expected = createHmac('sha256',config.cursorSecret).update(body).digest();
      if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) throw new Error();
      const value = JSON.parse(Buffer.from(body,'base64url').toString('utf8')) as Cursor;
      if (value.v !== 1 || value.walletId !== walletId || !Number.isSafeInteger(value.after) || !Number.isSafeInteger(value.ceiling)
        || value.after < 0 || value.ceiling < 1 || value.after > value.ceiling) throw new Error();
      return value;
    } catch { throw new AppError(400,'INVALID_CURSOR','Cursor is invalid or belongs to another wallet'); }
  }
}

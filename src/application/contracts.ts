import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, Money, type MoneyProps, WagerTransactionKind, WagerTransactionStatus } from '../domain';
import { AppError } from './errors';

export const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const identifier = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const moneySchema = z.object({ amount: z.string().max(29), currency: z.enum(['BRL','USD','EUR','GBP']) }).strict();
const baseSchema = z.object({
  providerId: identifier(100),
  externalTransactionId: identifier(200),
  playerId: uuidSchema,
  walletId: uuidSchema,
  roundId: identifier(200),
  gameId: identifier(200),
  kind: z.enum(['BET','WIN','LOSS','REFUND','ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: identifier(200).optional(),
}).strict();
const keySchema = z.string().min(1).max(256).regex(/^[\x21-\x7E]+$/);
const walletSchema = z.object({ playerId: uuidSchema, initialBalance: moneySchema }).strict();

export interface SubmitInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}
export interface SubmissionContext { correlationId?: string; messageId?: string; consumerName?: string }

export function parseSubmission(raw: unknown, key: string): SubmitInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400,'INVALID_PAYLOAD','Invalid transaction payload');
  const { idempotencyKey: _transportKey, ...business } = raw as Record<string, unknown>;
  const parsed = baseSchema.safeParse(business);
  const parsedKey = keySchema.safeParse(key);
  if (!parsed.success || !parsedKey.success) throw new AppError(400, 'INVALID_PAYLOAD', 'Invalid payload or missing Idempotency-Key');
  try {
    const money = Money.from(parsed.data.money);
    return { ...parsed.data, kind: parsed.data.kind as WagerTransactionKind, money: money.toJSON(), idempotencyKey: parsedKey.data };
  } catch (error) {
    if (error instanceof DomainError) throw new AppError(400, error.code, 'Invalid money representation');
    throw error;
  }
}

export function parseWallet(raw: unknown): { playerId: string; initialBalance: Money } {
  const parsed = walletSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, 'INVALID_PAYLOAD', 'Invalid wallet payload');
  try { return { playerId: parsed.data.playerId, initialBalance: Money.from(parsed.data.initialBalance) }; }
  catch (error) {
    if (error instanceof DomainError) throw new AppError(400, error.code, 'Invalid money representation');
    throw error;
  }
}

export function parseUuid(raw: string): string {
  const result = uuidSchema.safeParse(raw);
  if (!result.success) throw new AppError(400, 'INVALID_ID', 'Expected a UUID');
  return result.data;
}

/** Sort object keys recursively, retain array order, then SHA-256 over UTF-8 JSON. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function canonicalHash(value: unknown): string { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
export function businessPayload(input: SubmitInput): Omit<SubmitInput, 'idempotencyKey'> {
  const { idempotencyKey: _key, ...payload } = input;
  return payload;
}

import { randomUUID } from 'node:crypto';
import { Database } from '../../src/infrastructure/database';
import { FinancialService } from '../../src/application/financial-service';
import { Money, WagerTransactionKind } from '../../src/domain';
import type { SubmitInput } from '../../src/application/contracts';
import { QueryService } from '../../src/application/query-service';

export async function connectTestDatabase(): Promise<Database> {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Integration tests require a database name ending in _test');
  if (process.env.ALLOW_INTEGRATION_TESTS !== '1') throw new Error('Set ALLOW_INTEGRATION_TESTS=1 to run integration tests');
  const db = await Database.connect(url);
  await db.migrate();
  return db;
}
export async function createTestWallet(db: Database, amount = '100.00') {
  const service = new FinancialService(db);
  const playerId = randomUUID();
  const result = await service.createWallet(playerId,Money.from({amount,currency:'BRL'}));
  return { service, walletId: result.id as string, playerId };
}
export function inputFor(wallet: {walletId:string;playerId:string}, overrides: Partial<SubmitInput> = {}): SubmitInput {
  const external = randomUUID();
  return { providerId:'provider-a', externalTransactionId:external, idempotencyKey:`provider-a:${external}`,
    playerId:wallet.playerId,walletId:wallet.walletId,roundId:'round-test',gameId:'fortune-chimp',
    kind:WagerTransactionKind.Bet,money:{amount:'10.00',currency:'BRL'},...overrides };
}
export async function assertReconciled(db: Database, walletId: string): Promise<void> {
  const report = await new QueryService(db).reconciliation(walletId,randomUUID());
  if (!report.consistent) throw new Error(`Wallet ${walletId} did not reconcile`);
}
export async function eventually<T>(read:()=>Promise<T>, predicate:(value:T)=>boolean, timeoutMs=10000):Promise<T> {
  const deadline=Date.now()+timeoutMs;
  let last: T;
  do { last=await read(); if(predicate(last))return last; await Bun.sleep(25); } while(Date.now()<deadline);
  throw new Error(`Condition not reached within ${timeoutMs}ms; last=${JSON.stringify(last!)}`);
}

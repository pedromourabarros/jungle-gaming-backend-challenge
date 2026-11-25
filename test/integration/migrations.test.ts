import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Database } from '../../src/infrastructure/database';
import { FinancialService } from '../../src/application/financial-service';
import { QueryService } from '../../src/application/query-service';
import { Money } from '../../src/domain';

let db: Database;
const businessTables = ['failed_messages','inbox_messages','outbox_messages','wager_transactions','wallet_ledger_entries','wallets'];

beforeAll(async () => {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (process.env.ALLOW_INTEGRATION_TESTS !== '1' || !url || !new URL(url).pathname.endsWith('_migration_test')) {
    throw new Error('Migration roundtrip requires ALLOW_INTEGRATION_TESTS=1 and MIGRATION_DATABASE_URL ending in _migration_test');
  }
  const normalUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (normalUrl && new URL(url).pathname === new URL(normalUrl).pathname) {
    throw new Error('The destructive migration roundtrip must use a separate disposable database');
  }
  db = await Database.connect(url);
}, 60_000);

afterAll(async () => { await db?.close(); });

async function tables(): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by table_name");
  return rows.map(row => row.table_name);
}
async function functions(): Promise<string[]> {
  const rows = await db.query<{ proname: string }>(
    "select p.proname from pg_proc p join pg_namespace n on p.pronamespace = n.oid where n.nspname = 'public' order by p.proname");
  return rows.map(row => row.proname);
}

describe('Real PostgreSQL MikroORM migration lifecycle', () => {
  test('up is idempotent, down removes tables/triggers/functions, and up rebuilds a usable schema', async () => {
    // This database is deliberately separate from all financial and messaging integration tests.
    await db.rollback();
    expect(await tables()).toEqual([]);
    await db.migrate();
    expect(await tables()).toEqual(businessTables);
    const firstFunctions = await functions();
    expect(firstFunctions).toContain('verify_wallet_movement');
    expect(firstFunctions).toContain('verify_transaction_result');
    expect(firstFunctions).toContain('verify_ledger_insert');
    expect(firstFunctions).toContain('forbid_audit_mutation');

    const first = await new FinancialService(db).createWallet(randomUUID(), Money.from({amount:'100.00',currency:'BRL'}));
    const firstReport = await new QueryService(db).reconciliation(first.id as string,randomUUID());
    expect(firstReport.consistent).toBe(true);
    expect(firstReport.checkedEntries).toBe(1);
    await db.migrate();
    expect((await new QueryService(db).wallet(first.id as string)).balance).toEqual({amount:'100.00',currency:'BRL'});

    const indexes = await db.query<{ indexname: string; indexdef: string }>("select indexname,indexdef from pg_indexes where schemaname = 'public'");
    expect(indexes.find(row=>row.indexname==='one_processed_reversal_per_kind')?.indexdef).toMatch(/UNIQUE.*reference_transaction_id, kind/);
    expect(indexes.find(row=>row.indexname==='one_opening_per_wallet')?.indexdef).toMatch(/UNIQUE/);
    expect(indexes.find(row=>row.indexname==='outbox_due')?.indexdef).toMatch(/published_at IS NULL/);
    expect(indexes.find(row=>row.indexname==='pending_references_due')?.indexdef).toMatch(/PENDING_REFERENCE/);
    expect(indexes.find(row=>row.indexname==='ledger_transaction_lookup')?.indexdef).toMatch(/transaction_id/);

    const deferred = await db.query<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>(
      "select tgname,tgdeferrable,tginitdeferred from pg_trigger where tgname in ('wallet_movement','transaction_result') order by tgname");
    expect(deferred).toHaveLength(2);
    for (const trigger of deferred) {
      expect(trigger.tgdeferrable).toBe(true);
      expect(trigger.tginitdeferred).toBe(true);
    }

    await db.rollback();
    expect(await tables()).toEqual([]);
    expect(await functions()).toEqual([]);
    await db.migrate();
    expect(await tables()).toEqual(businessTables);
    expect(await functions()).toEqual(firstFunctions);
    const restored = await new FinancialService(db).createWallet(randomUUID(), Money.from({amount:'0.00',currency:'EUR'}));
    expect((await new QueryService(db).reconciliation(restored.id as string,randomUUID())).consistent).toBe(true);
    expect((await new QueryService(db).wallet(restored.id as string)).version).toBe(1);
  }, 90_000);
});

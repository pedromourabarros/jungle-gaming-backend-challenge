import { Migration } from '@mikro-orm/migrations';
import { schemaDown, schemaUp } from './schema';

export class Migration202611250001 extends Migration {
  override async up(): Promise<void> { this.addSql(schemaUp); }
  override async down(): Promise<void> { this.addSql(schemaDown); }
}

/** Deferred integrity checks resolve ledger rows by transaction, including across many wallets. */
export class Migration202611250002 extends Migration {
  override async up(): Promise<void> {
    this.addSql('create index ledger_transaction_lookup on wallet_ledger_entries(transaction_id)');
  }
  override async down(): Promise<void> {
    this.addSql('drop index if exists ledger_transaction_lookup');
  }
}

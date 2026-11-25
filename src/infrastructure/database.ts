import { EntitySchema, LockMode } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM, type SqlEntityManager } from '@mikro-orm/postgresql';
import { config } from './config';
import { Migration202611250001, Migration202611250002 } from './migration';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string' },
    balance: { type: 'string', columnType: 'numeric(28,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});

/** em.execute automatically uses em.getTransactionContext(); never call a bare connection here. */
export async function sql<T extends object = Record<string, unknown>>(
  em: SqlEntityManager, statement: string, params: unknown[] = [],
): Promise<T[]> {
  return em.execute<T[]>(statement, params);
}

export class Database {
  private constructor(public readonly orm: MikroORM) {}

  static async connect(url = config.databaseUrl): Promise<Database> {
    const orm = await MikroORM.init({
      clientUrl: url,
      entities: [WalletSchema],
      extensions: [Migrator],
      migrations: { migrationsList: [Migration202611250001, Migration202611250002], transactional: true, allOrNothing: true },
      pool: { min: 0, max: config.poolMax, acquireTimeoutMillis: 5000 },
      driverOptions: { connection: { connectionTimeoutMillis: 5000 } },
      debug: false,
      allowGlobalContext: false,
    });
    return new Database(orm);
  }

  transaction<T>(work: (em: SqlEntityManager) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async em => {
      await em.execute(`set local lock_timeout = '${config.lockTimeoutMs}ms'`);
      await em.execute(`set local statement_timeout = '${config.statementTimeoutMs}ms'`);
      return work(em);
    });
  }

  query<T extends object = Record<string, unknown>>(statement: string, params: unknown[] = []): Promise<T[]> {
    return sql<T>(this.orm.em.fork(), statement, params);
  }

  async lockWallet(em: SqlEntityManager, id: string): Promise<WalletRecord | null> {
    return em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
  }

  async migrate(): Promise<void> { await this.orm.getMigrator().up(); }
  async rollback(): Promise<void> { await this.orm.getMigrator().down({ to: 0 }); }
  async close(): Promise<void> { await this.orm.close(true); }
}

import { Database } from '../src/infrastructure/database';
const action = process.argv[2] ?? 'up';
if (!['up','down'].includes(action)) throw new Error('Usage: bun scripts/migrate.ts up|down');
const db = await Database.connect(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
try {
  if (action === 'down') await db.rollback(); else await db.migrate();
  console.log(JSON.stringify({event:'migrations_completed', action}));
} finally { await db.close(); }

function integer(name: string, fallback: number, min = 1, max = 2_147_483_647): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid configuration: ${name}`);
  return value;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://jungle_app:jungle_app@127.0.0.1:5432/jungle',
  port: integer('PORT', 3000, 0, 65535),
  poolMax: integer('DATABASE_POOL_MAX', 12, 2, 100),
  lockTimeoutMs: integer('DATABASE_LOCK_TIMEOUT_MS', 2000, 50, 30000),
  statementTimeoutMs: integer('DATABASE_STATEMENT_TIMEOUT_MS', 10000, 100, 60000),
  referenceRetryBaseMs: integer('REFERENCE_RETRY_BASE_MS', 500, 10, 60000),
  referenceRetryMaxMs: integer('REFERENCE_RETRY_MAX_MS', 30000, 10, 3600000),
  referenceMaxAttempts: integer('REFERENCE_MAX_ATTEMPTS', 20, 1, 1000),
  referenceTtlMs: integer('REFERENCE_TTL_MS', 86400000, 100, 604800000),
  cursorSecret: process.env.CURSOR_SECRET ?? 'local-development-cursor-secret-change-in-production',
};

if (process.env.NODE_ENV === 'production' && (!process.env.CURSOR_SECRET || config.cursorSecret.length < 32)) {
  throw new Error('Production requires CURSOR_SECRET with at least 32 characters');
}

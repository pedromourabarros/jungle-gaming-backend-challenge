export class AppError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) { super(message); this.name = 'AppError'; }
}

export function databaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; cause?: unknown; previous?: unknown };
  return typeof value.code === 'string' ? value.code : databaseCode(value.cause ?? value.previous);
}

export function isTransient(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  const code = databaseCode(error);
  if (code && (/^08/.test(code) || ['40001','40P01','55P03','57014','57P01','57P02','57P03','53300',
    'ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOTFOUND'].includes(code))) return true;
  const name = error instanceof Error ? error.name : '';
  return /Timeout|Connection|Pool/.test(name);
}

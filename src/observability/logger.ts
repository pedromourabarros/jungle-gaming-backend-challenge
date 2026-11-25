const allowed = new Set(['correlationId','messageId','transactionId','walletId','providerId','eventId','eventType',
  'status','code','failureCode','attempts','durationMs','idempotentReplay','worker','count','port','signal','reason','sqlState']);

/** An allowlist intentionally excludes raw errors, SQL, receipt handles and financial payloads. */
export function log(level: 'info' | 'warn' | 'error', event: string, context: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (allowed.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      safe[key] = typeof value === 'string' ? value.replace(/[\r\n\t]/g, '').slice(0, 256) : value;
    }
  }
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safe })}\n`);
}

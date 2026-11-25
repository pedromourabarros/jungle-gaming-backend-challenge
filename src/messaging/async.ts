/** Interruptible scheduling; aborting a sleep never cancels a financial transaction. */
export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function settleWithin(task: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function workerBackoff(attempt: number, baseMs = 1000, maximumMs = 300000): number {
  return Math.min(maximumMs, baseMs * (2 ** Math.min(Math.max(attempt - 1, 0), 20)));
}

export function testOnlyHook<T>(hook: T | undefined): T | undefined {
  if (hook !== undefined && process.env.NODE_ENV !== 'test') throw new Error('Fault hooks require NODE_ENV=test');
  return hook;
}

export function crashIfRequested(variable: 'TEST_CRASH_AFTER_COMMIT' | 'TEST_CRASH_AFTER_PUBLISH'): void {
  if (process.env.NODE_ENV === 'test' && process.env[variable] === '1') process.kill(process.pid, 'SIGKILL');
}

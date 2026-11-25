import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { TransactionResult, SubmitInput } from '../../src/application/contracts';

const projectRoot = resolve(import.meta.dir, '../..');
const reservedPorts = new Set<number>();

export interface ApplicationProcess {
  readonly pid: number;
  readonly baseUrl: string;
  readonly exited: Promise<number>;
  output(): string;
  isRunning(): boolean;
  waitForExit(timeoutMs?: number): Promise<number>;
  stop(): Promise<void>;
  kill(): Promise<void>;
}

/** Poll a condition with a bounded deadline; startup and recovery never assume a fixed sleep. */
export async function eventually<T>(
  description: string,
  probe: () => Promise<T | false | null | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      const result = await probe();
      if (result !== false && result !== null && result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(Math.min(40, Math.max(1, deadline - performance.now())));
  }
  throw new Error(`Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function unusedPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    const port = await new Promise<number>((resolvePort, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Could not allocate a test port'));
        resolvePort(address.port);
      });
    });
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
  throw new Error('Could not allocate a distinct application port');
}

export async function startApplication(
  overrides: Record<string, string> = {},
  readyTimeoutMs = 25_000,
  entrypoint = 'src/main.ts',
): Promise<ApplicationProcess> {
  const port = await unusedPort();
  let output = '';
  const append = (chunk: string) => { output = (output + chunk).slice(-120_000); };
  const child = Bun.spawn([process.execPath, entrypoint], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      MESSAGING_ENABLED: 'false',
      SQS_CONSUMER_ENABLED: 'false',
      OUTBOX_ENABLED: 'false',
      PENDING_REFERENCE_ENABLED: 'false',
      SHUTDOWN_GRACE_MS: '3000',
      WORKER_POLL_INTERVAL_MS: '30',
      SQS_POLL_WAIT_SECONDS: '1',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '6',
      ...overrides,
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
      append(decoder.decode());
    } finally { reader.releaseLock(); }
  };
  const streams = Promise.allSettled([drain(child.stdout), drain(child.stderr)]);
  let exited = false;
  const exit = child.exited.then(code => { exited = true; reservedPorts.delete(port); return code; });
  const waitForExit = async (timeoutMs = 15_000) => {
    await eventually('application process to exit', async () => exited, timeoutMs);
    await streams;
    return exit;
  };
  const application: ApplicationProcess = {
    pid: child.pid,
    baseUrl: `http://127.0.0.1:${port}`,
    exited: exit,
    output: () => output,
    isRunning: () => !exited,
    waitForExit,
    stop: async () => {
      if (!exited) child.kill('SIGTERM');
      try { await waitForExit(8000); }
      catch { if (!exited) child.kill('SIGKILL'); await waitForExit(5000); }
    },
    kill: async () => { if (!exited) child.kill('SIGKILL'); await waitForExit(5000); },
  };
  try {
    await eventually('application readiness', async () => {
      if (exited) throw new Error(`Application exited during startup:\n${output}`);
      const response = await fetch(`${application.baseUrl}/health/ready`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    }, readyTimeoutMs);
    return application;
  } catch (error) {
    await application.stop();
    throw new Error(`${error instanceof Error ? error.message : 'Application startup failed'}\n${output}`);
  }
}

export async function submitHttp(application: ApplicationProcess, input: SubmitInput): Promise<{
  status: number;
  result: TransactionResult;
}> {
  const { idempotencyKey, ...business } = input;
  const response = await fetch(`${application.baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(business),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json() as TransactionResult;
  return { status: response.status, result };
}

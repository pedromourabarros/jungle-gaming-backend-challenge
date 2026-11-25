import type { Message } from '@aws-sdk/client-sqs';
import { AppError } from '../application/errors';
import { parseSubmission, type SubmitInput } from '../application/contracts';
import type { FinancialService } from '../application/financial-service';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { crashIfRequested, delay, testOnlyHook, workerBackoff } from './async';
import { SqsGateway } from './sqs-gateway';

type MessageContext = { correlationId: string; messageId: string; consumerName: string; walletId: string; providerId: string };

export interface ConsumerOptions {
  concurrency?: number;
  consumerName?: string;
  afterCommitBeforeAck?: (message: Message) => Promise<void>;
}

export interface ParsedEnvelope {
  messageId: string;
  occurredAt: string;
  input: SubmitInput;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]); const month = Number(parts[2]); const day = Number(parts[3]);
  // Date.parse normalizes some impossible dates (for example February 31).
  const days = new Date(Date.UTC(year < 100 ? year + 400 : year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

export function parseEnvelope(body: string | undefined): ParsedEnvelope {
  let value: unknown;
  try { value = JSON.parse(body ?? ''); } catch { throw new AppError(400, 'INVALID_MESSAGE_ENVELOPE', 'Invalid queue message envelope'); }
  if (!record(value) || value.type !== 'WagerTransactionRequested'
    || typeof value.messageId !== 'string' || value.messageId.length < 1 || value.messageId.length > 128
    || value.messageId !== value.messageId.trim() || /[\u0000-\u001f\u007f]/.test(value.messageId)
    || !validTimestamp(value.occurredAt) || !record(value.data)
    || typeof value.data.idempotencyKey !== 'string') {
    throw new AppError(400, 'INVALID_MESSAGE_ENVELOPE', 'Invalid queue message envelope');
  }
  const { idempotencyKey, ...business } = value.data;
  return { messageId: value.messageId, occurredAt: value.occurredAt, input: parseSubmission(business, idempotencyKey) };
}

/** Transport acknowledgement happens only after the use case has returned from its SQL commit. */
export class SqsConsumer {
  readonly consumerName: string;
  private readonly concurrency: number;
  private readonly afterCommitBeforeAck: ConsumerOptions['afterCommitBeforeAck'];
  private readonly inFlight = new Map<string, {
    message: Message; heartbeat: AbortController; heartbeatTask: Promise<void>; transport: Promise<void>; released: boolean;
  }>();

  constructor(
    private readonly gateway: SqsGateway,
    private readonly service: Pick<FinancialService, 'submit' | 'recordFailed'>,
    options: ConsumerOptions = {},
  ) {
    this.consumerName = options.consumerName ?? 'wager-transaction-consumer-v1';
    this.concurrency = options.concurrency ?? 10;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 10) {
      throw new Error('Consumer concurrency must be between 1 and 10');
    }
    this.afterCommitBeforeAck = testOnlyHook(options.afterCommitBeforeAck);
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const messages = await this.gateway.receive(this.concurrency, signal);
        if (signal.aborted) {
          await Promise.allSettled(messages.map(message => message.ReceiptHandle
            ? this.gateway.changeVisibility(message.ReceiptHandle, 0) : Promise.resolve()));
          break;
        }
        // Bound concurrency and retain all task promises through graceful shutdown.
        await Promise.allSettled(messages.map(message => this.handleMessage(message)));
      } catch {
        if (signal.aborted) break;
        metrics.inc('retries_total', { worker: 'consumer_poll' });
        log('warn', 'consumer.poll_failed', { code: 'SQS_UNAVAILABLE' });
        await delay(1000, signal);
      }
    }
  }

  async handleMessage(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (!receipt) {
      log('warn', 'consumer.missing_receipt', { code: 'INVALID_TRANSPORT_MESSAGE' });
      return;
    }
    const heartbeat = new AbortController();
    const heartbeatTask = this.heartbeat(receipt, heartbeat.signal);
    const state = { message, heartbeat, heartbeatTask, transport: Promise.resolve(), released: false };
    this.inFlight.set(receipt, state);
    const stopHeartbeat = async () => { heartbeat.abort(); await heartbeatTask; };
    const acknowledge = async () => {
      await stopHeartbeat();
      if (!state.released) {
        state.transport = this.gateway.acknowledge(receipt);
        await state.transport;
      }
    };
    const rawCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const receiveCount = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1;
    let parsed: ParsedEnvelope | undefined;
    let context: MessageContext | undefined;

    try {
      parsed = parseEnvelope(message.Body);
      context = { correlationId: parsed.messageId, messageId: parsed.messageId, consumerName: this.consumerName,
        walletId: parsed.input.walletId, providerId: parsed.input.providerId };
      const result = await this.service.submit(parsed.input, context);
      if (state.released) return;
      // These faults are inaccessible through HTTP and are disabled outside NODE_ENV=test.
      await this.afterCommitBeforeAck?.(message);
      crashIfRequested('TEST_CRASH_AFTER_COMMIT');
      if (state.released) return;
      if (result.status === 'FAILED') {
        await this.deadLetter(message, result.failureCode ?? 'TRANSACTION_FAILED', parsed.input.walletId, acknowledge);
      } else {
        await acknowledge();
      }
      if (state.released) return;
      metrics.inc('sqs_messages_total', { status: result.status });
      log('info', 'consumer.acknowledged', {
        ...context, transactionId: result.transactionId, walletId: parsed.input.walletId,
        providerId: parsed.input.providerId, status: result.status,
      });
    } catch (error) {
      if (state.released) return;
      const appError = error instanceof AppError ? error : undefined;
      const permanent = !!appError && !appError.retryable;
      const exhausted = receiveCount >= this.gateway.config.maxReceiveCount;
      const code = permanent ? appError.code : 'PROCESSING_RETRY_EXHAUSTED';
      if (permanent || exhausted) {
        try {
          // Contract/domain conflicts do not create a different financial operation.
          // Infrastructure failures with an identifiable valid command remain auditable.
          if (parsed && context && (!permanent || appError.httpStatus >= 500)) {
            await this.service.recordFailed(parsed.input, context, code);
          }
          if (state.released) return;
          await this.deadLetter(message, code, parsed?.input.walletId, acknowledge);
          if (state.released) return;
          log('warn', 'consumer.dead_lettered', {
            ...context, walletId: parsed?.input.walletId, providerId: parsed?.input.providerId,
            code, attempts: receiveCount,
          });
        } catch {
          // Neither a failed audit commit nor a failed DLQ send authorizes DeleteMessage.
          // The broker's redrive policy is the fallback if PostgreSQL stays unavailable.
          await stopHeartbeat();
          if (!state.released) {
            state.transport = this.retry(receipt, receiveCount, context, 'DLQ_OR_AUDIT_UNAVAILABLE');
            await state.transport;
          }
        }
      } else {
        await stopHeartbeat();
        if (!state.released) {
          state.transport = this.retry(receipt, receiveCount, context, appError?.code ?? 'TRANSIENT_PROCESSING_ERROR');
          await state.transport;
        }
      }
    } finally {
      await stopHeartbeat();
      this.inFlight.delete(receipt);
    }
  }

  async releaseInFlight(): Promise<void> {
    await Promise.allSettled([...this.inFlight.entries()].map(async ([receipt, item]) => {
      item.released = true;
      item.heartbeat.abort();
      await item.heartbeatTask;
      await item.transport.catch(() => undefined);
      await this.gateway.changeVisibility(receipt, 0);
    }));
  }

  private async deadLetter(message: Message, code: string, walletId?: string, acknowledge?: () => Promise<void>): Promise<void> {
    await this.gateway.sendToDlq(message, code, walletId);
    // Count successful transfers only, never an intention to send.
    metrics.inc('dlq_messages_total', { code });
    if (acknowledge) await acknowledge();
    else if (message.ReceiptHandle) await this.gateway.acknowledge(message.ReceiptHandle);
  }

  private async retry(receipt: string, attempt: number, context: MessageContext | undefined, code: string): Promise<void> {
    metrics.inc('retries_total', { worker: 'consumer' });
    log('warn', 'consumer.retry_scheduled', { ...context, code, attempts: attempt });
    const seconds = Math.ceil(workerBackoff(attempt, 1000, 30000) / 1000);
    try { await this.gateway.changeVisibility(receipt, seconds); }
    catch { log('warn', 'consumer.visibility_failed', { ...context, code: 'SQS_UNAVAILABLE' }); }
  }

  private async heartbeat(receipt: string, signal: AbortSignal): Promise<void> {
    const interval = Math.floor(this.gateway.config.visibilityTimeoutSeconds * 1000 / 3);
    while (!signal.aborted) {
      await delay(interval, signal);
      if (signal.aborted) return;
      try { await this.gateway.changeVisibility(receipt, this.gateway.config.visibilityTimeoutSeconds); }
      catch {
        metrics.inc('retries_total', { worker: 'visibility_heartbeat' });
        log('warn', 'consumer.heartbeat_failed', { code: 'SQS_UNAVAILABLE' });
      }
    }
  }
}

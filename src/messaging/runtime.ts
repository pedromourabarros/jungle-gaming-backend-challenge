import type { FinancialService } from '../application/financial-service';
import type { Database } from '../infrastructure/database';
import { log } from '../observability/logger';
import { metrics } from '../observability/metrics';
import { delay, settleWithin } from './async';
import { OutboxPublisher, type OutboxOptions } from './outbox-publisher';
import { PendingReferenceWorker } from './pending-reference-worker';
import { SqsConsumer, type ConsumerOptions } from './sqs-consumer';
import { SqsGateway } from './sqs-gateway';

export interface MessagingOptions {
  gateway?: SqsGateway;
  consumerConcurrency?: number;
  pollIntervalMs?: number;
  shutdownGraceMs?: number;
  outboxLeaseMs?: number;
  consumerEnabled?: boolean;
  outboxEnabled?: boolean;
  pendingEnabled?: boolean;
  afterCommitBeforeAck?: ConsumerOptions['afterCommitBeforeAck'];
  afterPublishBeforeMark?: OutboxOptions['afterPublishBeforeMark'];
}

export class MessagingRuntime {
  readonly gateway: SqsGateway;
  readonly consumer: SqsConsumer;
  readonly publisher: OutboxPublisher;
  readonly pending: PendingReferenceWorker;
  private readonly signal = new AbortController();
  private tasks: Promise<void>[] = [];
  private started = false;
  private stopping: Promise<void> | undefined;
  private readonly interval: number;
  private readonly grace: number;

  constructor(db: Database, service: FinancialService, private readonly options: MessagingOptions = {}) {
    this.gateway = options.gateway ?? new SqsGateway();
    this.consumer = new SqsConsumer(this.gateway, service, {
      concurrency: options.consumerConcurrency,
      afterCommitBeforeAck: options.afterCommitBeforeAck,
    });
    this.publisher = new OutboxPublisher(db, this.gateway, {
      leaseMs: options.outboxLeaseMs,
      afterPublishBeforeMark: options.afterPublishBeforeMark,
    });
    this.pending = new PendingReferenceWorker(service);
    this.interval = options.pollIntervalMs ?? Number(process.env.WORKER_POLL_INTERVAL_MS ?? '250');
    this.grace = options.shutdownGraceMs ?? Number(process.env.SHUTDOWN_GRACE_MS ?? '25000');
    if (!Number.isSafeInteger(this.interval) || this.interval < 10 || this.interval > 60000
      || !Number.isSafeInteger(this.grace) || this.grace < 100 || this.grace > 300000) {
      throw new Error('Invalid worker scheduling configuration');
    }
  }

  start(): void {
    if (this.started || this.signal.signal.aborted) return;
    this.started = true;
    if (process.env.MESSAGING_ENABLED === 'false') return;
    if (this.options.consumerEnabled ?? process.env.SQS_CONSUMER_ENABLED !== 'false') {
      this.tasks.push(this.consumer.run(this.signal.signal));
    }
    if (this.options.outboxEnabled ?? process.env.OUTBOX_ENABLED !== 'false') {
      this.tasks.push(this.loop('outbox', () => this.publisher.publishBatch()));
    }
    if (this.options.pendingEnabled ?? process.env.PENDING_REFERENCE_ENABLED !== 'false') {
      this.tasks.push(this.loop('pending_reference', () => this.pending.tick()));
    }
  }

  stop(): Promise<void> {
    this.stopping ??= this.finish();
    return this.stopping;
  }

  private async finish(): Promise<void> {
    this.signal.abort(); // Interrupts long polling and schedules; in-flight commits keep running.
    const complete = Promise.allSettled(this.tasks);
    if (!await settleWithin(complete, this.grace)) {
      log('warn', 'messaging.shutdown_deadline', { code: 'IN_FLIGHT_WORK_RELEASED' });
      await Promise.allSettled([this.consumer.releaseInFlight(), this.publisher.releaseOwnedLeases()]);
    }
    this.gateway.close();
    await settleWithin(complete, 2000);
  }

  private async loop(worker: string, action: () => Promise<unknown>): Promise<void> {
    while (!this.signal.signal.aborted) {
      try { await action(); }
      catch {
        metrics.inc('retries_total', { worker });
        log('warn', 'messaging.worker_retry', { worker, code: 'WORKER_OPERATION_FAILED' });
      }
      await delay(this.interval, this.signal.signal);
    }
  }
}

import { copyDate, DomainError, requireDate } from "./errors";
import { type IntegrationEvent } from "./events";
import { immutableJson } from "./json";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  readonly payload: Readonly<Record<string, unknown>>;
  private readonly eventTime: Date;
  private nextTime?: Date;
  private publicationTime?: Date;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    private _attempts: number,
    nextAttemptAt?: Date,
    publishedAt?: Date,
  ) {
    this.payload = immutableJson(payload);
    this.eventTime = copyDate(occurredAt);
    this.nextTime = nextAttemptAt ? copyDate(nextAttemptAt) : undefined;
    this.publicationTime = publishedAt ? copyDate(publishedAt) : undefined;
  }

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, { ...event.toJSON() }, event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType, state.payload, state.occurredAt,
      state.attempts, state.nextAttemptAt, state.publishedAt);
  }

  get attempts(): number { return this._attempts; }
  get occurredAt(): Date { return copyDate(this.eventTime); }
  get nextAttemptAt(): Date | undefined { return this.nextTime ? copyDate(this.nextTime) : undefined; }
  get publishedAt(): Date | undefined { return this.publicationTime ? copyDate(this.publicationTime) : undefined; }
  isPending(): boolean { return this.publicationTime === undefined; }

  isDue(now: Date): boolean {
    requireDate(now, "now");
    return this.isPending() && (!this.nextTime || this.nextTime.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this.assertPending();
    requireDate(at, "at");
    this.publicationTime = copyDate(at);
    this.nextTime = undefined;
  }

  /** Durable 1s, 2s, 4s ... retries, capped at five minutes; no event is discarded. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    requireDate(now, "now");
    const attempts = this._attempts + 1;
    if (!Number.isSafeInteger(attempts)) throw new DomainError("INVALID_OUTBOX_STATE", "Retry count exceeds the safe integer range");
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts - 1, 20));
    this._attempts = attempts;
    this.nextTime = new Date(now.getTime() + delayMs);
  }

  private assertPending(): void {
    if (!this.isPending()) throw new DomainError("INVALID_OUTBOX_STATE", "Published outbox messages are terminal");
  }
}

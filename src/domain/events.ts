import { copyDate, requireDate, requireText } from "./errors";
import { immutableJson } from "./json";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Readonly<T>;
}

/** Every integration event has a concrete type/version and a durable event identity. */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  private readonly eventTime: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    requireText(props.eventId, "eventId");
    requireText(props.aggregateId, "aggregateId");
    requireText(props.correlationId, "correlationId");
    if (props.causationId !== undefined) requireText(props.causationId, "causationId");
    requireDate(props.occurredAt, "occurredAt");
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.eventTime = copyDate(props.occurredAt);
    this.data = immutableJson(props.data);
  }

  get occurredAt(): Date { return copyDate(this.eventTime); }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.eventTime.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export class WagerTransactionProcessed<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WagerTransactionProcessed<T> { return new WagerTransactionProcessed(props); }
}

export class WagerTransactionRejected<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WagerTransactionRejected<T> { return new WagerTransactionRejected(props); }
}

export class WagerTransactionPendingReference<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WagerTransactionPendingReference<T> { return new WagerTransactionPendingReference(props); }
}

export class WagerTransactionFailed<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WagerTransactionFailed<T> { return new WagerTransactionFailed(props); }
}

export class WalletBalanceChanged<T = Record<string, unknown>> extends IntegrationEvent<T> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(props: IntegrationEventProps<T>): WalletBalanceChanged<T> { return new WalletBalanceChanged(props); }
}

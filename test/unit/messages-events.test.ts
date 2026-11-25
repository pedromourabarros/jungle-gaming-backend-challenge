import { describe, expect, test } from "bun:test";
import {
  DomainError, InboxMessage, Money, OutboxMessage, WalletBalanceChanged,
  WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference,
  WagerTransactionFailed, type IntegrationEventProps,
} from "../../src/domain";

const at = new Date("2026-11-25T10:00:00.000Z");
const later = new Date("2026-11-25T10:00:10.000Z");
const eventProps = <T>(data: T): IntegrationEventProps<T> => ({ eventId: "event-1", aggregateId: "wallet-1", correlationId: "correlation-1", causationId: "message-1", occurredAt: at, data });
const event = () => WagerTransactionProcessed.create(eventProps({ transactionId: "tx-1", money: { amount: "25.00", currency: "BRL" } }));

function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected a domain error"); }
  catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(code); }
}

describe("Typed integration events", () => {
  test("each concrete event owns its stable eventType and version", () => {
    const cases = [
      [WagerTransactionProcessed.create(eventProps({})), "WagerTransactionProcessed"],
      [WagerTransactionRejected.create(eventProps({})), "WagerTransactionRejected"],
      [WagerTransactionPendingReference.create(eventProps({})), "WagerTransactionPendingReference"],
      [WalletBalanceChanged.create(eventProps({})), "WalletBalanceChanged"],
      [WagerTransactionFailed.create(eventProps({})), "WagerTransactionFailed"],
    ] as const;
    for (const [value, type] of cases) {
      expect(value.eventType).toBe(type);
      expect(value.version).toBe(1);
      expect(value.toJSON().eventType).toBe(type);
    }
  });

  test("serialized envelopes contain identity, tracing, ISO time and decimal strings", () => {
    expect(event().toJSON()).toEqual({
      eventId: "event-1", eventType: "WagerTransactionProcessed", aggregateId: "wallet-1",
      correlationId: "correlation-1", causationId: "message-1", occurredAt: "2026-11-25T10:00:00.000Z", version: 1,
      data: { transactionId: "tx-1", money: { amount: "25.00", currency: "BRL" } },
    });
    expect(JSON.parse(JSON.stringify(event()))).toEqual(event().toJSON());
  });

  test("caller data, nested arrays and dates cannot mutate a confirmed event", () => {
    const data = { wallet: { balance: { amount: "100.00", currency: "BRL" } }, tags: ["a"] };
    const inputDate = new Date(at.getTime());
    const value = WalletBalanceChanged.create({ ...eventProps(data), occurredAt: inputDate });
    data.wallet.balance.amount = "0.00";
    data.tags.push("b");
    inputDate.setUTCFullYear(1990);
    value.occurredAt.setUTCFullYear(1991);
    expect(value.data.wallet.balance.amount).toBe("100.00");
    expect(value.data.tags).toEqual(["a"]);
    expect(value.occurredAt).toEqual(at);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.data.wallet.balance)).toBe(true);
    expect(() => { value.data.wallet.balance.amount = "1.00"; }).toThrow();
    expect(() => { value.data.tags.push("c"); }).toThrow();
  });

  test("optional tracing and data fields follow stable JSON omission semantics", () => {
    const props = eventProps({ optional: undefined, nullable: null, flag: true, count: 1 });
    const value = WagerTransactionProcessed.create({ ...props, causationId: undefined });
    expect(value.toJSON()).not.toHaveProperty("causationId");
    expect(value.data).toMatchObject({ nullable: null, flag: true, count: 1 });
    expect(value.data).not.toHaveProperty("optional");
  });

  test.each([Money.from({ amount: "1.00", currency: "BRL" }), 1n, new Date(), Number.NaN, Number.POSITIVE_INFINITY, () => "no", [undefined]].map((unsupported) => ({ unsupported })))(
    "rejects non-JSON data rather than losing or changing it during serialization", ({ unsupported }) => {
      expectCode(() => WagerTransactionProcessed.create(eventProps({ unsupported })), "INVALID_EVENT_DATA");
    },
  );

  test("rejects circular data", () => {
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expectCode(() => WagerTransactionProcessed.create(eventProps(cyclic)), "INVALID_EVENT_DATA");
  });

  test("__proto__ is preserved as a data key without changing object prototypes", () => {
    const data = JSON.parse('{"__proto__":{"injected":true},"transactionId":"tx-1"}') as Record<string, unknown>;
    const value = WagerTransactionProcessed.create(eventProps(data));
    expect(Object.getPrototypeOf(value.data)).toBe(Object.prototype);
    expect(value.data["__proto__"]).toEqual({ injected: true });
    expect(({} as Record<string, unknown>)["injected"]).toBeUndefined();
  });

  test("invalid timestamps and empty identities are rejected", () => {
    expectCode(() => WagerTransactionProcessed.create({ ...eventProps({}), occurredAt: new Date("invalid") }), "INVALID_INPUT");
    expectCode(() => WagerTransactionProcessed.create({ ...eventProps({}), correlationId: "" }), "INVALID_INPUT");
  });
});

describe("Durable inbox state", () => {
  const receive = () => InboxMessage.receive({ messageId: "m1", consumerName: "wagering", payloadHash: "hash1", receivedAt: at });

  test("new receipt is unprocessed and exposes a business-payload hash comparison", () => {
    const value = receive();
    expect(value.isProcessed()).toBe(false);
    expect(value.matchesPayload("hash1")).toBe(true);
    expect(value.matchesPayload("different-payload")).toBe(false);
    expect(value.consumerName).toBe("wagering");
  });

  test("processing is terminal and rehydration preserves the original decision time", () => {
    const value = receive();
    value.markProcessed(later);
    expect(value.isProcessed()).toBe(true);
    expectCode(() => value.markProcessed(at), "INVALID_INBOX_STATE");
    const restored = InboxMessage.rehydrate({ messageId: value.messageId, consumerName: value.consumerName, payloadHash: value.payloadHash,
      receivedAt: value.receivedAt, processedAt: value.processedAt });
    expect(restored.isProcessed()).toBe(true);
    expect(restored.processedAt).toEqual(later);
    restored.processedAt?.setUTCFullYear(1990);
    restored.receivedAt.setUTCFullYear(1991);
    expect(restored.processedAt).toEqual(later);
    expect(restored.receivedAt).toEqual(at);
  });

  test("malformed identity cannot become an inbox receipt", () => {
    expectCode(() => InboxMessage.receive({ messageId: "", consumerName: "wagering", payloadHash: "hash", receivedAt: at }), "INVALID_INPUT");
    expectCode(() => InboxMessage.receive({ messageId: "m", consumerName: "", payloadHash: "hash", receivedAt: at }), "INVALID_INPUT");
  });
});

describe("Outbox durable delivery lifecycle", () => {
  test("enqueue preserves eventId and the complete immutable envelope", () => {
    const value = OutboxMessage.enqueue(event());
    expect(value.id).toBe("event-1");
    expect(value.payload).toEqual({ ...event().toJSON() });
    expect(value.aggregateId).toBe("wallet-1");
    expect(value.attempts).toBe(0);
    expect(value.isPending()).toBe(true);
    expect(value.isDue(at)).toBe(true);
    expect(Object.isFrozen(value.payload)).toBe(true);
  });

  test("exponential retries persist across rehydration and cap at five minutes", () => {
    let value = OutboxMessage.enqueue(event());
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000];
    for (const [index, delay] of delays.entries()) {
      value.scheduleRetry(at);
      expect(value.attempts).toBe(index + 1);
      expect(value.nextAttemptAt?.getTime()).toBe(at.getTime() + delay);
      expect(value.isDue(new Date(at.getTime() + delay - 1))).toBe(false);
      expect(value.isDue(new Date(at.getTime() + delay))).toBe(true);
      value = OutboxMessage.rehydrate({ id: value.id, aggregateId: value.aggregateId, eventType: value.eventType,
        payload: value.payload, occurredAt: value.occurredAt, attempts: value.attempts,
        nextAttemptAt: value.nextAttemptAt, publishedAt: value.publishedAt });
      expect(value.attempts).toBe(index + 1);
      expect(value.id).toBe("event-1");
    }
  });

  test("published events cannot retry or be republished by a state transition", () => {
    const value = OutboxMessage.enqueue(event());
    value.scheduleRetry(at);
    value.markPublished(later);
    expect(value.isPending()).toBe(false);
    expect(value.isDue(new Date("2099-01-01"))).toBe(false);
    expect(value.nextAttemptAt).toBeUndefined();
    expect(value.publishedAt).toEqual(later);
    expectCode(() => value.scheduleRetry(later), "INVALID_OUTBOX_STATE");
    expectCode(() => value.markPublished(at), "INVALID_OUTBOX_STATE");
    expect(value.attempts).toBe(1);
    expect(value.publishedAt).toEqual(later);
  });

  test("rehydrated payload and timestamps cannot mutate persisted facts through aliases", () => {
    const payload = { eventId: "e", data: { amount: "25.00" } };
    const nextAttemptAt = new Date(later.getTime());
    const value = OutboxMessage.rehydrate({ id: "e", aggregateId: "w", eventType: "WagerTransactionProcessed", payload,
      occurredAt: at, attempts: 2, nextAttemptAt });
    payload.data.amount = "0.00";
    nextAttemptAt.setUTCFullYear(1990);
    value.nextAttemptAt?.setUTCFullYear(1991);
    expect(value.payload).toEqual({ eventId: "e", data: { amount: "25.00" } });
    expect(value.nextAttemptAt).toEqual(later);
  });
});

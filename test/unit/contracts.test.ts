import { describe, expect, test } from "bun:test";
import { businessPayload, canonicalHash, canonicalJson, parseSubmission, parseWallet, type SubmitInput } from "../../src/application/contracts";
import { AppError } from "../../src/application/errors";
import { WagerTransactionKind } from "../../src/domain";

const payload = () => ({
  providerId: "provider-a", externalTransactionId: "operation-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987", gameId: "fortune-chimp", kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
});

describe("Canonical business-payload hashing and idempotency identity", () => {
  test("object-key order, including nested money keys, cannot change business identity", () => {
    const input = parseSubmission(payload(), "key-1");
    const reversed = Object.fromEntries(Object.entries(payload()).reverse());
    reversed.money = { currency: "BRL", amount: "25.00" };
    const equivalent = parseSubmission(reversed, "key-1");
    expect(canonicalHash(businessPayload(input))).toBe(canonicalHash(businessPayload(equivalent)));
    expect(canonicalHash(businessPayload(input))).toMatch(/^[a-f0-9]{64}$/);
  });

  test("canonical JSON sorts object keys recursively and retains array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [3, 2, 1] })).toBe('{"a":{"b":3,"y":2},"list":[3,2,1],"z":1}');
    expect(canonicalHash({ items: ["a", "b"] })).not.toBe(canonicalHash({ items: ["b", "a"] }));
    expect(canonicalHash({ present: "yes", optional: undefined })).toBe(canonicalHash({ present: "yes" }));
  });

  test("header key is the source of truth and stays outside the payload hash", () => {
    const input = parseSubmission({ ...payload(), idempotencyKey: "untrusted-body-key" }, "header-key");
    const otherKey = parseSubmission(payload(), "other-header-key");
    expect(input.idempotencyKey).toBe("header-key");
    expect(businessPayload(input)).not.toHaveProperty("idempotencyKey");
    expect(canonicalHash(businessPayload(input))).toBe(canonicalHash(businessPayload(otherKey)));
  });

  test.each([
    { providerId: "provider-b" },
    { externalTransactionId: "operation-124" },
    { playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2" },
    { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" },
    { roundId: "round-988" },
    { gameId: "another-game" },
    { kind: "WIN" },
    { money: { amount: "25.01", currency: "BRL" } },
    { money: { amount: "25.00", currency: "USD" } },
    { referenceExternalTransactionId: "original-operation" },
  ])("changing a business field changes the hash for conflict detection: %j", (change) => {
    const original = parseSubmission(payload(), "same-key");
    const changed = parseSubmission({ ...payload(), ...change }, "same-key");
    expect(canonicalHash(businessPayload(original))).not.toBe(canonicalHash(businessPayload(changed)));
  });

  test("canonical UUID normalization does not create false payload conflicts", () => {
    const original = parseSubmission(payload(), "same-key");
    const uppercase = parseSubmission({ ...payload(), walletId: payload().walletId.toUpperCase(), playerId: payload().playerId.toUpperCase() }, "same-key");
    expect(canonicalHash(businessPayload(original))).toBe(canonicalHash(businessPayload(uppercase)));
  });

  test("transport context is not part of the accepted business contract", () => {
    expect(() => parseSubmission({ ...payload(), correlationId: "request-1" }, "key")).toThrow(AppError);
    expect(() => parseSubmission({ ...payload(), receiptHandle: "secret" }, "key")).toThrow(AppError);
  });
});

describe("HTTP and SQS shared submission input validation", () => {
  test.each(["", " ", "two words", "line\nbreak", "x".repeat(257)])("rejects invalid/missing idempotency key %j", (key) => {
    expect(() => parseSubmission(payload(), key)).toThrow(AppError);
  });

  test("a parsed input preserves public kind and decimal MoneyProps", () => {
    const value: SubmitInput = parseSubmission(payload(), "provider-a:operation-123");
    expect(value.kind).toBe(WagerTransactionKind.Bet);
    expect(value.money).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test.each([
    { kind: "OPENING" }, { kind: "UNKNOWN" }, { providerId: "__system__" }, { providerId: "" },
    { walletId: "not-a-uuid" }, { playerId: "" }, { extra: "unaccepted" },
    { money: { amount: 25, currency: "BRL" } },
    { money: { amount: "25.000", currency: "BRL" } },
    { money: { amount: "25.00", currency: "JPY" } },
    { money: { amount: "25.00", currency: "BRL", precision: 2 } },
  ])("rejects malformed fields instead of silently coercing them: %j", (change) => {
    expect(() => parseSubmission({ ...payload(), ...change }, "key")).toThrow(AppError);
  });

  test("wallet contracts use the same exact Money representation", () => {
    const value = parseWallet({ playerId: payload().playerId, initialBalance: { amount: "0.00", currency: "EUR" } });
    expect(value.initialBalance.toJSON()).toEqual({ amount: "0.00", currency: "EUR" });
    expect(() => parseWallet({ playerId: payload().playerId, initialBalance: { amount: "-1.00", currency: "BRL" } })).toThrow(AppError);
    expect(() => parseWallet({ playerId: payload().playerId, initialBalance: { amount: "1", currency: "BRL" } })).toThrow(AppError);
  });
});

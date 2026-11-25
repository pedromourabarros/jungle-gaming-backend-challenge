import { describe, expect, test } from "bun:test";
import {
  DomainError, LedgerDirection, Money, WagerTransaction, WagerTransactionKind as K,
  WagerTransactionStatus as S, type CreateWagerTransactionProps, type WagerTransactionState,
} from "../../src/domain";

const at = new Date("2026-11-25T10:00:00.000Z");
const decided = new Date("2026-11-25T10:00:01.000Z");
const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const props = (extra: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: "tx-1", providerId: "provider-a", externalTransactionId: "external-1", idempotencyKey: "provider-a:external-1",
  payloadHash: "hash-a", walletId: "wallet-1", playerId: "player-1", roundId: "round-1", gameId: "game-1",
  kind: K.Bet, money: money("10.00"), createdAt: at, ...extra,
});
const create = (extra: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(extra));
const reference = (extra: Partial<WagerTransactionState> = {}) => WagerTransaction.rehydrate({
  ...props({ id: "reference-id", externalTransactionId: "original", idempotencyKey: "provider-a:original" }),
  status: S.Processed, processedAt: at, observedBalance: money("90.00"), ...extra,
});
const reversal = (extra: Partial<CreateWagerTransactionProps> = {}) => create({ kind: K.Refund, referenceExternalTransactionId: "original", ...extra });

function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected a domain error"); }
  catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(code); }
}

describe("WagerTransaction creation and financial directions", () => {
  test("a provider operation begins pending and retains exact business identity", () => {
    const tx = create();
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.providerId).toBe("provider-a");
    expect(tx.idempotencyKey).toBe("provider-a:external-1");
    expect(tx.matchesPayload("hash-a")).toBe(true);
    expect(tx.matchesPayload("hash-b")).toBe(false);
    expect(tx.observedBalance).toBeUndefined();
  });

  test.each([K.Refund, K.Rollback])("%s requires an external provider reference", (kind) => {
    expectCode(() => create({ kind }), "REFERENCE_REQUIRED");
    expect(create({ kind, referenceExternalTransactionId: "original" }).requiresReference()).toBe(true);
  });

  test("BET cannot provide a reference; OPENING is internal only", () => {
    expectCode(() => create({ referenceExternalTransactionId: "original" }), "REFERENCE_NOT_ALLOWED");
    expectCode(() => create({ kind: K.Opening }), "INTERNAL_TRANSACTION_KIND");
    const opening = WagerTransaction.opening(props());
    expect(opening.kind).toBe(K.Opening);
    opening.markProcessed(undefined, decided, money("10.00"));
    expect(opening.status).toBe(S.Processed);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("WIN may be independent, or carry a reference that must be resolved", () => {
    const independent = create({ kind: K.Win });
    expect(independent.requiresReference()).toBe(false);
    expect(independent.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    independent.markProcessed(undefined, decided, money("110.00"));
    const linked = create({ kind: K.Win, referenceExternalTransactionId: "original" });
    expectCode(() => linked.markProcessed(undefined, decided, money("110.00")), "REFERENCE_REQUIRED");
    linked.validateReference(reference());
    linked.markProcessed("reference-id", decided, money("110.00"));
    expect(linked.referenceTransactionId).toBe("reference-id");
  });

  test("LOSS accepts non-negative informational amounts and never has a ledger direction", () => {
    expectCode(() => create({ kind: K.Loss, money: money("1.00").negate() }), "INVALID_AMOUNT");
    const informational = create({ kind: K.Loss, money: money("25.00") });
    informational.markProcessed(undefined, decided, money("100.00"));
    expect(informational.affectsBalance()).toBe(false);
    expect(informational.money.toString()).toBe("25.00");
    expect(informational.observedBalance?.toString()).toBe("100.00");
    const loss = create({ kind: K.Loss, money: money("0.00") });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.requiresReference()).toBe(false);
    expectCode(() => loss.ledgerDirectionFor(), "NO_FINANCIAL_EFFECT");
    loss.markProcessed(undefined, decided, money("100.00"));
    expect(loss.status).toBe(S.Processed);
    expect(loss.observedBalance?.toString()).toBe("100.00");
  });

  test.each([K.Bet, K.Win, K.Refund, K.Rollback])("%s requires a positive amount", (kind) => {
    const ref = [K.Refund, K.Rollback].includes(kind) ? "original" : undefined;
    expectCode(() => create({ kind, referenceExternalTransactionId: ref, money: money("0.00") }), "INVALID_AMOUNT");
    expectCode(() => create({ kind, referenceExternalTransactionId: ref, money: money("1.00").negate() }), "INVALID_AMOUNT");
  });

  test("BET debits, REFUND credits, and ROLLBACK inverts each permitted target", () => {
    expect(create().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(reversal().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const rollback = reversal({ kind: K.Rollback });
    expect(rollback.ledgerDirectionFor(reference({ kind: K.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(reference({ kind: K.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(reference({ kind: K.Refund }))).toBe(LedgerDirection.Debit);
    expectCode(() => rollback.ledgerDirectionFor(), "REFERENCE_REQUIRED");
    expectCode(() => rollback.ledgerDirectionFor(reference({ kind: K.Loss })), "REFERENCE_INVALID_KIND");
    expectCode(() => rollback.ledgerDirectionFor(reference({ kind: K.Rollback })), "REFERENCE_INVALID_KIND");
  });

  test("unknown kinds and empty identities are rejected by the domain factory", () => {
    expectCode(() => create({ kind: "BOGUS" as K }), "INVALID_TRANSACTION_KIND");
    for (const field of ["id", "providerId", "externalTransactionId", "idempotencyKey", "payloadHash", "walletId", "playerId", "roundId", "gameId"] as const) {
      expectCode(() => create({ [field]: " " }), "INVALID_INPUT");
    }
  });
});

describe("Reference rules", () => {
  test("a full refund of a processed matching BET is valid", () => {
    expect(() => reversal().validateReference(reference())).not.toThrow();
  });

  test.each(["providerId", "playerId", "walletId", "roundId", "externalTransactionId"] as const)("rejects reference mismatch in %s", (field) => {
    expectCode(() => reversal().validateReference(reference({ [field]: "other" })), "REFERENCE_MISMATCH");
  });

  test("rejects a self-reference", () => {
    expectCode(() => reversal({ externalTransactionId: "original" }), "SELF_REFERENCE");
    expectCode(() => reversal().validateReference(reference({ id: "tx-1" })), "REFERENCE_MISMATCH");
  });

  test("rejects cross-currency and partial reversal references", () => {
    expectCode(() => reversal().validateReference(reference({ money: money("10.00", "USD") })), "CURRENCY_MISMATCH");
    expectCode(() => reversal({ money: money("5.00") }).validateReference(reference()), "REFERENCE_AMOUNT_MISMATCH");
  });

  test.each([S.Pending, S.PendingReference, S.Rejected, S.Failed])("a reference in %s is not reversible", (status) => {
    expectCode(() => reversal().validateReference(reference({ status })), "REFERENCE_NOT_PROCESSED");
  });

  test("REFUND only accepts BET; ROLLBACK accepts BET, WIN and REFUND", () => {
    expectCode(() => reversal().validateReference(reference({ kind: K.Win })), "REFERENCE_INVALID_KIND");
    for (const kind of [K.Bet, K.Win, K.Refund]) expect(() => reversal({ kind: K.Rollback }).validateReference(reference({ kind }))).not.toThrow();
    for (const kind of [K.Opening, K.Loss, K.Rollback]) expectCode(() => reversal({ kind: K.Rollback }).validateReference(reference({ kind })), "REFERENCE_INVALID_KIND");
  });

  test("WIN may differ from the BET amount; it still requires a processed BET when linked", () => {
    const win = create({ kind: K.Win, money: money("100.00"), referenceExternalTransactionId: "original" });
    expect(() => win.validateReference(reference())).not.toThrow();
    expectCode(() => win.validateReference(reference({ status: S.Rejected })), "REFERENCE_NOT_PROCESSED");
  });
});

describe("Persisted state machine and immutable terminal outcomes", () => {
  test("out-of-order reference becomes pending, can retry, then becomes processed", () => {
    const tx = reversal();
    tx.markPendingReference(money("100.00"));
    expect(tx.status).toBe(S.PendingReference);
    tx.markPendingReference(money("90.00"));
    expect(tx.isTerminal()).toBe(false);
    tx.validateReference(reference());
    tx.markProcessed("reference-id", decided, money("100.00"));
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe("reference-id");
    expect(tx.processedAt).toEqual(decided);
    expect(tx.observedBalance?.toString()).toBe("100.00");
  });

  test("pending reference exhaustion remains an audited terminal rejection", () => {
    const tx = reversal();
    tx.markPendingReference(money("100.00"));
    tx.reject("REFERENCE_NOT_FOUND", decided, money("100.00"));
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(tx.processedAt).toEqual(decided);
    expect(tx.observedBalance?.toString()).toBe("100.00");
  });

  test("currency rejection preserves the actual wallet balance currency", () => {
    const tx = create({ money: money("10.00", "USD") });
    tx.reject("CURRENCY_MISMATCH", decided, money("100.00", "BRL"));
    expect(tx.observedBalance?.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
  });

  test.each([S.Processed, S.Rejected, S.Failed])("%s forbids all transitions, including reapplying the same outcome", (status) => {
    const tx = WagerTransaction.rehydrate({ ...props({ kind: K.Refund, referenceExternalTransactionId: "original" }), status,
      referenceTransactionId: status === S.Processed ? "reference-id" : undefined,
      failureCode: status === S.Processed ? undefined : "ORIGINAL_FAILURE", processedAt: decided, observedBalance: money("12.34"),
    });
    for (const action of [
      () => tx.markProcessed("reference-id", decided, money("999.00")),
      () => tx.markPendingReference(money("999.00")),
      () => tx.reject("NEW_FAILURE", decided, money("999.00")),
      () => tx.fail("NEW_FAILURE", decided, money("999.00")),
    ]) expectCode(action, "INVALID_TRANSACTION_STATE");
    expect(tx.status).toBe(status);
    expect(tx.observedBalance?.toString()).toBe("12.34");
  });

  test("permanent failure has a stable code, decision timestamp and observed balance", () => {
    const tx = create();
    tx.fail("INFRASTRUCTURE_PERMANENT", decided, money("100.00"));
    expect(tx.status).toBe(S.Failed);
    expect(tx.failureCode).toBe("INFRASTRUCTURE_PERMANENT");
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toEqual(decided);
  });

  test("invalid transition arguments do not alter pending state", () => {
    const tx = create();
    expectCode(() => tx.markPendingReference(money("100.00")), "REFERENCE_REQUIRED");
    expectCode(() => tx.markProcessed("unexpected-ref", decided, money("90.00")), "REFERENCE_MISMATCH");
    expectCode(() => tx.markProcessed(undefined, decided, money("90.00", "USD")), "CURRENCY_MISMATCH");
    expectCode(() => tx.markProcessed(undefined, decided, money("1.00").negate()), "INVALID_BALANCE");
    expectCode(() => tx.reject("", decided, money("90.00")), "INVALID_INPUT");
    expect(tx.status).toBe(S.Pending);
    expect(tx.observedBalance).toBeUndefined();
  });

  test("rehydration preserves a historical terminal result without replaying transitions", () => {
    const tx = WagerTransaction.rehydrate({ ...props(), status: S.Processed, processedAt: decided, observedBalance: money("90.00") });
    expect(tx.status).toBe(S.Processed);
    expect(tx.observedBalance?.toString()).toBe("90.00");
    tx.processedAt?.setUTCFullYear(1990);
    tx.createdAt.setUTCFullYear(1991);
    expect(tx.processedAt).toEqual(decided);
    expect(tx.createdAt).toEqual(at);
  });
});

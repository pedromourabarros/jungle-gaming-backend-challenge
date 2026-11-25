import { describe, expect, test } from "bun:test";
import { DomainError, LedgerDirection, Money, MONEY_MAX_AMOUNT, Wallet, WalletLedgerEntry, type LedgerEntryState, type WalletMovement } from "../../src/domain";

const at = new Date("2026-11-25T10:00:00.000Z");
const next = new Date("2026-11-25T10:00:01.000Z");
const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const wallet = (amount = "100.00") => Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: money(amount), at });
const move = (amount: string, extra: Partial<WalletMovement> = {}): WalletMovement => ({ entryId: "entry-1", transactionId: "tx-1", money: money(amount), at: next, ...extra });
function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected a domain error"); }
  catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(code); }
}

describe("Wallet aggregate and corresponding immutable ledger facts", () => {
  test("opening initializes version 1, including a zero wallet", () => {
    expect(wallet().version).toBe(1);
    expect(wallet().balance.toString()).toBe("100.00");
    expect(wallet("0.00").balance.isZero()).toBe(true);
    expect(wallet("0.00").version).toBe(1);
  });

  test("negative opening is rejected even if passed as an internal Money result", () => {
    expectCode(() => Wallet.open({ id: "w", playerId: "p", initialBalance: money("1.00").negate(), at }), "INVALID_INITIAL_BALANCE");
  });

  test("debit creates the exact matching ledger entry and increments version once", () => {
    const w = wallet();
    const entry = w.debit(move("80.00"));
    expect(w.balance.toString()).toBe("20.00");
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(next);
    expect(entry.walletId).toBe(w.id);
    expect(entry.transactionId).toBe("tx-1");
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe("100.00");
    expect(entry.balanceAfter.toString()).toBe("20.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test("a second 80.00 debit is rejected without changing the 20.00 balance or version", () => {
    const w = wallet();
    w.debit(move("80.00"));
    expectCode(() => w.debit(move("80.00", { entryId: "entry-2", transactionId: "tx-2" })), "INSUFFICIENT_FUNDS");
    expect(w.balance.toString()).toBe("20.00");
    expect(w.version).toBe(2);
    expect(w.updatedAt).toEqual(next);
  });

  test("reversal overdraft has a distinct failure code and leaves the wallet untouched", () => {
    const w = wallet("10.00");
    expectCode(() => w.debit(move("10.01", { insufficientFundsCode: "REVERSAL_INSUFFICIENT_FUNDS" })), "REVERSAL_INSUFFICIENT_FUNDS");
    expect(w.balance.toString()).toBe("10.00");
    expect(w.version).toBe(1);
  });

  test("full debit to zero is valid; subsequent credit creates a continuous ledger chain", () => {
    const w = wallet();
    const debit = w.debit(move("100.00"));
    const credit = w.credit(move("25.00", { entryId: "entry-2", transactionId: "tx-2" }));
    expect(debit.balanceAfter.equals(credit.balanceBefore)).toBe(true);
    expect(credit.direction).toBe(LedgerDirection.Credit);
    expect(credit.walletVersion).toBe(3);
    expect(w.balance.toString()).toBe("25.00");
    expect(w.version).toBe(3);
  });

  test.each(["debit", "credit"] as const)("%s rejects wrong currency and zero, without mutating the wallet", (method) => {
    const w = wallet();
    expectCode(() => w[method](move("1.00", { money: money("1.00", "USD") })), "CURRENCY_MISMATCH");
    expectCode(() => w[method](move("0.00")), "INVALID_AMOUNT");
    expect(w.balance.toString()).toBe("100.00");
    expect(w.version).toBe(1);
  });

  test("overflow or invalid ledger identity cannot partially mutate the aggregate", () => {
    const w = wallet(MONEY_MAX_AMOUNT);
    expectCode(() => w.credit(move("0.01")), "BALANCE_LIMIT_EXCEEDED");
    expectCode(() => w.debit(move("0.01", { entryId: "" })), "INVALID_INPUT");
    expect(w.balance.toString()).toBe(MONEY_MAX_AMOUNT);
    expect(w.version).toBe(1);
  });

  test("dates passed into and read from the aggregate are defensive copies", () => {
    const date = new Date(at);
    const w = Wallet.open({ id: "w", playerId: "p", initialBalance: money("1.00"), at: date });
    date.setUTCFullYear(1990);
    w.createdAt.setUTCFullYear(1991);
    w.updatedAt.setUTCFullYear(1992);
    expect(w.createdAt).toEqual(at);
    expect(w.updatedAt).toEqual(at);
  });

  test("rehydration preserves existing version and does not replay an opening movement", () => {
    const w = Wallet.rehydrate({ id: "w", playerId: "p", currency: "BRL", balance: money("87.50"), version: 42, createdAt: at, updatedAt: next });
    expect(w.version).toBe(42);
    expect(w.balance.toString()).toBe("87.50");
    expect(w.createdAt).toEqual(at);
    expect(w.credit(move("0.50")).walletVersion).toBe(43);
  });
});

const ledgerState = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
  id: "l", walletId: "w", transactionId: "t", direction: LedgerDirection.Credit,
  money: money("100.00"), balanceBefore: money("0.00"), balanceAfter: money("100.00"), walletVersion: 1, createdAt: at,
  ...overrides,
});

describe("WalletLedgerEntry factories and structural immutability", () => {
  test("opening ledger is CREDIT from zero with wallet version 1", () => {
    const entry = WalletLedgerEntry.create(ledgerState());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletVersion).toBe(1);
  });

  test.each([
    { balanceAfter: money("99.99") },
    { direction: LedgerDirection.Debit },
    { money: money("100.00", "USD") },
    { direction: "OTHER" as LedgerDirection },
  ])("rejects inconsistent arithmetic, direction or currency %j", (extra) => {
    expectCode(() => WalletLedgerEntry.create(ledgerState(extra)), "UNBALANCED_LEDGER_ENTRY");
  });

  test.each([
    { money: money("0.00") },
    { money: money("1.00").negate() },
    { balanceBefore: money("1.00").negate() },
    { balanceAfter: money("1.00").negate() },
    { walletVersion: 0 },
    { walletVersion: 1.5 },
  ])("rejects invalid ledger state %j", (extra) => {
    expectCode(() => WalletLedgerEntry.create(ledgerState(extra)), "INVALID_LEDGER_ENTRY");
  });

  test("the entry cannot be reassigned or changed through a Date alias", () => {
    const date = new Date(at);
    const entry = WalletLedgerEntry.create(ledgerState({ createdAt: date }));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => { (entry as unknown as { direction: string }).direction = "DEBIT"; }).toThrow();
    date.setUTCFullYear(1990);
    entry.createdAt.setUTCFullYear(1991);
    expect(entry.createdAt).toEqual(at);
  });

  test("rehydration reconstructs state without replaying creation validation", () => {
    // An intentionally corrupt row is reconstructible so a reconciliation/audit can inspect it.
    const entry = WalletLedgerEntry.rehydrate(ledgerState({ balanceAfter: money("99.00") }));
    expect(entry.balanceAfter.toString()).toBe("99.00");
    expect(entry.isBalanced()).toBe(false);
  });
});

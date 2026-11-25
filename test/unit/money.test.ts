import { describe, expect, test } from "bun:test";
import { DomainError, Money, MONEY_MAX_AMOUNT, SUPPORTED_CURRENCIES, type MoneyProps } from "../../src/domain";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected a domain error"); }
  catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(code); }
}

describe("Money: exact fixed-scale decimal contract", () => {
  test.each([...SUPPORTED_CURRENCIES])("round-trips supported currency %s", (currency) => {
    const value = Money.from({ amount: "25.00", currency });
    expect(value.toJSON()).toEqual({ amount: "25.00", currency });
    expect(value.toString()).toBe("25.00");
    expect(JSON.stringify(value)).toBe(`{"amount":"25.00","currency":"${currency}"}`);
  });

  test("0.10 + 0.20 is exactly 0.30, without binary floating-point rounding", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
    expect(brl("0.30").subtract(brl("0.10")).toString()).toBe("0.20");
  });

  test("amounts beyond Number.MAX_SAFE_INTEGER retain every cent", () => {
    const large = brl("9007199254740993.99");
    expect(large.add(brl("0.01")).toString()).toBe("9007199254740994.00");
    expect(large.subtract(brl("9007199254740993.00")).toString()).toBe("0.99");
  });

  test.each(["", " ", "1", "1.0", "1.", ".00", ".50", "01.00", "00.00", "-1.00", "-0.00", "+1.00", "1e3", "1E+3", "NaN", "Infinity", "-Infinity", "1.001", "1.005", "1.999", "1,00", "1_000.00", " 1.00", "1.00 ", "0x10", "１.００", "1.00\n"])(
    "rejects invalid public amount %j instead of rounding/coercing", (amount) => {
      expectCode(() => brl(amount), "INVALID_AMOUNT");
    },
  );

  test.each([1, 0, null, undefined, true, {}, []].map((amount) => ({ amount })))("rejects non-string public amount %j", ({ amount }) => {
    expectCode(() => Money.from({ amount, currency: "BRL" } as MoneyProps), "INVALID_AMOUNT");
  });

  test.each([null, undefined, [], "25.00"].map((value) => ({ value })))("rejects invalid money container %j", ({ value }) => {
    expectCode(() => Money.from(value as unknown as MoneyProps), "INVALID_MONEY");
  });

  test.each(["", "brl", "BR", "BRLX", "JPY", "ZZZ", " BRL", "BRL "])("rejects unsupported currency %j", (currency) => {
    expectCode(() => Money.from({ amount: "1.00", currency }), "UNSUPPORTED_CURRENCY");
    expectCode(() => Money.zero(currency), "UNSUPPORTED_CURRENCY");
  });

  test("accepts numeric(28,2) maximum and rejects one cent beyond it", () => {
    const max = brl(MONEY_MAX_AMOUNT);
    expect(max.toString()).toBe(MONEY_MAX_AMOUNT);
    expectCode(() => max.add(brl("0.01")), "BALANCE_LIMIT_EXCEEDED");
    expectCode(() => brl("100000000000000000000000000.00"), "BALANCE_LIMIT_EXCEEDED");
    expectCode(() => brl(`${"9".repeat(1000)}.00`), "BALANCE_LIMIT_EXCEEDED");
    expectCode(() => max.negate().subtract(brl("0.01")), "BALANCE_LIMIT_EXCEEDED");
  });

  test("negative internal results serialize correctly and are not public inputs", () => {
    const negative = brl("3.00").subtract(brl("5.25"));
    expect(negative.toJSON()).toEqual({ amount: "-2.25", currency: "BRL" });
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(negative.negate().toString()).toBe("2.25");
    expect(Money.rehydrate("-2.25", "BRL").equals(negative)).toBe(true);
    expect(Money.rehydrate("-0.00", "BRL").toString()).toBe("0.00");
  });

  test("zero and comparisons preserve exact cent boundaries", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(Money.zero("BRL").negate().toString()).toBe("0.00");
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("99999999999999999999.99").isLessThan(brl("100000000000000000000.00"))).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.00"))).toBe(false);
  });

  test("currency mismatches fail arithmetic/comparison and equality remains false", () => {
    const a = brl("1.00");
    const b = Money.from({ amount: "1.00", currency: "USD" });
    for (const op of [() => a.add(b), () => a.subtract(b), () => a.isLessThan(b)]) expectCode(op, "CURRENCY_MISMATCH");
    expect(a.equals(b)).toBe(false);
  });

  test("operations and serialization cannot mutate the source value", () => {
    const original = brl("12.34");
    const result = original.add(brl("0.66"));
    const json = original.toJSON();
    json.amount = "999.00";
    expect(result).not.toBe(original);
    expect(original.toString()).toBe("12.34");
    expect(result.toString()).toBe("13.00");
    expect(Object.isFrozen(original)).toBe(true);
    expect(() => { (original as unknown as { currency: string }).currency = "USD"; }).toThrow();
  });

  test("a deterministic sequence of credits and reversals returns exactly to the start", () => {
    const opening = brl("12345678901234567890.12");
    const values = ["0.01", "0.99", "17.25", "999999999.99", "0.10", "0.20"].map(brl);
    let running = opening;
    for (const value of values) running = running.add(value);
    for (const value of [...values].reverse()) running = running.subtract(value);
    expect(running.equals(opening)).toBe(true);
  });
});

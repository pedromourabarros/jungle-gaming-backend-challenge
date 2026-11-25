import { DomainError } from "./errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

/** All supported currencies use the challenge's fixed two-decimal scale. */
export const SUPPORTED_CURRENCIES = Object.freeze(["BRL", "USD", "EUR", "GBP"] as const);
export const MONEY_MAX_AMOUNT = "99999999999999999999999999.99";
const MAX_MINOR = 10n ** 28n - 1n;
const FACTOR = 100n;
const DECIMAL = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;

/** Exact, immutable fixed-scale value object. No monetary value is converted to number. */
export class Money {
  private constructor(private readonly minor: bigint, public readonly currency: string) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (!props || typeof props !== "object" || Array.isArray(props)) {
      throw new DomainError("INVALID_MONEY", "Money must be an object with amount and currency");
    }
    return Money.parse(props.amount, props.currency, false);
  }

  /** Signed amounts are only accepted when reconstructing internal/persisted state. */
  static rehydrate(amount: string, currency: string): Money {
    return Money.parse(amount, currency, true);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean { return this.minor === 0n; }
  isPositive(): boolean { return this.minor > 0n; }
  isNegative(): boolean { return this.minor < 0n; }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const absolute = this.minor < 0n ? -this.minor : this.minor;
    const fraction = (absolute % FACTOR).toString().padStart(2, "0");
    return `${this.minor < 0n ? "-" : ""}${absolute / FACTOR}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError("CURRENCY_MISMATCH", "Money operations require the same currency");
    }
  }

  private static assertCurrency(currency: string): void {
    if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
      throw new DomainError("UNSUPPORTED_CURRENCY", "Currency must be BRL, USD, EUR or GBP");
    }
  }

  private static parse(amount: string, currency: string, signed: boolean): Money {
    Money.assertCurrency(currency);
    if (typeof amount !== "string") {
      throw new DomainError("INVALID_AMOUNT", "Amount must be a decimal string with exactly two fractional digits");
    }
    const negative = signed && amount.startsWith("-");
    const absolute = negative ? amount.slice(1) : amount;
    if (!DECIMAL.test(absolute)) {
      throw new DomainError("INVALID_AMOUNT", "Amount must be a canonical decimal string with exactly two fractional digits");
    }
    // Reject overlong input before allocating a potentially enormous bigint.
    if (absolute.length > MONEY_MAX_AMOUNT.length) {
      throw new DomainError("BALANCE_LIMIT_EXCEEDED", "Amount exceeds numeric(28,2) capacity");
    }
    const minor = BigInt(absolute.replace(".", ""));
    return Money.checked(negative ? -minor : minor, currency);
  }

  private static checked(minor: bigint, currency: string): Money {
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new DomainError("BALANCE_LIMIT_EXCEEDED", "Amount exceeds numeric(28,2) capacity");
    }
    return new Money(minor, currency);
  }
}

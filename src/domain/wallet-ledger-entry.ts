import { copyDate, DomainError, requireDate, requireText } from "./errors";
import { Money } from "./money";

export enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/** An append-only financial fact. Its amount, balances, identity and date cannot be mutated. */
export class WalletLedgerEntry {
  private readonly date: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    createdAt: Date,
  ) {
    this.date = copyDate(createdAt);
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    requireText(props.id, "id");
    requireText(props.walletId, "walletId");
    requireText(props.transactionId, "transactionId");
    requireDate(props.createdAt, "createdAt");
    if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new DomainError("INVALID_LEDGER_ENTRY", "walletVersion must be a positive safe integer");
    }
    if (!props.money.isPositive() || props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError("INVALID_LEDGER_ENTRY", "Ledger requires a positive amount and non-negative balances");
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new DomainError("UNBALANCED_LEDGER_ENTRY", "Ledger arithmetic, direction and currency must agree");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id, state.walletId, state.transactionId, state.direction, state.money,
      state.balanceBefore, state.balanceAfter, state.walletVersion, state.createdAt,
    );
  }

  get createdAt(): Date { return copyDate(this.date); }

  isBalanced(): boolean {
    if (this.money.currency !== this.balanceBefore.currency || this.money.currency !== this.balanceAfter.currency) return false;
    try {
      if (this.direction === LedgerDirection.Debit) return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
      if (this.direction === LedgerDirection.Credit) return this.balanceBefore.add(this.money).equals(this.balanceAfter);
      return false;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }
}

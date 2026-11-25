import { copyDate, DomainError, requireDate, requireText } from "./errors";
import { Money } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
  insufficientFundsCode?: string;
}

export class Wallet {
  private readonly creationTime: Date;
  private updateTime: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.creationTime = copyDate(createdAt);
    this.updateTime = copyDate(updatedAt);
  }

  static open(props: OpenWalletProps): Wallet {
    requireText(props.id, "id");
    requireText(props.playerId, "playerId");
    requireDate(props.at, "at");
    if (props.initialBalance.isNegative()) {
      throw new DomainError("INVALID_INITIAL_BALANCE", "Initial balance cannot be negative");
    }
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, props.at, props.at);
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get createdAt(): Date { return copyDate(this.creationTime); }
  get updatedAt(): Date { return copyDate(this.updateTime); }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.validateMovement(movement);
    if (this._balance.isLessThan(movement.money)) {
      throw new DomainError(movement.insufficientFundsCode ?? "INSUFFICIENT_FUNDS", "Debit would produce a negative wallet balance");
    }
    return this.apply(LedgerDirection.Debit, movement, this._balance.subtract(movement.money));
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.validateMovement(movement);
    return this.apply(LedgerDirection.Credit, movement, this._balance.add(movement.money));
  }

  private validateMovement(movement: WalletMovement): void {
    if (movement.money.currency !== this.currency) {
      throw new DomainError("CURRENCY_MISMATCH", "Transaction currency must match the wallet currency");
    }
    if (!movement.money.isPositive()) {
      throw new DomainError("INVALID_AMOUNT", "Financial movements require a positive amount");
    }
    requireDate(movement.at, "at");
  }

  private apply(direction: LedgerDirection, movement: WalletMovement, balanceAfter: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    // Construct and validate the matching fact before mutating aggregate state.
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this.updateTime = copyDate(movement.at);
    return entry;
  }
}

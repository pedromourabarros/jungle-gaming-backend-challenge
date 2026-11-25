import { copyDate, DomainError, type FailureCode, requireDate, requireText } from "./errors";
import { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
}

export type OpeningTransactionProps = Omit<CreateWagerTransactionProps, "kind" | "referenceExternalTransactionId">;

export class WagerTransaction {
  private readonly creationTime: Date;
  private processingTime?: Date;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    processedAt?: Date,
    private _observedBalance?: Money,
  ) {
    this.creationTime = copyDate(createdAt);
    this.processingTime = processedAt ? copyDate(processedAt) : undefined;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError("INTERNAL_TRANSACTION_KIND", "OPENING cannot be submitted by a provider");
    }
    WagerTransaction.validate(props);
    return WagerTransaction.rehydrate({ ...props, status: WagerTransactionStatus.Pending });
  }

  /** Internal factory; the application records its ledger and outbox in the opening SQL transaction. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    const internal = { ...props, kind: WagerTransactionKind.Opening };
    WagerTransaction.validate(internal);
    return WagerTransaction.rehydrate({ ...internal, status: WagerTransactionStatus.Pending });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey,
      state.payloadHash, state.walletId, state.playerId, state.roundId, state.gameId,
      state.kind, state.money, state.referenceExternalTransactionId, state.createdAt,
      state.status, state.referenceTransactionId, state.failureCode, state.processedAt,
      state.observedBalance,
    );
  }

  get createdAt(): Date { return copyDate(this.creationTime); }
  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this.processingTime ? copyDate(this.processingTime) : undefined; }
  get observedBalance(): Money | undefined { return this._observedBalance; }

  markProcessed(referenceTransactionId: string | undefined, at: Date, balance: Money): void {
    this.assertMutable();
    requireDate(at, "at");
    if (this.referenceExternalTransactionId && !referenceTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", "A supplied external reference must be resolved before processing");
    }
    if (!this.referenceExternalTransactionId && referenceTransactionId) {
      throw new DomainError("REFERENCE_MISMATCH", "Cannot attach an internal reference absent from the accepted payload");
    }
    if (balance.currency !== this.money.currency) {
      throw new DomainError("CURRENCY_MISMATCH", "Processed balance must use the transaction currency");
    }
    this.assertBalance(balance);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this.processingTime = copyDate(at);
    this._observedBalance = balance;
  }

  markPendingReference(balance: Money): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", "Pending reference requires an external reference");
    }
    this.assertBalance(balance);
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = balance;
  }

  reject(code: FailureCode, at: Date, balance: Money): void {
    this.finishFailure(WagerTransactionStatus.Rejected, code, at, balance);
  }

  fail(code: FailureCode, at: Date, balance: Money): void {
    this.finishFailure(WagerTransactionStatus.Failed, code, at, balance);
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed
      || this._status === WagerTransactionStatus.Rejected
      || this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean { return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  /** Relational business rules; persistence resolves the external id and reversal uniqueness. */
  validateReference(reference: WagerTransaction): void {
    if (reference.providerId !== this.providerId || reference.playerId !== this.playerId
      || reference.walletId !== this.walletId || reference.roundId !== this.roundId
      || reference.externalTransactionId !== this.referenceExternalTransactionId
      || reference.id === this.id) {
      throw new DomainError("REFERENCE_MISMATCH", "Reference must belong to the same provider, player, wallet and round");
    }
    if (reference.money.currency !== this.money.currency) {
      throw new DomainError("CURRENCY_MISMATCH", "Reference currency must match the transaction currency");
    }
    const allowed: readonly WagerTransactionKind[] = this.kind === WagerTransactionKind.Rollback
      ? [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]
      : [WagerTransactionKind.Bet];
    if (!allowed.includes(reference.kind)) {
      throw new DomainError("REFERENCE_INVALID_KIND", "This operation cannot reference that transaction kind");
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new DomainError("REFERENCE_NOT_PROCESSED", "Reference must be processed before it can be used");
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new DomainError("REFERENCE_AMOUNT_MISMATCH", "Partial reversals are not supported");
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet: return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund: return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) throw new DomainError("REFERENCE_REQUIRED", "ROLLBACK needs a resolved reference");
        if (![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind)) {
          throw new DomainError("REFERENCE_INVALID_KIND", "ROLLBACK only reverses BET, WIN or REFUND");
        }
        return reference.kind === WagerTransactionKind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new DomainError("NO_FINANCIAL_EFFECT", "LOSS has no ledger direction");
    }
  }

  private assertMutable(): void {
    if (this.isTerminal()) {
      throw new DomainError("INVALID_TRANSACTION_STATE", `Transaction in ${this._status} is terminal`);
    }
  }

  private assertBalance(balance: Money): void {
    if (balance.isNegative()) throw new DomainError("INVALID_BALANCE", "Observed wallet balance cannot be negative");
  }

  private finishFailure(status: WagerTransactionStatus.Rejected | WagerTransactionStatus.Failed, code: FailureCode, at: Date, balance: Money): void {
    this.assertMutable();
    requireText(code, "failureCode");
    requireDate(at, "at");
    this.assertBalance(balance);
    this._status = status;
    this._failureCode = code;
    this.processingTime = copyDate(at);
    this._observedBalance = balance;
  }

  private static validate(props: CreateWagerTransactionProps): void {
    for (const field of ["id", "providerId", "externalTransactionId", "idempotencyKey", "payloadHash", "walletId", "playerId", "roundId", "gameId"] as const) {
      requireText(props[field], field);
    }
    requireDate(props.createdAt, "createdAt");
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new DomainError("INVALID_TRANSACTION_KIND", "Unknown transaction kind");
    }
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new DomainError("INVALID_AMOUNT", "LOSS requires a non-negative informational amount; financial operations require a positive amount");
    }
    if (props.referenceExternalTransactionId !== undefined) requireText(props.referenceExternalTransactionId, "referenceExternalTransactionId");
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new DomainError("SELF_REFERENCE", "A transaction cannot reference its own external identity");
    }
    if ([WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(props.kind) && !props.referenceExternalTransactionId) {
      throw new DomainError("REFERENCE_REQUIRED", "REFUND and ROLLBACK require a reference");
    }
    if ([WagerTransactionKind.Bet, WagerTransactionKind.Opening].includes(props.kind) && props.referenceExternalTransactionId !== undefined) {
      throw new DomainError("REFERENCE_NOT_ALLOWED", "BET and OPENING cannot reference another transaction");
    }
  }
}

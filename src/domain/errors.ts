/** Stable machine-readable errors; transport adapters decide the HTTP/SQS mapping. */
export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export type FailureCode = string;

export function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_INPUT", `${field} must be a non-empty string`);
  }
}

export function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

export function requireDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INVALID_INPUT", `${field} must be a valid date`);
  }
}

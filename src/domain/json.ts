import { DomainError } from "./errors";

/** Copy before freezing, so callers cannot mutate persisted event facts through aliases. */
export function immutableJson<T>(input: T): Readonly<T> {
  const ancestors = new WeakSet<object>();
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") {
      throw new DomainError("INVALID_EVENT_DATA", "Event data must contain JSON values only");
    }
    if (ancestors.has(value)) throw new DomainError("INVALID_EVENT_DATA", "Event data cannot be circular");
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      result = Object.freeze(value.map(clone));
    } else {
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new DomainError("INVALID_EVENT_DATA", "Event data must contain plain JSON objects, not domain instances");
      }
      const object: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        // JSON omits optional object fields. Undefined array entries are rejected above.
        if (field !== undefined) Object.defineProperty(object, key, { value: clone(field), enumerable: true });
      }
      result = Object.freeze(object);
    }
    ancestors.delete(value);
    return result;
  };
  return clone(input) as Readonly<T>;
}

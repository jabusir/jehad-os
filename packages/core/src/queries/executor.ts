// Shared executor + row helpers for the M6A structured-query services
// (plan §13: the four §40 item-5 questions + the derived-stalled variant +
// the leverage query). Executor is the same structural subset of pg.Pool /
// @jehad/db SqlExecutor used by the other core services — @jehad/core stays
// free of runtime dependencies. All functions in this directory are
// READ-ONLY: they only ever issue SELECTs against canonical tables.

export interface QueryExecutor {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Throws on unparseable timestamps — a canonical row must never yield NaN. */
export function toIso(value: unknown, column: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`row has unparseable ${column}: ${String(value)}`);
  }
  return date.toISOString();
}

export function toIsoOrNull(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : toIso(value, column);
}

/** Validates a caller-supplied Date | string into a Date (TypeError otherwise). */
export function parseDateInput(value: Date | string, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  throw new TypeError(`${field} must be a valid date, got ${String(value)}`);
}

/** Stable composite key for a polymorphic (type, id) item reference. */
export function itemKey(type: string, id: string): string {
  return `${type}\u0000${id}`;
}

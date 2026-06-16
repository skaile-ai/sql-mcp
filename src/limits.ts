// src/limits.ts
/** Coerce a DB value into a JSON-safe value (spec §8 type handling). */
export function coerceValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Buffer.isBuffer(v)) return v.toString("base64");
  return v;
}

export function coerceRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = coerceValue(row[k]);
  return out;
}

export function byteSize(rows: unknown): number {
  return Buffer.byteLength(JSON.stringify(rows), "utf8");
}

export interface CappedRows {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/**
 * Clip rows to maxRows (flagging truncation) and enforce the byte cap.
 * Throws an Error whose message contains RESULT_TOO_LARGE when the (already
 * row-capped) page still exceeds maxResultBytes — callers map this to the code.
 */
export function capRows(
  rows: Record<string, unknown>[],
  maxRows: number,
  maxResultBytes: number,
): CappedRows {
  const truncated = rows.length > maxRows;
  const clipped = (truncated ? rows.slice(0, maxRows) : rows).map(coerceRow);
  if (byteSize(clipped) > maxResultBytes) {
    throw new Error("RESULT_TOO_LARGE: result exceeds max_result_bytes; narrow the query or columns");
  }
  return { rows: clipped, truncated };
}

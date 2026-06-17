// src/dialect/mssql-params.ts
import { TYPES } from "tedious";
// `TYPES` is a runtime value import, so `tedious` IS loaded when this module evaluates
// (it is a regular dependency). The dialect's Connection/Request are still constructed
// lazily inside defaultFactory. `DataType` is not re-exported from the package root, so we
// take it type-only from the deep path (erased at build, zero bundle impact).
import type { DataType as TediousType } from "tedious/lib/data-type.js";

/** Rewrite canonical `$1,$2` placeholders to tedious named placeholders `@p1,@p2`. */
export function rewriteToNamed(canonicalSql: string): string {
  return canonicalSql.replace(/\$(\d+)/g, (_m, n) => `@p${n}`);
}

/**
 * Pick a tedious TYPE for a JS value. tedious requires an explicit type per bound
 * parameter; we infer conservatively. `null` still needs a declared type (NVarChar).
 */
export function inferTdsType(v: unknown): TediousType {
  if (v === null || v === undefined) return TYPES.NVarChar;
  if (typeof v === "boolean") return TYPES.Bit;
  if (typeof v === "bigint") return TYPES.BigInt;
  if (typeof v === "number") {
    if (Number.isInteger(v)) {
      return v >= -2147483648 && v <= 2147483647 ? TYPES.Int : TYPES.BigInt;
    }
    return TYPES.Float;
  }
  if (v instanceof Date) return TYPES.DateTime2;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return TYPES.VarBinary;
  return TYPES.NVarChar; // strings + fallback
}

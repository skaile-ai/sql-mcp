// tests/limits.test.ts
import { describe, it, expect } from "vitest";
import { coerceValue, capRows, byteSize } from "../src/limits.js";

describe("coerceValue", () => {
  it("stringifies bigint, ISO-formats dates, base64s binary, nulls undefined", () => {
    expect(coerceValue(10n)).toBe("10");
    expect(coerceValue(new Date("2024-03-05T10:00:00.000Z"))).toBe("2024-03-05T10:00:00.000Z");
    expect(coerceValue(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(coerceValue(undefined)).toBeNull();
    expect(coerceValue("plain")).toBe("plain");
    expect(coerceValue(42)).toBe(42);
  });
});

describe("capRows", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));

  it("returns all rows when under the cap, not truncated", () => {
    const r = capRows(rows, 10, 1_000_000);
    expect(r.rows).toHaveLength(5);
    expect(r.truncated).toBe(false);
  });

  it("clips to maxRows and flags truncation", () => {
    const r = capRows(rows, 3, 1_000_000);
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("throws RESULT_TOO_LARGE when the page exceeds the byte cap", () => {
    expect(() => capRows(rows, 10, 1)).toThrow(/RESULT_TOO_LARGE/);
  });
});

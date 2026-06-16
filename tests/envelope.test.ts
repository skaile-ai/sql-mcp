// tests/envelope.test.ts
import { describe, it, expect } from "vitest";
import { ok, err } from "../src/envelope.js";

describe("envelope", () => {
  it("ok() builds a success envelope", () => {
    expect(ok("sql.query", { rows: [] })).toEqual({
      status: "success",
      tool_name: "sql.query",
      retriable: false,
      data: { rows: [] },
    });
  });

  it("ok() includes a warning when provided", () => {
    expect(ok("sql.query", { rows: [] }, "ROWS_TRUNCATED").warning).toBe("ROWS_TRUNCATED");
  });

  it("err() builds an error envelope without a data field", () => {
    const e = err("sql.query", "ACCESS_DENIED", "not allowed");
    expect(e).toEqual({
      status: "error",
      tool_name: "sql.query",
      code: "ACCESS_DENIED",
      error: "not allowed",
      retriable: false,
    });
  });
});

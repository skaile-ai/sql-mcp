import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";

describe("Dialect contract additions", () => {
  it("sqlite exposes empty classify hooks and no statement-timeout support", () => {
    const d = new SqliteDialect("readonly");
    expect(d.classifyHooks).toEqual({});
    expect(d.supportsStatementTimeout).toBe(false);
  });
});

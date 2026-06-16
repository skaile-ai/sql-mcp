// tests/tools/execute.test.ts
import { describe, it, expect } from "vitest";
import { handleExecute } from "../../src/tools/execute.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "dml",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};

function fakeDialect(over: Partial<Dialect> = {}): Dialect {
  return {
    name: "sqlite", paramStyle: "?", connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s.replace(/\$\d+/g, "?"), quoteIdent: (n) => `"${n}"`,
    query: async () => ({ columns: [], rows: [] }),
    execute: async () => ({ rowCount: 1 }),
    executeBatch: async () => [],
    listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
    ...over,
  };
}

describe("handleExecute", () => {
  it("runs a DML statement and returns rowCount", async () => {
    const env = await handleExecute(fakeDialect({ execute: async () => ({ rowCount: 4 }) }), config, {
      sql: "UPDATE t SET a = $1 WHERE id = $2", params: [1, 2],
    });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.rowCount).toBe(4);
  });

  it("rejects a SELECT with ACCESS_DENIED", async () => {
    const env = await handleExecute(fakeDialect(), config, { sql: "SELECT * FROM t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects DDL with ACCESS_DENIED", async () => {
    const env = await handleExecute(fakeDialect(), config, { sql: "DROP TABLE t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects multiple statements with ACCESS_DENIED", async () => {
    const env = await handleExecute(fakeDialect(), config, { sql: "UPDATE t SET a=1; DROP TABLE t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("scrubs a driver error message", async () => {
    const env = await handleExecute(
      fakeDialect({ execute: async () => { throw new Error("fail postgres://u:p@h/db"); } }),
      config, { sql: "DELETE FROM t" },
    );
    if (env.status !== "error") throw new Error("expected error");
    expect(env.error).not.toContain(":p@");
  });
});

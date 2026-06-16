// tests/tools/execute-ddl.test.ts
import { describe, it, expect } from "vitest";
import { handleExecuteDdl } from "../../src/tools/execute_ddl.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "full",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};
function fakeDialect(over: Partial<Dialect> = {}): Dialect {
  return {
    name: "sqlite", paramStyle: "?", classifyHooks: {}, supportsStatementTimeout: false,
    connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s,
    paginate: (sql, limit, offset) => `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS _page LIMIT ${limit} OFFSET ${offset}`,
    quoteIdent: (n) => `"${n}"`,
    query: async () => ({ columns: [], rows: [] }),
    execute: async () => ({ rowCount: 0 }), executeBatch: async () => [],
    listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
    ...over,
  };
}

describe("handleExecuteDdl", () => {
  it("runs a DDL statement", async () => {
    const env = await handleExecuteDdl(fakeDialect(), config, { sql: "CREATE TABLE t (id INTEGER)" });
    expect(env.status).toBe("success");
  });

  it("rejects DML with ACCESS_DENIED", async () => {
    const env = await handleExecuteDdl(fakeDialect(), config, { sql: "DELETE FROM t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects SELECT with ACCESS_DENIED", async () => {
    const env = await handleExecuteDdl(fakeDialect(), config, { sql: "SELECT 1" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects multi-statement DDL with ACCESS_DENIED", async () => {
    const env = await handleExecuteDdl(fakeDialect(), config, {
      sql: "CREATE TABLE t (id INTEGER); DROP TABLE t",
    });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });
});

// tests/tools/execute-batch.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleExecuteBatch } from "../../src/tools/execute_batch.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "dml",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};
function fakeDialect(over: Partial<Dialect> = {}): Dialect {
  return {
    name: "sqlite", paramStyle: "?", classifyHooks: {}, supportsStatementTimeout: false,
    connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s.replace(/\$\d+/g, "?"),
    paginate: (sql, limit, offset) => `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS _page LIMIT ${limit} OFFSET ${offset}`,
    quoteIdent: (n) => `"${n}"`,
    query: async () => ({ columns: [], rows: [] }),
    execute: async () => ({ rowCount: 0 }),
    executeBatch: async (stmts) => stmts.map(() => ({ rowCount: 1 })),
    listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
    ...over,
  };
}

describe("handleExecuteBatch", () => {
  it("runs an all-DML batch and returns a positional array", async () => {
    const env = await handleExecuteBatch(fakeDialect(), config, {
      statements: [{ sql: "INSERT INTO t VALUES ($1)", params: [1] }, { sql: "UPDATE t SET a=2" }],
    });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.results).toEqual([{ rowCount: 1 }, { rowCount: 1 }]);
  });

  it("rejects the WHOLE batch (nothing executes) if any statement is not DML", async () => {
    const executeBatch = vi.fn(async () => [] as Array<{ rowCount: number }>);
    const env = await handleExecuteBatch(fakeDialect({ executeBatch }), config, {
      statements: [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "DROP TABLE t" }],
    });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it("rejects an empty batch with VALIDATION_ERROR", async () => {
    const env = await handleExecuteBatch(fakeDialect(), config, { statements: [] });
    expect(env).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
  });

  it("rejects an oversized batch with VALIDATION_ERROR (nothing executes)", async () => {
    const executeBatch = vi.fn(async () => [] as Array<{ rowCount: number }>);
    const env = await handleExecuteBatch(fakeDialect({ executeBatch }), config, {
      statements: Array.from({ length: 101 }, () => ({ sql: "INSERT INTO t VALUES (1)" })),
    });
    expect(env).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it("returns an error envelope (rolled back) when the dialect throws", async () => {
    const env = await handleExecuteBatch(
      fakeDialect({ executeBatch: async () => { throw new Error("constraint at host postgres://u:p@h/db"); } }),
      config, { statements: [{ sql: "INSERT INTO t VALUES (1)" }] },
    );
    if (env.status !== "error") throw new Error("expected error");
    expect(env.code).toBe("TOOL_EXECUTION_ERROR");
    expect(env.error).not.toContain(":p@"); // scrubbed
  });
});

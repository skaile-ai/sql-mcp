// tests/tools/introspection.test.ts
import { describe, it, expect } from "vitest";
import { handleCapabilities } from "../../src/tools/capabilities.js";
import { handleListTables, handleDescribeTable } from "../../src/tools/introspection.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "readonly",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};

const dialect: Dialect = {
  name: "sqlite", paramStyle: "?",
  classifyHooks: {},
  supportsStatementTimeout: false,
  connect: async () => {}, close: async () => {},
  rewriteParams: (s) => s,
  paginate: (sql, limit, offset) => `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS _page LIMIT ${limit} OFFSET ${offset}`,
  quoteIdent: (n) => `"${n}"`,
  query: async () => ({ columns: [], rows: [] }),
  execute: async () => ({ rowCount: 0 }), executeBatch: async () => [],
  listSchemas: async () => ["main"],
  listTables: async () => [{ name: "users", type: "table", schema: "main" }],
  describeTable: async () => [{ name: "id", type: "INTEGER", nullable: false, default: null, primaryKey: true }],
};

describe("introspection + capabilities", () => {
  it("capabilities reports dialect, access scope, and limits", async () => {
    const env = await handleCapabilities(dialect, config);
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data).toMatchObject({
      dialect: "sqlite", access: "readonly",
      limits: { max_rows: 1000, max_result_bytes: 10_485_760, statement_timeout_ms: 30_000 },
    });
    expect(env.data.feature_flags.statement_timeout).toBe(false);
  });

  it("list_tables returns the dialect's tables", async () => {
    const env = await handleListTables(dialect, {});
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.tables[0]).toMatchObject({ name: "users", type: "table" });
  });

  it("describe_table returns ACCESS-safe columns", async () => {
    const env = await handleDescribeTable(dialect, { table: "users" });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.columns[0]).toMatchObject({ name: "id", primaryKey: true });
  });

  it("describe_table surfaces an invalid identifier as VALIDATION_ERROR", async () => {
    const bad: Dialect = { ...dialect, describeTable: async () => { throw new Error("invalid identifier: x"); } };
    const env = await handleDescribeTable(bad, { table: "x\"; DROP" });
    expect(env).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
  });
});

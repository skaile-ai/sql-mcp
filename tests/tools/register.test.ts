// tests/tools/register.test.ts
import { describe, it, expect } from "vitest";
import { registerReadTools, type ToolRegistrar } from "../../src/tools/register.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "readonly",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};
const dialect: Dialect = {
  name: "sqlite", paramStyle: "?", classifyHooks: {}, supportsStatementTimeout: false,
  connect: async () => {}, close: async () => {},
  rewriteParams: (s) => s,
  paginate: (sql, limit, offset) => `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS _page LIMIT ${limit} OFFSET ${offset}`,
  quoteIdent: (n) => `"${n}"`,
  query: async () => ({ columns: ["n"], rows: [{ n: 1 }] }),
  execute: async () => ({ rowCount: 0 }), executeBatch: async () => [],
  listSchemas: async () => ["main"], listTables: async () => [], describeTable: async () => [],
};

describe("registerReadTools", () => {
  it("registers the five read tools and they return JSON text content", async () => {
    const registered: Record<string, (args: any) => Promise<any>> = {};
    const fake: ToolRegistrar = {
      registerTool(name, _def, handler) { registered[name] = handler; },
    };
    registerReadTools(fake, dialect, config);

    expect(Object.keys(registered).sort()).toEqual(
      ["sql.capabilities", "sql.describe_table", "sql.list_schemas", "sql.list_tables", "sql.query"].sort(),
    );

    const res = await registered["sql.query"]!({ sql: "SELECT 1 AS n" });
    expect(res.content[0].type).toBe("text");
    const env = JSON.parse(res.content[0].text);
    expect(env.status).toBe("success");
    expect(env.data.rows).toEqual([{ n: 1 }]);
  });
});

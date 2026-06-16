// tests/tools/register-write.test.ts
import { describe, it, expect } from "vitest";
import { registerWriteTools, type ToolRegistrar } from "../../src/tools/register.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config, AccessScope } from "../../src/config.js";

const dialect: Dialect = {
  name: "sqlite", paramStyle: "?", connect: async () => {}, close: async () => {},
  rewriteParams: (s) => s, quoteIdent: (n) => `"${n}"`,
  query: async () => ({ columns: [], rows: [] }),
  execute: async () => ({ rowCount: 1 }), executeBatch: async () => [{ rowCount: 1 }],
  listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
};
function configFor(access: AccessScope): Config {
  return { dialect: "sqlite", dsn: ":memory:", access, maxRows: 1000, maxResultBytes: 1, statementTimeoutMs: 1, cursorSecret: "s" };
}
function registrarSpy() {
  const names: string[] = [];
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const reg: ToolRegistrar = { registerTool(name, _def, h) { names.push(name); handlers[name] = h; } };
  return { reg, names, handlers };
}

describe("registerWriteTools (scope-gated)", () => {
  it("registers nothing for a readonly instance", () => {
    const { reg, names } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("readonly"));
    expect(names).toEqual([]);
  });

  it("registers execute + execute_batch (not execute_ddl) for dml", () => {
    const { reg, names } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("dml"));
    expect(names.sort()).toEqual(["sql.execute", "sql.execute_batch"].sort());
  });

  it("registers all three write tools for full", () => {
    const { reg, names } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("full"));
    expect(names.sort()).toEqual(["sql.execute", "sql.execute_batch", "sql.execute_ddl"].sort());
  });

  it("registered sql.execute returns JSON envelope content", async () => {
    const { reg, handlers } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("dml"));
    const res = await handlers["sql.execute"]!({ sql: "UPDATE t SET a=1" });
    const env = JSON.parse(res.content[0].text);
    expect(env).toMatchObject({ status: "success", tool_name: "sql.execute", data: { rowCount: 1 } });
  });
});

import { describe, it, expect } from "vitest";
import { MssqlDialect, type MssqlExecutor, type MssqlExecutorFactory } from "../../src/dialect/mssql.js";

interface Call { sql: string; params: unknown[]; }
function fakeExecutor(rowsFor: (sql: string) => any[]): { exec: MssqlExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const exec: MssqlExecutor = {
    async run(sql, params) {
      calls.push({ sql, params });
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length };
    },
    async close() {},
  };
  return { exec, calls };
}
const factory = (exec: MssqlExecutor): MssqlExecutorFactory => () => exec;

describe("MssqlDialect", () => {
  it("paramStyle is @p and rewriteParams maps $n -> @pn", () => {
    const d = new MssqlDialect("readonly", factory(fakeExecutor(() => []).exec));
    expect(d.paramStyle).toBe("@p");
    expect(d.rewriteParams("SELECT $1, $2")).toBe("SELECT @p1, @p2");
  });

  it("classify hooks treat MERGE as DML; statement timeout supported", () => {
    const d = new MssqlDialect("dml", factory(fakeExecutor(() => []).exec));
    expect(d.classifyHooks.extraDml).toContain("merge");
    expect(d.supportsStatementTimeout).toBe(true);
  });

  it("query rolls back the read transaction (no READ ONLY modifier in MSSQL)", async () => {
    const { exec, calls } = fakeExecutor((sql) => (sql.includes("SELECT id") ? [{ id: 1 }] : []));
    const d = new MssqlDialect("readonly", factory(exec));
    await d.connect("mssql://sa:p@h/db");
    const r = await d.query("SELECT id FROM users", []);
    expect(r.columns).toEqual(["id"]);
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /BEGIN TRAN/i.test(s))).toBe(true);
    expect(sqls.some((s) => /ROLLBACK/i.test(s))).toBe(true);
  });

  it("quoteIdent bracket-quotes and rejects injection", () => {
    const d = new MssqlDialect("full", factory(fakeExecutor(() => []).exec));
    expect(d.quoteIdent("users")).toBe("[users]");
    expect(() => d.quoteIdent("a]b")).toThrow();
  });
});

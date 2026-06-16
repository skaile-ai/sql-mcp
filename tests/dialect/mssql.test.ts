import { describe, it, expect } from "vitest";
import { MssqlDialect, type MssqlExecutor, type MssqlExecutorFactory } from "../../src/dialect/mssql.js";

interface Call { sql: string; params: unknown[]; }
function fakeExecutor(rowsFor: (sql: string) => any[]): { exec: MssqlExecutor; calls: Call[]; tx: string[] } {
  const calls: Call[] = [];
  const tx: string[] = [];
  const exec: MssqlExecutor = {
    async run(sql, params) { calls.push({ sql, params }); const rows = rowsFor(sql); return { rows, rowCount: rows.length }; },
    async beginTransaction() { tx.push("begin"); },
    async commit() { tx.push("commit"); },
    async rollback() { tx.push("rollback"); },
    async close() {},
  };
  return { exec, calls, tx };
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

  it("query brackets the read in a transaction it always rolls back (no READ ONLY modifier in MSSQL)", async () => {
    const { exec, tx } = fakeExecutor((sql) =>
      sql.includes("DATABASEPROPERTYEX") ? [{ u: "READ_ONLY" }] : sql.includes("SELECT id") ? [{ id: 1 }] : [],
    );
    const d = new MssqlDialect("readonly", factory(exec));
    await d.connect("mssql://sa:p@h/db");
    const r = await d.query("SELECT id FROM users", []);
    expect(r.columns).toEqual(["id"]);
    expect(tx).toEqual(["begin", "rollback"]);
  });

  it("quoteIdent bracket-quotes and rejects injection", () => {
    const d = new MssqlDialect("full", factory(fakeExecutor(() => []).exec));
    expect(d.quoteIdent("users")).toBe("[users]");
    expect(() => d.quoteIdent("a]b")).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { MysqlDialect, type MysqlPool, type MysqlPoolFactory } from "../../src/dialect/mysql.js";

interface Call { sql: string; params: unknown[]; }
function fakePool(rowsFor: (sql: string) => any[]): { pool: MysqlPool; calls: Call[] } {
  const calls: Call[] = [];
  const run = (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    // mysql2 returns [rows, fields]; for non-SELECT it returns a ResultSetHeader.
    return [rowsFor(sql) as any, []] as [any, any];
  };
  const pool: MysqlPool = {
    // Transactions run on a pinned connection; the fake records its query()s into the same array.
    async getConnection() {
      return { query: async (s: string, p: unknown[] = []) => run(s, p), release() {} };
    },
    async query(sql: string, params: unknown[] = []) {
      return run(sql, params);
    },
    async end() {},
  };
  return { pool, calls };
}
const factory = (pool: MysqlPool): MysqlPoolFactory => () => pool;

describe("MysqlDialect", () => {
  it("paramStyle is ? and rewriteParams maps $n -> ?", () => {
    const d = new MysqlDialect("readonly", factory(fakePool(() => []).pool));
    expect(d.paramStyle).toBe("?");
    expect(d.rewriteParams("SELECT $1, $2")).toBe("SELECT ?, ?");
  });

  it("supports statement timeout and has no MERGE hook (MySQL lacks MERGE)", () => {
    const d = new MysqlDialect("dml", factory(fakePool(() => []).pool));
    expect(d.supportsStatementTimeout).toBe(true);
    expect(d.classifyHooks.extraDml ?? []).not.toContain("merge");
  });

  it("query wraps reads in START TRANSACTION READ ONLY and returns columns+rows", async () => {
    const { pool, calls } = fakePool((sql) => (sql.includes("SELECT id") ? [{ id: 1 }, { id: 2 }] : []));
    const d = new MysqlDialect("readonly", factory(pool));
    await d.connect("mysql://u:p@h/db");
    const r = await d.query("SELECT id FROM users", []);
    expect(r.columns).toEqual(["id"]);
    expect(r.rows).toHaveLength(2);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("START TRANSACTION READ ONLY");
    expect(sqls).toContain("COMMIT");
    const begin = sqls.indexOf("START TRANSACTION READ ONLY");
    const select = sqls.findIndex((s) => s.includes("SELECT id"));
    const commit = sqls.indexOf("COMMIT");
    expect(begin).toBeLessThan(select);
    expect(select).toBeLessThan(commit);
  });

  it("introspection reads run inside a START TRANSACTION READ ONLY bracket", async () => {
    const { pool, calls } = fakePool((sql) =>
      sql.includes("information_schema.tables")
        ? [{ table_schema: "appdb", table_name: "users", table_type: "BASE TABLE" }]
        : [],
    );
    const d = new MysqlDialect("readonly", factory(pool));
    await d.connect("mysql://u:p@h/db");
    const tables = await d.listTables();
    expect(tables).toHaveLength(1);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("START TRANSACTION READ ONLY");
    expect(sqls).toContain("COMMIT");
    const begin = sqls.indexOf("START TRANSACTION READ ONLY");
    const select = sqls.findIndex((s) => s.includes("information_schema.tables"));
    const commit = sqls.lastIndexOf("COMMIT");
    expect(begin).toBeLessThan(select);
    expect(select).toBeLessThan(commit);
  });

  it("quoteIdent backtick-quotes and rejects injection", () => {
    const d = new MysqlDialect("full", factory(fakePool(() => []).pool));
    expect(d.quoteIdent("users")).toBe("`users`");
    expect(() => d.quoteIdent("a`b")).toThrow();
  });
});

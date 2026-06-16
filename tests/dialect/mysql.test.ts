import { describe, it, expect } from "vitest";
import { MysqlDialect, type MysqlPool, type MysqlPoolFactory } from "../../src/dialect/mysql.js";

interface Call { sql: string; params: unknown[]; }
// rowsFor returns either a row array (SELECT) or a ResultSetHeader-like object ({ affectedRows }).
function fakePool(rowsFor: (sql: string) => any): { pool: MysqlPool; calls: Call[] } {
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

  it("execute returns affectedRows as rowCount via pool.query (auto-commit)", async () => {
    const { pool, calls } = fakePool((sql) =>
      sql.includes("UPDATE users") ? { affectedRows: 3 } : [],
    );
    const d = new MysqlDialect("dml", factory(pool));
    await d.connect("mysql://u:p@h/db");
    const r = await d.execute("UPDATE users SET name = ? WHERE id = ?", ["x", 1]);
    expect(r).toEqual({ rowCount: 3 });
    // No transaction bracket — auto-commit via pool.query().
    const sqls = calls.map((c) => c.sql);
    expect(sqls).not.toContain("START TRANSACTION");
    expect(sqls).toContain("UPDATE users SET name = ? WHERE id = ?");
  });

  it("executeBatch wraps statements in START TRANSACTION / COMMIT and returns aligned rowCounts", async () => {
    const { pool, calls } = fakePool((sql) => {
      if (sql.includes("INSERT")) return { affectedRows: 1 };
      if (sql.includes("UPDATE")) return { affectedRows: 2 };
      return [];
    });
    const d = new MysqlDialect("dml", factory(pool));
    await d.connect("mysql://u:p@h/db");
    const results = await d.executeBatch([
      { sql: "INSERT INTO t (a) VALUES (?)", params: [1] },
      { sql: "UPDATE t SET a = ?", params: [2] },
    ]);
    expect(results).toEqual([{ rowCount: 1 }, { rowCount: 2 }]);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("START TRANSACTION");
    expect(sqls).toContain("COMMIT");
    const begin = sqls.indexOf("START TRANSACTION");
    const commit = sqls.indexOf("COMMIT");
    const insert = sqls.findIndex((s) => s.includes("INSERT"));
    const update = sqls.findIndex((s) => s.includes("UPDATE"));
    expect(begin).toBeLessThan(insert);
    expect(insert).toBeLessThan(update);
    expect(update).toBeLessThan(commit);
  });

  it("quoteIdent backtick-quotes and rejects injection", () => {
    const d = new MysqlDialect("full", factory(fakePool(() => []).pool));
    expect(d.quoteIdent("users")).toBe("`users`");
    expect(() => d.quoteIdent("a`b")).toThrow();
  });
});

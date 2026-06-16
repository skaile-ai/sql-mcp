import { describe, it, expect } from "vitest";
import { PostgresDialect, type PgPool, type PgPoolFactory } from "../../src/dialect/postgres.js";

interface Call { sql: string; params: unknown[]; }

function fakePool(responses: Record<string, { rows: any[]; rowCount?: number }>): { pool: PgPool; calls: Call[] } {
  const calls: Call[] = [];
  const run = (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    // Silence the readonly-verification warning in unit runs by confirming the GUC.
    if (sql.includes("default_transaction_read_only")) {
      return { rows: [{ default_transaction_read_only: "on" }] };
    }
    // Match on a substring so the test can key off the meaningful statement.
    const key = Object.keys(responses).find((k) => sql.includes(k));
    return responses[key ?? ""] ?? { rows: [], rowCount: 0 };
  };
  const pool: PgPool = {
    // Transactions pin a single client; the fake records into the SAME calls array so
    // assertions see the BEGIN/COMMIT that now flow through the pinned client.
    async connect() {
      return {
        async query(sql: string, params: unknown[] = []) {
          return run(sql, params);
        },
        release() {},
      };
    },
    async query(sql: string, params: unknown[] = []) {
      return run(sql, params);
    },
    async end() {},
  };
  return { pool, calls };
}

const factory =
  (pool: PgPool): PgPoolFactory =>
  () =>
    pool;

describe("PostgresDialect", () => {
  it("paramStyle is $n and rewriteParams is identity", () => {
    const d = new PostgresDialect("readonly", factory(fakePool({}).pool));
    expect(d.paramStyle).toBe("$n");
    expect(d.rewriteParams("SELECT $1, $2")).toBe("SELECT $1, $2");
  });

  it("classify hooks treat MERGE as DML and statement timeout is supported", () => {
    const d = new PostgresDialect("dml", factory(fakePool({}).pool));
    expect(d.classifyHooks.extraDml).toContain("merge");
    expect(d.supportsStatementTimeout).toBe(true);
  });

  it("query wraps reads in a READ ONLY transaction and returns columns+rows", async () => {
    const { pool, calls } = fakePool({
      "SELECT id": { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }] },
    });
    const d = new PostgresDialect("readonly", factory(pool));
    await d.connect("postgresql://u:p@h/db");
    const r = await d.query("SELECT id, name FROM users", []);
    expect(r.columns).toEqual(["id", "name"]);
    expect(r.rows).toHaveLength(2);
    // The read must be bracketed by a READ ONLY transaction on the pinned client; with a
    // single connection the order is BEGIN → SELECT → COMMIT (no interleaved pool query).
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("BEGIN TRANSACTION READ ONLY");
    expect(sqls).toContain("COMMIT");
    const begin = sqls.indexOf("BEGIN TRANSACTION READ ONLY");
    const select = sqls.findIndex((s) => s.includes("SELECT id"));
    const commit = sqls.indexOf("COMMIT");
    expect(begin).toBeLessThan(select);
    expect(select).toBeLessThan(commit);
  });

  it("introspection reads run inside a READ ONLY transaction", async () => {
    const { pool, calls } = fakePool({
      "FROM information_schema.tables": { rows: [{ table_schema: "public", table_name: "users", table_type: "BASE TABLE" }] },
    });
    const d = new PostgresDialect("readonly", factory(pool));
    await d.connect("postgresql://u:p@h/db");
    const tables = await d.listTables();
    expect(tables).toHaveLength(1);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("BEGIN TRANSACTION READ ONLY");
    expect(sqls).toContain("COMMIT");
    const begin = sqls.indexOf("BEGIN TRANSACTION READ ONLY");
    const select = sqls.findIndex((s) => s.includes("FROM information_schema.tables"));
    const commit = sqls.lastIndexOf("COMMIT");
    expect(begin).toBeLessThan(select);
    expect(select).toBeLessThan(commit);
  });

  it("quoteIdent rejects injection and double-quotes valid names", () => {
    const d = new PostgresDialect("full", factory(fakePool({}).pool));
    expect(d.quoteIdent("users")).toBe('"users"');
    expect(() => d.quoteIdent('users"; DROP')).toThrow();
  });
});

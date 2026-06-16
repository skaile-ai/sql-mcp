import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { LIVE, startPostgres } from "./helpers/containers.js";
import { PostgresDialect } from "../../src/dialect/postgres.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

const cfg = (dsn: string, access: Config["access"]): Config => ({
  dialect: "postgres", dsn, access,
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

describe.skipIf(!LIVE)("PostgreSQL live integration", () => {
  let container: StartedTestContainer;
  let dsn: string;

  beforeAll(async () => {
    ({ container, dsn } = await startPostgres());
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: dsn });
    await pool.query("CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)");
    for (let i = 1; i <= 5; i++) await pool.query("INSERT INTO users (name) VALUES ($1)", [`u${i}`]);
    await pool.end();
  }, 180_000);

  afterAll(async () => { await container?.stop(); });

  it("describe_table + list_tables reflect the seed", async () => {
    const d = new PostgresDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const cols = await handleDescribeTable(d, { table: "users" });
    if (cols.status !== "success") throw new Error(cols.error);
    expect(cols.data.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(cols.data.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
    const tabs = await handleListTables(d, {});
    if (tabs.status !== "success") throw new Error(tabs.error);
    expect(tabs.data.tables.map((t) => t.name)).toContain("users");
    await d.close();
  });

  it("query paginates through all rows via next_cursor", async () => {
    const d = new PostgresDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const env = await handleQuery(d, cfg(dsn, "readonly"), { sql: "SELECT id FROM users ORDER BY id", cursor });
      if (env.status !== "success") throw new Error(env.error);
      seen.push(...env.data.rows.map((r) => Number(r.id)));
      cursor = env.data.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await d.close();
  });

  it("readonly instance rejects a write at the DB level (default_transaction_read_only)", async () => {
    const d = new PostgresDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    // Bypass the classifier to prove the DB-level guarantee (spec §7.3 layer 3).
    await expect(d.query("DELETE FROM users", [])).rejects.toThrow();
    await d.close();
  });

  it("dml instance inserts and the row count is reported", async () => {
    const d = new PostgresDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const env = await handleExecute(d, cfg(dsn, "dml"), { sql: "INSERT INTO users (name) VALUES ($1)", params: ["x"] });
    if (env.status !== "success") throw new Error(env.error);
    expect(env.data.rowCount).toBe(1);
    await d.close();
  });
});

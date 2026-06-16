import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { LIVE, startMysql } from "./helpers/containers.js";
import { MysqlDialect } from "../../src/dialect/mysql.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

const cfg = (dsn: string, access: Config["access"]): Config => ({
  dialect: "mysql", dsn, access,
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

describe.skipIf(!LIVE)("MySQL live integration", () => {
  let container: StartedTestContainer;
  let dsn: string;

  beforeAll(async () => {
    ({ container, dsn } = await startMysql());
    const mysql = await import("mysql2/promise");
    // MySQL 8's entrypoint runs a throwaway init server (which also logs "ready for connections")
    // then restarts the real one, so the mapped port can briefly drop the connection. Retry until
    // the real server accepts.
    let conn: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        conn = await mysql.createConnection({ uri: dsn });
        await conn.query("SELECT 1");
        break;
      } catch {
        await conn?.end().catch(() => {});
        conn = undefined;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!conn) throw new Error("mysql container never became reachable for seeding");
    await conn.query("CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL)");
    for (let i = 1; i <= 5; i++) await conn.query("INSERT INTO users (name) VALUES (?)", [`u${i}`]);
    await conn.end();
  }, 180_000);

  afterAll(async () => { await container?.stop(); });

  it("describe_table + list_tables reflect the seed", async () => {
    const d = new MysqlDialect("readonly", undefined, 30_000);
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
    const d = new MysqlDialect("readonly", undefined, 30_000);
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

  it("readonly instance rejects a write at the DB level (START TRANSACTION READ ONLY)", async () => {
    const d = new MysqlDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    await expect(d.query("DELETE FROM users", [])).rejects.toThrow();
    await d.close();
  });

  it("dml instance inserts and reports affectedRows", async () => {
    const d = new MysqlDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const env = await handleExecute(d, cfg(dsn, "dml"), { sql: "INSERT INTO users (name) VALUES ($1)", params: ["x"] });
    if (env.status !== "success") throw new Error(env.error);
    expect(env.data.rowCount).toBe(1);
    await d.close();
  });

  it("execute_batch is atomic: a mid-batch failure rolls back earlier statements", async () => {
    const d = new MysqlDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const before = await d.query("SELECT COUNT(*) AS n FROM users", []);
    const beforeN = Number(before.rows[0]!.n);
    // Second statement violates the PK (id=1 already exists) → whole batch must roll back.
    await expect(
      d.executeBatch([
        { sql: "INSERT INTO users (name) VALUES (?)", params: ["batch-a"] },
        { sql: "INSERT INTO users (id, name) VALUES (?, ?)", params: [1, "dup"] },
      ]),
    ).rejects.toThrow();
    const after = await d.query("SELECT COUNT(*) AS n FROM users", []);
    expect(Number(after.rows[0]!.n)).toBe(beforeN); // first INSERT was rolled back
    await d.close();
  });
});

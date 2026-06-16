import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { LIVE, startMssql } from "./helpers/containers.js";
import { MssqlDialect } from "../../src/dialect/mssql.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

const cfg = (dsn: string, access: Config["access"]): Config => ({
  dialect: "mssql", dsn, access,
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

async function seed(dsn: string): Promise<void> {
  const { Connection, Request } = await import("tedious");
  const u = new URL(dsn);
  const conn = new Connection({
    server: u.hostname,
    options: { port: Number(u.port), database: "master", encrypt: true, trustServerCertificate: true },
    authentication: { type: "default", options: { userName: u.username, password: decodeURIComponent(u.password) } },
  });
  await new Promise<void>((res, rej) => { conn.on("connect", (e) => (e ? rej(e) : res())); conn.connect(); });
  const exec = (sql: string) =>
    new Promise<void>((res, rej) => { const r = new Request(sql, (e) => (e ? rej(e) : res())); conn.execSql(r); });
  await exec("CREATE TABLE users (id INT IDENTITY PRIMARY KEY, name NVARCHAR(64) NOT NULL)");
  for (let i = 1; i <= 5; i++) await exec(`INSERT INTO users (name) VALUES ('u${i}')`);
  conn.close();
}

describe.skipIf(!LIVE)("MSSQL live integration", () => {
  let container: StartedTestContainer;
  let dsn: string;

  beforeAll(async () => { ({ container, dsn } = await startMssql()); await seed(dsn); }, 240_000);
  afterAll(async () => { await container?.stop(); });

  it("describe_table + list_tables reflect the seed", async () => {
    const d = new MssqlDialect("readonly", undefined, 30_000);
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
    const d = new MssqlDialect("readonly", undefined, 30_000);
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

  it("dml instance inserts via @pN params and reports a row count", async () => {
    const d = new MssqlDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const env = await handleExecute(d, cfg(dsn, "dml"), { sql: "INSERT INTO users (name) VALUES ($1)", params: ["x"] });
    if (env.status !== "success") throw new Error(env.error);
    expect(env.data.rowCount).toBe(1);
    await d.close();
  });
});

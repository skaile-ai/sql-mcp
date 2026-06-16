// tests/integration/sqlite.live.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

let dir: string;
let dbPath: string;

const config: Config = {
  dialect: "sqlite", dsn: "", access: "readonly",
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlmcp-"));
  dbPath = join(dir, "test.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  for (let i = 1; i <= 5; i++) seed.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(i, `u${i}`);
  seed.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("SQLite live integration", () => {
  it("describe_table reports the seeded columns", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);
    const env = await handleDescribeTable(d, { table: "users" });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.columns.map((c) => c.name)).toEqual(["id", "name"]);
    await d.close();
  });

  it("list_tables finds users", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);
    const env = await handleListTables(d, {});
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.tables.map((t) => t.name)).toContain("users");
    await d.close();
  });

  it("query paginates through all rows via next_cursor", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);

    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const env = await handleQuery(d, config, { sql: "SELECT id FROM users ORDER BY id", cursor });
      if (env.status !== "success") throw new Error("expected success");
      seen.push(...env.data.rows.map((r) => Number(r.id)));
      cursor = env.data.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await d.close();
  });

  it("a write through the read-only connection fails", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);
    // Bypasses the classifier on purpose: proves the DB-level read-only guarantee (spec §7 layer 3).
    await expect(d.query("DELETE FROM users", [])).rejects.toThrow();
    await d.close();
  });
});

// tests/integration/sqlite-write.live.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleExecuteBatch } from "../../src/tools/execute_batch.js";
import { handleExecuteDdl } from "../../src/tools/execute_ddl.js";
import { handleQuery } from "../../src/tools/query.js";
import type { Config } from "../../src/config.js";

let dir: string;
let dbPath: string;
const cfg = (access: "dml" | "full"): Config => ({
  dialect: "sqlite", dsn: dbPath, access, maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlmcp-w-"));
  dbPath = join(dir, "w.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT NOT NULL)");
  seed.prepare("INSERT INTO t (id, n) VALUES (1, 'a')").run();
  seed.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SQLite live write integration", () => {
  it("execute INSERT/UPDATE/DELETE report row counts", async () => {
    const d = new SqliteDialect("dml"); await d.connect(dbPath);
    const ins = await handleExecute(d, cfg("dml"), { sql: "INSERT INTO t (id, n) VALUES ($1, $2)", params: [2, "b"] });
    expect(ins.status === "success" && ins.data.rowCount).toBe(1);
    const upd = await handleExecute(d, cfg("dml"), { sql: "UPDATE t SET n = $1", params: ["x"] });
    expect(upd.status === "success" && upd.data.rowCount).toBe(2);
    await d.close();
  });

  it("execute_batch is atomic — a failing statement rolls back the whole batch", async () => {
    const d = new SqliteDialect("dml"); await d.connect(dbPath);
    // Second insert violates the PK (id=1 already exists) → whole batch must roll back.
    const env = await handleExecuteBatch(d, cfg("dml"), {
      statements: [
        { sql: "INSERT INTO t (id, n) VALUES (5, 'e')" },
        { sql: "INSERT INTO t (id, n) VALUES (1, 'dup')" },
      ],
    });
    expect(env.status).toBe("error");
    // id=5 must NOT have been committed.
    const check = await handleQuery(d, cfg("dml"), { sql: "SELECT id FROM t WHERE id = 5" });
    expect(check.status === "success" && check.data.rows.length).toBe(0);
    await d.close();
  });

  it("execute_ddl creates and drops a table (full scope)", async () => {
    const d = new SqliteDialect("full"); await d.connect(dbPath);
    expect((await handleExecuteDdl(d, cfg("full"), { sql: "CREATE TABLE t2 (id INTEGER)" })).status).toBe("success");
    const listed = await handleQuery(d, cfg("full"), { sql: "SELECT name FROM sqlite_master WHERE name='t2'" });
    expect(listed.status === "success" && listed.data.rows.length).toBe(1);
    expect((await handleExecuteDdl(d, cfg("full"), { sql: "DROP TABLE t2" })).status).toBe("success");
    await d.close();
  });
});

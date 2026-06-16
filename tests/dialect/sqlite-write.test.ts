// tests/dialect/sqlite-write.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import type { SqliteDb } from "../../src/dialect/sqlite.js";

// Fake db recording exec() calls and returning a fixed change count from run().
function fakeDb(opts: { changes?: number; failOnSql?: string } = {}): { db: SqliteDb; calls: string[] } {
  const calls: string[] = [];
  const db: SqliteDb = {
    prepare(sql: string) {
      return {
        all: () => [],
        run: (..._params: unknown[]) => {
          calls.push(`run:${sql}`);
          if (opts.failOnSql && sql === opts.failOnSql) throw new Error("constraint failed");
          return { changes: opts.changes ?? 1 };
        },
      };
    },
    exec: (sql: string) => { calls.push(`exec:${sql}`); },
    close() {},
  };
  return { db, calls };
}

describe("SqliteDialect (write)", () => {
  it("execute() returns the changed row count", async () => {
    const { db } = fakeDb({ changes: 3 });
    const d = new SqliteDialect("dml", () => db);
    await d.connect(":memory:");
    expect(await d.execute("UPDATE t SET a=?", [1])).toEqual({ rowCount: 3 });
  });

  it("executeBatch() wraps statements in BEGIN/COMMIT and returns per-statement counts", async () => {
    const { db, calls } = fakeDb({ changes: 1 });
    const d = new SqliteDialect("dml", () => db);
    await d.connect(":memory:");
    const res = await d.executeBatch([
      { sql: "INSERT INTO t VALUES (?)", params: [1] },
      { sql: "INSERT INTO t VALUES (?)", params: [2] },
    ]);
    expect(res).toEqual([{ rowCount: 1 }, { rowCount: 1 }]);
    expect(calls[0]).toBe("exec:BEGIN");
    expect(calls[calls.length - 1]).toBe("exec:COMMIT");
    expect(calls).not.toContain("exec:ROLLBACK");
  });

  it("executeBatch() rolls back and rethrows when a statement fails", async () => {
    const failSql = "INSERT INTO t VALUES (2)";
    const { db, calls } = fakeDb({ failOnSql: failSql });
    const d = new SqliteDialect("dml", () => db);
    await d.connect(":memory:");
    await expect(
      d.executeBatch([{ sql: "INSERT INTO t VALUES (1)" }, { sql: failSql }]),
    ).rejects.toThrow(/constraint/);
    expect(calls).toContain("exec:ROLLBACK");
    expect(calls).not.toContain("exec:COMMIT");
  });

  it("executeBatch() surfaces the original error even when ROLLBACK itself throws", async () => {
    // run() throws "ORIGINAL"; exec("ROLLBACK") also throws — the original must win.
    const db: SqliteDb = {
      prepare(_sql: string) {
        return {
          all: () => [],
          run: (..._params: unknown[]) => { throw new Error("ORIGINAL"); },
        };
      },
      exec: (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("rollback boom");
      },
      close() {},
    };
    const d = new SqliteDialect("dml", () => db);
    await d.connect(":memory:");
    await expect(
      d.executeBatch([{ sql: "INSERT INTO t VALUES (1)" }]),
    ).rejects.toThrow(/ORIGINAL/);
  });
});

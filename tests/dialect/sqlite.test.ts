// tests/dialect/sqlite.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import type { SqliteDb } from "../../src/dialect/sqlite.js";

// Minimal fake of the node:sqlite surface the dialect uses.
function fakeDb(responses: Record<string, unknown[]>): SqliteDb {
  return {
    prepare(sql: string) {
      return {
        all: (..._params: unknown[]) => responses[sql.trim()] ?? [],
      };
    },
    close() {},
  };
}

describe("SqliteDialect (read)", () => {
  it("rewrites canonical $1 params to ?", async () => {
    const d = new SqliteDialect("readonly", () => fakeDb({}));
    await d.connect(":memory:");
    expect(d.rewriteParams("SELECT * FROM t WHERE a=$1 AND b=$2")).toBe(
      "SELECT * FROM t WHERE a=? AND b=?",
    );
  });

  it("lists tables and views from sqlite_master", async () => {
    const sql = "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
    const d = new SqliteDialect("readonly", () =>
      fakeDb({ [sql]: [{ name: "users", type: "table" }, { name: "v_active", type: "view" }] }),
    );
    await d.connect(":memory:");
    const tables = await d.listTables();
    expect(tables).toEqual([
      { name: "users", type: "table", schema: "main" },
      { name: "v_active", type: "view", schema: "main" },
    ]);
  });

  it("describes a table via PRAGMA with a quoted identifier", async () => {
    const d = new SqliteDialect("readonly", () =>
      fakeDb({
        'PRAGMA table_info("users")': [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
        ],
      }),
    );
    await d.connect(":memory:");
    const cols = await d.describeTable("users");
    expect(cols[0]).toMatchObject({ name: "id", type: "INTEGER", nullable: false, primaryKey: true });
  });

  it("rejects an invalid table identifier before building PRAGMA SQL", async () => {
    const d = new SqliteDialect("readonly", () => fakeDb({}));
    await d.connect(":memory:");
    await expect(d.describeTable('x"; DROP TABLE x; --')).rejects.toThrow(/identifier/i);
  });
});

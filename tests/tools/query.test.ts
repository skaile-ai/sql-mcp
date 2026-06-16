// tests/tools/query.test.ts
import { describe, it, expect } from "vitest";
import { handleQuery } from "../../src/tools/query.js";
import { encodeCursor } from "../../src/cursor.js";
import type { Dialect, QueryResult } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "readonly",
  maxRows: 2, maxResultBytes: 1_000_000, statementTimeoutMs: 30_000, cursorSecret: "s",
};

function dialectReturning(rows: Record<string, unknown>[]): Dialect {
  return {
    name: "sqlite", paramStyle: "?",
    connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s.replace(/\$\d+/g, "?"),
    quoteIdent: (n) => `"${n}"`,
    query: async (): Promise<QueryResult> => ({ columns: rows[0] ? Object.keys(rows[0]) : [], rows }),
    listSchemas: async () => ["main"], listTables: async () => [], describeTable: async () => [],
  };
}

describe("handleQuery", () => {
  it("rejects a non-SELECT statement with ACCESS_DENIED", async () => {
    const env = await handleQuery(dialectReturning([]), config, { sql: "DELETE FROM t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects multiple statements", async () => {
    const env = await handleQuery(dialectReturning([]), config, { sql: "SELECT 1; SELECT 2" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("returns a page and a next_cursor when more rows exist", async () => {
    // maxRows=2 → page size 2; dialect returns 3 (page+1) → there is a next page.
    const d = dialectReturning([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const env = await handleQuery(d, config, { sql: "SELECT * FROM t" });
    expect(env.status).toBe("success");
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.rows).toHaveLength(2);
    expect(env.data.rowCount).toBe(2);
    expect(typeof env.data.next_cursor).toBe("string");
    expect(env.data.truncated).toBe(false);
  });

  it("omits next_cursor on the last page", async () => {
    const d = dialectReturning([{ id: 1 }]);
    const env = await handleQuery(d, config, { sql: "SELECT * FROM t" });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.next_cursor).toBeUndefined();
  });

  it("treats a negative decoded cursor offset as 0", async () => {
    let nativeSql = "";
    const d: Dialect = {
      ...dialectReturning([{ id: 1 }]),
      query: async (sql: string): Promise<QueryResult> => {
        nativeSql = sql;
        return { columns: ["id"], rows: [{ id: 1 }] };
      },
    };
    const cursor = encodeCursor({ mode: "offset", offset: -1 }, config.cursorSecret);
    const env = await handleQuery(d, config, { sql: "SELECT * FROM t", cursor });
    expect(env.status).toBe("success");
    expect(nativeSql).toContain("OFFSET 0");
    expect(nativeSql).not.toContain("OFFSET -1");
  });
});

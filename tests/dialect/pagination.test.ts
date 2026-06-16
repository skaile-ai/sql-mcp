import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import { PostgresDialect } from "../../src/dialect/postgres.js";
import { MysqlDialect } from "../../src/dialect/mysql.js";
import { MssqlDialect } from "../../src/dialect/mssql.js";

const noop: any = () => ({ query: async () => ({ rows: [] }), end: async () => {}, run: async () => ({ rows: [], rowCount: 0 }), close: async () => {} });

describe("dialect.paginate", () => {
  it("LIMIT/OFFSET dialects wrap with LIMIT n OFFSET m", () => {
    for (const d of [new SqliteDialect("readonly"), new PostgresDialect("readonly", noop), new MysqlDialect("readonly", noop)]) {
      const p = d.paginate("SELECT id FROM users ORDER BY id", 10, 20);
      expect(p).toContain("LIMIT 10");
      expect(p).toContain("OFFSET 20");
    }
  });

  it("MSSQL uses OFFSET ... ROWS FETCH NEXT ... ROWS ONLY with an ORDER BY", () => {
    const d = new MssqlDialect("readonly", noop);
    const p = d.paginate("SELECT id FROM users ORDER BY id", 10, 20);
    expect(p).toMatch(/OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY/i);
    expect(p).toMatch(/ORDER BY/i);
  });
});

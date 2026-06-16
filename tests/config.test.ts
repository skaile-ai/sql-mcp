// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { SQL_MCP_DIALECT: "sqlite", SQL_MCP_DSN: "/tmp/db.sqlite" };

describe("loadConfig", () => {
  it("parses required fields and applies limit defaults", () => {
    const c = loadConfig(base);
    expect(c.dialect).toBe("sqlite");
    expect(c.dsn).toBe("/tmp/db.sqlite");
    expect(c.access).toBe("readonly"); // safest default
    expect(c.maxRows).toBe(1000);
    expect(c.maxResultBytes).toBe(10 * 1024 * 1024);
    expect(c.statementTimeoutMs).toBe(30_000);
    expect(c.cursorSecret).toBe("/tmp/db.sqlite"); // defaults to DSN derivation
  });

  it("rejects an unknown dialect", () => {
    expect(() => loadConfig({ ...base, SQL_MCP_DIALECT: "oracle" })).toThrow(/dialect/i);
  });

  it("requires a DSN", () => {
    expect(() => loadConfig({ SQL_MCP_DIALECT: "sqlite" })).toThrow(/SQL_MCP_DSN/);
  });

  it("caps max_rows at 10000", () => {
    expect(loadConfig({ ...base, SQL_MCP_MAX_ROWS: "999999" }).maxRows).toBe(10_000);
  });

  it("honours explicit access + cursor secret", () => {
    const c = loadConfig({ ...base, SQL_MCP_ACCESS: "full", SQL_MCP_CURSOR_SECRET: "s3cret" });
    expect(c.access).toBe("full");
    expect(c.cursorSecret).toBe("s3cret");
  });
});

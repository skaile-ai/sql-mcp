// tests/create-server.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/create-server.js";
import type { Dialect } from "../src/dialect/types.js";
import type { Config } from "../src/config.js";

// Read the release version from disk, independently of src/version.ts.
const pkgVersion: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "readonly",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};
const dialect: Dialect = {
  name: "sqlite", paramStyle: "?", classifyHooks: {}, supportsStatementTimeout: false,
  connect: async () => {}, close: async () => {},
  rewriteParams: (s) => s,
  paginate: (sql) => sql,
  quoteIdent: (n) => `"${n}"`,
  query: async () => ({ columns: [], rows: [] }),
  execute: async () => ({ rowCount: 0 }), executeBatch: async () => [],
  listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
};

describe("createServer initialize result", () => {
  it("carries the package.json version in serverInfo and in instructions", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(dialect, config);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport); // performs the initialize handshake

    try {
      expect(client.getServerVersion()).toEqual({ name: "sql-mcp", version: pkgVersion });
      const instructions = client.getInstructions();
      expect(instructions).toBeDefined();
      expect(instructions!.startsWith(`sql-mcp ${pkgVersion}: `)).toBe(true);
      expect(instructions).toContain(
        `When asked which version of this server is running, the answer is ${pkgVersion}.`,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

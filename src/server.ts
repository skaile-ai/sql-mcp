// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createDialect } from "./dialect/index.js";
import { registerReadTools } from "./tools/register.js";
import { SERVER_VERSION } from "./version.js";
import { safeErrorMessage } from "./scrub.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const dialect = createDialect(config);
  await dialect.connect(config.dsn);

  const server = new McpServer({ name: "sql-mcp", version: SERVER_VERSION });
  registerReadTools(server, dialect, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the JSON-RPC channel; status goes to stderr.
  process.stderr.write(`sql-mcp ${SERVER_VERSION} ready (dialect=${config.dialect}, access=${config.access})\n`);
}

main().catch((e) => {
  process.stderr.write(`sql-mcp failed to start: ${safeErrorMessage(e)}\n`);
  process.exit(1);
});

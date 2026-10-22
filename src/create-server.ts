// src/create-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { Dialect } from "./dialect/types.js";
import { registerReadTools, registerWriteTools } from "./tools/register.js";
import { SERVER_INSTRUCTIONS, SERVER_VERSION } from "./version.js";

/** Build the MCP server with its tools registered; the caller connects a transport. */
export function createServer(dialect: Dialect, config: Config): McpServer {
  const server = new McpServer(
    { name: "sql-mcp", version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerReadTools(server, dialect, config);
  registerWriteTools(server, dialect, config); // no-op for readonly; gates internally
  return server;
}

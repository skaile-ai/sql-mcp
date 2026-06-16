// src/tools/register.ts
import { z } from "zod";
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { handleCapabilities } from "./capabilities.js";
import { handleListSchemas, handleListTables, handleDescribeTable } from "./introspection.js";
import { handleQuery } from "./query.js";
import { err } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

export interface ToolContent {
  // Index signature keeps ToolContent structurally assignable to the SDK's
  // CallToolResult (which carries `[x: string]: unknown`) under SDK >=1.29.
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

/** Minimal surface of McpServer.registerTool we depend on (keeps registration unit-testable). */
export interface ToolRegistrar {
  registerTool(
    name: string,
    def: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: any, extra?: any) => Promise<ToolContent>,
  ): void;
}

function asContent(env: unknown): ToolContent {
  return { content: [{ type: "text", text: JSON.stringify(env) }] };
}

/** Wrap a handler so every envelope is serialized and any thrown error is scrubbed + enveloped. */
function wrap(toolName: string, fn: (args: any) => Promise<unknown>) {
  return async (args: any): Promise<ToolContent> => {
    try {
      return asContent(await fn(args));
    } catch (e) {
      return asContent(err(toolName, "TOOL_EXECUTION_ERROR", safeErrorMessage(e)));
    }
  };
}

export function registerReadTools(server: ToolRegistrar, dialect: Dialect, config: Config): void {
  server.registerTool(
    "sql.capabilities",
    { description: "Report dialect, access scope, feature flags, and safety limits.", inputSchema: {} },
    wrap("sql.capabilities", () => handleCapabilities(dialect, config)),
  );

  server.registerTool(
    "sql.list_schemas",
    { description: "List schemas/databases visible to the connection.", inputSchema: {} },
    wrap("sql.list_schemas", () => handleListSchemas(dialect)),
  );

  server.registerTool(
    "sql.list_tables",
    {
      description: "List tables and views, optionally scoped to a schema.",
      inputSchema: { schema: z.string().optional() },
    },
    wrap("sql.list_tables", (a) => handleListTables(dialect, a)),
  );

  server.registerTool(
    "sql.describe_table",
    {
      description: "Describe a table's columns, types, nullability, defaults, and primary key.",
      inputSchema: { table: z.string(), schema: z.string().optional() },
    },
    wrap("sql.describe_table", (a) => handleDescribeTable(dialect, a)),
  );

  server.registerTool(
    "sql.query",
    {
      description:
        "Run a read-only SELECT. Parameterized ($1,$2). Supports keyset/offset pagination via `cursor`/`limit`; returns next_cursor when more rows exist.",
      inputSchema: {
        sql: z.string(),
        params: z.array(z.unknown()).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    wrap("sql.query", (a) => handleQuery(dialect, config, a)),
  );
}

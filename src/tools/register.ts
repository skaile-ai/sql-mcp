// src/tools/register.ts
import { z } from "zod";
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { handleCapabilities } from "./capabilities.js";
import { handleListSchemas, handleListTables, handleDescribeTable } from "./introspection.js";
import { handleQuery } from "./query.js";
import { handleExecute } from "./execute.js";
import { handleExecuteDdl } from "./execute_ddl.js";
import { handleExecuteBatch } from "./execute_batch.js";
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

export function registerWriteTools(server: ToolRegistrar, dialect: Dialect, config: Config): void {
  if (config.access === "readonly") return; // no write tools for read-only instances

  server.registerTool(
    "sql.execute",
    {
      description: "Run a single DML statement (INSERT/UPDATE/DELETE). Parameterized ($1,$2). Auto-commits.",
      inputSchema: { sql: z.string(), params: z.array(z.unknown()).optional() },
    },
    wrap("sql.execute", (a) => handleExecute(dialect, config, a)),
  );

  server.registerTool(
    "sql.execute_batch",
    {
      description:
        "Run an ordered array of DML statements atomically (one BEGIN/COMMIT). All statements are classified before any executes; any non-DML rejects the whole batch.",
      inputSchema: {
        statements: z.array(z.object({ sql: z.string(), params: z.array(z.unknown()).optional() })),
      },
    },
    wrap("sql.execute_batch", (a) => handleExecuteBatch(dialect, config, a)),
  );

  if (config.access === "full") {
    server.registerTool(
      "sql.execute_ddl",
      {
        description: "Run a single DDL statement (CREATE/ALTER/DROP/TRUNCATE). Only available at `full` scope.",
        inputSchema: { sql: z.string(), params: z.array(z.unknown()).optional() },
      },
      wrap("sql.execute_ddl", (a) => handleExecuteDdl(dialect, config, a)),
    );
  }
}

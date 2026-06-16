// src/tools/capabilities.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { ok, type Envelope } from "../envelope.js";
import { SERVER_VERSION } from "../version.js";

export interface CapabilitiesData {
  server_version: string;
  dialect: string;
  param_style: string;
  access: string;
  feature_flags: { write: boolean; ddl: boolean; transactions_handle: boolean; server_side_cursors: boolean; statement_timeout: boolean };
  limits: { max_rows: number; max_result_bytes: number; statement_timeout_ms: number };
}

export async function handleCapabilities(
  dialect: Dialect,
  config: Config,
): Promise<Envelope<CapabilitiesData>> {
  return ok("sql.capabilities", {
    server_version: SERVER_VERSION,
    dialect: dialect.name,
    param_style: dialect.paramStyle,
    access: config.access,
    feature_flags: {
      write: config.access !== "readonly",
      ddl: config.access === "full",
      transactions_handle: false, // v2
      server_side_cursors: false, // v2
      statement_timeout: dialect.supportsStatementTimeout,
    },
    limits: {
      max_rows: config.maxRows,
      max_result_bytes: config.maxResultBytes,
      statement_timeout_ms: config.statementTimeoutMs,
    },
  });
}

// src/config.ts
export const DIALECTS = ["postgres", "mysql", "sqlite", "mssql"] as const;
export type DialectName = (typeof DIALECTS)[number];

export const ACCESS_SCOPES = ["readonly", "dml", "full"] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export interface Config {
  dialect: DialectName;
  dsn: string;
  access: AccessScope;
  maxRows: number;
  maxResultBytes: number;
  statementTimeoutMs: number;
  cursorSecret: string;
}

const MAX_ROWS_CAP = 10_000;

function intEnv(raw: string | undefined, fallback: number, cap?: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return cap ? Math.min(n, cap) : n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const dialect = env.SQL_MCP_DIALECT as DialectName | undefined;
  if (!dialect || !DIALECTS.includes(dialect)) {
    throw new Error(`SQL_MCP_DIALECT must be one of ${DIALECTS.join(", ")} (got ${String(dialect)})`);
  }
  const dsn = env.SQL_MCP_DSN;
  if (!dsn) throw new Error("SQL_MCP_DSN is required");

  const access = (env.SQL_MCP_ACCESS as AccessScope | undefined) ?? "readonly";
  if (!ACCESS_SCOPES.includes(access)) {
    throw new Error(`SQL_MCP_ACCESS must be one of ${ACCESS_SCOPES.join(", ")} (got ${access})`);
  }

  return {
    dialect,
    dsn,
    access,
    maxRows: intEnv(env.SQL_MCP_MAX_ROWS, 1000, MAX_ROWS_CAP),
    maxResultBytes: intEnv(env.SQL_MCP_MAX_RESULT_BYTES, 10 * 1024 * 1024),
    statementTimeoutMs: intEnv(env.SQL_MCP_STATEMENT_TIMEOUT_MS, 30_000),
    // Defaults to a deterministic derivation from the DSN so cursor tokens
    // survive restarts (spec §6a). Set explicitly to control rotation.
    cursorSecret: env.SQL_MCP_CURSOR_SECRET ?? dsn,
  };
}

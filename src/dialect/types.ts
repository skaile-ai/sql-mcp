// src/dialect/types.ts
import type { DialectName } from "../config.js";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  type: "table" | "view";
  schema?: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface BatchStatement {
  sql: string;
  params?: unknown[];
}

/** Read + write subset of the Dialect contract. Handle-based transactions and server-side
 *  cursors remain out of scope (v2 of the broader roadmap). */
export interface Dialect {
  readonly name: DialectName;
  readonly paramStyle: "$n" | "?" | "@p";
  /** Per-dialect keyword hooks for the shared classifier (e.g. MERGE as DML). */
  readonly classifyHooks: import("../classifier.js").ClassifyHooks;
  /** Whether this dialect enforces `statement_timeout_ms` at the driver/DB level. */
  readonly supportsStatementTimeout: boolean;
  connect(dsn: string): Promise<void>;
  close(): Promise<void>;
  /** Rewrite canonical `$1/$2` placeholders into the dialect-native form. */
  rewriteParams(canonicalSql: string): string;
  /** Quote an identifier (caller has already allowlist-validated it). */
  quoteIdent(name: string): string;
  query(sql: string, params: unknown[]): Promise<QueryResult>;
  /** Run one DML/DDL statement; returns the affected row count (0 for DDL). */
  execute(sql: string, params: unknown[]): Promise<{ rowCount: number }>;
  /** Run an ordered list of statements in a single transaction; rolls back atomically on error. */
  executeBatch(statements: BatchStatement[]): Promise<Array<{ rowCount: number }>>;
  listSchemas(): Promise<string[]>;
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<ColumnInfo[]>;
}

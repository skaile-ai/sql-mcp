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

/** Read subset of the Dialect contract (this phase). Write/transaction methods arrive in Phase 2. */
export interface Dialect {
  readonly name: DialectName;
  readonly paramStyle: "$n" | "?" | "@p";
  connect(dsn: string): Promise<void>;
  close(): Promise<void>;
  /** Rewrite canonical `$1/$2` placeholders into the dialect-native form. */
  rewriteParams(canonicalSql: string): string;
  /** Quote an identifier (caller has already allowlist-validated it). */
  quoteIdent(name: string): string;
  query(sql: string, params: unknown[]): Promise<QueryResult>;
  listSchemas(): Promise<string[]>;
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<ColumnInfo[]>;
}

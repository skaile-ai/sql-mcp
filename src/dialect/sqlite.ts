// src/dialect/sqlite.ts
import type { AccessScope } from "../config.js";
import { assertValidIdent, quoteIdentAnsi } from "../identifiers.js";
import type { BatchStatement, ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";

// The slice of node:sqlite's DatabaseSync we depend on (kept tiny for testability).
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export type SqliteDbFactory = (path: string, readOnly: boolean) => SqliteDb;

const defaultFactory: SqliteDbFactory = (path, readOnly) => {
  // Imported lazily so unit tests (which inject a fake) never touch the native binding.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path, { readOnly }) as unknown as SqliteDb;
};

export class SqliteDialect implements Dialect {
  readonly name = "sqlite" as const;
  readonly paramStyle = "?" as const;
  private db: SqliteDb | null = null;

  constructor(
    private readonly access: AccessScope,
    private readonly factory: SqliteDbFactory = defaultFactory,
  ) {}

  async connect(dsn: string): Promise<void> {
    // DB-level read-only guarantee (spec §7 layer 3): a readonly instance opens read-only.
    this.db = this.factory(dsn, this.access === "readonly");
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private require(): SqliteDb {
    if (!this.db) throw new Error("CONNECTION_FAILED: sqlite database is not connected");
    return this.db;
  }

  rewriteParams(canonicalSql: string): string {
    // $1, $2, ... → ? (SQLite is positional). Assumes params are passed in order.
    return canonicalSql.replace(/\$\d+/g, "?");
  }

  quoteIdent(name: string): string {
    assertValidIdent(name);
    return quoteIdentAnsi(name);
  }

  async query(sql: string, params: unknown[]): Promise<QueryResult> {
    const rows = this.require().prepare(sql).all(...params) as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { columns, rows };
  }

  async execute(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    const r = this.require().prepare(sql).run(...params);
    return { rowCount: r.changes };
  }

  async executeBatch(statements: BatchStatement[]): Promise<Array<{ rowCount: number }>> {
    const db = this.require();
    db.exec("BEGIN");
    try {
      const results = statements.map((s) => ({
        rowCount: db.prepare(s.sql).run(...(s.params ?? [])).changes,
      }));
      db.exec("COMMIT");
      return results;
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* best-effort; original error takes priority */ }
      throw e;
    }
  }

  async listSchemas(): Promise<string[]> {
    return ["main"];
  }

  async listTables(_schema?: string): Promise<TableInfo[]> {
    const sql =
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
    const rows = this.require().prepare(sql).all() as Array<{ name: string; type: "table" | "view" }>;
    return rows.map((r) => ({ name: r.name, type: r.type, schema: "main" }));
  }

  async describeTable(table: string, _schema?: string): Promise<ColumnInfo[]> {
    const quoted = this.quoteIdent(table); // validates + quotes (throws on injection)
    const rows = this.require().prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    return rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.notnull === 0,
      default: r.dflt_value,
      primaryKey: r.pk > 0,
    }));
  }
}

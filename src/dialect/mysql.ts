// src/dialect/mysql.ts
import type { AccessScope } from "../config.js";
import type { ClassifyHooks } from "../classifier.js";
import { assertValidIdent, quoteIdentMysql } from "../identifiers.js";
import type { BatchStatement, ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";

// Minimal slice of mysql2/promise Pool. query() returns [rows, fields] like mysql2.
export type MysqlQueryReturn = [unknown, unknown];
// A pooled connection — transactions MUST run on a single pinned connection, never via pool.query()
// (the pool hands out a different connection per call, which would scatter BEGIN/…/COMMIT and
// silently break atomicity). Mirrors the pg PgClient fix.
export interface MysqlConnection {
  query(sql: string, params?: unknown[]): Promise<MysqlQueryReturn>;
  release(): void;
}
export interface MysqlPool {
  getConnection(): Promise<MysqlConnection>;
  query(sql: string, params?: unknown[]): Promise<MysqlQueryReturn>; // single auto-commit statements only
  end(): Promise<void>;
}
export type MysqlPoolFactory = (dsn: string) => MysqlPool;

const defaultFactory: MysqlPoolFactory = (dsn) => {
  const mysql = require("mysql2/promise") as typeof import("mysql2/promise");
  const pool = mysql.createPool({
    uri: dsn,
    connectionLimit: 4, // small pool per spec §5; a configurable cap is deferred — see plan carryover.
    // BIGINT/DECIMAL as strings so wide numerics survive JSON (spec §8).
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
  });
  return pool as unknown as MysqlPool;
};

export class MysqlDialect implements Dialect {
  readonly name = "mysql" as const;
  readonly paramStyle = "?" as const;
  readonly classifyHooks: ClassifyHooks = {}; // MySQL has no MERGE
  readonly supportsStatementTimeout = true; // SELECT only, via max_execution_time (MySQL has no DML/DDL statement timeout)
  private pool: MysqlPool | null = null;

  constructor(
    private readonly access: AccessScope,
    private readonly factory: MysqlPoolFactory = defaultFactory,
    private readonly statementTimeoutMs = 30_000,
  ) {}

  async connect(dsn: string): Promise<void> {
    this.pool = this.factory(dsn);
    if (this.access === "readonly") {
      // MySQL has no inspectable session-level read-only role flag; the DB-level guarantee is a
      // read-only grant. Surface that expectation rather than implying enforcement we can't verify.
      process.stderr.write("sql-mcp warning: mysql readonly enforcement relies on a read-only grant + START TRANSACTION READ ONLY; verify the DB user has no write privileges\n");
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private require(): MysqlPool {
    if (!this.pool) throw new Error("CONNECTION_FAILED: mysql pool is not connected");
    return this.pool;
  }

  rewriteParams(canonicalSql: string): string {
    return canonicalSql.replace(/\$\d+/g, "?");
  }

  paginate(sql: string, limit: number, offset: number): string {
    const trimmed = sql.replace(/;\s*$/, "");
    return `SELECT * FROM (${trimmed}) AS _page LIMIT ${limit} OFFSET ${offset}`;
  }

  quoteIdent(name: string): string {
    assertValidIdent(name);
    return quoteIdentMysql(name);
  }

  /**
   * Run a read on a single pinned connection inside a READ ONLY transaction.
   * The READ ONLY bracket is intentional defense-in-depth applied regardless of access scope —
   * do not drop it for dml/full instances.
   */
  private async withReadTx<T>(fn: (conn: MysqlConnection) => Promise<T>): Promise<T> {
    const conn = await this.require().getConnection();
    try {
      // Statement timeout applies to SELECT via max_execution_time; set it on the pinned
      // connection so it is guaranteed applied (the pool 'connection' event was racy + swallowed errors).
      await conn.query(`SET SESSION max_execution_time = ${Math.max(0, Math.floor(this.statementTimeoutMs))}`);
      await conn.query("START TRANSACTION READ ONLY");
      const out = await fn(conn);
      await conn.query("COMMIT");
      return out;
    } catch (e) {
      try { await conn.query("ROLLBACK"); } catch { /* original error wins */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async query(sql: string, params: unknown[]): Promise<QueryResult> {
    return this.withReadTx(async (conn) => {
      const [rows] = await conn.query(sql, params);
      const arr = (rows as Record<string, unknown>[]) ?? [];
      const columns = arr.length > 0 ? Object.keys(arr[0]!) : [];
      return { columns, rows: arr };
    });
  }

  async execute(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    // Single auto-commit statement: pool.query() is correct (no transaction to pin).
    const [res] = await this.require().query(sql, params);
    const affected = (res as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
    return { rowCount: affected };
  }

  async executeBatch(statements: BatchStatement[]): Promise<Array<{ rowCount: number }>> {
    const conn = await this.require().getConnection();
    try {
      await conn.query("START TRANSACTION");
      const results: Array<{ rowCount: number }> = [];
      for (const s of statements) {
        const [res] = await conn.query(s.sql, s.params ?? []);
        results.push({ rowCount: (res as { affectedRows?: number } | undefined)?.affectedRows ?? 0 });
      }
      await conn.query("COMMIT");
      return results;
    } catch (e) {
      try { await conn.query("ROLLBACK"); } catch { /* original error wins */ }
      throw e;
    } finally {
      conn.release();
    }
  }

  async listSchemas(): Promise<string[]> {
    return this.withReadTx(async (conn) => {
      const [rows] = await conn.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY schema_name",
      );
      return (rows as Record<string, unknown>[]).map((r) => String(r.schema_name ?? r.SCHEMA_NAME));
    });
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    return this.withReadTx(async (conn) => {
      const [rows] = await conn.query(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_type IN ('BASE TABLE','VIEW')
         AND (? IS NULL OR table_schema = ?)
         AND table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
       ORDER BY table_schema, table_name`,
        [schema ?? null, schema ?? null],
      );
      return (rows as Record<string, unknown>[]).map((r) => ({
        name: String(r.table_name ?? r.TABLE_NAME),
        type: String(r.table_type ?? r.TABLE_TYPE) === "VIEW" ? ("view" as const) : ("table" as const),
        schema: String(r.table_schema ?? r.TABLE_SCHEMA),
      }));
    });
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    assertValidIdent(table);
    return this.withReadTx(async (conn) => {
      // MySQL's information_schema spans every schema in the instance, so an unqualified table
      // name would union same-named tables (e.g. sys.users). Scope to the connected database when
      // no schema is given; column_key='PRI' is then row-scoped to that one table.
      const [rows] = await conn.query(
        `SELECT column_name, data_type, is_nullable, column_default, column_key
         FROM information_schema.columns
        WHERE table_name = ? AND table_schema = COALESCE(?, DATABASE())
        ORDER BY ordinal_position`,
        [table, schema ?? null],
      );
      return (rows as Record<string, unknown>[]).map((r) => ({
        name: String(r.column_name ?? r.COLUMN_NAME),
        type: String(r.data_type ?? r.DATA_TYPE),
        nullable: String(r.is_nullable ?? r.IS_NULLABLE) === "YES",
        default: (r.column_default ?? r.COLUMN_DEFAULT) == null ? null : String(r.column_default ?? r.COLUMN_DEFAULT),
        primaryKey: String(r.column_key ?? r.COLUMN_KEY) === "PRI",
      }));
    });
  }
}

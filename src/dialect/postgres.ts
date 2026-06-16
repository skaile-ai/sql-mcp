// src/dialect/postgres.ts
import type { AccessScope } from "../config.js";
import type { ClassifyHooks } from "../classifier.js";
import { assertValidIdent, quoteIdentAnsi } from "../identifiers.js";
import type { BatchStatement, ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";

// Minimal slice of node-postgres's Pool we depend on (keeps the dialect unit-testable).
export interface PgQueryResult { rows: Record<string, unknown>[]; rowCount?: number | null; }
export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  release(): void;
}
export interface PgPool {
  connect(): Promise<PgClient>;
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>; // single auto-commit statements only
  end(): Promise<void>;
}
export type PgPoolFactory = (dsn: string, opts: { readOnly: boolean; statementTimeoutMs: number }) => PgPool;

const defaultFactory: PgPoolFactory = (dsn, opts) => {
  // Lazy import so unit tests (which inject a fake) never load the native-optional driver.
  const { Pool } = require("pg") as typeof import("pg");
  return new Pool({
    connectionString: dsn,
    statement_timeout: opts.statementTimeoutMs,
    // DB-level read-only guarantee (spec §7.3): every transaction defaults to read-only.
    options: opts.readOnly ? "-c default_transaction_read_only=on" : undefined,
    max: 4, // small pool per spec §5; a configurable cap (SQL_MCP_PG_POOL_MAX) is deferred — see plan carryover.
  }) as unknown as PgPool;
};

export class PostgresDialect implements Dialect {
  readonly name = "postgres" as const;
  readonly paramStyle = "$n" as const;
  readonly classifyHooks: ClassifyHooks = { extraDml: ["merge"] };
  readonly supportsStatementTimeout = true;
  private pool: PgPool | null = null;

  constructor(
    private readonly access: AccessScope,
    private readonly factory: PgPoolFactory = defaultFactory,
    private readonly statementTimeoutMs = 30_000,
  ) {}

  async connect(dsn: string): Promise<void> {
    this.pool = this.factory(dsn, { readOnly: this.access === "readonly", statementTimeoutMs: this.statementTimeoutMs });
    if (this.access === "readonly") {
      // Confirm the read-only guarantee; warn (never throw) when it cannot be verified.
      try {
        const r = await this.pool.query("SHOW default_transaction_read_only");
        const val = (r.rows[0] as Record<string, unknown> | undefined)?.default_transaction_read_only;
        if (val !== "on") {
          process.stderr.write("sql-mcp warning: postgres readonly instance could not confirm default_transaction_read_only=on\n");
        }
      } catch {
        process.stderr.write("sql-mcp warning: postgres readonly verification query failed; relying on classifier + read-only role\n");
      }
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private require(): PgPool {
    if (!this.pool) throw new Error("CONNECTION_FAILED: postgres pool is not connected");
    return this.pool;
  }

  rewriteParams(canonicalSql: string): string {
    return canonicalSql; // Postgres is natively $1,$2,...
  }

  paginate(sql: string, limit: number, offset: number): string {
    const trimmed = sql.replace(/;\s*$/, "");
    return `SELECT * FROM (${trimmed}) AS _page LIMIT ${limit} OFFSET ${offset}`;
  }

  quoteIdent(name: string): string {
    assertValidIdent(name);
    return quoteIdentAnsi(name);
  }

  /** Run a read on a single pinned client inside a READ ONLY transaction. */
  private async withReadTx<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.require().connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* original error wins */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async query(sql: string, params: unknown[]): Promise<QueryResult> {
    return this.withReadTx(async (client) => {
      const r = await client.query(sql, params);
      const columns = r.rows.length > 0 ? Object.keys(r.rows[0]!) : [];
      return { columns, rows: r.rows };
    });
  }

  async execute(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    const r = await this.require().query(sql, params);
    return { rowCount: r.rowCount ?? 0 };
  }

  async executeBatch(statements: BatchStatement[]): Promise<Array<{ rowCount: number }>> {
    const client = await this.require().connect();
    try {
      await client.query("BEGIN");
      const results: Array<{ rowCount: number }> = [];
      for (const s of statements) {
        const r = await client.query(s.sql, s.params ?? []);
        results.push({ rowCount: r.rowCount ?? 0 });
      }
      await client.query("COMMIT");
      return results;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* original error wins */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async listSchemas(): Promise<string[]> {
    return this.withReadTx(async (client) => {
      const r = await client.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name",
      );
      return r.rows.map((row) => String((row as Record<string, unknown>).schema_name));
    });
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    return this.withReadTx(async (client) => {
      const r = await client.query(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_type IN ('BASE TABLE','VIEW')
         AND ($1::text IS NULL OR table_schema = $1)
         AND table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY table_schema, table_name`,
        [schema ?? null],
      );
      return r.rows.map((row) => {
        const rr = row as Record<string, unknown>;
        return {
          name: String(rr.table_name),
          type: rr.table_type === "VIEW" ? ("view" as const) : ("table" as const),
          schema: String(rr.table_schema),
        };
      });
    });
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    assertValidIdent(table); // value-bound below, but validate early (defense in depth)
    return this.withReadTx(async (client) => {
      const r = await client.query(
        `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              (pk.column_name IS NOT NULL) AS is_pk
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND kcu.table_name = $1
              AND ($2::text IS NULL OR tc.table_schema = $2)
         ) pk ON pk.column_name = c.column_name
        WHERE c.table_name = $1 AND ($2::text IS NULL OR c.table_schema = $2)
        ORDER BY c.ordinal_position`,
        [table, schema ?? null],
      );
      return r.rows.map((row) => {
        const rr = row as Record<string, unknown>;
        return {
          name: String(rr.column_name),
          type: String(rr.data_type),
          nullable: rr.is_nullable === "YES",
          default: rr.column_default == null ? null : String(rr.column_default),
          primaryKey: rr.is_pk === true,
        };
      });
    });
  }
}

// src/dialect/mssql.ts
import type { AccessScope } from "../config.js";
import type { ClassifyHooks } from "../classifier.js";
import { assertValidIdent, quoteIdentMssql } from "../identifiers.js";
import { rewriteToNamed, inferTdsType } from "./mssql-params.js";
import type { BatchStatement, ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";

// Seam: execute a (already-@pN-rewritten) statement with ordered params; return rows + count.
export interface MssqlExecutor {
  run(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  close(): Promise<void>;
}
export type MssqlExecutorFactory = (dsn: string, opts: { readOnly: boolean; statementTimeoutMs: number }) => MssqlExecutor;

const defaultFactory: MssqlExecutorFactory = (dsn, opts) => {
  const { Connection, Request } = require("tedious") as typeof import("tedious");
  const u = new URL(dsn);
  const config = {
    server: u.hostname,
    options: {
      port: u.port ? Number(u.port) : 1433,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "master",
      encrypt: true,
      trustServerCertificate: true,
      requestTimeout: opts.statementTimeoutMs,
      rowCollectionOnRequestCompletion: true,
    },
    authentication: {
      type: "default" as const,
      options: { userName: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
    },
  };

  let conn: import("tedious").Connection | null = null;
  const connected = new Promise<import("tedious").Connection>((resolve, reject) => {
    const c = new Connection(config);
    c.on("connect", (err) => (err ? reject(err) : resolve(c)));
    c.connect();
    conn = c;
  });

  return {
    async run(sql, params) {
      const c = await connected;
      return await new Promise((resolve, reject) => {
        const rows: Record<string, unknown>[] = [];
        const req = new Request(sql, (err, rowCount) => {
          if (err) return reject(err);
          resolve({ rows, rowCount: rowCount ?? rows.length });
        });
        params.forEach((val, i) => req.addParameter(`p${i + 1}`, inferTdsType(val), val ?? null));
        req.on("row", (columns: any[]) => {
          const row: Record<string, unknown> = {};
          for (const col of columns) row[col.metadata.colName] = col.value;
          rows.push(row);
        });
        c.execSql(req);
      });
    },
    async close() {
      conn?.close();
    },
  };
};

export class MssqlDialect implements Dialect {
  readonly name = "mssql" as const;
  readonly paramStyle = "@p" as const;
  readonly classifyHooks: ClassifyHooks = { extraDml: ["merge"] };
  readonly supportsStatementTimeout = true; // tedious requestTimeout
  private exec: MssqlExecutor | null = null;

  constructor(
    private readonly access: AccessScope,
    private readonly factory: MssqlExecutorFactory = defaultFactory,
    private readonly statementTimeoutMs = 30_000,
  ) {}

  async connect(dsn: string): Promise<void> {
    this.exec = this.factory(dsn, { readOnly: this.access === "readonly", statementTimeoutMs: this.statementTimeoutMs });
    if (this.access === "readonly") {
      // MSSQL has no READ ONLY transaction; the DB-level guarantee is a read-only DB/login.
      try {
        const r = await this.exec.run("SELECT CAST(DATABASEPROPERTYEX(DB_NAME(),'Updateability') AS NVARCHAR(128)) AS u", []);
        const u = r.rows[0]?.u;
        if (u !== "READ_ONLY") {
          process.stderr.write("sql-mcp warning: mssql readonly instance is not on a READ_ONLY database; enforcement relies on a read-only login + classifier\n");
        }
      } catch {
        process.stderr.write("sql-mcp warning: mssql readonly verification query failed; relying on classifier + read-only login\n");
      }
    }
  }

  async close(): Promise<void> {
    await this.exec?.close();
    this.exec = null;
  }

  private require(): MssqlExecutor {
    if (!this.exec) throw new Error("CONNECTION_FAILED: mssql connection is not established");
    return this.exec;
  }

  rewriteParams(canonicalSql: string): string {
    return rewriteToNamed(canonicalSql);
  }

  paginate(sql: string, limit: number, offset: number): string {
    const trimmed = sql.replace(/;\s*$/, "");
    // MSSQL OFFSET/FETCH is part of the ORDER BY clause and cannot wrap a derived table
    // that carries its own ORDER BY (T-SQL error 1033). Append the window to the caller's
    // query instead. OFFSET/FETCH requires an ORDER BY, so inject a no-op one when absent.
    // Heuristic limitation: a query whose ONLY ORDER BY sits inside a subquery should carry
    // a top-level ORDER BY for stable pages (documented in the PR).
    const hasOrderBy = /\border\s+by\b/i.test(trimmed);
    const order = hasOrderBy ? "" : " ORDER BY (SELECT NULL)";
    return `${trimmed}${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  quoteIdent(name: string): string {
    assertValidIdent(name);
    return quoteIdentMssql(name);
  }

  async query(sql: string, params: unknown[]): Promise<QueryResult> {
    const exec = this.require();
    // No READ ONLY tx in MSSQL: bracket in a tx we always roll back (SELECTs unaffected;
    // any stray write is undone). Classifier is the primary guard on the read path.
    await exec.run("BEGIN TRAN", []);
    try {
      const r = await exec.run(sql, params);
      await exec.run("ROLLBACK", []);
      const columns = r.rows.length > 0 ? Object.keys(r.rows[0]!) : [];
      return { columns, rows: r.rows };
    } catch (e) {
      try { await exec.run("ROLLBACK", []); } catch { /* original error wins */ }
      throw e;
    }
  }

  async execute(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    return { rowCount: (await this.require().run(sql, params)).rowCount };
  }

  async executeBatch(statements: BatchStatement[]): Promise<Array<{ rowCount: number }>> {
    const exec = this.require();
    await exec.run("BEGIN TRAN", []);
    try {
      const results: Array<{ rowCount: number }> = [];
      for (const s of statements) {
        // Handler (src/tools/execute_batch.ts) already rewrote $n→@pN via dialect.rewriteParams;
        // do NOT rewrite again here — exactly one rewrite.
        const r = await exec.run(s.sql, s.params ?? []);
        results.push({ rowCount: r.rowCount });
      }
      await exec.run("COMMIT", []);
      return results;
    } catch (e) {
      try { await exec.run("ROLLBACK", []); } catch { /* original error wins */ }
      throw e;
    }
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.require().run(
      "SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin','db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter','db_denydatareader','db_denydatawriter') ORDER BY name",
      [],
    );
    return r.rows.map((row) => String(row.name));
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const r = await this.require().run(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') AND (@p1 IS NULL OR TABLE_SCHEMA = @p1)
       ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      [schema ?? null],
    );
    return r.rows.map((row) => ({
      name: String(row.TABLE_NAME),
      type: String(row.TABLE_TYPE) === "VIEW" ? ("view" as const) : ("table" as const),
      schema: String(row.TABLE_SCHEMA),
    }));
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    assertValidIdent(table);
    const r = await this.require().run(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PK
         FROM INFORMATION_SCHEMA.COLUMNS c
         LEFT JOIN (
           SELECT kcu.COLUMN_NAME, kcu.TABLE_NAME, kcu.TABLE_SCHEMA
             FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
               ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
         ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME AND pk.TABLE_NAME = c.TABLE_NAME AND pk.TABLE_SCHEMA = c.TABLE_SCHEMA
        WHERE c.TABLE_NAME = @p1 AND (@p2 IS NULL OR c.TABLE_SCHEMA = @p2)
        ORDER BY c.ORDINAL_POSITION`,
      [table, schema ?? null],
    );
    return r.rows.map((row) => ({
      name: String(row.COLUMN_NAME),
      type: String(row.DATA_TYPE),
      nullable: String(row.IS_NULLABLE) === "YES",
      default: row.COLUMN_DEFAULT == null ? null : String(row.COLUMN_DEFAULT),
      primaryKey: row.IS_PK === 1 || row.IS_PK === true,
    }));
  }
}

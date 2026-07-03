// src/dialect/mssql.ts
import type { AccessScope } from "../config.js";
import type { ClassifyHooks } from "../classifier.js";
import { assertValidIdent, quoteIdentMssql } from "../identifiers.js";
import { rewriteToNamed, inferTdsType } from "./mssql-params.js";
import type { BatchStatement, ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";

// Seam: execute a (already-@pN-rewritten) statement with ordered params; return rows + count.
export interface MssqlExecutor {
  run(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}
export type MssqlExecutorFactory = (dsn: string, opts: { readOnly: boolean; statementTimeoutMs: number }) => MssqlExecutor;
export type MssqlTediousDriver = Pick<typeof import("tedious"), "Connection" | "Request">;

export const createMssqlExecutorFactory = ({ Connection, Request }: MssqlTediousDriver): MssqlExecutorFactory => (dsn, opts) => {
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
  let txConn: import("tedious").Connection | null = null;

  // A single tedious connection permits only one in-flight request. Serialize every TDS
  // request (connection creation, queries, AND transaction-control) through a promise
  // chain so concurrent MCP calls queue cleanly instead of hitting "another request is
  // currently in progress".
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const result = chain.then(op, op);
    chain = result.then(() => undefined, () => undefined);
    return result;
  };

  const normalizeError = (err: unknown, fallback: string): Error =>
    err instanceof Error ? err : new Error(err == null ? fallback : String(err));

  const discardConnection = (c: import("tedious").Connection, close: boolean): void => {
    if (conn === c) conn = null;
    if (close) {
      try { c.close(); } catch { /* discard best-effort */ }
    }
  };
  const isLoggedIn = (c: import("tedious").Connection): boolean => {
    const stateName = (c as { state?: { name?: string } }).state?.name;
    return stateName === "LoggedIn";
  };

  const openConnection = (): Promise<import("tedious").Connection> =>
    new Promise<import("tedious").Connection>((resolve, reject) => {
      const c = new Connection(config);
      let settled = false;

      const fail = (err: unknown, close = true): void => {
        if (settled) return;
        settled = true;
        discardConnection(c, close);
        reject(normalizeError(err, "CONNECTION_FAILED: mssql connection failed"));
      };

      c.on("connect", (err) => {
        if (err) {
          fail(err);
          return;
        }
        if (conn !== c) {
          fail(new Error("CONNECTION_FAILED: mssql connection closed while connecting"), true);
          return;
        }
        settled = true;
        resolve(c);
      });
      c.on("end", () => {
        if (settled) {
          discardConnection(c, false);
        } else {
          fail(new Error("CONNECTION_FAILED: mssql connection ended before connect completed"), false);
        }
      });
      c.on("error", (err) => {
        if (settled) {
          discardConnection(c, true);
        } else {
          fail(err);
        }
      });

      conn = c;
      c.connect();
    });

  const getConnection = (): Promise<import("tedious").Connection> => {
    if (conn) {
      if (isLoggedIn(conn)) return Promise.resolve(conn);
      discardConnection(conn, true);
    }
    return openConnection();
  };
  const getRequestConnection = (): Promise<import("tedious").Connection> => {
    if (!txConn) return getConnection();
    if (conn === txConn && isLoggedIn(txConn)) return Promise.resolve(txConn);
    throw new Error("CONNECTION_FAILED: mssql transaction connection was lost");
  };
  const getTransactionControlConnection = async (): Promise<import("tedious").Connection> => {
    if (!txConn) return getConnection();
    if (conn === txConn && isLoggedIn(txConn)) return txConn;
    txConn = null;
    throw new Error("CONNECTION_FAILED: mssql transaction connection was lost");
  };
  const finishTransaction = (
    c: import("tedious").Connection,
    complete: (cb: (e?: Error | null) => void) => void,
  ): Promise<void> =>
    new Promise<void>((res, rej) => {
      const done = (e?: Error | null): void => {
        if (txConn === c) txConn = null;
        if (e) {
          if (isStaleConnectionError(e)) discardConnection(c, true);
          rej(e);
        } else {
          res();
        }
      };
      try {
        complete(done);
      } catch (e) {
        done(normalizeError(e, "CONNECTION_FAILED: mssql transaction completion failed"));
      }
    });

  const isStaleConnectionError = (err: Error): boolean =>
    /not connected/i.test(err.message) || /Requests can only be made in the LoggedIn state/i.test(err.message);

  const runRaw = (c: import("tedious").Connection, sql: string, params: unknown[]) =>
    new Promise<{ rows: Record<string, unknown>[]; rowCount: number }>((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      const req = new Request(sql, (err, rowCount) => {
        if (err) {
          if (isStaleConnectionError(err)) discardConnection(c, true);
          reject(err);
          return;
        }
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

  return {
    async run(sql, params) {
      return enqueue(async () => runRaw(await getRequestConnection(), sql, params));
    },
    async beginTransaction() {
      return enqueue(async () => {
        const c = await getConnection();
        return new Promise<void>((res, rej) =>
          c.beginTransaction((e?: Error | null) => {
            if (e) {
              if (isStaleConnectionError(e)) discardConnection(c, true);
              rej(e);
            } else {
              txConn = c;
              res();
            }
          }),
        );
      });
    },
    async commit() {
      return enqueue(async () => {
        const c = await getTransactionControlConnection();
        return finishTransaction(c, (done) => c.commitTransaction(done));
      });
    },
    async rollback() {
      return enqueue(async () => {
        const c = await getTransactionControlConnection();
        return finishTransaction(c, (done) => c.rollbackTransaction(done));
      });
    },
    async close() {
      // Close remains outside the queue so shutdown can interrupt a connecting or in-flight socket;
      // handlers above discard the same connection and reject queued work instead of reusing it.
      const c = conn ?? txConn;
      conn = null;
      txConn = null;
      c?.close();
    },
  };
};

const defaultFactory: MssqlExecutorFactory = (dsn, opts) =>
  createMssqlExecutorFactory(require("tedious") as typeof import("tedious"))(dsn, opts);

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
    // MSSQL OFFSET/FETCH is part of the ORDER BY clause and cannot wrap a derived table that
    // carries its own ORDER BY (T-SQL error 1033). Append the window to the caller's query and
    // inject a no-op ORDER BY only when there is no TOP-LEVEL one. Strip parenthesized groups
    // first so an ORDER BY that lives solely inside a subquery does not falsely suppress it.
    let outer = trimmed;
    let prev: string;
    do { prev = outer; outer = outer.replace(/\([^()]*\)/g, " "); } while (outer !== prev);
    const hasTopLevelOrderBy = /\border\s+by\b/i.test(outer);
    const order = hasTopLevelOrderBy ? "" : " ORDER BY (SELECT NULL)";
    return `${trimmed}${order} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  quoteIdent(name: string): string {
    assertValidIdent(name);
    return quoteIdentMssql(name);
  }

  async query(sql: string, params: unknown[]): Promise<QueryResult> {
    const exec = this.require();
    // MSSQL has no READ ONLY tx; bracket the read in a transaction we always roll back so any
    // stray write is undone. Classifier is the primary read-path guard. Native tedious tx
    // methods keep @@TRANCOUNT consistent (raw BEGIN TRAN/ROLLBACK strings corrupt it → err 266).
    await exec.beginTransaction();
    try {
      const r = await exec.run(sql, params);
      // A rollback failure here (e.g. socket drop after a successful read) must not lose the rows.
      try { await exec.rollback(); } catch { /* keep the successful result */ }
      const columns = r.rows.length > 0 ? Object.keys(r.rows[0]!) : [];
      return { columns, rows: r.rows };
    } catch (e) {
      try { await exec.rollback(); } catch { /* original error wins */ }
      throw e;
    }
  }

  async execute(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    return { rowCount: (await this.require().run(sql, params)).rowCount };
  }

  async executeBatch(statements: BatchStatement[]): Promise<Array<{ rowCount: number }>> {
    const exec = this.require();
    await exec.beginTransaction();
    try {
      const results: Array<{ rowCount: number }> = [];
      for (const s of statements) {
        // Handler (src/tools/execute_batch.ts) already rewrote $n→@pN; do NOT rewrite again.
        const r = await exec.run(s.sql, s.params ?? []);
        results.push({ rowCount: r.rowCount });
      }
      await exec.commit();
      return results;
    } catch (e) {
      try { await exec.rollback(); } catch { /* original error wins */ }
      throw e;
    }
  }

  // Introspection deliberately skips the read-tx bracket used by query(): these are
  // read-only system-catalog SELECTs (sys.* / INFORMATION_SCHEMA) with nothing to roll back.
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

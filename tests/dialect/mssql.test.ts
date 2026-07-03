import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import {
  createMssqlExecutorFactory,
  MssqlDialect,
  type MssqlExecutor,
  type MssqlExecutorFactory,
} from "../../src/dialect/mssql.js";

interface Call { sql: string; params: unknown[]; }
function fakeExecutor(rowsFor: (sql: string) => any[]): { exec: MssqlExecutor; calls: Call[]; tx: string[] } {
  const calls: Call[] = [];
  const tx: string[] = [];
  const exec: MssqlExecutor = {
    async run(sql, params) { calls.push({ sql, params }); const rows = rowsFor(sql); return { rows, rowCount: rows.length }; },
    async beginTransaction() { tx.push("begin"); },
    async commit() { tx.push("commit"); },
    async rollback() { tx.push("rollback"); },
    async close() {},
  };
  return { exec, calls, tx };
}
const factory = (exec: MssqlExecutor): MssqlExecutorFactory => () => exec;

function fakeTedious(opts: { requestDelayMs?: number } = {}) {
  type RequestCallback = (err?: Error | null, rowCount?: number) => void;
  const connections: any[] = [];
  let nextConnectionId = 1;

  class FakeRequest extends EventEmitter {
    readonly parameters: Array<{ name: string; type: unknown; value: unknown }> = [];

    constructor(
      readonly sql: string,
      readonly callback: RequestCallback,
    ) {
      super();
    }

    addParameter(name: string, type: unknown, value: unknown): void {
      this.parameters.push({ name, type, value });
    }
  }

  class FakeConnection extends EventEmitter {
    readonly id: number;
    readonly config: unknown;
    state = { name: "Initialized" };
    closed = false;
    failNextRequest: Error | null = null;
    inFlight = 0;
    maxInFlight = 0;

    constructor(config: unknown) {
      super();
      this.id = nextConnectionId;
      nextConnectionId += 1;
      this.config = config;
      connections.push(this);
    }

    connect(): void {
      queueMicrotask(() => {
        this.state = { name: "LoggedIn" };
        this.emit("connect");
      });
    }

    execSql(req: FakeRequest): void {
      if (this.failNextRequest) {
        const err = this.failNextRequest;
        this.failNextRequest = null;
        queueMicrotask(() => req.callback(err));
        return;
      }
      if (this.closed) {
        queueMicrotask(() => req.callback(new Error("Not connected")));
        return;
      }
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      req.emit("row", [{ metadata: { colName: "connectionId" }, value: this.id }]);
      const finish = () => {
        this.inFlight -= 1;
        req.callback(null, 1);
      };
      if (opts.requestDelayMs) setTimeout(finish, opts.requestDelayMs);
      else queueMicrotask(finish);
    }

    beginTransaction(cb: (err?: Error | null) => void): void {
      queueMicrotask(() => cb(this.closed ? new Error("Not connected") : null));
    }

    commitTransaction(cb: (err?: Error | null) => void): void {
      queueMicrotask(() => cb(this.closed ? new Error("Not connected") : null));
    }

    rollbackTransaction(cb: (err?: Error | null) => void): void {
      queueMicrotask(() => cb(this.closed ? new Error("Not connected") : null));
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.state = { name: "Final" };
      this.emit("end");
    }
  }

  const driver = { Connection: FakeConnection, Request: FakeRequest } as any;
  const createExecutor = () =>
    createMssqlExecutorFactory(driver)("mssql://sa:password@localhost:1433/app", {
      readOnly: false,
      statementTimeoutMs: 1_000,
    });
  return { connections, createExecutor };
}

describe("MssqlDialect", () => {
  it("paramStyle is @p and rewriteParams maps $n -> @pn", () => {
    const d = new MssqlDialect("readonly", factory(fakeExecutor(() => []).exec));
    expect(d.paramStyle).toBe("@p");
    expect(d.rewriteParams("SELECT $1, $2")).toBe("SELECT @p1, @p2");
  });

  it("classify hooks treat MERGE as DML; statement timeout supported", () => {
    const d = new MssqlDialect("dml", factory(fakeExecutor(() => []).exec));
    expect(d.classifyHooks.extraDml).toContain("merge");
    expect(d.supportsStatementTimeout).toBe(true);
  });

  it("query brackets the read in a transaction it always rolls back (no READ ONLY modifier in MSSQL)", async () => {
    const { exec, tx } = fakeExecutor((sql) =>
      sql.includes("DATABASEPROPERTYEX") ? [{ u: "READ_ONLY" }] : sql.includes("SELECT id") ? [{ id: 1 }] : [],
    );
    const d = new MssqlDialect("readonly", factory(exec));
    await d.connect("mssql://sa:p@h/db");
    const r = await d.query("SELECT id FROM users", []);
    expect(r.columns).toEqual(["id"]);
    expect(tx).toEqual(["begin", "rollback"]);
  });

  it("quoteIdent bracket-quotes and rejects injection", () => {
    const d = new MssqlDialect("full", factory(fakeExecutor(() => []).exec));
    expect(d.quoteIdent("users")).toBe("[users]");
    expect(() => d.quoteIdent("a]b")).toThrow();
  });

  it("default tedious executor reconnects lazily after an idle end event", async () => {
    const tedious = fakeTedious();
    const exec = tedious.createExecutor();

    const first = await exec.run("SELECT 1", []);
    tedious.connections[0]!.emit("end");
    const second = await exec.run("SELECT 2", []);

    expect(first.rows).toEqual([{ connectionId: 1 }]);
    expect(second.rows).toEqual([{ connectionId: 2 }]);
    expect(tedious.connections).toHaveLength(2);
  });

  it("default tedious executor reconnects lazily after a dead connection state", async () => {
    const tedious = fakeTedious();
    const exec = tedious.createExecutor();

    await expect(exec.run("SELECT 1", [])).resolves.toMatchObject({ rows: [{ connectionId: 1 }] });
    tedious.connections[0]!.state = { name: "Final" };
    await expect(exec.run("SELECT 2", [])).resolves.toMatchObject({ rows: [{ connectionId: 2 }] });

    expect(tedious.connections[0]!.closed).toBe(true);
    expect(tedious.connections).toHaveLength(2);
  });

  it("default tedious executor reconnects lazily after a connection error", async () => {
    const tedious = fakeTedious();
    const exec = tedious.createExecutor();

    await expect(exec.run("SELECT 1", [])).resolves.toMatchObject({ rows: [{ connectionId: 1 }] });
    tedious.connections[0]!.emit("error", new Error("socket dropped"));
    await expect(exec.run("SELECT 2", [])).resolves.toMatchObject({ rows: [{ connectionId: 2 }] });

    expect(tedious.connections[0]!.closed).toBe(true);
    expect(tedious.connections).toHaveLength(2);
  });

  it("default tedious executor reconnects after a request-level not connected error", async () => {
    const tedious = fakeTedious();
    const exec = tedious.createExecutor();

    await expect(exec.run("SELECT 1", [])).resolves.toMatchObject({ rows: [{ connectionId: 1 }] });
    tedious.connections[0]!.failNextRequest = new Error("Not connected");
    await expect(exec.run("SELECT 2", [])).rejects.toThrow("Not connected");
    await expect(exec.run("SELECT 3", [])).resolves.toMatchObject({ rows: [{ connectionId: 2 }] });

    expect(tedious.connections[0]!.closed).toBe(true);
    expect(tedious.connections).toHaveLength(2);
  });

  it("default tedious executor close resets lifecycle state for the next request", async () => {
    const tedious = fakeTedious();
    const exec = tedious.createExecutor();

    await expect(exec.run("SELECT 1", [])).resolves.toMatchObject({ rows: [{ connectionId: 1 }] });
    await exec.close();
    await expect(exec.run("SELECT 2", [])).resolves.toMatchObject({ rows: [{ connectionId: 2 }] });

    expect(tedious.connections[0]!.closed).toBe(true);
    expect(tedious.connections).toHaveLength(2);
  });

  it("default tedious executor keeps requests serialized while reconnect-capable", async () => {
    const tedious = fakeTedious({ requestDelayMs: 5 });
    const exec = tedious.createExecutor();

    await Promise.all([exec.run("SELECT 1", []), exec.run("SELECT 2", [])]);

    expect(tedious.connections).toHaveLength(1);
    expect(tedious.connections[0]!.maxInFlight).toBe(1);
  });

  it("default tedious executor does not reconnect in the middle of a transaction", async () => {
    const tedious = fakeTedious();
    const exec = tedious.createExecutor();

    await exec.beginTransaction();
    tedious.connections[0]!.close();
    await expect(exec.run("SELECT 1", [])).rejects.toThrow("transaction connection was lost");
    await expect(exec.rollback()).rejects.toThrow("transaction connection was lost");
    await expect(exec.run("SELECT 2", [])).resolves.toMatchObject({ rows: [{ connectionId: 2 }] });

    expect(tedious.connections).toHaveLength(2);
  });
});

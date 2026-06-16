# SQL MCP Server — Phase 2: Write scope on SQLite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scope-gated write capability to the SQLite MCP server: `sql.execute` (DML), `sql.execute_batch` (atomic multi-DML), and `sql.execute_ddl` (DDL), enforced by the existing classifier + per-instance access scope.

**Architecture:** Extends the Phase 1 `Dialect` interface with `execute` and `executeBatch`; the SQLite dialect opens a writable connection for `dml`/`full` scopes (read-only otherwise — already wired). Three new tool handlers reuse the shared classifier for class-gating; `sql.execute_batch` classifies **every** statement before opening a single `BEGIN`/…/`COMMIT` and rolls back atomically on failure. Registration is scope-gated: `dml` adds `execute` + `execute_batch`; `full` adds `execute_ddl` too.

**Tech Stack:** Same as Phase 1 — TypeScript, Bun, `@modelcontextprotocol/sdk`, `zod`, `node:sqlite`, Vitest. Builds on the merged Phase 1 (`main` @ `0ea678b`).

**Spec:** `docs/specs/2026-06-16-sql-mcp-design.md` (§6 tool surface, §7 enforcement). **Out of scope:** handle-based transactions (`begin`/`commit`/`rollback`), server-side cursors, Postgres/MySQL/MSSQL adapters, statement-timeout enforcement (SQLite has no native cancellation in Node 24 — `feature_flags.statement_timeout` stays `false`, per §13).

---

## Preconditions

- Branch off the latest `main`: `git switch -c feat/phase-2-write-scope`.
- Phase 1 is merged: `src/dialect/{types,sqlite,index}.ts`, `src/tools/{register,query,capabilities,introspection}.ts`, `src/server.ts`, `src/{classifier,envelope,scrub,limits,config,identifiers}.ts` all exist and pass 53 tests.

---

## File structure (this phase)

```
src/dialect/types.ts          # MODIFY: add BatchStatement + execute/executeBatch to Dialect
src/dialect/sqlite.ts         # MODIFY: extend SqliteStatement/SqliteDb; implement execute/executeBatch
src/tools/execute.ts          # CREATE: sql.execute (DML) handler
src/tools/execute_ddl.ts      # CREATE: sql.execute_ddl (DDL) handler
src/tools/execute_batch.ts    # CREATE: sql.execute_batch (atomic multi-DML) handler
src/tools/register.ts         # MODIFY: add registerWriteTools(server, dialect, config)
src/server.ts                 # MODIFY: call registerWriteTools after registerReadTools
tests/dialect/sqlite-write.test.ts     # CREATE: unit (fake db) for execute/executeBatch
tests/tools/execute.test.ts            # CREATE
tests/tools/execute-ddl.test.ts        # CREATE
tests/tools/execute-batch.test.ts      # CREATE
tests/tools/register-write.test.ts     # CREATE: scope-gated registration
tests/integration/sqlite-write.live.test.ts  # CREATE: real writes, atomic rollback, DDL
```

---

## Task 1: Extend the `Dialect` interface + SQLite write methods

**Files:**
- Modify: `src/dialect/types.ts`, `src/dialect/sqlite.ts`
- Test: `tests/dialect/sqlite-write.test.ts`

- [ ] **Step 1: Write the failing test (fake db with run + exec)**

```ts
// tests/dialect/sqlite-write.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import type { SqliteDb } from "../../src/dialect/sqlite.js";

// Fake db recording exec() calls and returning a fixed change count from run().
function fakeDb(opts: { changes?: number; failOnSql?: string } = {}): { db: SqliteDb; calls: string[] } {
  const calls: string[] = [];
  const db: SqliteDb = {
    prepare(sql: string) {
      return {
        all: () => [],
        run: (..._params: unknown[]) => {
          calls.push(`run:${sql}`);
          if (opts.failOnSql && sql === opts.failOnSql) throw new Error("constraint failed");
          return { changes: opts.changes ?? 1 };
        },
      };
    },
    exec: (sql: string) => { calls.push(`exec:${sql}`); },
    close() {},
  };
  return { db, calls };
}

describe("SqliteDialect (write)", () => {
  it("execute() returns the changed row count", async () => {
    const { db } = fakeDb({ changes: 3 });
    const d = new SqliteDialect("dml", () => db);
    await d.connect(":memory:");
    expect(await d.execute("UPDATE t SET a=?", [1])).toEqual({ rowCount: 3 });
  });

  it("executeBatch() wraps statements in BEGIN/COMMIT and returns per-statement counts", async () => {
    const { db, calls } = fakeDb({ changes: 1 });
    const d = new SqliteDialect("dml", () => db);
    await d.connect(":memory:");
    const res = await d.executeBatch([
      { sql: "INSERT INTO t VALUES (?)", params: [1] },
      { sql: "INSERT INTO t VALUES (?)", params: [2] },
    ]);
    expect(res).toEqual([{ rowCount: 1 }, { rowCount: 1 }]);
    expect(calls[0]).toBe("exec:BEGIN");
    expect(calls[calls.length - 1]).toBe("exec:COMMIT");
    expect(calls).not.toContain("exec:ROLLBACK");
  });

  it("executeBatch() rolls back and rethrows when a statement fails", async () => {
    const failSql = "INSERT INTO t VALUES (2)";
    const { db, calls } = fakeDb({ failOnSql: failSql });
    const d = new SqliteDialect("dml", () => db);
    await d.connect(":memory:");
    await expect(
      d.executeBatch([{ sql: "INSERT INTO t VALUES (1)" }, { sql: failSql }]),
    ).rejects.toThrow(/constraint/);
    expect(calls).toContain("exec:ROLLBACK");
    expect(calls).not.toContain("exec:COMMIT");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/peteralbert/repos/skaile/sql-mcp && bun run test -- sqlite-write`
Expected: FAIL — `execute`/`executeBatch` not on `SqliteDialect`; `SqliteDb` has no `exec`, `SqliteStatement` has no `run`.

- [ ] **Step 3: Extend `src/dialect/types.ts`**

Add the `BatchStatement` type and two methods to the `Dialect` interface. Update the doc comment.

```ts
// src/dialect/types.ts  — replace the interface doc comment + add members

export interface BatchStatement {
  sql: string;
  params?: unknown[];
}

/** Read + write subset of the Dialect contract. Handle-based transactions and server-side
 *  cursors remain out of scope (v2 of the broader roadmap). */
export interface Dialect {
  readonly name: DialectName;
  readonly paramStyle: "$n" | "?" | "@p";
  connect(dsn: string): Promise<void>;
  close(): Promise<void>;
  rewriteParams(canonicalSql: string): string;
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
```

- [ ] **Step 4: Extend `src/dialect/sqlite.ts`**

Extend the `SqliteStatement`/`SqliteDb` seams and implement the two methods. Apply these edits:

Replace the `SqliteStatement`/`SqliteDb` interfaces:

```ts
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number };
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
```

Add `BatchStatement` to the type import:

```ts
import type { BatchStatement, ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";
```

Add these two methods to the `SqliteDialect` class (e.g. right after `query`):

```ts
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
      db.exec("ROLLBACK");
      throw e;
    }
  }
```

> Note: the `defaultFactory` already opens the DB writable when `access !== "readonly"` (the existing `readOnly: this.access === "readonly"` in `connect`). No connect change is needed.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- sqlite-write`
Expected: PASS (3 tests).

- [ ] **Step 6: Run full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: all pass (now 56); typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/dialect/types.ts src/dialect/sqlite.ts tests/dialect/sqlite-write.test.ts
git commit -m "feat: Dialect execute/executeBatch + SQLite write methods"
```

---

## Task 2: `sql.execute` handler (DML)

**Files:**
- Create: `src/tools/execute.ts`
- Test: `tests/tools/execute.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/execute.test.ts
import { describe, it, expect } from "vitest";
import { handleExecute } from "../../src/tools/execute.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "dml",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};

function fakeDialect(over: Partial<Dialect> = {}): Dialect {
  return {
    name: "sqlite", paramStyle: "?", connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s.replace(/\$\d+/g, "?"), quoteIdent: (n) => `"${n}"`,
    query: async () => ({ columns: [], rows: [] }),
    execute: async () => ({ rowCount: 1 }),
    executeBatch: async () => [],
    listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
    ...over,
  };
}

describe("handleExecute", () => {
  it("runs a DML statement and returns rowCount", async () => {
    const env = await handleExecute(fakeDialect({ execute: async () => ({ rowCount: 4 }) }), config, {
      sql: "UPDATE t SET a = $1 WHERE id = $2", params: [1, 2],
    });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.rowCount).toBe(4);
  });

  it("rejects a SELECT with ACCESS_DENIED", async () => {
    const env = await handleExecute(fakeDialect(), config, { sql: "SELECT * FROM t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects DDL with ACCESS_DENIED", async () => {
    const env = await handleExecute(fakeDialect(), config, { sql: "DROP TABLE t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects multiple statements with ACCESS_DENIED", async () => {
    const env = await handleExecute(fakeDialect(), config, { sql: "UPDATE t SET a=1; DROP TABLE t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("scrubs a driver error message", async () => {
    const env = await handleExecute(
      fakeDialect({ execute: async () => { throw new Error("fail postgres://u:p@h/db"); } }),
      config, { sql: "DELETE FROM t" },
    );
    if (env.status !== "error") throw new Error("expected error");
    expect(env.error).not.toContain(":p@");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- tools/execute.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools/execute.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { ok, err, type Envelope } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

const TOOL = "sql.execute";

export interface ExecuteInput {
  sql: string;
  params?: unknown[];
}

export async function handleExecute(
  dialect: Dialect,
  _config: Config,
  input: ExecuteInput,
): Promise<Envelope<{ rowCount: number }>> {
  const cls = classify(input.sql);
  if (cls.class !== "dml") {
    return err(TOOL, "ACCESS_DENIED", `sql.execute accepts a single DML statement only (got ${cls.class})`);
  }
  try {
    const native = dialect.rewriteParams(input.sql);
    return ok(TOOL, await dialect.execute(native, input.params ?? []));
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", safeErrorMessage(e));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- tools/execute.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/execute.ts tests/tools/execute.test.ts
git commit -m "feat: sql.execute (DML) handler"
```

---

## Task 3: `sql.execute_ddl` handler (DDL)

**Files:**
- Create: `src/tools/execute_ddl.ts`
- Test: `tests/tools/execute-ddl.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/execute-ddl.test.ts
import { describe, it, expect } from "vitest";
import { handleExecuteDdl } from "../../src/tools/execute_ddl.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "full",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};
function fakeDialect(over: Partial<Dialect> = {}): Dialect {
  return {
    name: "sqlite", paramStyle: "?", connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s, quoteIdent: (n) => `"${n}"`,
    query: async () => ({ columns: [], rows: [] }),
    execute: async () => ({ rowCount: 0 }), executeBatch: async () => [],
    listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
    ...over,
  };
}

describe("handleExecuteDdl", () => {
  it("runs a DDL statement", async () => {
    const env = await handleExecuteDdl(fakeDialect(), config, { sql: "CREATE TABLE t (id INTEGER)" });
    expect(env.status).toBe("success");
  });

  it("rejects DML with ACCESS_DENIED", async () => {
    const env = await handleExecuteDdl(fakeDialect(), config, { sql: "DELETE FROM t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects SELECT with ACCESS_DENIED", async () => {
    const env = await handleExecuteDdl(fakeDialect(), config, { sql: "SELECT 1" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- execute-ddl`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools/execute_ddl.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { ok, err, type Envelope } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

const TOOL = "sql.execute_ddl";

export interface ExecuteDdlInput {
  sql: string;
  params?: unknown[];
}

export async function handleExecuteDdl(
  dialect: Dialect,
  _config: Config,
  input: ExecuteDdlInput,
): Promise<Envelope<{ rowCount: number }>> {
  const cls = classify(input.sql);
  if (cls.class !== "ddl") {
    return err(TOOL, "ACCESS_DENIED", `sql.execute_ddl accepts a single DDL statement only (got ${cls.class})`);
  }
  try {
    const native = dialect.rewriteParams(input.sql);
    return ok(TOOL, await dialect.execute(native, input.params ?? []));
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", safeErrorMessage(e));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- execute-ddl`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/execute_ddl.ts tests/tools/execute-ddl.test.ts
git commit -m "feat: sql.execute_ddl (DDL) handler"
```

---

## Task 4: `sql.execute_batch` handler (atomic multi-DML)

Classifies **every** statement before any executes; any non-DML rejects the whole batch and nothing runs (spec §6).

**Files:**
- Create: `src/tools/execute_batch.ts`
- Test: `tests/tools/execute-batch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/execute-batch.test.ts
import { describe, it, expect, vi } from "vitest";
import { handleExecuteBatch } from "../../src/tools/execute_batch.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "dml",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};
function fakeDialect(over: Partial<Dialect> = {}): Dialect {
  return {
    name: "sqlite", paramStyle: "?", connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s.replace(/\$\d+/g, "?"), quoteIdent: (n) => `"${n}"`,
    query: async () => ({ columns: [], rows: [] }),
    execute: async () => ({ rowCount: 0 }),
    executeBatch: async (stmts) => stmts.map(() => ({ rowCount: 1 })),
    listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
    ...over,
  };
}

describe("handleExecuteBatch", () => {
  it("runs an all-DML batch and returns a positional array", async () => {
    const env = await handleExecuteBatch(fakeDialect(), config, {
      statements: [{ sql: "INSERT INTO t VALUES ($1)", params: [1] }, { sql: "UPDATE t SET a=2" }],
    });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.results).toEqual([{ rowCount: 1 }, { rowCount: 1 }]);
  });

  it("rejects the WHOLE batch (nothing executes) if any statement is not DML", async () => {
    const executeBatch = vi.fn(async () => [] as Array<{ rowCount: number }>);
    const env = await handleExecuteBatch(fakeDialect({ executeBatch }), config, {
      statements: [{ sql: "INSERT INTO t VALUES (1)" }, { sql: "DROP TABLE t" }],
    });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it("rejects an empty batch with VALIDATION_ERROR", async () => {
    const env = await handleExecuteBatch(fakeDialect(), config, { statements: [] });
    expect(env).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
  });

  it("returns an error envelope (rolled back) when the dialect throws", async () => {
    const env = await handleExecuteBatch(
      fakeDialect({ executeBatch: async () => { throw new Error("constraint at host postgres://u:p@h/db"); } }),
      config, { statements: [{ sql: "INSERT INTO t VALUES (1)" }] },
    );
    if (env.status !== "error") throw new Error("expected error");
    expect(env.code).toBe("TOOL_EXECUTION_ERROR");
    expect(env.error).not.toContain(":p@"); // scrubbed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- execute-batch`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools/execute_batch.ts
import type { Config } from "../config.js";
import type { Dialect, BatchStatement } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { ok, err, type Envelope } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

const TOOL = "sql.execute_batch";

export interface ExecuteBatchInput {
  statements: BatchStatement[];
}

export async function handleExecuteBatch(
  dialect: Dialect,
  _config: Config,
  input: ExecuteBatchInput,
): Promise<Envelope<{ results: Array<{ rowCount: number }> }>> {
  if (!input.statements || input.statements.length === 0) {
    return err(TOOL, "VALIDATION_ERROR", "execute_batch requires at least one statement");
  }

  // Classify EVERY statement before anything executes; any non-DML rejects the whole batch.
  for (let i = 0; i < input.statements.length; i++) {
    const cls = classify(input.statements[i]!.sql);
    if (cls.class !== "dml") {
      return err(TOOL, "ACCESS_DENIED", `statement ${i} is not DML (got ${cls.class}); batch rejected`);
    }
  }

  const native: BatchStatement[] = input.statements.map((s) => ({
    sql: dialect.rewriteParams(s.sql),
    params: s.params ?? [],
  }));

  try {
    return ok(TOOL, { results: await dialect.executeBatch(native) });
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", safeErrorMessage(e));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- execute-batch`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/execute_batch.ts tests/tools/execute-batch.test.ts
git commit -m "feat: sql.execute_batch (atomic multi-DML) handler"
```

---

## Task 5: Scope-gated registration + server wiring

**Files:**
- Modify: `src/tools/register.ts`, `src/server.ts`
- Test: `tests/tools/register-write.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/register-write.test.ts
import { describe, it, expect } from "vitest";
import { registerWriteTools, type ToolRegistrar } from "../../src/tools/register.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config, AccessScope } from "../../src/config.js";

const dialect: Dialect = {
  name: "sqlite", paramStyle: "?", connect: async () => {}, close: async () => {},
  rewriteParams: (s) => s, quoteIdent: (n) => `"${n}"`,
  query: async () => ({ columns: [], rows: [] }),
  execute: async () => ({ rowCount: 1 }), executeBatch: async () => [{ rowCount: 1 }],
  listSchemas: async () => [], listTables: async () => [], describeTable: async () => [],
};
function configFor(access: AccessScope): Config {
  return { dialect: "sqlite", dsn: ":memory:", access, maxRows: 1000, maxResultBytes: 1, statementTimeoutMs: 1, cursorSecret: "s" };
}
function registrarSpy() {
  const names: string[] = [];
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const reg: ToolRegistrar = { registerTool(name, _def, h) { names.push(name); handlers[name] = h; } };
  return { reg, names, handlers };
}

describe("registerWriteTools (scope-gated)", () => {
  it("registers nothing for a readonly instance", () => {
    const { reg, names } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("readonly"));
    expect(names).toEqual([]);
  });

  it("registers execute + execute_batch (not execute_ddl) for dml", () => {
    const { reg, names } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("dml"));
    expect(names.sort()).toEqual(["sql.execute", "sql.execute_batch"].sort());
  });

  it("registers all three write tools for full", () => {
    const { reg, names } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("full"));
    expect(names.sort()).toEqual(["sql.execute", "sql.execute_batch", "sql.execute_ddl"].sort());
  });

  it("registered sql.execute returns JSON envelope content", async () => {
    const { reg, handlers } = registrarSpy();
    registerWriteTools(reg, dialect, configFor("dml"));
    const res = await handlers["sql.execute"]!({ sql: "UPDATE t SET a=1" });
    const env = JSON.parse(res.content[0].text);
    expect(env).toMatchObject({ status: "success", tool_name: "sql.execute", data: { rowCount: 1 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- register-write`
Expected: FAIL — `registerWriteTools` is not exported.

- [ ] **Step 3: Modify `src/tools/register.ts`**

Add imports for the three new handlers near the existing handler imports:

```ts
import { handleExecute } from "./execute.js";
import { handleExecuteDdl } from "./execute_ddl.js";
import { handleExecuteBatch } from "./execute_batch.js";
import { z } from "zod"; // already imported at top; do not duplicate
```

Append the new export (reusing the existing `wrap`, `ToolRegistrar`, and `z`):

```ts
export function registerWriteTools(server: ToolRegistrar, dialect: Dialect, config: Config): void {
  if (config.access === "readonly") return; // no write tools for read-only instances

  server.registerTool(
    "sql.execute",
    {
      description: "Run a single DML statement (INSERT/UPDATE/DELETE). Parameterized ($1,$2). Auto-commits.",
      inputSchema: { sql: z.string(), params: z.array(z.unknown()).optional() },
    },
    wrap("sql.execute", (a) => handleExecute(dialect, config, a)),
  );

  server.registerTool(
    "sql.execute_batch",
    {
      description:
        "Run an ordered array of DML statements atomically (one BEGIN/COMMIT). All statements are classified before any executes; any non-DML rejects the whole batch.",
      inputSchema: {
        statements: z.array(z.object({ sql: z.string(), params: z.array(z.unknown()).optional() })),
      },
    },
    wrap("sql.execute_batch", (a) => handleExecuteBatch(dialect, config, a)),
  );

  if (config.access === "full") {
    server.registerTool(
      "sql.execute_ddl",
      {
        description: "Run a single DDL statement (CREATE/ALTER/DROP/TRUNCATE). Only available at `full` scope.",
        inputSchema: { sql: z.string(), params: z.array(z.unknown()).optional() },
      },
      wrap("sql.execute_ddl", (a) => handleExecuteDdl(dialect, config, a)),
    );
  }
}
```

- [ ] **Step 4: Modify `src/server.ts`**

Add the import and the call (after `registerReadTools`):

```ts
import { registerReadTools, registerWriteTools } from "./tools/register.js";
// ...
  registerReadTools(server, dialect, config);
  registerWriteTools(server, dialect, config); // no-op for readonly; gates internally
```

- [ ] **Step 5: Run test + typecheck**

Run: `bun run test -- register-write && bun run typecheck`
Expected: PASS (4 tests); typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools/register.ts src/server.ts tests/tools/register-write.test.ts
git commit -m "feat: scope-gated write-tool registration + server wiring"
```

---

## Task 6: Live SQLite write integration + smoke

**Files:**
- Test: `tests/integration/sqlite-write.live.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/sqlite-write.live.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleExecuteBatch } from "../../src/tools/execute_batch.js";
import { handleExecuteDdl } from "../../src/tools/execute_ddl.js";
import { handleQuery } from "../../src/tools/query.js";
import type { Config } from "../../src/config.js";

let dir: string;
let dbPath: string;
const cfg = (access: "dml" | "full"): Config => ({
  dialect: "sqlite", dsn: dbPath, access, maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlmcp-w-"));
  dbPath = join(dir, "w.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT NOT NULL)");
  seed.prepare("INSERT INTO t (id, n) VALUES (1, 'a')").run();
  seed.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SQLite live write integration", () => {
  it("execute INSERT/UPDATE/DELETE report row counts", async () => {
    const d = new SqliteDialect("dml"); await d.connect(dbPath);
    const ins = await handleExecute(d, cfg("dml"), { sql: "INSERT INTO t (id, n) VALUES ($1, $2)", params: [2, "b"] });
    expect(ins.status === "success" && ins.data.rowCount).toBe(1);
    const upd = await handleExecute(d, cfg("dml"), { sql: "UPDATE t SET n = $1", params: ["x"] });
    expect(upd.status === "success" && upd.data.rowCount).toBe(2);
    await d.close();
  });

  it("execute_batch is atomic — a failing statement rolls back the whole batch", async () => {
    const d = new SqliteDialect("dml"); await d.connect(dbPath);
    // Second insert violates the PK (id=1 already exists) → whole batch must roll back.
    const env = await handleExecuteBatch(d, cfg("dml"), {
      statements: [
        { sql: "INSERT INTO t (id, n) VALUES (5, 'e')" },
        { sql: "INSERT INTO t (id, n) VALUES (1, 'dup')" },
      ],
    });
    expect(env.status).toBe("error");
    // id=5 must NOT have been committed.
    const check = await handleQuery(d, cfg("dml"), { sql: "SELECT id FROM t WHERE id = 5" });
    expect(check.status === "success" && check.data.rows.length).toBe(0);
    await d.close();
  });

  it("execute_ddl creates and drops a table (full scope)", async () => {
    const d = new SqliteDialect("full"); await d.connect(dbPath);
    expect((await handleExecuteDdl(d, cfg("full"), { sql: "CREATE TABLE t2 (id INTEGER)" })).status).toBe("success");
    const listed = await handleQuery(d, cfg("full"), { sql: "SELECT name FROM sqlite_master WHERE name='t2'" });
    expect(listed.status === "success" && listed.data.rows.length).toBe(1);
    expect((await handleExecuteDdl(d, cfg("full"), { sql: "DROP TABLE t2" })).status).toBe("success");
    await d.close();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun run test -- sqlite-write.live`
Expected: PASS (3 tests).

- [ ] **Step 3: Full suite + typecheck + build**

Run: `bun run test && bun run typecheck && bun run build`
Expected: all tests pass (~66 total); typecheck exit 0; `Built dist/server.js`.

- [ ] **Step 4: Smoke-run that write tools appear at `full` scope**

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const fs=require("fs");try{fs.unlinkSync("/tmp/smoke-w.db")}catch{};const db=new DatabaseSync("/tmp/smoke-w.db");db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");db.close()'

printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SQL_MCP_DIALECT=sqlite SQL_MCP_DSN=/tmp/smoke-w.db SQL_MCP_ACCESS=full node dist/server.js
```

Expected: `tools/list` now lists **eight** tools — the five read tools plus `sql.execute`, `sql.execute_batch`, `sql.execute_ddl`. Re-running with `SQL_MCP_ACCESS=readonly` lists only the five read tools; `SQL_MCP_ACCESS=dml` lists seven (no `sql.execute_ddl`).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/sqlite-write.live.test.ts
git commit -m "test: live SQLite write integration (DML, atomic batch rollback, DDL)"
```

---

## Self-review (against the spec)

- **§6 write tools:** `sql.execute` (Task 2, DML-gated), `sql.execute_batch` (Task 4, classify-all-before-run, positional array, rollback→error), `sql.execute_ddl` (Task 3, DDL-gated). ✓
- **§6 scope gating:** Task 5 — `dml` → execute + execute_batch; `full` → + execute_ddl; `readonly` → none. ✓
- **§7 enforcement:** every write tool classifies and rejects out-of-class statements with `ACCESS_DENIED`; `execute_batch` rejects the whole batch before any execution; writable DB connection only for `dml`/`full` (read-only connection otherwise — Phase 1, unchanged). ✓
- **§9 envelope + scrubbing:** all handlers return the uniform envelope; driver errors routed through `safeErrorMessage`. ✓
- **§10 Dialect:** `execute` + `executeBatch` added to the interface and the SQLite dialect; `executeBatch` is the atomic transaction primitive. ✓
- **Capabilities (§6):** `feature_flags.write`/`ddl` already derive from `config.access` (Phase 1) — they now correctly advertise the registered tools; no change needed. `statement_timeout` stays `false` (not enforced on SQLite). ✓

**Placeholder scan:** none. **Type consistency:** `BatchStatement`, `Dialect.execute`/`executeBatch`, handler names (`handleExecute`, `handleExecuteDdl`, `handleExecuteBatch`), and `registerWriteTools` are defined once and reused across tasks; `execute_batch` returns `{ results: [{rowCount}] }` consistently in handler, test, and registration.

---

## Carryover (still deferred to later phases)

- Handle-based transactions (`begin`/`commit`/`rollback`) and server-side cursors — broader-roadmap v2.
- Postgres/MySQL/MSSQL adapters (Phase 3): wire `classify(sql, { extraDml: dialect.extraDml })` at the `handleExecute`/`handleExecuteBatch` callsites for `MERGE`; rewrite params on masked SQL; READ ONLY transactions on the read path.
- Statement-timeout enforcement on SQLite (§13).

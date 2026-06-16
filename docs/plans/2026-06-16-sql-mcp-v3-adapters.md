# SQL MCP — Phase 3: Networked Dialect Adapters (Postgres, MySQL, MSSQL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three remaining `Dialect` adapters — PostgreSQL (`pg`), MySQL (`mysql2`), MSSQL (`tedious`) — behind the existing dialect-agnostic tool surface, so the same `sql.*` tools work against all four engines selected purely by `SQL_MCP_DIALECT`.

**Architecture:** Each adapter implements the existing `Dialect` interface (`src/dialect/types.ts`) using a lazily-required, injectable driver seam (mirroring `SqliteDbFactory`) so unit tests run network-free. Shared scaffolding lands first: classifier hooks wired at the tool callsites, a per-dialect `supportsStatementTimeout` capability flag, and broadened credential scrubbing. Reads run inside a per-dialect READ ONLY transaction; `readonly` instances apply a DB-level read-only guarantee and emit a startup warning when it cannot be confirmed (spec §7.3). Live coverage uses `testcontainers`, gated behind `RUN_DB_INTEGRATION` so the default suite and `ci.yml` stay container-free.

**Tech Stack:** TypeScript (ESM, Node 24), Vitest, `pg`, `mysql2`, `tedious`, `testcontainers`, `bun build --target=node`.

**Execution shape:** Three PRs — **3a** (shared scaffolding + Postgres), **3b** (MySQL), **3c** (MSSQL). Each PR ends green (typecheck + unit suite + build) and is reviewed before the next starts.

**Spec references:** §4 (config), §6 (tools), §7 (defense in depth), §8 (limits/coercion/identifier safety/param contract), §9 (envelope + scrubbing), §10 (Dialect interface), §13 (open items resolved below).

## Open items resolved (spec §13)

| Open item | Decision for v1 |
|---|---|
| Discrete conn fields vs DSN | **DSN only.** `SQL_MCP_DSN` is the single source; discrete host/port/user fields deferred. |
| MSSQL read-only-tx semantics | tedious has **no** `READ ONLY` transaction modifier. Read path wraps in a transaction and **rolls back** (SELECTs unaffected). DB-level guarantee = read-only login / read-only DB; `connect` checks `DATABASEPROPERTYEX(DB_NAME(),'Updateability')` and warns when not `READ_ONLY`. |
| Statement timeout | Now enforced per-dialect: pg `statement_timeout` client option; mysql `SET SESSION max_execution_time` (SELECT-only, documented); mssql `requestTimeout`. SQLite stays unsupported. Surfaced via new `Dialect.supportsStatementTimeout`. |
| Keyset vs offset cursor | Unchanged from Phase 1: **offset pagination** via the existing `paginate()` sub-select wrapper in `handleQuery`. Adapters only execute the wrapped SQL; no per-dialect cursor logic. |
| Identifier allowlist | Introspection binds the table/schema name as a **value parameter** into `information_schema` queries (no identifier interpolation needed), and additionally `assertValidIdent`-validates before binding (defense in depth). `quoteIdent` is still implemented per-dialect for interface completeness. |

## Correction (post-3a review) — pin a single connection for transactions

A pooled `query()`/`pool.query()` checks out a **different connection per call**. Running
`BEGIN` / `<stmt>` / `COMMIT` as separate pooled-`query` calls therefore (a) scatters the
statements across connections so the transaction never brackets them, (b) **breaks
`executeBatch` atomicity** (the v1 transaction primitive — spec §6), and (c) leaks a connection
back to the pool with an open transaction. Any multi-statement transaction MUST pin one
connection: Postgres `pool.connect()` → client → `release()`; MySQL `pool.getConnection()` →
conn → `release()`. Single auto-commit statements (`execute`, the readonly verification query)
may still use `pool.query()`. The Postgres code below has been fixed (commit on the 3a branch);
the MySQL code in Part 3b already reflects this. MSSQL uses one long-lived connection (no pool),
so it is unaffected. Each transaction adapter carries a live atomicity test (mid-batch failure ⇒
earlier statements rolled back).

---

## Part 3a — Shared scaffolding + PostgreSQL adapter (PR A)

### Task 1: Wire classifier hooks + statement-timeout capability into the Dialect contract

**Files:**
- Modify: `src/dialect/types.ts`
- Modify: `src/dialect/sqlite.ts`
- Modify: `src/tools/query.ts:38`, `src/tools/execute.ts:21`, `src/tools/execute_batch.ts:32`, `src/tools/execute_ddl.ts` (classify callsite)
- Modify: `src/tools/capabilities.ts:30`
- Test: `tests/dialect/dialect-contract.test.ts` (new), update existing test fakes

- [ ] **Step 1: Write the failing test** — `tests/dialect/dialect-contract.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";

describe("Dialect contract additions", () => {
  it("sqlite exposes empty classify hooks and no statement-timeout support", () => {
    const d = new SqliteDialect("readonly");
    expect(d.classifyHooks).toEqual({});
    expect(d.supportsStatementTimeout).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test -- dialect-contract`
Expected: FAIL — `classifyHooks`/`supportsStatementTimeout` do not exist on `SqliteDialect`.

- [ ] **Step 3: Extend the interface** — add to `Dialect` in `src/dialect/types.ts`, after `paramStyle`:

```ts
  /** Per-dialect keyword hooks for the shared classifier (e.g. MERGE as DML). */
  readonly classifyHooks: import("../classifier.js").ClassifyHooks;
  /** Whether this dialect enforces `statement_timeout_ms` at the driver/DB level. */
  readonly supportsStatementTimeout: boolean;
```

- [ ] **Step 4: Implement on `SqliteDialect`** — add after `readonly paramStyle = "?" as const;`:

```ts
  readonly classifyHooks = {} as const;
  readonly supportsStatementTimeout = false;
```

- [ ] **Step 5: Wire hooks at every classify callsite**

In `src/tools/query.ts`, change the handler to pass hooks:
```ts
  const cls = classify(input.sql, dialect.classifyHooks);
```
In `src/tools/execute.ts`:
```ts
  const cls = classify(input.sql, dialect.classifyHooks);
```
In `src/tools/execute_batch.ts` (inside the loop):
```ts
    const cls = classify(input.statements[i]!.sql, dialect.classifyHooks);
```
In `src/tools/execute_ddl.ts` (at its classify callsite):
```ts
  const cls = classify(input.sql, dialect.classifyHooks);
```

- [ ] **Step 6: Make capabilities advertise the per-dialect flag** — in `src/tools/capabilities.ts`, replace the hardcoded `statement_timeout: false` line with:

```ts
      statement_timeout: dialect.supportsStatementTimeout,
```

- [ ] **Step 7: Fix the unit-test fakes** — the partial `Dialect` fakes in `tests/tools/query.test.ts`, `tests/tools/introspection.test.ts`, `tests/tools/register.test.ts`, `tests/tools/register-write.test.ts` will fail typecheck. Add the two new members to each fake object:

```ts
  classifyHooks: {},
  supportsStatementTimeout: false,
```

- [ ] **Step 8: Run the full suite + typecheck**

Run: `bun run test && bun run typecheck`
Expected: all green (existing ~78 tests + the new one); `tsc --noEmit` exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/dialect/types.ts src/dialect/sqlite.ts src/tools/*.ts tests/
git commit -m "feat(dialect): wire classifier hooks + per-dialect statement-timeout flag

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: Broaden credential scrubbing for networked-driver errors

**Files:**
- Modify: `src/scrub.ts`
- Test: `tests/scrub.test.ts`

- [ ] **Step 1: Add failing assertions** to `tests/scrub.test.ts`:

```ts
it("scrubs token / api_key / secret / ssl_key style secrets", () => {
  expect(scrubCredentials("token=abc123 failed")).toBe("token=*** failed");
  expect(scrubCredentials("api_key=zzz; host=x")).toBe("api_key=***; host=x");
  expect(scrubCredentials("apikey=zzz")).toBe("apikey=***");
  expect(scrubCredentials("secret=hunter2")).toBe("secret=***");
  expect(scrubCredentials("ssl_key=/etc/k.pem")).toBe("ssl_key=***");
  expect(scrubCredentials("sslpassword=zzz")).toBe("sslpassword=***");
});

it("scrubs MSSQL connection-string style 'Password=...;'", () => {
  expect(scrubCredentials("Server=h;Database=d;User Id=sa;Password=P@ss1;")).toContain("Password=***;");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test -- scrub`
Expected: FAIL — `token=`/`api_key=`/`secret=`/`ssl_key=` not yet scrubbed.

- [ ] **Step 3: Add the pattern** to the `PATTERNS` array in `src/scrub.ts`, after the existing `password|passwd|...` entry:

```ts
  // Additional key=value secrets surfaced by networked drivers (token, api keys, generic secret, ssl key material)
  [/(\b(?:token|api[_-]?key|secret|ssl_key|sslpassword)\s*=\s*)[^;\s]+/gi, "$1***"],
```

- [ ] **Step 4: Run the suite**

Run: `bun run test -- scrub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scrub.ts tests/scrub.test.ts
git commit -m "feat(scrub): broaden credential patterns (token/api_key/secret/ssl_key)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Add driver dependencies + integration harness scaffolding

**Files:**
- Modify: `package.json`
- Create: `tests/integration/helpers/containers.ts`
- Modify: `vitest.config.ts`
- Create: `.github/workflows/db-integration.yml`

- [ ] **Step 1: Add dependencies** — runtime drivers + testcontainers (dev). Run:

```bash
cd /Users/peteralbert/repos/skaile/sql-mcp
bun add pg mysql2 tedious
bun add -d testcontainers @types/pg
```

(`mysql2` and `tedious` ship their own types; `pg` needs `@types/pg`.)

- [ ] **Step 2: Add an `test:integration` script** to `package.json` `scripts`:

```json
    "test:integration": "RUN_DB_INTEGRATION=1 vitest run tests/integration",
```

- [ ] **Step 3: Keep live tests out of the default run** — update `vitest.config.ts` so the default `bun run test` excludes `*.live.test.ts`, but `test:integration` (which targets `tests/integration`) still picks them up:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Networked live tests require Docker (testcontainers); run them via `bun run test:integration`.
    exclude: process.env.RUN_DB_INTEGRATION
      ? ["**/node_modules/**"]
      : ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
  },
});
```

> NOTE: the existing `tests/integration/sqlite*.live.test.ts` are SQLite-only (no Docker). They will now run **only** under `test:integration`. That is acceptable — SQLite unit coverage in `tests/dialect/` remains in the default run. Confirm the default run stays green after this change.

- [ ] **Step 4: Write the container helper** — `tests/integration/helpers/containers.ts`:

```ts
// Spins up throwaway DB containers for live integration tests. Only imported by
// *.live.test.ts, which run solely under `bun run test:integration` (RUN_DB_INTEGRATION=1).
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

export const LIVE = !!process.env.RUN_DB_INTEGRATION;

export async function startPostgres(): Promise<{ container: StartedTestContainer; dsn: string }> {
  const container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_PASSWORD: "secret", POSTGRES_DB: "appdb" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const dsn = `postgresql://postgres:secret@${container.getHost()}:${container.getMappedPort(5432)}/appdb`;
  return { container, dsn };
}

export async function startMysql(): Promise<{ container: StartedTestContainer; dsn: string }> {
  const container = await new GenericContainer("mysql:8.0")
    .withEnvironment({ MYSQL_ROOT_PASSWORD: "secret", MYSQL_DATABASE: "appdb" })
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forLogMessage(/ready for connections/, 2))
    .withStartupTimeout(120_000)
    .start();
  const dsn = `mysql://root:secret@${container.getHost()}:${container.getMappedPort(3306)}/appdb`;
  return { container, dsn };
}

export async function startMssql(): Promise<{ container: StartedTestContainer; dsn: string }> {
  const container = await new GenericContainer("mcr.microsoft.com/mssql/server:2022-latest")
    .withEnvironment({ ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: "Str0ng!Passw0rd" })
    .withExposedPorts(1433)
    .withWaitStrategy(Wait.forLogMessage(/SQL Server is now ready for client connections/, 1))
    .withStartupTimeout(180_000)
    .start();
  const dsn = `mssql://sa:Str0ng!Passw0rd@${container.getHost()}:${container.getMappedPort(1433)}/master`;
  return { container, dsn };
}
```

- [ ] **Step 5: Add the gated CI workflow** — `.github/workflows/db-integration.yml`:

```yaml
name: DB integration

# Real-database tests via testcontainers. Kept off the fast `ci.yml` path: runs
# manually (workflow_dispatch) and on PRs that touch a dialect adapter.
on:
  workflow_dispatch:
  pull_request:
    types: [opened, synchronize, reopened]
    paths:
      - "src/dialect/**"
      - "tests/integration/**"

jobs:
  integration:
    name: Live dialect tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: "1.3.11"
      - run: bun install --frozen-lockfile
      - name: Integration tests (testcontainers)
        run: bun run test:integration
```

- [ ] **Step 6: Verify the default suite is unchanged and the build still works**

Run: `bun run test && bun run typecheck && bun run build`
Expected: default run excludes `*.live.test.ts`, all unit tests pass, typecheck clean, `Built dist/server.js`.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock vitest.config.ts tests/integration/helpers/containers.ts .github/workflows/db-integration.yml
git commit -m "chore: add pg/mysql2/tedious + testcontainers harness (gated db-integration CI)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4: PostgreSQL dialect (unit-tested via an injected pool seam)

**Files:**
- Create: `src/dialect/postgres.ts`
- Modify: `src/dialect/index.ts`
- Test: `tests/dialect/postgres.test.ts`

- [ ] **Step 1: Write the failing unit test** — `tests/dialect/postgres.test.ts`. The test injects a fake pool seam, so no network/`pg` is touched:

```ts
import { describe, it, expect } from "vitest";
import { PostgresDialect, type PgPool, type PgPoolFactory } from "../../src/dialect/postgres.js";

interface Call { sql: string; params: unknown[]; }

function fakePool(responses: Record<string, { rows: any[]; rowCount?: number }>): { pool: PgPool; calls: Call[] } {
  const calls: Call[] = [];
  const pool: PgPool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      // Match on a substring so the test can key off the meaningful statement.
      const key = Object.keys(responses).find((k) => sql.includes(k));
      return responses[key ?? ""] ?? { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return { pool, calls };
}

const factory =
  (pool: PgPool): PgPoolFactory =>
  () =>
    pool;

describe("PostgresDialect", () => {
  it("paramStyle is $n and rewriteParams is identity", () => {
    const d = new PostgresDialect("readonly", factory(fakePool({}).pool));
    expect(d.paramStyle).toBe("$n");
    expect(d.rewriteParams("SELECT $1, $2")).toBe("SELECT $1, $2");
  });

  it("classify hooks treat MERGE as DML and statement timeout is supported", () => {
    const d = new PostgresDialect("dml", factory(fakePool({}).pool));
    expect(d.classifyHooks.extraDml).toContain("merge");
    expect(d.supportsStatementTimeout).toBe(true);
  });

  it("query wraps reads in a READ ONLY transaction and returns columns+rows", async () => {
    const { pool, calls } = fakePool({
      "SELECT id": { rows: [{ id: 1, name: "a" }, { id: 2, name: "b" }] },
    });
    const d = new PostgresDialect("readonly", factory(pool));
    await d.connect("postgresql://u:p@h/db");
    const r = await d.query("SELECT id, name FROM users", []);
    expect(r.columns).toEqual(["id", "name"]);
    expect(r.rows).toHaveLength(2);
    // The read must be bracketed by a READ ONLY transaction.
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("BEGIN TRANSACTION READ ONLY");
    expect(sqls).toContain("COMMIT");
  });

  it("quoteIdent rejects injection and double-quotes valid names", () => {
    const d = new PostgresDialect("full", factory(fakePool({}).pool));
    expect(d.quoteIdent("users")).toBe('"users"');
    expect(() => d.quoteIdent('users"; DROP')).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test -- postgres`
Expected: FAIL — module `src/dialect/postgres.js` does not exist.

- [ ] **Step 3: Implement the dialect** — `src/dialect/postgres.ts`:

```ts
// src/dialect/postgres.ts
import type { AccessScope } from "../config.js";
import type { ClassifyHooks } from "../classifier.js";
import { assertValidIdent, quoteIdentAnsi } from "../identifiers.js";
import type { BatchStatement, ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";

// Minimal slice of node-postgres's Pool we depend on (keeps the dialect unit-testable).
export interface PgQueryResult { rows: Record<string, unknown>[]; rowCount?: number | null; }
export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
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
    max: 4,
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
        const r = await this.pool.query("SHOW transaction_read_only");
        const val = (r.rows[0] as Record<string, unknown> | undefined)?.transaction_read_only;
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

  quoteIdent(name: string): string {
    assertValidIdent(name);
    return quoteIdentAnsi(name);
  }

  async query(sql: string, params: unknown[]): Promise<QueryResult> {
    const pool = this.require();
    // Bracket the read in a READ ONLY transaction (defense in depth; harmless when the
    // session already defaults to read-only).
    await pool.query("BEGIN TRANSACTION READ ONLY");
    try {
      const r = await pool.query(sql, params);
      await pool.query("COMMIT");
      const columns = r.rows.length > 0 ? Object.keys(r.rows[0]!) : [];
      return { columns, rows: r.rows };
    } catch (e) {
      try { await pool.query("ROLLBACK"); } catch { /* original error wins */ }
      throw e;
    }
  }

  async execute(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    const r = await this.require().query(sql, params);
    return { rowCount: r.rowCount ?? 0 };
  }

  async executeBatch(statements: BatchStatement[]): Promise<Array<{ rowCount: number }>> {
    const pool = this.require();
    await pool.query("BEGIN");
    try {
      const results: Array<{ rowCount: number }> = [];
      for (const s of statements) {
        const r = await pool.query(s.sql, s.params ?? []);
        results.push({ rowCount: r.rowCount ?? 0 });
      }
      await pool.query("COMMIT");
      return results;
    } catch (e) {
      try { await pool.query("ROLLBACK"); } catch { /* original error wins */ }
      throw e;
    }
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.require().query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name",
    );
    return r.rows.map((row) => String((row as Record<string, unknown>).schema_name));
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const r = await this.require().query(
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
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    assertValidIdent(table); // value-bound below, but validate early (defense in depth)
    const r = await this.require().query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              (pk.column_name IS NOT NULL) AS is_pk
         FROM information_schema.columns c
         LEFT JOIN (
           SELECT kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
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
  }
}
```

- [ ] **Step 4: Run the unit test**

Run: `bun run test -- postgres`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the factory** — `src/dialect/index.ts`:

```ts
import { PostgresDialect } from "./postgres.js";
// ...
    case "postgres":
      return new PostgresDialect(config.access, undefined, config.statementTimeoutMs);
```

- [ ] **Step 6: Typecheck + full unit suite + build**

Run: `bun run test && bun run typecheck && bun run build`
Expected: all green; `Built dist/server.js`.

- [ ] **Step 7: Confirm `pg` bundles + the driver loads** — a bad DSN must fail at startup with a scrubbed message (proves the bundle contains `pg`):

```bash
SQL_MCP_DIALECT=postgres SQL_MCP_DSN='postgresql://u:secretpw@127.0.0.1:1/db' SQL_MCP_ACCESS=readonly \
  node dist/server.js 2>&1 | head -2
```

Expected: a `sql-mcp failed to start:` line whose message does **not** contain `secretpw` (scrubbed). The process exits 1.

- [ ] **Step 8: Commit**

```bash
git add src/dialect/postgres.ts src/dialect/index.ts tests/dialect/postgres.test.ts
git commit -m "feat(dialect): PostgreSQL adapter (pg) with READ ONLY tx + statement timeout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5: PostgreSQL live integration test (testcontainers, gated)

**Files:**
- Create: `tests/integration/postgres.live.test.ts`

- [ ] **Step 1: Write the live test** — `tests/integration/postgres.live.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { LIVE, startPostgres } from "./helpers/containers.js";
import { PostgresDialect } from "../../src/dialect/postgres.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

const cfg = (dsn: string, access: Config["access"]): Config => ({
  dialect: "postgres", dsn, access,
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

describe.skipIf(!LIVE)("PostgreSQL live integration", () => {
  let container: StartedTestContainer;
  let dsn: string;

  beforeAll(async () => {
    ({ container, dsn } = await startPostgres());
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: dsn });
    await pool.query("CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)");
    for (let i = 1; i <= 5; i++) await pool.query("INSERT INTO users (name) VALUES ($1)", [`u${i}`]);
    await pool.end();
  }, 180_000);

  afterAll(async () => { await container?.stop(); });

  it("describe_table + list_tables reflect the seed", async () => {
    const d = new PostgresDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const cols = await handleDescribeTable(d, { table: "users" });
    if (cols.status !== "success") throw new Error(cols.error);
    expect(cols.data.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(cols.data.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
    const tabs = await handleListTables(d, {});
    if (tabs.status !== "success") throw new Error(tabs.error);
    expect(tabs.data.tables.map((t) => t.name)).toContain("users");
    await d.close();
  });

  it("query paginates through all rows via next_cursor", async () => {
    const d = new PostgresDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const env = await handleQuery(d, cfg(dsn, "readonly"), { sql: "SELECT id FROM users ORDER BY id", cursor });
      if (env.status !== "success") throw new Error(env.error);
      seen.push(...env.data.rows.map((r) => Number(r.id)));
      cursor = env.data.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await d.close();
  });

  it("readonly instance rejects a write at the DB level (default_transaction_read_only)", async () => {
    const d = new PostgresDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    // Bypass the classifier to prove the DB-level guarantee (spec §7.3 layer 3).
    await expect(d.query("DELETE FROM users", [])).rejects.toThrow();
    await d.close();
  });

  it("dml instance inserts and the row count is reported", async () => {
    const d = new PostgresDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const env = await handleExecute(d, cfg(dsn, "dml"), { sql: "INSERT INTO users (name) VALUES ($1)", params: ["x"] });
    if (env.status !== "success") throw new Error(env.error);
    expect(env.data.rowCount).toBe(1);
    await d.close();
  });
});
```

- [ ] **Step 2: Run the integration test (requires Docker)**

Run: `bun run test:integration -- postgres`
Expected: PASS (4 tests) when Docker is available. If Docker is unavailable locally, the `describe.skipIf(!LIVE)` still requires `RUN_DB_INTEGRATION` — confirm at minimum that without the flag the default `bun run test` does **not** attempt to start a container.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/postgres.live.test.ts
git commit -m "test: live PostgreSQL integration (pagination, RO guarantee, DML)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 6: Open PR A and run the review loop

- [ ] **Step 1: Push the branch and open the PR**

```bash
git push -u origin feat/phase-3a-postgres
gh pr create --title "feat: Phase 3a — shared adapter scaffolding + PostgreSQL" \
  --body "Implements the Postgres dialect + cross-cutting scaffolding (classifier hooks at callsites, per-dialect statement-timeout flag, broadened scrubbing, testcontainers harness). See docs/plans/2026-06-16-sql-mcp-v3-adapters.md Part 3a."
```

- [ ] **Step 2: Drive the Claude review loop** — wait for `claude-code-review`, address every relevant finding (controller verifies fixes), re-review until approved. Then hand the PR to the user to merge (established pattern).

---

## Part 3b — MySQL adapter (PR B)

> Branch from `main` after PR A merges. Reuses all scaffolding from Part 3a.

### Task 7: MySQL dialect

**Files:**
- Create: `src/dialect/mysql.ts`
- Modify: `src/dialect/index.ts`
- Test: `tests/dialect/mysql.test.ts`

- [ ] **Step 1: Write the failing unit test** — `tests/dialect/mysql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MysqlDialect, type MysqlPool, type MysqlPoolFactory } from "../../src/dialect/mysql.js";

interface Call { sql: string; params: unknown[]; }
function fakePool(rowsFor: (sql: string) => any[]): { pool: MysqlPool; calls: Call[] } {
  const calls: Call[] = [];
  const run = (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    // mysql2 returns [rows, fields]; for non-SELECT it returns a ResultSetHeader.
    return [rowsFor(sql) as any, []] as [any, any];
  };
  const pool: MysqlPool = {
    // Transactions run on a pinned connection; the fake records its query()s into the same array.
    async getConnection() {
      return { query: async (s: string, p: unknown[] = []) => run(s, p), release() {} };
    },
    async query(sql: string, params: unknown[] = []) {
      return run(sql, params);
    },
    async end() {},
  };
  return { pool, calls };
}
const factory = (pool: MysqlPool): MysqlPoolFactory => () => pool;

describe("MysqlDialect", () => {
  it("paramStyle is ? and rewriteParams maps $n -> ?", () => {
    const d = new MysqlDialect("readonly", factory(fakePool(() => []).pool));
    expect(d.paramStyle).toBe("?");
    expect(d.rewriteParams("SELECT $1, $2")).toBe("SELECT ?, ?");
  });

  it("supports statement timeout and has no MERGE hook (MySQL lacks MERGE)", () => {
    const d = new MysqlDialect("dml", factory(fakePool(() => []).pool));
    expect(d.supportsStatementTimeout).toBe(true);
    expect(d.classifyHooks.extraDml ?? []).not.toContain("merge");
  });

  it("query wraps reads in START TRANSACTION READ ONLY and returns columns+rows", async () => {
    const { pool, calls } = fakePool((sql) => (sql.includes("SELECT id") ? [{ id: 1 }, { id: 2 }] : []));
    const d = new MysqlDialect("readonly", factory(pool));
    await d.connect("mysql://u:p@h/db");
    const r = await d.query("SELECT id FROM users", []);
    expect(r.columns).toEqual(["id"]);
    expect(r.rows).toHaveLength(2);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("START TRANSACTION READ ONLY");
    expect(sqls).toContain("COMMIT");
  });

  it("quoteIdent backtick-quotes and rejects injection", () => {
    const d = new MysqlDialect("full", factory(fakePool(() => []).pool));
    expect(d.quoteIdent("users")).toBe("`users`");
    expect(() => d.quoteIdent("a`b")).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test -- mysql`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `src/dialect/mysql.ts`:

```ts
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
export type MysqlPoolFactory = (dsn: string, opts: { readOnly: boolean; statementTimeoutMs: number }) => MysqlPool;

const defaultFactory: MysqlPoolFactory = (dsn, opts) => {
  const mysql = require("mysql2/promise") as typeof import("mysql2/promise");
  const pool = mysql.createPool({
    uri: dsn,
    connectionLimit: 4,
    // BIGINT/DECIMAL as strings so wide numerics survive JSON (spec §8).
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    // SELECT-level statement timeout + read-only default per connection.
    connectAttributes: {},
  });
  // Apply per-connection session settings as connections are created.
  (pool as unknown as { on: (e: string, cb: (c: any) => void) => void }).on("connection", (conn: any) => {
    conn.query(`SET SESSION max_execution_time = ${Math.max(0, Math.floor(opts.statementTimeoutMs))}`);
    if (opts.readOnly) conn.query("SET SESSION TRANSACTION READ ONLY");
  });
  return pool as unknown as MysqlPool;
};

export class MysqlDialect implements Dialect {
  readonly name = "mysql" as const;
  readonly paramStyle = "?" as const;
  readonly classifyHooks: ClassifyHooks = {}; // MySQL has no MERGE
  readonly supportsStatementTimeout = true; // via SET SESSION max_execution_time (SELECT statements)
  private pool: MysqlPool | null = null;

  constructor(
    private readonly access: AccessScope,
    private readonly factory: MysqlPoolFactory = defaultFactory,
    private readonly statementTimeoutMs = 30_000,
  ) {}

  async connect(dsn: string): Promise<void> {
    this.pool = this.factory(dsn, { readOnly: this.access === "readonly", statementTimeoutMs: this.statementTimeoutMs });
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

  quoteIdent(name: string): string {
    assertValidIdent(name);
    return quoteIdentMysql(name);
  }

  async query(sql: string, params: unknown[]): Promise<QueryResult> {
    const conn = await this.require().getConnection();
    try {
      await conn.query("START TRANSACTION READ ONLY");
      const [rows] = await conn.query(sql, params);
      await conn.query("COMMIT");
      const arr = (rows as Record<string, unknown>[]) ?? [];
      const columns = arr.length > 0 ? Object.keys(arr[0]!) : [];
      return { columns, rows: arr };
    } catch (e) {
      try { await conn.query("ROLLBACK"); } catch { /* original error wins */ }
      throw e;
    } finally {
      conn.release();
    }
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
    const [rows] = await this.require().query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY schema_name",
    );
    return (rows as Record<string, unknown>[]).map((r) => String(r.schema_name ?? r.SCHEMA_NAME));
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const [rows] = await this.require().query(
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
  }

  async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    assertValidIdent(table);
    const [rows] = await this.require().query(
      `SELECT column_name, data_type, is_nullable, column_default, column_key
         FROM information_schema.columns
        WHERE table_name = ? AND (? IS NULL OR table_schema = ?)
        ORDER BY ordinal_position`,
      [table, schema ?? null, schema ?? null],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      name: String(r.column_name ?? r.COLUMN_NAME),
      type: String(r.data_type ?? r.DATA_TYPE),
      nullable: String(r.is_nullable ?? r.IS_NULLABLE) === "YES",
      default: (r.column_default ?? r.COLUMN_DEFAULT) == null ? null : String(r.column_default ?? r.COLUMN_DEFAULT),
      primaryKey: String(r.column_key ?? r.COLUMN_KEY) === "PRI",
    }));
  }
}
```

- [ ] **Step 4: Run the unit test**

Run: `bun run test -- mysql`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `src/dialect/index.ts`**

```ts
import { MysqlDialect } from "./mysql.js";
// ...
    case "mysql":
      return new MysqlDialect(config.access, undefined, config.statementTimeoutMs);
```

- [ ] **Step 6: Typecheck + full unit suite + build + bundle-load smoke**

Run: `bun run test && bun run typecheck && bun run build`
Then:
```bash
SQL_MCP_DIALECT=mysql SQL_MCP_DSN='mysql://u:secretpw@127.0.0.1:1/db' SQL_MCP_ACCESS=readonly \
  node dist/server.js 2>&1 | head -2
```
Expected: green suite/build; the startup-failure line does **not** contain `secretpw`.

- [ ] **Step 7: Commit**

```bash
git add src/dialect/mysql.ts src/dialect/index.ts tests/dialect/mysql.test.ts
git commit -m "feat(dialect): MySQL adapter (mysql2) with RO transaction + max_execution_time

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 8: MySQL live integration test

**Files:**
- Create: `tests/integration/mysql.live.test.ts`

- [ ] **Step 1: Write the live test** — same structure as Task 5, swapping the dialect/seed. `src/dialect/mysql.ts` + `startMysql()`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { LIVE, startMysql } from "./helpers/containers.js";
import { MysqlDialect } from "../../src/dialect/mysql.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

const cfg = (dsn: string, access: Config["access"]): Config => ({
  dialect: "mysql", dsn, access,
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

describe.skipIf(!LIVE)("MySQL live integration", () => {
  let container: StartedTestContainer;
  let dsn: string;

  beforeAll(async () => {
    ({ container, dsn } = await startMysql());
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({ uri: dsn });
    await conn.query("CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL)");
    for (let i = 1; i <= 5; i++) await conn.query("INSERT INTO users (name) VALUES (?)", [`u${i}`]);
    await conn.end();
  }, 180_000);

  afterAll(async () => { await container?.stop(); });

  it("describe_table + list_tables reflect the seed", async () => {
    const d = new MysqlDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const cols = await handleDescribeTable(d, { table: "users" });
    if (cols.status !== "success") throw new Error(cols.error);
    expect(cols.data.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(cols.data.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
    const tabs = await handleListTables(d, {});
    if (tabs.status !== "success") throw new Error(tabs.error);
    expect(tabs.data.tables.map((t) => t.name)).toContain("users");
    await d.close();
  });

  it("query paginates through all rows via next_cursor", async () => {
    const d = new MysqlDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const env = await handleQuery(d, cfg(dsn, "readonly"), { sql: "SELECT id FROM users ORDER BY id", cursor });
      if (env.status !== "success") throw new Error(env.error);
      seen.push(...env.data.rows.map((r) => Number(r.id)));
      cursor = env.data.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await d.close();
  });

  it("readonly instance rejects a write at the DB level (START TRANSACTION READ ONLY)", async () => {
    const d = new MysqlDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    await expect(d.query("DELETE FROM users", [])).rejects.toThrow();
    await d.close();
  });

  it("dml instance inserts and reports affectedRows", async () => {
    const d = new MysqlDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const env = await handleExecute(d, cfg(dsn, "dml"), { sql: "INSERT INTO users (name) VALUES ($1)", params: ["x"] });
    if (env.status !== "success") throw new Error(env.error);
    expect(env.data.rowCount).toBe(1);
    await d.close();
  });

  it("execute_batch is atomic: a mid-batch failure rolls back earlier statements", async () => {
    const d = new MysqlDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const before = await d.query("SELECT COUNT(*) AS n FROM users", []);
    const beforeN = Number(before.rows[0]!.n);
    // Second statement violates the PK (id=1 already exists) → whole batch must roll back.
    await expect(
      d.executeBatch([
        { sql: "INSERT INTO users (name) VALUES (?)", params: ["batch-a"] },
        { sql: "INSERT INTO users (id, name) VALUES (?, ?)", params: [1, "dup"] },
      ]),
    ).rejects.toThrow();
    const after = await d.query("SELECT COUNT(*) AS n FROM users", []);
    expect(Number(after.rows[0]!.n)).toBe(beforeN); // first INSERT was rolled back
    await d.close();
  });
});
```

> NOTE on the read-only write-rejection test: `START TRANSACTION READ ONLY` makes the in-tx `DELETE` fail with `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION` — that is the assertion. (A read-only *grant* is the production guarantee; the warning in `connect` documents this.)

- [ ] **Step 2: Run the integration test (Docker)**

Run: `bun run test:integration -- mysql`
Expected: PASS (4 tests) with Docker available.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mysql.live.test.ts
git commit -m "test: live MySQL integration (pagination, RO transaction, DML)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 9: Open PR B and run the review loop

- [ ] Push `feat/phase-3b-mysql`; `gh pr create` titled "feat: Phase 3b — MySQL adapter (mysql2)"; drive the Claude review loop to approval; hand to user to merge.

---

## Part 3c — MSSQL adapter (PR C)

> Branch from `main` after PR B merges. `tedious` is the outlier: named `@pN` parameters with explicit per-parameter type declarations, and no `READ ONLY` transaction.

### Task 10: MSSQL parameter rewriting + type inference helpers

**Files:**
- Create: `src/dialect/mssql-params.ts`
- Test: `tests/dialect/mssql-params.test.ts`

- [ ] **Step 1: Write the failing test** — `tests/dialect/mssql-params.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rewriteToNamed, inferTdsType } from "../../src/dialect/mssql-params.js";

describe("MSSQL param helpers", () => {
  it("rewrites $1,$2 to @p1,@p2", () => {
    expect(rewriteToNamed("SELECT * FROM t WHERE a=$1 AND b=$2")).toBe("SELECT * FROM t WHERE a=@p1 AND b=@p2");
  });

  it("repeated $1 maps to @p1 in every position", () => {
    expect(rewriteToNamed("SELECT $1, $1")).toBe("SELECT @p1, @p1");
  });

  it("infers TDS types by JS value", () => {
    expect(inferTdsType(42).name).toBe("Int");
    expect(inferTdsType(2 ** 40).name).toBe("BigInt");
    expect(inferTdsType(3.14).name).toBe("Float");
    expect(inferTdsType("hi").name).toBe("NVarChar");
    expect(inferTdsType(true).name).toBe("Bit");
    expect(inferTdsType(new Date()).name).toBe("DateTime2");
    expect(inferTdsType(Buffer.from("x")).name).toBe("VarBinary");
    expect(inferTdsType(null).name).toBe("NVarChar"); // null still needs a declared type
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test -- mssql-params`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `src/dialect/mssql-params.ts`:

```ts
// src/dialect/mssql-params.ts
import { TYPES, type TediousType } from "tedious";

/** Rewrite canonical `$1,$2` placeholders to tedious named placeholders `@p1,@p2`. */
export function rewriteToNamed(canonicalSql: string): string {
  return canonicalSql.replace(/\$(\d+)/g, (_m, n) => `@p${n}`);
}

/**
 * Pick a tedious TYPE for a JS value. tedious requires an explicit type per bound
 * parameter; we infer conservatively. `null` still needs a declared type (NVarChar).
 */
export function inferTdsType(v: unknown): TediousType {
  if (v === null || v === undefined) return TYPES.NVarChar;
  if (typeof v === "boolean") return TYPES.Bit;
  if (typeof v === "bigint") return TYPES.BigInt;
  if (typeof v === "number") {
    if (Number.isInteger(v)) {
      return v >= -2147483648 && v <= 2147483647 ? TYPES.Int : TYPES.BigInt;
    }
    return TYPES.Float;
  }
  if (v instanceof Date) return TYPES.DateTime2;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return TYPES.VarBinary;
  return TYPES.NVarChar; // strings + fallback
}
```

- [ ] **Step 4: Run the test**

Run: `bun run test -- mssql-params`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dialect/mssql-params.ts tests/dialect/mssql-params.test.ts
git commit -m "feat(dialect): MSSQL param rewriting + TDS type inference

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 11: MSSQL dialect

**Files:**
- Create: `src/dialect/mssql.ts`
- Modify: `src/dialect/index.ts`
- Modify: `src/identifiers.ts` (ensure `quoteIdentMssql` exists — it does per Phase 1; confirm)
- Test: `tests/dialect/mssql.test.ts`

- [ ] **Step 1: Write the failing unit test** — `tests/dialect/mssql.test.ts`. The seam is a `MssqlExecutor` (run a SQL string + ordered params, get rows / rowCount), so unit tests never load `tedious`:

```ts
import { describe, it, expect } from "vitest";
import { MssqlDialect, type MssqlExecutor, type MssqlExecutorFactory } from "../../src/dialect/mssql.js";

interface Call { sql: string; params: unknown[]; }
function fakeExecutor(rowsFor: (sql: string) => any[]): { exec: MssqlExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const exec: MssqlExecutor = {
    async run(sql, params) {
      calls.push({ sql, params });
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length };
    },
    async close() {},
  };
  return { exec, calls };
}
const factory = (exec: MssqlExecutor): MssqlExecutorFactory => () => exec;

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

  it("query rolls back the read transaction (no READ ONLY modifier in MSSQL)", async () => {
    const { exec, calls } = fakeExecutor((sql) => (sql.includes("SELECT id") ? [{ id: 1 }] : []));
    const d = new MssqlDialect("readonly", factory(exec));
    await d.connect("mssql://sa:p@h/db");
    const r = await d.query("SELECT id FROM users", []);
    expect(r.columns).toEqual(["id"]);
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /BEGIN TRAN/i.test(s))).toBe(true);
    expect(sqls.some((s) => /ROLLBACK/i.test(s))).toBe(true);
  });

  it("quoteIdent bracket-quotes and rejects injection", () => {
    const d = new MssqlDialect("full", factory(fakeExecutor(() => []).exec));
    expect(d.quoteIdent("users")).toBe("[users]");
    expect(() => d.quoteIdent("a]b")).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test -- "dialect/mssql"`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the executor seam + dialect** — `src/dialect/mssql.ts`. The `tedious`-backed executor maps `$n→@pn`, declares each param's type via `inferTdsType`, and reads `request.on("row")`:

```ts
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
        const r = await exec.run(this.rewriteParams(s.sql), s.params ?? []);
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
```

> NOTE: introspection SQL here uses literal `@p1`/`@p2` placeholders directly (the executor binds positional params to `p1..pN`), so these strings are passed to `exec.run` **without** `rewriteParams` (they're already named). `query`/`execute` receive already-`rewriteParams`-rewritten SQL from the tool handlers; `executeBatch` rewrites each statement itself (handlers don't pre-rewrite batch items — confirm against `src/tools/execute_batch.ts`, which calls `dialect.rewriteParams` per statement, so **do not double-rewrite**: drop the inner `this.rewriteParams` in `executeBatch` if the handler already rewrote — verify the handler and keep exactly one rewrite).

- [ ] **Step 4: Reconcile the batch rewrite** — read `src/tools/execute_batch.ts`: it maps `sql: dialect.rewriteParams(s.sql)` before calling `dialect.executeBatch`. Therefore `MssqlDialect.executeBatch` must **not** rewrite again. Change its loop to:

```ts
        const r = await exec.run(s.sql, s.params ?? []);
```

- [ ] **Step 5: Run the unit test**

Run: `bun run test -- "dialect/mssql"`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire into `src/dialect/index.ts`**

```ts
import { MssqlDialect } from "./mssql.js";
// ...
    case "mssql":
      return new MssqlDialect(config.access, undefined, config.statementTimeoutMs);
```

Remove the `default: throw DIALECT_UNSUPPORTED` only if all four are now handled — keep the `default` for forward-safety (an unknown enum value), but it is now unreachable for the four configured dialects.

- [ ] **Step 7: Typecheck + full unit suite + build + bundle-load smoke**

Run: `bun run test && bun run typecheck && bun run build`
Then confirm `tedious` (CJS) bundled and loads:
```bash
SQL_MCP_DIALECT=mssql SQL_MCP_DSN='mssql://sa:secretpw@127.0.0.1:1/db' SQL_MCP_ACCESS=readonly \
  node dist/server.js 2>&1 | head -2
```
Expected: green suite/build; startup-failure line does **not** contain `secretpw`. If `bun build` fails to bundle `tedious`, fall back to marking it external in `build.ts` and shipping it in the asset payload — record the decision in the PR description.

- [ ] **Step 8: Commit**

```bash
git add src/dialect/mssql.ts src/dialect/index.ts tests/dialect/mssql.test.ts
git commit -m "feat(dialect): MSSQL adapter (tedious) with @pN params + rollback read tx

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 12: MSSQL live integration test

**Files:**
- Create: `tests/integration/mssql.live.test.ts`

- [ ] **Step 1: Write the live test** — mirror Task 5, using `startMssql()` + `MssqlDialect`. Seed via tedious. The read-only write-rejection assertion does **not** apply (MSSQL has no RO tx and the container DB is writable), so assert the **capabilities/describe/pagination/DML** paths and the **startup warning** instead:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { LIVE, startMssql } from "./helpers/containers.js";
import { MssqlDialect } from "../../src/dialect/mssql.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleExecute } from "../../src/tools/execute.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

const cfg = (dsn: string, access: Config["access"]): Config => ({
  dialect: "mssql", dsn, access,
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
});

async function seed(dsn: string): Promise<void> {
  const { Connection, Request } = await import("tedious");
  const u = new URL(dsn);
  const conn = new Connection({
    server: u.hostname,
    options: { port: Number(u.port), database: "master", encrypt: true, trustServerCertificate: true },
    authentication: { type: "default", options: { userName: u.username, password: decodeURIComponent(u.password) } },
  });
  await new Promise<void>((res, rej) => { conn.on("connect", (e) => (e ? rej(e) : res())); conn.connect(); });
  const exec = (sql: string) =>
    new Promise<void>((res, rej) => { const r = new Request(sql, (e) => (e ? rej(e) : res())); conn.execSql(r); });
  await exec("CREATE TABLE users (id INT IDENTITY PRIMARY KEY, name NVARCHAR(64) NOT NULL)");
  for (let i = 1; i <= 5; i++) await exec(`INSERT INTO users (name) VALUES ('u${i}')`);
  conn.close();
}

describe.skipIf(!LIVE)("MSSQL live integration", () => {
  let container: StartedTestContainer;
  let dsn: string;

  beforeAll(async () => { ({ container, dsn } = await startMssql()); await seed(dsn); }, 240_000);
  afterAll(async () => { await container?.stop(); });

  it("describe_table + list_tables reflect the seed", async () => {
    const d = new MssqlDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const cols = await handleDescribeTable(d, { table: "users" });
    if (cols.status !== "success") throw new Error(cols.error);
    expect(cols.data.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(cols.data.columns.find((c) => c.name === "id")?.primaryKey).toBe(true);
    const tabs = await handleListTables(d, {});
    if (tabs.status !== "success") throw new Error(tabs.error);
    expect(tabs.data.tables.map((t) => t.name)).toContain("users");
    await d.close();
  });

  it("query paginates through all rows via next_cursor", async () => {
    const d = new MssqlDialect("readonly", undefined, 30_000);
    await d.connect(dsn);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const env = await handleQuery(d, cfg(dsn, "readonly"), { sql: "SELECT id FROM users ORDER BY id", cursor });
      if (env.status !== "success") throw new Error(env.error);
      seen.push(...env.data.rows.map((r) => Number(r.id)));
      cursor = env.data.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await d.close();
  });

  it("dml instance inserts via @pN params and reports a row count", async () => {
    const d = new MssqlDialect("dml", undefined, 30_000);
    await d.connect(dsn);
    const env = await handleExecute(d, cfg(dsn, "dml"), { sql: "INSERT INTO users (name) VALUES ($1)", params: ["x"] });
    if (env.status !== "success") throw new Error(env.error);
    expect(env.data.rowCount).toBe(1);
    await d.close();
  });
});
```

> NOTE: MSSQL pagination uses the existing `paginate()` wrapper `SELECT * FROM (...) AS _page LIMIT n OFFSET m`. **MSSQL does not support `LIMIT/OFFSET`** — it uses `OFFSET m ROWS FETCH NEXT n ROWS ONLY` and requires an `ORDER BY`. This is a real incompatibility (see Task 13).

- [ ] **Step 2: Run the integration test (Docker)**

Run: `bun run test:integration -- mssql`
Expected: PASS once Task 13 fixes pagination; until then the pagination test exposes the `LIMIT/OFFSET` incompatibility.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/mssql.live.test.ts
git commit -m "test: live MSSQL integration (describe, pagination, @pN DML)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 13: Dialect-aware pagination (fixes MSSQL LIMIT/OFFSET)

**Problem:** `handleQuery`'s `paginate()` emits `LIMIT n OFFSET m`, which Postgres/MySQL/SQLite accept but **MSSQL rejects** (`OFFSET … FETCH` + mandatory `ORDER BY`). Pagination must become dialect-aware.

**Files:**
- Modify: `src/dialect/types.ts` (add `paginate` to the interface)
- Modify: `src/dialect/sqlite.ts`, `src/dialect/postgres.ts`, `src/dialect/mysql.ts`, `src/dialect/mssql.ts`
- Modify: `src/tools/query.ts` (delegate to `dialect.paginate`)
- Test: `tests/dialect/pagination.test.ts`, update `tests/tools/query.test.ts` fakes

- [ ] **Step 1: Write the failing test** — `tests/dialect/pagination.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import { PostgresDialect } from "../../src/dialect/postgres.js";
import { MysqlDialect } from "../../src/dialect/mysql.js";
import { MssqlDialect } from "../../src/dialect/mssql.js";

const noop: any = () => ({ query: async () => ({ rows: [] }), end: async () => {}, run: async () => ({ rows: [], rowCount: 0 }), close: async () => {} });

describe("dialect.paginate", () => {
  it("LIMIT/OFFSET dialects wrap with LIMIT n OFFSET m", () => {
    for (const d of [new SqliteDialect("readonly"), new PostgresDialect("readonly", noop), new MysqlDialect("readonly", noop)]) {
      const p = d.paginate("SELECT id FROM users ORDER BY id", 10, 20);
      expect(p).toContain("LIMIT 10");
      expect(p).toContain("OFFSET 20");
    }
  });

  it("MSSQL uses OFFSET ... ROWS FETCH NEXT ... ROWS ONLY with an ORDER BY", () => {
    const d = new MssqlDialect("readonly", noop);
    const p = d.paginate("SELECT id FROM users ORDER BY id", 10, 20);
    expect(p).toMatch(/OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY/i);
    expect(p).toMatch(/ORDER BY/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test -- "dialect/pagination"`
Expected: FAIL — `paginate` not on the dialects.

- [ ] **Step 3: Add `paginate` to the interface** — in `src/dialect/types.ts`, after `rewriteParams`:

```ts
  /** Wrap a SELECT to fetch `limit` rows starting at `offset`, in dialect-native syntax. */
  paginate(sql: string, limit: number, offset: number): string;
```

- [ ] **Step 4: Implement on each dialect.** For SQLite/Postgres/MySQL (identical) add:

```ts
  paginate(sql: string, limit: number, offset: number): string {
    const trimmed = sql.replace(/;\s*$/, "");
    return `SELECT * FROM (${trimmed}) AS _page LIMIT ${limit} OFFSET ${offset}`;
  }
```

For MSSQL (`src/dialect/mssql.ts`) — MSSQL needs `ORDER BY` for `OFFSET/FETCH`; wrap and supply a stable ordering over the subquery's first column via `(SELECT NULL)` ordering which MSSQL allows for OFFSET:

```ts
  paginate(sql: string, limit: number, offset: number): string {
    const trimmed = sql.replace(/;\s*$/, "");
    // MSSQL OFFSET/FETCH requires ORDER BY. The inner query's own ORDER BY governs row
    // identity; the outer ORDER BY (SELECT 1) is the syntactic requirement for the window.
    return `SELECT * FROM (${trimmed}) AS _page ORDER BY (SELECT 1) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
```

> NOTE: `ORDER BY (SELECT 1)` satisfies the MSSQL grammar without reordering; the agent's own `ORDER BY` inside the wrapped SELECT is what makes pages deterministic. Document in the PR that, as with the other dialects, the caller must `ORDER BY` for stable pagination (spec §6a trade-off already states pages are not snapshot-consistent).

- [ ] **Step 5: Delegate from the handler** — in `src/tools/query.ts`, remove the local `paginate()` function and change the fetch line to:

```ts
  const native = dialect.rewriteParams(dialect.paginate(input.sql, pageSize + 1, offset));
```

- [ ] **Step 6: Update the `query.test.ts` fake** to implement `paginate` (delegate to the LIMIT/OFFSET form):

```ts
  paginate: (sql: string, limit: number, offset: number) =>
    `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS _page LIMIT ${limit} OFFSET ${offset}`,
```

- [ ] **Step 7: Full unit suite + typecheck + build**

Run: `bun run test && bun run typecheck && bun run build`
Expected: all green.

- [ ] **Step 8: Re-run the MSSQL live pagination test (Docker)**

Run: `bun run test:integration -- mssql`
Expected: pagination test now passes.

- [ ] **Step 9: Commit**

```bash
git add src/dialect/types.ts src/dialect/*.ts src/tools/query.ts tests/dialect/pagination.test.ts tests/tools/query.test.ts
git commit -m "feat(dialect): dialect-aware pagination (MSSQL OFFSET/FETCH)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 14: Open PR C and run the review loop

- [ ] Push `feat/phase-3c-mssql`; `gh pr create` titled "feat: Phase 3c — MSSQL adapter (tedious) + dialect-aware pagination"; drive the Claude review loop to approval; hand to user to merge.

---

## Self-review (against the spec)

- **§6 tool surface:** unchanged — all four dialects expose the same `sql.*` tools; only the `Dialect` implementations differ. ✓
- **§7 defense in depth:** (1) tool-gating unchanged; (2) classifier now receives per-dialect hooks (`merge` for pg/mssql) at all four callsites; (3) DB-level read-only — pg `default_transaction_read_only=on` + READ ONLY tx, mysql `START TRANSACTION READ ONLY`, mssql rollback-tx + read-only-DB check; each warns when it cannot confirm read-only. ✓
- **§8 limits/coercion/identifiers/params:** statement timeout now enforced (pg client option / mysql `max_execution_time` / mssql `requestTimeout`) and advertised per-dialect; rows flow through the existing `coerceRow` in `capRows`; introspection binds the identifier as a value param + `assertValidIdent`; canonical `$1` rewritten to `?`/`@pN`. mysql pool forces `bigNumberStrings` for JSON-safe wide numerics. ✓
- **§9 envelope + scrubbing:** all handlers unchanged (already enveloped + scrubbed); scrub patterns broadened for networked-driver secrets. ✓
- **§10 Dialect:** four implementations behind one interface; `paginate` added so the read path is fully dialect-agnostic; `classifyHooks` exposed for the shared classifier. ✓
- **§13 open items:** DSN-only, MSSQL RO semantics, statement timeout, pagination syntax, identifier allowlist — all resolved above. ✓

**Placeholder scan:** none. **Type consistency:** `Dialect` members (`classifyHooks`, `supportsStatementTimeout`, `paginate`, `query`/`execute`/`executeBatch`/introspection) are defined once in `types.ts` and implemented identically across `sqlite`/`postgres`/`mysql`/`mssql`; the driver-seam factory pattern (`*PoolFactory`/`MssqlExecutorFactory`) is uniform; `rewriteParams`/`paginate` signatures match across dialects.

---

## Carryover (deferred past Phase 3)

- **Phase 4 (publication):** author `ai-assets/mcp/sql/MCP.md`, document the first `command: node` MCP pattern in `ai-assets/mcp/DOMAIN.md`, ship `v0.1.0` via tag-driven `release.yml` (`server.js` + sha256 manifest). Confirm the `${workspace}`-absolute `args` path token (spec §13).
- **v2 roadmap:** handle-based transactions (`begin`/`commit`/`rollback`) + server-side cursors (the shared pinned-connection engine).
- **Configurable `execute_batch` cap** (`SQL_MCP_MAX_BATCH_STATEMENTS`) if a real need appears.
- **Discrete connection fields** (host/port/user) as an alternative to a single DSN.
- **Configurable pool size** (`SQL_MCP_PG_POOL_MAX` and per-dialect equivalents) — pg/mysql currently hardcode a small pool (spec §5). Add when concurrency tuning is actually needed.

> **3a review carryover for 3b/3c:** route introspection reads through the same READ-ONLY-transaction helper as `query()` (pg added a private `withReadTx`). For MySQL, wrap `listSchemas`/`listTables`/`describeTable` in a `getConnection()` + `START TRANSACTION READ ONLY` helper too. Verify the readonly guarantee against the *session-default* flag, not the current-transaction flag (pg uses `SHOW default_transaction_read_only`).
- **Keyset pagination** (ordering-key cursor) as an upgrade over offset, per spec §6a — offset is the v1 baseline.

# SQL MCP Server — Phase 1: Read-only SQLite vertical slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working, end-to-end MCP server that exposes **read-only SQLite** access over stdio — the thinnest vertical slice of the full SQL MCP server, with all the security-critical core in place.

**Architecture:** A Node/TypeScript stdio MCP server (`@modelcontextprotocol/sdk`). Tools are dialect-agnostic and call a `Dialect` adapter (SQLite via Node 24 built-in `node:sqlite` in this phase). All SQL flows through a single shared statement classifier; reads run on a read-only connection; results are size-capped, type-coerced, and paginated with an HMAC-signed cursor. Pure-logic modules are unit-tested with Vitest; the SQLite binding is behind an injectable seam so logic tests need no real DB, with one live integration test against a temp file.

**Tech Stack:** TypeScript, Bun (tooling + bundling via `bun build`), `@modelcontextprotocol/sdk`, `zod`, `node:sqlite` (built-in), Vitest, Node 24 runtime.

**Scope (this plan):** config • response envelope • credential scrubbing • CTE-aware classifier • signed keyset/offset cursor • result limits + type coercion • identifier safety • `Dialect` interface • SQLite dialect • read tools (`capabilities`, `list_schemas`, `list_tables`, `describe_table`, `query`) • server wiring • bundle. **Out of this plan (later phases):** write tools (`execute`/`execute_batch`/`execute_ddl`), Postgres/MySQL/MSSQL adapters, the `ai-assets/mcp/sql/MCP.md` catalog entry + release. See "Follow-on phases" at the end.

**Spec:** `docs/specs/2026-06-16-sql-mcp-design.md` (§ references below point to it).

---

## File structure (this phase)

```
sql-mcp/
├── package.json                 # deps, scripts (test, build, typecheck)
├── tsconfig.json                # strict TS
├── vitest.config.ts             # test config
├── build.ts                     # bun build → dist/server.js
├── src/
│   ├── server.ts                # entry: load config, connect dialect, register read tools, stdio transport
│   ├── version.ts               # SERVER_VERSION constant
│   ├── config.ts                # parse + validate env → Config
│   ├── envelope.ts              # ok()/err() uniform response envelope + ErrorCode
│   ├── scrub.ts                 # scrubCredentials(text) — strip DSNs/passwords/tokens
│   ├── classifier.ts            # classify(sql) → select|dml|ddl|other|multiple (CTE-aware, comment/stack-safe)
│   ├── identifiers.ts           # assertValidIdent(name) + quote helpers
│   ├── cursor.ts                # encodeCursor/decodeCursor (HMAC-signed)
│   ├── limits.ts                # coerceValue/coerceRows + page-size math
│   ├── dialect/
│   │   ├── types.ts             # Dialect interface + shared row/column types
│   │   ├── sqlite.ts            # SqliteDialect (read methods) + injectable db factory
│   │   └── index.ts             # createDialect(config) registry
│   └── tools/
│       ├── register.ts          # registerReadTools(server, dialect, config)
│       ├── capabilities.ts      # sql.capabilities handler
│       ├── introspection.ts     # sql.list_schemas / list_tables / describe_table handlers
│       └── query.ts             # sql.query handler (classify + paginate + limit + coerce)
└── tests/
    ├── config.test.ts
    ├── envelope.test.ts
    ├── scrub.test.ts
    ├── classifier.test.ts
    ├── identifiers.test.ts
    ├── cursor.test.ts
    ├── limits.test.ts
    ├── dialect/sqlite.test.ts            # unit, fake db
    ├── tools/query.test.ts               # unit, fake dialect
    └── integration/sqlite.live.test.ts   # real node:sqlite, temp file
```

---

## Task 0: Repository scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `build.ts`, `src/version.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@skaile/sql-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Portable SQL MCP server (PostgreSQL, MySQL, SQLite, MSSQL)",
  "engines": { "node": ">=24" },
  "bin": { "sql-mcp": "dist/server.js" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "bun run build.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.5.0",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src", "tests", "build.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create `src/version.ts`**

```ts
export const SERVER_VERSION = "0.1.0";
```

- [ ] **Step 5: Create `build.ts`** (bundles to a single file; `node:*` builtins stay external)

```ts
// Bundles the server to dist/server.js for the ai-assets upstream_pointer asset.
// node: builtins (incl. node:sqlite) are externalized; everything else is inlined.
const result = await Bun.build({
  entrypoints: ["src/server.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  minify: false,
  naming: "server.js",
});
if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
console.log("Built dist/server.js");
```

- [ ] **Step 6: Install deps and verify typecheck runs**

Run: `bun install && bun run typecheck`
Expected: install succeeds; `tsc --noEmit` exits 0 (no source files yet → no errors).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts build.ts src/version.ts bun.lock
git commit -m "chore: scaffold Node/TS project (bun, vitest, build)"
```

---

## Task 1: Config module (`src/config.ts`)

Parses and validates the env surface (spec §4). Phase 1 only needs `sqlite` + `readonly`, but the full enums are validated so later phases don't churn the parser.

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { SQL_MCP_DIALECT: "sqlite", SQL_MCP_DSN: "/tmp/db.sqlite" };

describe("loadConfig", () => {
  it("parses required fields and applies limit defaults", () => {
    const c = loadConfig(base);
    expect(c.dialect).toBe("sqlite");
    expect(c.dsn).toBe("/tmp/db.sqlite");
    expect(c.access).toBe("readonly"); // safest default
    expect(c.maxRows).toBe(1000);
    expect(c.maxResultBytes).toBe(10 * 1024 * 1024);
    expect(c.statementTimeoutMs).toBe(30_000);
    expect(c.cursorSecret).toBe("/tmp/db.sqlite"); // defaults to DSN derivation
  });

  it("rejects an unknown dialect", () => {
    expect(() => loadConfig({ ...base, SQL_MCP_DIALECT: "oracle" })).toThrow(/dialect/i);
  });

  it("requires a DSN", () => {
    expect(() => loadConfig({ SQL_MCP_DIALECT: "sqlite" })).toThrow(/SQL_MCP_DSN/);
  });

  it("caps max_rows at 10000", () => {
    expect(loadConfig({ ...base, SQL_MCP_MAX_ROWS: "999999" }).maxRows).toBe(10_000);
  });

  it("honours explicit access + cursor secret", () => {
    const c = loadConfig({ ...base, SQL_MCP_ACCESS: "full", SQL_MCP_CURSOR_SECRET: "s3cret" });
    expect(c.access).toBe("full");
    expect(c.cursorSecret).toBe("s3cret");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- config`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/config.ts
export const DIALECTS = ["postgres", "mysql", "sqlite", "mssql"] as const;
export type DialectName = (typeof DIALECTS)[number];

export const ACCESS_SCOPES = ["readonly", "dml", "full"] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export interface Config {
  dialect: DialectName;
  dsn: string;
  access: AccessScope;
  maxRows: number;
  maxResultBytes: number;
  statementTimeoutMs: number;
  cursorSecret: string;
}

const MAX_ROWS_CAP = 10_000;

function intEnv(raw: string | undefined, fallback: number, cap?: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return cap ? Math.min(n, cap) : n;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const dialect = env.SQL_MCP_DIALECT as DialectName | undefined;
  if (!dialect || !DIALECTS.includes(dialect)) {
    throw new Error(`SQL_MCP_DIALECT must be one of ${DIALECTS.join(", ")} (got ${String(dialect)})`);
  }
  const dsn = env.SQL_MCP_DSN;
  if (!dsn) throw new Error("SQL_MCP_DSN is required");

  const access = (env.SQL_MCP_ACCESS as AccessScope | undefined) ?? "readonly";
  if (!ACCESS_SCOPES.includes(access)) {
    throw new Error(`SQL_MCP_ACCESS must be one of ${ACCESS_SCOPES.join(", ")} (got ${access})`);
  }

  return {
    dialect,
    dsn,
    access,
    maxRows: intEnv(env.SQL_MCP_MAX_ROWS, 1000, MAX_ROWS_CAP),
    maxResultBytes: intEnv(env.SQL_MCP_MAX_RESULT_BYTES, 10 * 1024 * 1024),
    statementTimeoutMs: intEnv(env.SQL_MCP_STATEMENT_TIMEOUT_MS, 30_000),
    // Defaults to a deterministic derivation from the DSN so cursor tokens
    // survive restarts (spec §6a). Set explicitly to control rotation.
    cursorSecret: env.SQL_MCP_CURSOR_SECRET ?? dsn,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- config`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config env parsing + validation"
```

---

## Task 2: Response envelope (`src/envelope.ts`)

Uniform structured envelope (spec §9), including the optional non-fatal `warning`.

**Files:**
- Create: `src/envelope.ts`
- Test: `tests/envelope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/envelope.test.ts
import { describe, it, expect } from "vitest";
import { ok, err } from "../src/envelope.js";

describe("envelope", () => {
  it("ok() builds a success envelope", () => {
    expect(ok("sql.query", { rows: [] })).toEqual({
      status: "success",
      tool_name: "sql.query",
      retriable: false,
      data: { rows: [] },
    });
  });

  it("ok() includes a warning when provided", () => {
    expect(ok("sql.query", { rows: [] }, "ROWS_TRUNCATED").warning).toBe("ROWS_TRUNCATED");
  });

  it("err() builds an error envelope without a data field", () => {
    const e = err("sql.query", "ACCESS_DENIED", "not allowed");
    expect(e).toEqual({
      status: "error",
      tool_name: "sql.query",
      code: "ACCESS_DENIED",
      error: "not allowed",
      retriable: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- envelope`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/envelope.ts
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "ACCESS_DENIED"
  | "CONNECTION_FAILED"
  | "STATEMENT_TIMEOUT"
  | "RESULT_TOO_LARGE"
  | "DIALECT_UNSUPPORTED"
  | "TOOL_EXECUTION_ERROR";

export interface SuccessEnvelope<T> {
  status: "success";
  tool_name: string;
  retriable: false;
  data: T;
  warning?: string;
}

export interface ErrorEnvelope {
  status: "error";
  tool_name: string;
  code: ErrorCode;
  error: string;
  retriable: boolean;
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(toolName: string, data: T, warning?: string): SuccessEnvelope<T> {
  const env: SuccessEnvelope<T> = { status: "success", tool_name: toolName, retriable: false, data };
  if (warning) env.warning = warning;
  return env;
}

export function err(
  toolName: string,
  code: ErrorCode,
  error: string,
  retriable = false,
): ErrorEnvelope {
  return { status: "error", tool_name: toolName, code, error, retriable };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- envelope`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/envelope.ts tests/envelope.test.ts
git commit -m "feat: uniform response envelope"
```

---

## Task 3: Credential scrubbing (`src/scrub.ts`)

Mandatory per spec §9 — driver errors routinely embed DSNs with passwords.

**Files:**
- Create: `src/scrub.ts`
- Test: `tests/scrub.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/scrub.test.ts
import { describe, it, expect } from "vitest";
import { scrubCredentials } from "../src/scrub.js";

describe("scrubCredentials", () => {
  it("masks the password inside a DSN", () => {
    const out = scrubCredentials("connect ECONNREFUSED postgresql://admin:s3cret@host:5432/db");
    expect(out).not.toContain("s3cret");
    expect(out).toContain("postgresql://admin:***@host:5432/db");
  });

  it("masks mysql/mssql style DSNs too", () => {
    expect(scrubCredentials("mysql://u:p@h/d")).not.toContain(":p@");
    expect(scrubCredentials("Server=h;User Id=u;Password=p;")).not.toContain("Password=p");
  });

  it("masks bearer tokens", () => {
    expect(scrubCredentials("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
  });

  it("leaves clean text untouched", () => {
    expect(scrubCredentials("table users not found")).toBe("table users not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- scrub`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/scrub.ts
// Fail-safe: when in doubt, mask. Patterns run in order; each is conservative.
const PATTERNS: Array<[RegExp, string]> = [
  // URL-style DSN userinfo: scheme://user:PASSWORD@host  ->  scheme://user:***@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, "$1***$2"],
  // key=value secrets: password=..., pwd=..., Password=...;
  [/((?:password|pwd)\s*=\s*)[^;\s]+/gi, "$1***"],
  // Bearer tokens
  [/(\bBearer\s+)[A-Za-z0-9._\-]+/gi, "$1***"],
];

/** Strip credential material (DSN passwords, key=value secrets, bearer tokens) from any text
 *  before it reaches a tool envelope or a log line. */
export function scrubCredentials(text: string): string {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Convenience: scrub an arbitrary thrown value down to a safe message string. */
export function safeErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return scrubCredentials(msg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- scrub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scrub.ts tests/scrub.test.ts
git commit -m "feat: credential scrubbing for errors/logs"
```

---

## Task 4: Statement classifier (`src/classifier.ts`)

Single shared classifier (spec §7.2). Must reject statement-stacking + comment-smuggling and detect **data-modifying CTEs**. Strategy: mask comments + string/quoted-identifier literals, reject a `;` that separates two non-empty statements, then classify by the keyword set present in the masked text (fail-closed: the most dangerous keyword wins). Per-dialect keyword hooks are accepted but default to none.

**Files:**
- Create: `src/classifier.ts`
- Test: `tests/classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/classifier.test.ts
import { describe, it, expect } from "vitest";
import { classify } from "../src/classifier.js";

describe("classify", () => {
  it("classifies a plain SELECT", () => {
    expect(classify("SELECT * FROM users").class).toBe("select");
  });

  it("classifies DML", () => {
    expect(classify("UPDATE users SET active = true WHERE id = $1").class).toBe("dml");
    expect(classify("delete from users").class).toBe("dml");
  });

  it("classifies DDL", () => {
    expect(classify("DROP TABLE users").class).toBe("ddl");
    expect(classify("create table t (id int)").class).toBe("ddl");
    expect(classify("TRUNCATE users").class).toBe("ddl");
  });

  it("flags multiple statements", () => {
    expect(classify("SELECT 1; DROP TABLE users").class).toBe("multiple");
  });

  it("ignores a trailing semicolon", () => {
    expect(classify("SELECT 1;").class).toBe("select");
  });

  it("does not treat a ';' inside a string literal as a separator", () => {
    expect(classify("SELECT ';drop' AS x").class).toBe("select");
  });

  it("ignores keywords hidden in comments", () => {
    expect(classify("SELECT 1 -- DROP TABLE users").class).toBe("select");
    expect(classify("SELECT 1 /* delete from x */").class).toBe("select");
  });

  it("detects a data-modifying CTE as a write (not a read)", () => {
    const sql = "WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d";
    expect(classify(sql).class).toBe("dml");
  });

  it("does not misclassify a column literally named after a keyword", () => {
    // 'update' as a quoted identifier is masked, so it stays a select
    expect(classify('SELECT "update" FROM t').class).toBe("select");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- classifier`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/classifier.ts
export type StmtClass = "select" | "dml" | "ddl" | "other" | "multiple";

export interface ClassifyHooks {
  extraDml?: string[]; // e.g. ["merge"] for dialects that treat MERGE as DML
  extraDdl?: string[];
}

export interface ClassifyResult {
  class: StmtClass;
  reason?: string;
}

const DDL = ["create", "alter", "drop", "truncate", "rename"];
const DML = ["insert", "update", "delete", "replace", "upsert"];

/**
 * Mask string literals, quoted identifiers, and comments to a single space so that
 * keyword/`;` detection only sees real SQL syntax. Fail-closed by design.
 */
function mask(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; } // doubled escape
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      out += " ";
    } else if (c === "[") {
      // MSSQL bracket identifier
      i++;
      while (i < n && sql[i] !== "]") i++;
      i++;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function hasWord(masked: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(masked);
}

export function classify(sql: string, hooks: ClassifyHooks = {}): ClassifyResult {
  const masked = mask(sql);

  // Statement stacking: any ';' with non-whitespace after it ⇒ multiple statements.
  const semiIdx = masked.indexOf(";");
  if (semiIdx !== -1 && masked.slice(semiIdx + 1).trim().length > 0) {
    return { class: "multiple", reason: "multiple statements are not allowed" };
  }

  const ddl = [...DDL, ...(hooks.extraDdl ?? [])];
  const dml = [...DML, ...(hooks.extraDml ?? [])];

  // Fail-closed precedence: DDL > DML > SELECT. A SELECT whose body contains a
  // data-modifying keyword (e.g. a data-modifying CTE) is treated as that class.
  if (ddl.some((k) => hasWord(masked, k))) return { class: "ddl" };
  if (dml.some((k) => hasWord(masked, k))) return { class: "dml" };
  if (hasWord(masked, "select") || hasWord(masked, "with")) return { class: "select" };
  return { class: "other", reason: "unrecognized statement" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- classifier`
Expected: PASS (9 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/classifier.ts tests/classifier.test.ts
git commit -m "feat: shared CTE-aware SQL statement classifier"
```

> **Note for later phases:** §13 flags that a full `WITH`-aware parser may be needed for edge cases (e.g. a benign SELECT subquery that merely *references* a table named like a keyword). The masked-keyword approach here is intentionally fail-closed (over-rejects rather than under-rejects). Revisit with a real parser if false-positives become a problem.

---

## Task 5: Identifier safety (`src/identifiers.ts`)

Introspection identifiers can't be value-bound (spec §8) → allowlist-validate + dialect-quote.

**Files:**
- Create: `src/identifiers.ts`
- Test: `tests/identifiers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/identifiers.test.ts
import { describe, it, expect } from "vitest";
import { assertValidIdent, quoteIdentAnsi, quoteIdentMysql, quoteIdentMssql } from "../src/identifiers.js";

describe("identifiers", () => {
  it("accepts normal names", () => {
    expect(() => assertValidIdent("users")).not.toThrow();
    expect(() => assertValidIdent("public_schema$1")).not.toThrow();
  });

  it("rejects injection attempts and oversized names", () => {
    expect(() => assertValidIdent('users"; DROP TABLE users; --')).toThrow(/identifier/i);
    expect(() => assertValidIdent("a".repeat(129))).toThrow(/identifier/i);
    expect(() => assertValidIdent("")).toThrow(/identifier/i);
  });

  it("quotes per dialect and escapes the close char", () => {
    expect(quoteIdentAnsi('a"b')).toBe('"a""b"');
    expect(quoteIdentMysql("a`b")).toBe("`a``b`");
    expect(quoteIdentMssql("a]b")).toBe("[a]]b]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- identifiers`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/identifiers.ts
const IDENT_RE = /^[A-Za-z_][\w$]{0,127}$/;

/** Allowlist-validate an identifier before it is ever interpolated into SQL. */
export function assertValidIdent(name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`invalid identifier: must match ${IDENT_RE} (1-128 chars, word/$ only)`);
  }
}

export function quoteIdentAnsi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
export function quoteIdentMysql(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}
export function quoteIdentMssql(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- identifiers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/identifiers.ts tests/identifiers.test.ts
git commit -m "feat: identifier allowlist + dialect quoting"
```

---

## Task 6: Signed cursor (`src/cursor.ts`)

Keyset/offset pagination token, HMAC-signed with the cursor secret (spec §6a). Tampered tokens are rejected.

**Files:**
- Create: `src/cursor.ts`
- Test: `tests/cursor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/cursor.test.ts
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../src/cursor.js";

const SECRET = "test-secret";

describe("cursor", () => {
  it("round-trips an offset payload", () => {
    const token = encodeCursor({ mode: "offset", offset: 100 }, SECRET);
    expect(decodeCursor(token, SECRET)).toEqual({ mode: "offset", offset: 100 });
  });

  it("rejects a tampered payload", () => {
    const token = encodeCursor({ mode: "offset", offset: 100 }, SECRET);
    const [body] = token.split(".");
    const forged = `${body}xx.${token.split(".")[1]}`;
    expect(() => decodeCursor(forged, SECRET)).toThrow(/cursor/i);
  });

  it("rejects a token signed with a different secret", () => {
    const token = encodeCursor({ mode: "offset", offset: 1 }, SECRET);
    expect(() => decodeCursor(token, "other")).toThrow(/cursor/i);
  });

  it("rejects malformed tokens", () => {
    expect(() => decodeCursor("not-a-token", SECRET)).toThrow(/cursor/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- cursor`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/cursor.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export interface CursorPayload {
  mode: "offset" | "keyset";
  offset?: number; // offset mode
  orderKey?: string; // keyset mode (reserved for a later phase)
  lastValue?: string | number | null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Encode a self-contained, integrity-protected cursor token: `<b64url(json)>.<b64url(hmac)>`. */
export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body, secret)}`;
}

/** Decode + verify a cursor token. Throws on any tampering, bad signature, or malformed input. */
export function decodeCursor(token: string, secret: string): CursorPayload {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("invalid cursor: malformed token");
  const [body, mac] = parts as [string, string];
  const expected = sign(body, secret);
  const a = fromB64url(mac);
  const b = fromB64url(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid cursor: signature mismatch");
  }
  try {
    return JSON.parse(fromB64url(body).toString("utf8")) as CursorPayload;
  } catch {
    throw new Error("invalid cursor: unparseable payload");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- cursor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cursor.ts tests/cursor.test.ts
git commit -m "feat: HMAC-signed pagination cursor"
```

---

## Task 7: Result limits + type coercion (`src/limits.ts`)

JSON-safe coercion (bigint/date/binary/null) and the page-size + byte-cap math (spec §8).

**Files:**
- Create: `src/limits.ts`
- Test: `tests/limits.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/limits.test.ts
import { describe, it, expect } from "vitest";
import { coerceValue, capRows, byteSize } from "../src/limits.js";

describe("coerceValue", () => {
  it("stringifies bigint, ISO-formats dates, base64s binary, nulls undefined", () => {
    expect(coerceValue(10n)).toBe("10");
    expect(coerceValue(new Date("2024-03-05T10:00:00.000Z"))).toBe("2024-03-05T10:00:00.000Z");
    expect(coerceValue(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(coerceValue(undefined)).toBeNull();
    expect(coerceValue("plain")).toBe("plain");
    expect(coerceValue(42)).toBe(42);
  });
});

describe("capRows", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));

  it("returns all rows when under the cap, not truncated", () => {
    const r = capRows(rows, 10, 1_000_000);
    expect(r.rows).toHaveLength(5);
    expect(r.truncated).toBe(false);
  });

  it("clips to maxRows and flags truncation", () => {
    const r = capRows(rows, 3, 1_000_000);
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("throws RESULT_TOO_LARGE when the page exceeds the byte cap", () => {
    expect(() => capRows(rows, 10, 1)).toThrow(/RESULT_TOO_LARGE/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- limits`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/limits.ts
/** Coerce a DB value into a JSON-safe value (spec §8 type handling). */
export function coerceValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (Buffer.isBuffer(v)) return v.toString("base64");
  return v;
}

export function coerceRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = coerceValue(row[k]);
  return out;
}

export function byteSize(rows: unknown): number {
  return Buffer.byteLength(JSON.stringify(rows), "utf8");
}

export interface CappedRows {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

/**
 * Clip rows to maxRows (flagging truncation) and enforce the byte cap.
 * Throws an Error whose message contains RESULT_TOO_LARGE when the (already
 * row-capped) page still exceeds maxResultBytes — callers map this to the code.
 */
export function capRows(
  rows: Record<string, unknown>[],
  maxRows: number,
  maxResultBytes: number,
): CappedRows {
  const truncated = rows.length > maxRows;
  const clipped = (truncated ? rows.slice(0, maxRows) : rows).map(coerceRow);
  if (byteSize(clipped) > maxResultBytes) {
    throw new Error("RESULT_TOO_LARGE: result exceeds max_result_bytes; narrow the query or columns");
  }
  return { rows: clipped, truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- limits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/limits.ts tests/limits.test.ts
git commit -m "feat: result type coercion + row/byte caps"
```

---

## Task 8: Dialect interface + SQLite dialect

`Dialect` interface (read subset for this phase) plus the SQLite implementation, with an injectable `db` factory so logic tests need no real binding. Spec §10.

**Files:**
- Create: `src/dialect/types.ts`, `src/dialect/sqlite.ts`, `src/dialect/index.ts`
- Test: `tests/dialect/sqlite.test.ts`

- [ ] **Step 1: Write the failing test (unit, fake db)**

```ts
// tests/dialect/sqlite.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import type { SqliteDb } from "../../src/dialect/sqlite.js";

// Minimal fake of the node:sqlite surface the dialect uses.
function fakeDb(responses: Record<string, unknown[]>): SqliteDb {
  return {
    prepare(sql: string) {
      return {
        all: (..._params: unknown[]) => responses[sql.trim()] ?? [],
      };
    },
    close() {},
  };
}

describe("SqliteDialect (read)", () => {
  it("rewrites canonical $1 params to ?", async () => {
    const d = new SqliteDialect("readonly", () => fakeDb({}));
    await d.connect(":memory:");
    expect(d.rewriteParams("SELECT * FROM t WHERE a=$1 AND b=$2")).toBe(
      "SELECT * FROM t WHERE a=? AND b=?",
    );
  });

  it("lists tables and views from sqlite_master", async () => {
    const sql = "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
    const d = new SqliteDialect("readonly", () =>
      fakeDb({ [sql]: [{ name: "users", type: "table" }, { name: "v_active", type: "view" }] }),
    );
    await d.connect(":memory:");
    const tables = await d.listTables();
    expect(tables).toEqual([
      { name: "users", type: "table", schema: "main" },
      { name: "v_active", type: "view", schema: "main" },
    ]);
  });

  it("describes a table via PRAGMA with a quoted identifier", async () => {
    const d = new SqliteDialect("readonly", () =>
      fakeDb({
        'PRAGMA table_info("users")': [
          { cid: 0, name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
        ],
      }),
    );
    await d.connect(":memory:");
    const cols = await d.describeTable("users");
    expect(cols[0]).toMatchObject({ name: "id", type: "INTEGER", nullable: false, primaryKey: true });
  });

  it("rejects an invalid table identifier before building PRAGMA SQL", async () => {
    const d = new SqliteDialect("readonly", () => fakeDb({}));
    await d.connect(":memory:");
    await expect(d.describeTable('x"; DROP TABLE x; --')).rejects.toThrow(/identifier/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- sqlite`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/dialect/types.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/dialect/sqlite.ts`**

```ts
// src/dialect/sqlite.ts
import type { AccessScope } from "../config.js";
import { assertValidIdent, quoteIdentAnsi } from "../identifiers.js";
import type { ColumnInfo, Dialect, QueryResult, TableInfo } from "./types.js";

// The slice of node:sqlite's DatabaseSync we depend on (kept tiny for testability).
export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
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
```

- [ ] **Step 5: Write `src/dialect/index.ts`**

```ts
// src/dialect/index.ts
import type { Config } from "../config.js";
import type { Dialect } from "./types.js";
import { SqliteDialect } from "./sqlite.js";

/** Construct the configured dialect. Phase 1 supports sqlite only. */
export function createDialect(config: Config): Dialect {
  switch (config.dialect) {
    case "sqlite":
      return new SqliteDialect(config.access);
    default:
      throw new Error(`DIALECT_UNSUPPORTED: ${config.dialect} is not implemented yet`);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run test -- sqlite`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/dialect/types.ts src/dialect/sqlite.ts src/dialect/index.ts tests/dialect/sqlite.test.ts
git commit -m "feat: Dialect interface + read-only SQLite dialect"
```

---

## Task 9: `sql.query` tool handler (`src/tools/query.ts`)

The most complex handler: classify (reject non-SELECT), rewrite params, paginate via signed offset cursor, cap rows/bytes, coerce. Spec §6/§6a/§7/§8.

**Files:**
- Create: `src/tools/query.ts`
- Test: `tests/tools/query.test.ts`

- [ ] **Step 1: Write the failing test (fake dialect)**

```ts
// tests/tools/query.test.ts
import { describe, it, expect } from "vitest";
import { handleQuery } from "../../src/tools/query.js";
import type { Dialect, QueryResult } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "readonly",
  maxRows: 2, maxResultBytes: 1_000_000, statementTimeoutMs: 30_000, cursorSecret: "s",
};

function dialectReturning(rows: Record<string, unknown>[]): Dialect {
  return {
    name: "sqlite", paramStyle: "?",
    connect: async () => {}, close: async () => {},
    rewriteParams: (s) => s.replace(/\$\d+/g, "?"),
    quoteIdent: (n) => `"${n}"`,
    query: async (): Promise<QueryResult> => ({ columns: rows[0] ? Object.keys(rows[0]) : [], rows }),
    listSchemas: async () => ["main"], listTables: async () => [], describeTable: async () => [],
  };
}

describe("handleQuery", () => {
  it("rejects a non-SELECT statement with ACCESS_DENIED", async () => {
    const env = await handleQuery(dialectReturning([]), config, { sql: "DELETE FROM t" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("rejects multiple statements", async () => {
    const env = await handleQuery(dialectReturning([]), config, { sql: "SELECT 1; SELECT 2" });
    expect(env).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  });

  it("returns a page and a next_cursor when more rows exist", async () => {
    // maxRows=2 → page size 2; dialect returns 3 (page+1) → there is a next page.
    const d = dialectReturning([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const env = await handleQuery(d, config, { sql: "SELECT * FROM t" });
    expect(env.status).toBe("success");
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.rows).toHaveLength(2);
    expect(env.data.rowCount).toBe(2);
    expect(typeof env.data.next_cursor).toBe("string");
    expect(env.data.truncated).toBe(false);
  });

  it("omits next_cursor on the last page", async () => {
    const d = dialectReturning([{ id: 1 }]);
    const env = await handleQuery(d, config, { sql: "SELECT * FROM t" });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.next_cursor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- query`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools/query.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { classify } from "../classifier.js";
import { encodeCursor, decodeCursor } from "../cursor.js";
import { capRows } from "../limits.js";
import { ok, err, type Envelope } from "../envelope.js";

const TOOL = "sql.query";

export interface QueryInput {
  sql: string;
  params?: unknown[];
  cursor?: string;
  limit?: number;
}

export interface QueryData {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  next_cursor?: string;
}

/** Wrap arbitrary user SELECT SQL as a sub-select so we can apply LIMIT/OFFSET uniformly. */
function paginate(sql: string, limit: number, offset: number): string {
  const trimmed = sql.replace(/;\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS _page LIMIT ${limit} OFFSET ${offset}`;
}

export async function handleQuery(
  dialect: Dialect,
  config: Config,
  input: QueryInput,
): Promise<Envelope<QueryData>> {
  const cls = classify(input.sql);
  if (cls.class !== "select") {
    return err(TOOL, "ACCESS_DENIED", `sql.query accepts read-only SELECT only (got ${cls.class})`);
  }

  // Page size: bounded by maxRows. If the caller asked for more than the cap, we clip + warn.
  const requested = input.limit ?? config.maxRows;
  const overCap = requested > config.maxRows;
  const pageSize = Math.min(requested, config.maxRows);

  let offset = 0;
  if (input.cursor) {
    try {
      const c = decodeCursor(input.cursor, config.cursorSecret);
      offset = c.offset ?? 0;
    } catch (e) {
      return err(TOOL, "VALIDATION_ERROR", (e as Error).message);
    }
  }

  // Fetch one extra row to detect whether a further page exists.
  const native = dialect.rewriteParams(paginate(input.sql, pageSize + 1, offset));
  let result;
  try {
    result = await dialect.query(native, input.params ?? []);
  } catch (e) {
    return err(TOOL, "TOOL_EXECUTION_ERROR", (e as Error).message);
  }

  const hasMore = result.rows.length > pageSize;
  const pageRows = hasMore ? result.rows.slice(0, pageSize) : result.rows;

  let capped;
  try {
    capped = capRows(pageRows, pageSize, config.maxResultBytes);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("RESULT_TOO_LARGE")) return err(TOOL, "RESULT_TOO_LARGE", msg);
    return err(TOOL, "TOOL_EXECUTION_ERROR", msg);
  }

  const data: QueryData = {
    columns: result.columns,
    rows: capped.rows,
    rowCount: capped.rows.length,
    truncated: overCap,
  };
  if (hasMore) {
    data.next_cursor = encodeCursor({ mode: "offset", offset: offset + pageSize }, config.cursorSecret);
  }
  return ok(TOOL, data, overCap ? "ROWS_TRUNCATED" : undefined);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- query`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/query.ts tests/tools/query.test.ts
git commit -m "feat: sql.query handler (classify, paginate, cap)"
```

---

## Task 10: Capabilities + introspection handlers (`src/tools/capabilities.ts`, `src/tools/introspection.ts`)

**Files:**
- Create: `src/tools/capabilities.ts`, `src/tools/introspection.ts`
- Test: extend `tests/tools/query.test.ts` is not appropriate; create `tests/tools/introspection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/introspection.test.ts
import { describe, it, expect } from "vitest";
import { handleCapabilities } from "../../src/tools/capabilities.js";
import { handleListTables, handleDescribeTable } from "../../src/tools/introspection.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "readonly",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};

const dialect: Dialect = {
  name: "sqlite", paramStyle: "?",
  connect: async () => {}, close: async () => {},
  rewriteParams: (s) => s, quoteIdent: (n) => `"${n}"`,
  query: async () => ({ columns: [], rows: [] }),
  listSchemas: async () => ["main"],
  listTables: async () => [{ name: "users", type: "table", schema: "main" }],
  describeTable: async () => [{ name: "id", type: "INTEGER", nullable: false, default: null, primaryKey: true }],
};

describe("introspection + capabilities", () => {
  it("capabilities reports dialect, access scope, and limits", async () => {
    const env = await handleCapabilities(dialect, config);
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data).toMatchObject({
      dialect: "sqlite", access: "readonly",
      limits: { max_rows: 1000, max_result_bytes: 10_485_760, statement_timeout_ms: 30_000 },
    });
  });

  it("list_tables returns the dialect's tables", async () => {
    const env = await handleListTables(dialect, {});
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.tables[0]).toMatchObject({ name: "users", type: "table" });
  });

  it("describe_table returns ACCESS-safe columns", async () => {
    const env = await handleDescribeTable(dialect, { table: "users" });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.columns[0]).toMatchObject({ name: "id", primaryKey: true });
  });

  it("describe_table surfaces an invalid identifier as VALIDATION_ERROR", async () => {
    const bad: Dialect = { ...dialect, describeTable: async () => { throw new Error("invalid identifier: x"); } };
    const env = await handleDescribeTable(bad, { table: "x\"; DROP" });
    expect(env).toMatchObject({ status: "error", code: "VALIDATION_ERROR" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- introspection`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/tools/capabilities.ts`**

```ts
// src/tools/capabilities.ts
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { ok, type Envelope } from "../envelope.js";
import { SERVER_VERSION } from "../version.js";

export interface CapabilitiesData {
  server_version: string;
  dialect: string;
  param_style: string;
  access: string;
  feature_flags: { write: boolean; ddl: boolean; transactions_handle: boolean; server_side_cursors: boolean };
  limits: { max_rows: number; max_result_bytes: number; statement_timeout_ms: number };
}

export async function handleCapabilities(
  dialect: Dialect,
  config: Config,
): Promise<Envelope<CapabilitiesData>> {
  return ok("sql.capabilities", {
    server_version: SERVER_VERSION,
    dialect: dialect.name,
    param_style: dialect.paramStyle,
    access: config.access,
    feature_flags: {
      write: config.access !== "readonly",
      ddl: config.access === "full",
      transactions_handle: false, // v2
      server_side_cursors: false, // v2
    },
    limits: {
      max_rows: config.maxRows,
      max_result_bytes: config.maxResultBytes,
      statement_timeout_ms: config.statementTimeoutMs,
    },
  });
}
```

- [ ] **Step 4: Write `src/tools/introspection.ts`**

```ts
// src/tools/introspection.ts
import type { Dialect, ColumnInfo, TableInfo } from "../dialect/types.js";
import { ok, err, type Envelope } from "../envelope.js";

export async function handleListSchemas(dialect: Dialect): Promise<Envelope<{ schemas: string[] }>> {
  try {
    return ok("sql.list_schemas", { schemas: await dialect.listSchemas() });
  } catch (e) {
    return err("sql.list_schemas", "TOOL_EXECUTION_ERROR", (e as Error).message);
  }
}

export async function handleListTables(
  dialect: Dialect,
  input: { schema?: string },
): Promise<Envelope<{ tables: TableInfo[] }>> {
  try {
    return ok("sql.list_tables", { tables: await dialect.listTables(input.schema) });
  } catch (e) {
    return err("sql.list_tables", "TOOL_EXECUTION_ERROR", (e as Error).message);
  }
}

export async function handleDescribeTable(
  dialect: Dialect,
  input: { table: string; schema?: string },
): Promise<Envelope<{ columns: ColumnInfo[] }>> {
  try {
    return ok("sql.describe_table", { columns: await dialect.describeTable(input.table, input.schema) });
  } catch (e) {
    const msg = (e as Error).message;
    // Identifier allowlist failures are caller errors, not server faults.
    if (/identifier/i.test(msg)) return err("sql.describe_table", "VALIDATION_ERROR", msg);
    return err("sql.describe_table", "TOOL_EXECUTION_ERROR", msg);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test -- introspection`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/capabilities.ts src/tools/introspection.ts tests/tools/introspection.test.ts
git commit -m "feat: capabilities + introspection handlers"
```

---

## Task 11: Tool registration + server wiring (`src/tools/register.ts`, `src/server.ts`)

Register the read tools on an `McpServer` (gating by scope is a no-op in Phase 1 since only read tools exist), connect the dialect, and serve over stdio. Each handler's envelope is returned as a single JSON text content block, and credential scrubbing is the last line of defense on any thrown error.

**Files:**
- Create: `src/tools/register.ts`, `src/server.ts`
- Test: `tests/tools/register.test.ts`

- [ ] **Step 1: Write the failing test (verifies registration wires handlers to a minimal server stub)**

```ts
// tests/tools/register.test.ts
import { describe, it, expect } from "vitest";
import { registerReadTools, type ToolRegistrar } from "../../src/tools/register.js";
import type { Dialect } from "../../src/dialect/types.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  dialect: "sqlite", dsn: ":memory:", access: "readonly",
  maxRows: 1000, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};
const dialect: Dialect = {
  name: "sqlite", paramStyle: "?", connect: async () => {}, close: async () => {},
  rewriteParams: (s) => s, quoteIdent: (n) => `"${n}"`,
  query: async () => ({ columns: ["n"], rows: [{ n: 1 }] }),
  listSchemas: async () => ["main"], listTables: async () => [], describeTable: async () => [],
};

describe("registerReadTools", () => {
  it("registers the five read tools and they return JSON text content", async () => {
    const registered: Record<string, (args: any) => Promise<any>> = {};
    const fake: ToolRegistrar = {
      registerTool(name, _def, handler) { registered[name] = handler; },
    };
    registerReadTools(fake, dialect, config);

    expect(Object.keys(registered).sort()).toEqual(
      ["sql.capabilities", "sql.describe_table", "sql.list_schemas", "sql.list_tables", "sql.query"].sort(),
    );

    const res = await registered["sql.query"]!({ sql: "SELECT 1 AS n" });
    expect(res.content[0].type).toBe("text");
    const env = JSON.parse(res.content[0].text);
    expect(env.status).toBe("success");
    expect(env.data.rows).toEqual([{ n: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- register`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/register.ts`**

```ts
// src/tools/register.ts
import { z } from "zod";
import type { Config } from "../config.js";
import type { Dialect } from "../dialect/types.js";
import { handleCapabilities } from "./capabilities.js";
import { handleListSchemas, handleListTables, handleDescribeTable } from "./introspection.js";
import { handleQuery } from "./query.js";
import { err } from "../envelope.js";
import { safeErrorMessage } from "../scrub.js";

export interface ToolContent {
  content: Array<{ type: "text"; text: string }>;
}

/** Minimal surface of McpServer.registerTool we depend on (keeps registration unit-testable). */
export interface ToolRegistrar {
  registerTool(
    name: string,
    def: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: any) => Promise<ToolContent>,
  ): void;
}

function asContent(env: unknown): ToolContent {
  return { content: [{ type: "text", text: JSON.stringify(env) }] };
}

/** Wrap a handler so every envelope is serialized and any thrown error is scrubbed + enveloped. */
function wrap(toolName: string, fn: (args: any) => Promise<unknown>) {
  return async (args: any): Promise<ToolContent> => {
    try {
      return asContent(await fn(args));
    } catch (e) {
      return asContent(err(toolName, "TOOL_EXECUTION_ERROR", safeErrorMessage(e)));
    }
  };
}

export function registerReadTools(server: ToolRegistrar, dialect: Dialect, config: Config): void {
  server.registerTool(
    "sql.capabilities",
    { description: "Report dialect, access scope, feature flags, and safety limits.", inputSchema: {} },
    wrap("sql.capabilities", () => handleCapabilities(dialect, config)),
  );

  server.registerTool(
    "sql.list_schemas",
    { description: "List schemas/databases visible to the connection.", inputSchema: {} },
    wrap("sql.list_schemas", () => handleListSchemas(dialect)),
  );

  server.registerTool(
    "sql.list_tables",
    {
      description: "List tables and views, optionally scoped to a schema.",
      inputSchema: { schema: z.string().optional() },
    },
    wrap("sql.list_tables", (a) => handleListTables(dialect, a)),
  );

  server.registerTool(
    "sql.describe_table",
    {
      description: "Describe a table's columns, types, nullability, defaults, and primary key.",
      inputSchema: { table: z.string(), schema: z.string().optional() },
    },
    wrap("sql.describe_table", (a) => handleDescribeTable(dialect, a)),
  );

  server.registerTool(
    "sql.query",
    {
      description:
        "Run a read-only SELECT. Parameterized ($1,$2). Supports keyset/offset pagination via `cursor`/`limit`; returns next_cursor when more rows exist.",
      inputSchema: {
        sql: z.string(),
        params: z.array(z.unknown()).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    wrap("sql.query", (a) => handleQuery(dialect, config, a)),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- register`
Expected: PASS.

- [ ] **Step 5: Write `src/server.ts`**

```ts
// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createDialect } from "./dialect/index.js";
import { registerReadTools } from "./tools/register.js";
import { SERVER_VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const dialect = createDialect(config);
  await dialect.connect(config.dsn);

  const server = new McpServer({ name: "sql-mcp", version: SERVER_VERSION });
  registerReadTools(server, dialect, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is reserved for the JSON-RPC channel; status goes to stderr.
  process.stderr.write(`sql-mcp ${SERVER_VERSION} ready (dialect=${config.dialect}, access=${config.access})\n`);
}

main().catch((e) => {
  process.stderr.write(`sql-mcp failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Typecheck the whole project**

Run: `bun run typecheck`
Expected: exits 0.

> If `McpServer.registerTool`'s signature differs in the installed SDK version, adapt `ToolRegistrar`/`registerReadTools` to match (the handlers and envelope logic are unaffected). Verify with `bunx tsc` against the resolved `@modelcontextprotocol/sdk` types.

- [ ] **Step 7: Commit**

```bash
git add src/tools/register.ts src/server.ts tests/tools/register.test.ts
git commit -m "feat: register read tools + stdio server entry"
```

---

## Task 12: Live SQLite integration test

End-to-end against a real `node:sqlite` temp DB, exercising the dialect + query handler with actual data.

**Files:**
- Test: `tests/integration/sqlite.live.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/sqlite.live.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDialect } from "../../src/dialect/sqlite.js";
import { handleQuery } from "../../src/tools/query.js";
import { handleDescribeTable, handleListTables } from "../../src/tools/introspection.js";
import type { Config } from "../../src/config.js";

let dir: string;
let dbPath: string;

const config: Config = {
  dialect: "sqlite", dsn: "", access: "readonly",
  maxRows: 2, maxResultBytes: 10_485_760, statementTimeoutMs: 30_000, cursorSecret: "s",
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sqlmcp-"));
  dbPath = join(dir, "test.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  for (let i = 1; i <= 5; i++) seed.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(i, `u${i}`);
  seed.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("SQLite live integration", () => {
  it("describe_table reports the seeded columns", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);
    const env = await handleDescribeTable(d, { table: "users" });
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.columns.map((c) => c.name)).toEqual(["id", "name"]);
    await d.close();
  });

  it("list_tables finds users", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);
    const env = await handleListTables(d, {});
    if (env.status !== "success") throw new Error("expected success");
    expect(env.data.tables.map((t) => t.name)).toContain("users");
    await d.close();
  });

  it("query paginates through all rows via next_cursor", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);

    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const env = await handleQuery(d, config, { sql: "SELECT id FROM users ORDER BY id", cursor });
      if (env.status !== "success") throw new Error("expected success");
      seen.push(...env.data.rows.map((r) => Number(r.id)));
      cursor = env.data.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    await d.close();
  });

  it("a write through the read-only connection fails", async () => {
    const d = new SqliteDialect("readonly");
    await d.connect(dbPath);
    // Bypasses the classifier on purpose: proves the DB-level read-only guarantee (spec §7 layer 3).
    await expect(d.query("DELETE FROM users", [])).rejects.toThrow();
    await d.close();
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun run test -- sqlite.live`
Expected: PASS (4 tests).

> If the test runtime lacks `node:sqlite`, run this file with Node instead: `node --experimental-sqlite --test-reporter=spec --import tsx tests/integration/sqlite.live.test.ts` is **not** the path here — simplest is to run the whole suite under Node-backed Vitest. Confirmed available under Node 24 (`DatabaseSync`); an `ExperimentalWarning` on stderr is expected and harmless.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/sqlite.live.test.ts
git commit -m "test: live SQLite integration (describe, list, paginate, read-only)"
```

---

## Task 13: Build the bundle and verify it runs

**Files:**
- Uses: `build.ts`, all `src/`

- [ ] **Step 1: Build**

Run: `bun run build`
Expected: prints `Built dist/server.js`; `dist/server.js` exists.

- [ ] **Step 2: Smoke-run the server against the temp DB via a hand-rolled MCP `initialize` + `tools/list`**

Create a throwaway seed DB and pipe two JSON-RPC frames into the server over stdio:

```bash
# seed
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/tmp/smoke.db");db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");db.prepare("INSERT INTO t VALUES (1)").run();db.close()'

# drive the server: initialize, then list tools
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SQL_MCP_DIALECT=sqlite SQL_MCP_DSN=/tmp/smoke.db SQL_MCP_ACCESS=readonly node dist/server.js
```

Expected: two JSON-RPC responses on stdout; the `tools/list` result lists the five `sql.*` tools. The `sql-mcp ... ready` line appears on **stderr** only (stdout stays clean JSON-RPC).

- [ ] **Step 3: Run the full suite + typecheck one more time**

Run: `bun run test && bun run typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "build: produce dist/server.js bundle (phase 1 read-only sqlite)"
```

---

## Self-review (against the spec)

- **§3 delivery (bundle, baseline node):** Task 0 `build.ts` (`bun build --target=node`), Task 13 runs `dist/server.js` on `node`. ✓
- **§4 config surface:** Task 1 covers all env vars incl. `SQL_MCP_CURSOR_SECRET` default-from-DSN and the `SQL_MCP_MAX_ROWS` 10k cap. ✓
- **§5 one DB per instance:** server connects a single dialect; tools take no connection arg. ✓ (pool: SQLite is a single in-process handle — the "small pool" nuance applies to the networked dialects in Phase 3.)
- **§6 tool surface (read):** capabilities, list_schemas, list_tables, describe_table, query — Tasks 9–11. Write tools deferred (Phase 2). ✓
- **§6a pagination + signed cursor:** Tasks 6 + 9 (offset mode; keyset reserved). Integrity HMAC enforced. ✓ (keyset-by-order-key enhancement noted for Phase 2.)
- **§7 enforcement:** tool-gating (only read tools registered) + classifier (Task 4, incl. CTE/stacking/comment) + DB-level read-only connection (Task 8 `readOnly` + Task 12 proof). ✓
- **§8 limits + coercion + identifier safety + param contract:** Tasks 5, 7, 9; `rewriteParams` ($1→?) in Task 8. ✓
- **§9 envelope + credential scrubbing:** Tasks 2, 3; scrubbing applied at the registration boundary (Task 11). ✓
- **§10 Dialect interface + SQLite:** Task 8 (read subset; write/tx methods are a Phase-2 interface extension). ✓

**Placeholder scan:** none — every step has runnable code/commands.
**Type consistency:** `Config`, `Dialect`, `Envelope`, `QueryData`, `ColumnInfo`, `TableInfo`, `CursorPayload` are defined once and reused verbatim across tasks; handler names (`handleQuery`, `handleCapabilities`, `handleListSchemas`, `handleListTables`, `handleDescribeTable`) match between definition and registration.

---

## Follow-on phases (separate plans)

1. **Phase 2 — Write scope on SQLite.** Extend the `Dialect` interface with `execute`, `executeBatch` (classify-all-before-BEGIN, positional-array return), and `quoteIdent`-backed DDL; add `sql.execute` (dml/full), `sql.execute_batch` (dml/full), `sql.execute_ddl` (full); scope-gated registration; statement-timeout enforcement (SQLite via `sqlite3_interrupt` on a timer, per §13).
2. **Phase 3 — Postgres / MySQL / MSSQL adapters.** One `Dialect` per engine (`pg`, `mysql2`, `tedious`), a small connection pool, READ ONLY transactions for the read path, `rewriteParams` to `?`/`@pN`, dialect introspection SQL, integration tests via testcontainers. Confirm `tedious` (CJS) bundles cleanly (§13).
3. **Phase 4 — Catalog entry + release.** Author `ai-assets/mcp/sql/MCP.md` (manifest + agent guidance), document the first-JS-server pattern in `ai-assets/mcp/DOMAIN.md`, and ship `v0.1.0` via the tag-driven `release.yml` (bundle + sha256 manifest as an `upstream_pointer` asset).

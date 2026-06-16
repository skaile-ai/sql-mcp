# SQL MCP Server — Design Spec

**Status:** Draft (brainstormed 2026-06-16) · **Author:** Peter Albert · **Repo:** `skaile-ai/sql-mcp`

A single, portable MCP server giving Skaile agents typed, permission-scoped access to the four
common SQL engines — **PostgreSQL, MySQL, SQLite, MSSQL** — through one uniform toolset. The
database engine is selected by configuration; dialect differences live entirely behind an internal
adapter and never leak into the agent-facing tool surface.

It is the third locally-run server in the `ai-assets/mcp/` catalog (after `xls`/excel and `ppt`),
and the **first Node/TypeScript MCP server** in the catalog — establishing a lighter delivery
pattern than the Java/POI servers.

---

## 1. Decisions locked during brainstorming

| # | Decision | Choice |
|---|----------|--------|
| 1 | One server vs. one-per-engine | **One unified server**; dialect is config, not architecture. |
| 2 | MCP server vs. extending the connector layer | **Standalone MCP server.** (The existing `postgres`/`sqlite` *connectors* are remnants slated to become MCP servers — this server is the target state, not a parallel subsystem. Their `adapter.ts` files are reference implementations.) |
| 3 | Capability scope | **Configurable per instance** — `readonly` / `dml` / `full`. |
| 4 | Credentials | **Existing workspace secret injection** (`env:` refs via `SecretProviderChain`, or `auth: backend` via the platform `tokenMediator`). No bespoke credential handling. Preconfiguration via **presets**. |
| 5 | Runtime | **Node / TypeScript.** Pure-JS drivers + Node 24 built-in `node:sqlite`. |
| 6 | Database per instance | **One database/DSN per instance**, backed by a small pool. Tools take no connection arg; multiple DBs = multiple `mcp:sql` instances. |
| 7 | Packaging / delivery | **No Nix recipe.** Bundle to a single `server.js`; ship as an `upstream_pointer` GitHub-release asset; run on the baseline `node`. |
| 8 | Access enforcement | **Defense in depth** — tool-gating + statement classification + DB-level guarantee. |
| 9 | Transactions | **Stateless atomic batch in v1** (`sql.execute_batch` — `BEGIN`/…/`COMMIT` in one call). Handle-based `begin`/`commit`/`rollback` deferred to v2. |
| 10 | Write-tool granularity | **Split** `execute` (DML) and `execute_ddl` (DDL), gated by separate scope tiers. |
| 11 | Large reads | **Stateless keyset pagination** on `sql.query` (`next_cursor`). Server-side DB cursors deferred to v2. |
| 12 | Cross-call state | **None in v1.** The server holds only the connection pool — no pinned-connection handles, so no idle-tx/cursor lifecycle to manage. |

---

## 2. Identity & placement

- Catalog entry: `ai-assets/mcp/sql/MCP.md` (sibling to `xls/`, `ppt/`, `github/`).
- Implementation: this repo, `skaile-ai/sql-mcp`, a flat submodule of the `skaile` parent (mirrors
  `excel-mcp/`, `powerpoint-mcp/`).
- Single unified server, dialect selected by config.

## 3. Delivery & runtime (no Nix recipe)

excel/ppt require Nix recipes because they bundle a JRE + LibreOffice — heavy native closures that
must be delivered as pinned `/nix/store` paths into offline containers. A pure-JS SQL server has no
such weight:

- The baseline Nix closure already ships **`nodejs 24` + `bun`** on PATH; Node 24 has built-in
  **`node:sqlite`** (zero native deps).
- `pg`, `mysql2`, `tedious` are pure-JS and bundle into one file via `bun build`/esbuild (inlined,
  **not** marked external — no runtime `node_modules`).

**Delivery path (verified against the runner):**

- The runner does **not** restrict an stdio server's `command` to `${recipe:...}` store paths — it
  passes `command`/`args` verbatim to `StdioClientTransport`
  (`workspaces/.../runner/src/external-mcp.ts`). Only `/nix/store/` paths get existence-validated.
- MCP assets can carry **runnable payload files**: materialized as an `upstream_pointer` (GitHub
  release) or `internal_blob`, every file lands under `.skaile/assets/mcp-server/<name>/` — exactly
  as skills/connectors ship code today.

Therefore the manifest runs the bundle on the baseline `node`:

```yaml
transport: stdio
command: node
args: ["<abs workspace path>/.skaile/assets/mcp-server/sql/server.js"]
```

The "build pipeline" is a single `bun build --target=node` step in this repo — **not** the
platform's `nix-build.yml` CI, no flake stanza, no closure-size budget, no `import-recipe`/NAR
machinery.

> **First-in-catalog note:** there is no existing `command: node` MCP server in the catalog (today
> it's Java-via-recipe or remote-HTTP). The infra supports it cleanly; document the pattern in
> `ai-assets/mcp/DOMAIN.md` when publishing.

## 4. Configuration surface

All credentials and config ride existing workspace mechanisms — no parallel system.

| Env var | Meaning |
|---|---|
| `SQL_MCP_DIALECT` | `postgres` \| `mysql` \| `sqlite` \| `mssql` |
| `SQL_MCP_DSN` | Connection string, supplied via secret injection (`env:DATABASE_URL` → `SecretProviderChain`) or `auth: backend` via the platform `tokenMediator` (same dual path the Postgres connector uses). |
| `SQL_MCP_ACCESS` | `readonly` \| `dml` \| `full` (the per-instance capability scope). |
| `SQL_MCP_CURSOR_SECRET` | Optional. Server-held key used to integrity-protect `next_cursor` tokens (§6a). When unset, the key is derived deterministically from the DSN, so tokens stay valid across restarts; set it explicitly to control rotation or when the DSN itself rotates. Supplied via secret injection like `SQL_MCP_DSN`. |
| `SQL_MCP_MAX_ROWS`, `SQL_MCP_MAX_RESULT_BYTES`, `SQL_MCP_STATEMENT_TIMEOUT_MS` | Optional overrides of the safety limits (§8). |

- **Presets** carry preconfiguration: placeholders (e.g. DSN as a `secret`-typed placeholder,
  dialect as an `enum`) folded into instance config via `materialize`.
- Per-engine connection params (host/port/db/user) may alternatively be expressed as discrete
  fields and assembled into a DSN internally — to be finalized in the plan.

## 5. Connection model

- **One database (DSN) per server instance**, backed by a **small connection pool** (default a
  handful of connections), health-checked on connect. "One database per instance" means tools take
  **no** connection argument — not literally one socket; the pool lets independent tool calls run
  without serializing behind each other.
- **MCP delivers no ordering/serialization guarantee** across tool calls. Each call checks out its
  own pooled connection for its duration, so concurrent calls are isolated; a single connection is
  never shared by two in-flight calls.
- To expose several databases, the operator declares several `mcp:sql` instances, each with its own
  `id`, dialect, DSN, and access scope.

## 6. Tool surface

Each tool declares its **intent**; the classifier (§7.2) verifies the submitted SQL matches that
intent; the scope (§7.1) gates which tools are even registered.

**Introspection — always available (all scopes):**

- `sql.capabilities` — self-describe: dialect, driver version, **active access scope**, feature
  flags, safety limits. Agent calls this first (cf. `ppt.capabilities`).
- `sql.list_schemas` — schemas/databases visible to the connection.
- `sql.list_tables` — tables + views (optionally scoped to a schema), with type.
- `sql.describe_table` — columns, types, nullability, defaults, primary/foreign keys, indexes.

**Read — always available:**

- `sql.query` — parameterized `SELECT`. Returns `{columns, rows, rowCount, truncated, next_cursor}`.
  Runs inside a DB-level **READ ONLY transaction**. Classifier rejects any non-read statement.
  Supports **stateless keyset pagination**: pass an opaque `cursor` (and optional `limit`) to fetch
  the next page; the server returns `next_cursor` until the result is exhausted. This is the
  deliberate path to read beyond `max_rows` — no server-side cursor state is held (see §6a).

**Write — `dml` and `full` scopes only:**

- `sql.execute` — parameterized INSERT/UPDATE/DELETE. Returns `{rowCount}`. Classifier rejects DDL
  and SELECT here. Each call auto-commits (no open transaction is held across calls).
- `sql.execute_batch` — an **ordered array** of parameterized DML statements run atomically as a
  single `BEGIN`/…/`COMMIT` **within one tool call** (rolled back as a whole on any failure).
  **Every statement is classified _before_ the `BEGIN` opens** — a DDL or SELECT in *any* position
  rejects the entire batch with `ACCESS_DENIED` and nothing executes. Returns a **positional array**
  `[{rowCount}, …]` aligned to the input order on success; a failed (and therefore fully
  rolled-back) batch returns an `error` envelope, never a partial array. This is v1's transaction
  primitive — multi-statement atomicity with **zero cross-call state**. (It cannot branch on
  intermediate results mid-transaction; that needs handle-based transactions — deferred to v2, see §12.)

**Schema — `full` scope only:**

- `sql.execute_ddl` — CREATE/ALTER/DROP/TRUNCATE. Classifier rejects DML and SELECT here. Separate
  tool so the highest-blast-radius operations carry their own scope tier and are unreachable from a
  `dml` instance.

## 6a. Pagination & state model

- **Stateless keyset pagination.** `next_cursor` is an opaque, self-contained token encoding the
  ordering key + last-seen value (preferred) or an offset (fallback when no orderable key exists).
  The agent passes it back to `sql.query` to get the next page. No DB-side cursor is held and no
  connection is pinned; pages survive process restarts **provided the cursor secret is stable**
  (see below). Trade-offs: keyset needs an orderable key; pages are not snapshot-consistent (data
  may shift between pages).
- **Cursor tokens MUST be integrity-protected** (HMAC or authenticated encryption) with the
  **server-held `SQL_MCP_CURSOR_SECRET`** key (§4). The token feeds the `keysetPredicate` WHERE
  clause, so an unsigned token is a blind-injection oracle — a caller could craft a cursor to inject
  arbitrary values into the query. The server rejects any token that fails verification. Because the
  key defaults to a deterministic derivation from the DSN (rather than a random per-process value),
  tokens remain valid across restarts; rotating the key (or the DSN) intentionally invalidates
  outstanding cursors. (This is a security requirement, not just a format choice.)
- **Offset fallback is O(n) and must be flagged.** When no orderable key exists and the cursor falls
  back to `OFFSET`, the database scans and discards the first N rows on every page. The result
  carries a warning when the offset fallback is active; it should only be used when the total page
  count is expected to be small. Prefer keyset whenever the query has a unique orderable key.
- **No cross-call logical state in v1.** The server holds only the connection pool. There are no
  pinned-connection handles, so there is no idle-transaction timeout, single-flight gate, or handle
  registry to manage. Handle-based transactions and server-side DB cursors (which both require that
  machinery, and share it) are deferred to v2.

## 7. Access enforcement — defense in depth

1. **Tool-gating.** Out-of-scope tools are never registered. A `readonly` instance exposes no
   `execute` / `execute_ddl` / transaction-write tools.
2. **Statement classification.** Every submitted SQL string is parsed/classified (SELECT vs DML vs
   DDL). A statement whose class doesn't match the calling tool, or is out of the instance's scope,
   is rejected with `ACCESS_DENIED`. The classifier is a **single shared implementation** with
   per-dialect hooks only for genuine syntax differences (e.g. `MERGE`, dialect-specific DDL
   keywords) — **not** four independent per-dialect classifiers, whose evasion-resistance would
   inevitably drift apart. It must be robust against the known evasion vectors:
   - **Multi-statement stacking** (`;`) and **comment-smuggling** — blocked regardless of scope.
   - **Data-modifying CTEs** — a `SELECT` whose `WITH` clause contains `INSERT`/`UPDATE`/`DELETE`
     (e.g. `WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d`, valid in PostgreSQL/MSSQL)
     is a **write**, not a read. The classifier must recurse into `WITH` clauses and reject such a
     statement on `sql.query` / a `readonly` instance — a top-level `SELECT` verb is not sufficient
     to deem it read-only.
3. **DB-level guarantee (required, not advisory).** Reads run in a READ ONLY transaction. A
   `readonly` instance **must** be bound to a read-only DB role; the server attempts to verify the
   role at connect and **logs a startup warning** when it cannot confirm read-only. Without a
   DB-level role the `readonly` guarantee is not absolute — a single classifier bug would otherwise
   collapse the model to two in-process controls. The database is the last line of defense, not the
   classifier.

## 8. Result & safety limits

Defaults below; all env-overridable and surfaced in `sql.capabilities`.

| Limit | Default | Signal |
|---|---|---|
| `max_rows` | 1000 (`SQL_MCP_MAX_ROWS`, **capped at 10 000**) | `truncated: true` + `warning: "ROWS_TRUNCATED"` |
| `max_result_bytes` | 10 MiB | `RESULT_TOO_LARGE` (hard error) |
| `statement_timeout_ms` | 30 000 (per statement) | `STATEMENT_TIMEOUT` |

- **Truncation is never silent.** When a read hits `max_rows`, the result sets `truncated: true`
  **and** carries a `ROWS_TRUNCATED` warning, so an agent that ignores the flag still sees the
  signal — important for counts/aggregations/existence checks. To read past `max_rows`, page with
  the `next_cursor` keyset (§6a); it is the deliberate "get the rest" path. (`max_result_bytes` is a
  hard error rather than a truncation because a half-serialized row can't be returned safely.)
- **Parameterization is mandatory** — bind params as an array; no string interpolation of values.
  The server accepts a **canonical `$1`/`$2` placeholder style** and rewrites placeholders to the
  dialect-native form (`?` for MySQL/SQLite, `@pN` for MSSQL) before execution, so the agent never
  has to know the target dialect's placeholder syntax. The active `paramStyle` is still reported in
  `sql.capabilities` for transparency.
- **Identifier safety for introspection tools.** `sql.list_tables(schema?)` and
  `sql.describe_table(table)` take schema/table *identifiers*, which **cannot** be value-bound — they
  must be interpolated into SQL. So they MUST (a) **allowlist-validate** the name before use (reject
  anything not matching a strict pattern, e.g. `/^[\w$]{1,128}$/`, and/or confirm it exists in the
  schema catalog) and (b) apply **dialect-specific identifier quoting** (`"name"` Postgres/SQLite,
  `` `name` `` MySQL, `[name]` MSSQL). Without both, `describe_table("users\"; DROP TABLE users; --")`
  is a textbook injection.
- **Type handling:** dates → ISO strings; `bigint`/wide numeric → string (JSON-safe); binary →
  base64; SQL `NULL` → `null`.

## 9. Error envelope

Uniform structured envelope (cf. ppt):

```json
{
  "status": "success" | "error",
  "code": "VALIDATION_ERROR" | "ACCESS_DENIED" | "CONNECTION_FAILED" | "STATEMENT_TIMEOUT" | "RESULT_TOO_LARGE" | "DIALECT_UNSUPPORTED" | "TOOL_EXECUTION_ERROR",
  "error": "human-readable message (only when status=error)",
  "warning": "ROWS_TRUNCATED",
  "retriable": false,
  "tool_name": "sql.query",
  "data": { }
}
```

- **Credential scrubbing is mandatory.** Driver errors routinely embed the full DSN, including the
  password (e.g. `connect ECONNREFUSED postgresql://admin:s3cret@host/db`). Every driver error
  **must** be passed through a sanitizer that strips connection-string / credential patterns (DSNs,
  passwords, bearer tokens) before its message reaches the `error` field or any log line. Credentials
  must never appear in tool output or logs.
- `warning` is optional and non-fatal (`status` stays `success`); `ROWS_TRUNCATED` is the first user.

## 10. Internal dialect abstraction

A single `Dialect` interface, four implementations — the tool layer is dialect-agnostic.

```
interface Dialect {
  connect(dsn): Pool/Handle
  listSchemas(), listTables(schema?), describeTable(table)
  query(sql, params, page?)         // read inside an internal READ ONLY tx; page = keyset/offset
  execute(sql, params)              // single auto-committed DML
  executeBatch(statements[])        // one BEGIN/…/COMMIT within the call (v1 atomicity primitive)
  // v2: beginTx()/commit()/rollback() handle + openCursor()/fetch()/close() — not in v1
  // classify lives in ONE shared implementation (recurses into WITH/CTEs); Dialect
  // provides only per-dialect keyword hooks (e.g. MERGE, dialect DDL verbs):
  classifyHooks: { extraDmlVerbs, extraDdlVerbs }
  quoteIdent(name)                                      // dialect identifier quoting + allowlist
  coerceRow(row)                                        // dates/bigint/binary normalization
  paramStyle: '$n' | '?' | '@p'
  keysetPredicate(orderKey, lastValue)                  // build the WHERE/ORDER for next_cursor
}
```

Implementations: `pg` (Postgres), `mysql2` (MySQL), `tedious` (MSSQL), `node:sqlite` (SQLite).

## 11. Extensibility — future engines

The design splits future databases along one line: **relational (SQL) vs. not.**

**Additional SQL engines (DuckDB, MariaDB, CockroachDB, Redshift, Snowflake, …) — supported by
design.** The `Dialect` interface (§10) is the extension point. Adding an engine is: (1) a new
`Dialect` implementation, (2) a new value in the `SQL_MCP_DIALECT` enum, (3) its driver dependency.
The tool surface, statement classifier, scope enforcement, limits, and error envelope all carry over
unchanged.

- **Packaging caveat:** the no-Nix delivery decision (§3) rests on all current drivers being
  *pure JS* (`pg`/`mysql2`/`tedious`/`node:sqlite`). An engine with a *native* driver (e.g.
  DuckDB's `@duckdb/node-api` addon) reopens the packaging question — it would require shipping a
  prebuilt native binary alongside the bundle or a thin Nix recipe for that engine. A **WASM**
  runtime (e.g. `@duckdb/duckdb-wasm`) is the more promising path, since it preserves the
  pure-bundle, no-native-addon story — to be evaluated if/when DuckDB is actually needed.

**Non-relational engines (MongoDB, Redis, Elasticsearch, Neo4j, …) — deliberately out, as a
sibling, not a retrofit.** They don't share the SQL tool surface (collections/BSON/aggregation vs.
tables/`SELECT`; no SELECT/DML/DDL taxonomy), so forcing them behind `sql.*` tools would be a leaky
abstraction. The server is named `sql` and its tools are `sql.*` precisely to signal "relational
only." A future document/graph/kv store gets its **own** MCP server, which can reuse this server's
*pattern* — config-selected backend, per-instance access scope, secret injection, no-Nix bundled-JS
delivery — without stretching this one.

## 12. Out of scope (v1) — and the v2 line

Deferred to v2 (all share the cross-call pinned-connection + handle-lifecycle engine, so they land
together once a concrete need justifies building it):

- **Handle-based transactions** — `begin`/`commit`/`rollback` across calls (branch on intermediate
  results mid-transaction). v1 covers atomicity with the stateless `sql.execute_batch` instead.
- **Server-side DB cursors** — `open`/`fetch`/`close` portals for snapshot-consistent, efficient
  deep iteration. v1 covers large reads with stateless keyset pagination on `sql.query` instead.

Out of scope entirely (v1):

- Agent-supplied ad-hoc `connect` (connections are config-only).
- Multiple connections per instance.
- Stored-procedure authoring, migrations, DAX, server-admin ops.

## 13. Open items to pin during planning

- Exact `${workspace}`-style absolute path token the materializer guarantees for the `args` path.
- SQL parser/classifier implementation (lightweight tokenizer vs. full parser) — must satisfy the
  §7.2 evasion-resistance properties (stacking, comments, **data-modifying CTEs**). A parser that
  understands `WITH` clauses is likely required, not a regex.
- MSSQL read-only-transaction semantics via `tedious`.
- Keyset pagination: how `next_cursor` picks the ordering key when the query has no obvious unique
  key (fall back to `OFFSET`? require an `ORDER BY`? derive from PK?), and the token **format**
  (the integrity-protection itself is required — see §6a — only the encoding format is open).
- Identifier allowlist: exact validation pattern + whether to require catalog-existence confirmation
  for `describe_table`/`list_tables` arguments (see §8).
- Whether to accept discrete connection fields (host/port/db/user) in addition to a single DSN.
- Asset publication shape (`upstream_pointer` release artifact layout: `server.js` + manifest with
  sha256).
- **SQLite has no native statement timeout** — `node:sqlite` would need an application-level abort
  via `sqlite3_interrupt()` driven by a timer to honour `statement_timeout_ms`.
- **`tedious` is CommonJS** — confirm `bun build --target=node` bundles it cleanly (CJS/ESM
  interop edge cases) as part of the build setup.

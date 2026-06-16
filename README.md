# sql-mcp

A single, portable **MCP server** giving Skaile agents typed, permission-scoped access to the four
common SQL engines — **PostgreSQL, MySQL, SQLite, MSSQL** — through one uniform toolset. The
database engine is selected by configuration; dialect differences live behind an internal adapter
and never leak into the agent-facing tools.

Part of the Skaile `ai-assets/mcp/` catalog (alongside `xls`/excel and `ppt`). Unlike those Java/POI
servers, this is a **pure Node/TypeScript** server bundled to a single file and run on the baseline
`node` — **no Nix recipe required**.

## Status

🚧 Design phase. See [`docs/specs/2026-06-16-sql-mcp-design.md`](docs/specs/2026-06-16-sql-mcp-design.md)
for the full design. Implementation has not started.

## At a glance

- **Engines:** PostgreSQL (`pg`), MySQL (`mysql2`), MSSQL (`tedious`), SQLite (`node:sqlite`).
- **One connection per server instance**, selected by `SQL_MCP_DIALECT` + `SQL_MCP_DSN`.
- **Access scope per instance:** `readonly` / `dml` / `full` (`SQL_MCP_ACCESS`).
- **Tools:** `sql.capabilities`, `sql.list_schemas`, `sql.list_tables`, `sql.describe_table`,
  `sql.query`, `sql.execute`, `sql.execute_ddl`, `sql.begin` / `commit` / `rollback`.
- **Safety:** defense-in-depth access enforcement (tool-gating + SQL statement classification +
  DB-level read-only transactions), mandatory parameterization, row/byte/time limits.

## Credentials

Supplied via the existing Skaile workspace secret-injection mechanism (`env:` references resolved by
`SecretProviderChain`, or `auth: backend` via the platform credential mediator). No credentials are
baked into the catalog entry.

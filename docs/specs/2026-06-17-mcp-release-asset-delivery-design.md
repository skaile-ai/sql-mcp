# MCP Release-Asset Delivery — Design

**Status:** approved (brainstorming → spec)
**Date:** 2026-06-17
**Driving consumer:** `sql-mcp` (Phase 4 publication), but the mechanism is generic.

## 1. Problem

`sql-mcp` Phase 4 (publication) is blocked. The original delivery decision
(spec `2026-06-16-sql-mcp-design.md` §3: "no Nix recipe — bundle to a single
`server.js`, ship as an `upstream_pointer` GitHub-release asset, run on the
baseline `node`") assumed runtime support that does **not** exist:

1. **No payload field in the MCP manifest.** `McpServerManifestSchema`
   (`workspaces/packages/workspaces/types/src/manifests/mcp-server.ts`) accepts
   only `name`, `description`, `version`, `transport`, `command`, `args`, `env`,
   `url`, `headers`, `keywords`, `license`. Nothing references a downloadable
   release artifact.
2. **No workspace path token.** The runner substitutes only `${recipe:<id>}` →
   `/nix/store/...` (`runner/src/recipe-templating.ts`). An
   `args: ["${workspace}/.skaile/assets/mcp-server/sql/server.js"]` entry would
   be passed to `node` **verbatim** and fail. (The `xls/MCP.md` carries a
   standing `TODO(workspaces)` for this exact missing token.)

What **does** already exist (and the design builds on):

- `mcp-server` is a first-class **materialized** asset kind. The platform
  `SessionMaterializer` fetches the catalog asset directory (`ai-assets/mcp/<name>/`)
  commit-pinned + per-file sha256-verified into
  `<workspaceDir>/.skaile/assets/mcp-server/<name>/` via the `upstream_pointer`
  branch (`installFromManifest`, flat mode). A test already asserts MCP.md lands
  at the asset dir.
- The materializer fetches through a pluggable `AssetFetcher` and follows a
  documented extension posture: *"add a new content kind … gate-then-write with
  path-traversal hard-fail."*
- The runner already has `projectDir` (the workspace root) in scope exactly
  where it substitutes `command`/`args`/`env` (`external-mcp.ts:198–201`).

## 2. Goal

Let an `mcp-server` catalog entry ship its runnable bundle as a GitHub **release**
asset — fetched, integrity-verified, and run on the baseline `node` — without a
Nix recipe. Single self-contained `server.js` (already produced by
`bun build --target=node`); no `node_modules` tree, no zip/`.mcpb` container.

## 3. Architecture

Three small, well-bounded code changes plus catalog content, across three repos.

### A. Manifest schema — `workspaces` (`types/src/manifests/mcp-server.ts`)

Add an optional `payload` object to `McpServerManifestSchema`:

```ts
payload: z
  .object({
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    dest: z.string().optional(), // defaults to basename(url path)
  })
  .optional(),
```

- Single object (YAGNI — one bundle per server). A future multi-file need is an
  array migration, not blocked by this shape.
- `sha256` is **mandatory** — it is the integrity gate. No unverified payload
  ever lands.
- `url` must be a syntactically valid URL; semantic host-allowlisting is enforced
  at fetch time (§B), not in the schema.

The schema is `z.looseObject`, so an unknown `payload` would pass parse silently
today; declaring it explicitly makes it typed and self-documenting and lets the
runner read it without a cast.

### B. Materializer payload fetch — `platform` (`session-materializer`)

Extend the existing `upstream_pointer` branch in
`session-materializer.service.ts`. **After** `installFromManifest` writes the
file-set (including MCP.md) into `targetDir`:

1. Read `targetDir/MCP.md`; parse its YAML frontmatter. If absent or no
   `payload`, do nothing (back-compat: excel/ppt/github unchanged).
2. If `payload` is present:
   - Validate `payload.url`: **https only**, host in the allowlist
     `{ github.com, objects.githubusercontent.com, raw.githubusercontent.com }`
     (mirrors the public store's existing github.com SSRF validation; release
     downloads 302-redirect from `github.com/.../releases/download/...` to
     `objects.githubusercontent.com`, so both hosts are required and redirects
     are followed only within the allowlist).
   - Fetch the bytes (follow redirects, optional `SKAILE_GITHUB_PAT` bearer for
     rate-limit relief, enforce a byte cap — new
     `SKAILE_MCP_PAYLOAD_MAX_BYTES`, default 25 MiB).
   - Compute sha256; **hard-fail on mismatch** (the byte stream is discarded, no
     file written).
   - Resolve `dest` (default `basename(url path)`) through the existing
     `assertSafePath` guard (no traversal / absolute / `..`; must stay within
     `targetDir`), then `writeFileAtomic(join(targetDir, dest), bytes, 0o644)`.

This slots into the existing per-item `try/catch`, so any payload failure
(unreachable host, non-allowlisted URL, hash mismatch, oversize, unsafe dest)
becomes a surfaced `skipped` entry with a reason — never silently installed,
never aborts the rest of the effective set (the established fail-soft contract).

The fetch reuses a `fetch`-shaped seam (like the existing `AssetFetcher`) so
tests inject a fake; the default uses global `fetch` + `node:crypto` sha256. The
release-download URL shape differs from the commit-keyed
`raw.githubusercontent.com` fetcher, so this is a small dedicated fetch
(allowlist + redirect + cap + hash), not a reuse of `createGitHubFetcher`.

**Why parse MCP.md frontmatter host-side (vs. threading `payload` through the
catalog install-manifest):** the manifest the materializer receives carries only
`files[] + source` (no per-asset config). MCP.md is already a materialized file
in `targetDir` at this point, so reading it adds no fetch and no store/catalog
schema change. A small YAML frontmatter parse is the minimal touch.

### C. `${workspace}` token — `workspaces` (`recipe-templating.ts` + `external-mcp.ts`)

Extend the substitution applied to `command`/`args`/`env` (currently
`substituteRecipeTemplating` / `substituteRecipeMap` at `external-mcp.ts:198–201`)
to also replace the literal token `${workspace}` with the runner's `projectDir`
(the workspace root that contains `.skaile/`). Resolution order is irrelevant —
`${workspace}` and `${recipe:…}` are disjoint token namespaces.

The catalog entry then uses:

```yaml
transport: stdio
command: node
args: ["${workspace}/.skaile/assets/mcp-server/sql/server.js"]
```

This also resolves the standing `xls/MCP.md` `${workspace}` TODO at the
mechanism level (updating xls's `EXCEL_MCP_ROOT` to use it is a separate,
out-of-scope change).

### D. Catalog content — `ai-assets`

- Author `ai-assets/mcp/sql/MCP.md`: frontmatter (`name: sql`, `description`,
  `version`, `transport: stdio`, `command: node`, `args` with `${workspace}`,
  `env` for `SQL_MCP_DIALECT`/`SQL_MCP_DSN`/`SQL_MCP_ACCESS`/optional limits,
  `payload: { url, sha256 }`, `keywords`) + agent-facing body (when to reach for
  it, tool flow, gotchas) following the `xls/MCP.md` shape.
- Update `ai-assets/mcp/DOMAIN.md`: document the new **`command: node` + release
  `payload`** pattern (the first-in-catalog note from the original spec), and add
  the `sql` row to the servers table.

### E. Release — `sql-mcp`

Tag `v0.1.0`. The existing `.github/workflows/release.yml` builds `dist/server.js`
and emits `dist/manifest.json` (`{ file, sha256, version }`), attaching both to
the GitHub Release. The `sha256` from `manifest.json` is what fills MCP.md
`payload.sha256` (step D), and the release-asset URL fills `payload.url`.

## 4. Runtime data flow

```
session start
  → SessionMaterializer.materializeForSession
      → effective set includes mcp:sql (upstream_pointer)
      → installFromManifest fetches ai-assets/mcp/sql/* (MCP.md, commit-pinned, sha256)
      → parse MCP.md payload → fetch server.js from release URL
          → host-allowlist + https + redirect + byte-cap
          → verify sha256 (hard-fail → skipped)
          → writeFileAtomic .skaile/assets/mcp-server/sql/server.js
  → runner loadMcpServerDeclarations
      → reads MCP.md (command: node, args: ["${workspace}/.../server.js"])
      → substitute ${workspace} → projectDir
      → StdioClientTransport spawns `node <ws>/.skaile/assets/mcp-server/sql/server.js`
```

## 5. Security

- **Integrity:** `payload.sha256` mandatory; mismatch discards bytes, writes
  nothing, records `skipped`.
- **SSRF:** https-only + host allowlist `{github.com, objects.githubusercontent.com,
  raw.githubusercontent.com}`; redirects followed only to allowlisted hosts.
- **Size:** `SKAILE_MCP_PAYLOAD_MAX_BYTES` (default 25 MiB) bounds the download.
- **Path safety:** `dest` guarded by `assertSafePath`; bytes always land inside
  the asset's own `targetDir`.
- **Fail-soft:** every failure is a surfaced `skipped`, never an abort, never a
  silent install.
- **No secret leakage:** the optional PAT is a bearer header only; never logged.

## 6. Components & boundaries

| Unit | Repo | Responsibility | Depends on |
|---|---|---|---|
| `payload` schema field | workspaces/types | typed manifest field | — |
| `${workspace}` substitution | workspaces/runner | resolve token → projectDir | — |
| payload fetch+verify+write | platform/session-materializer | land the bundle next to MCP.md | published workspaces (type), existing fetch/hash/path-safety helpers |
| `mcp/sql/MCP.md` + `DOMAIN.md` | ai-assets | catalog entry + pattern docs | sql-mcp v0.1.0 sha256 |
| `v0.1.0` tag | sql-mcp | produce server.js + sha256 manifest | release.yml (exists) |

## 7. Testing

- **workspaces** (vitest): `${workspace}` substitution in `command`, each `arg`,
  and `env` values (and that it is left untouched when no token present);
  `McpServerManifestSchema` accepts a valid `payload` and rejects a bad
  `sha256`/`url`.
- **platform** (jest, `libs/session-materializer`): payload sha256 pass → file
  written next to MCP.md; mismatch → `skipped`, no file; non-allowlisted /
  non-https URL → `skipped`; oversize → `skipped`; unsafe `dest` → `skipped`;
  **no `payload` → unchanged** (excel/ppt/github regression); MCP.md absent →
  no-op. Fake fetch seam + temp dir (existing `makeTempDir`).
- **ai-assets:** MCP.md frontmatter parses and validates against the schema.
- **sql-mcp:** `release.yml` already covered by build; the tag is the trigger.

## 8. Implementation order (one PR per repo, dependency-ordered)

1. **workspaces** — A (schema) + C (token) + tests → merge → publish
   `@skaile/workspaces` (minor bump). Foundational; nothing else integrates
   without the token + type.
2. **platform** — B (materializer fetch) + tests → consumes the bumped
   `@skaile/workspaces` for the `payload` type. Merge via the platform changeset
   + Version-PR flow.
3. **sql-mcp** — E: tag `v0.1.0` → release produces `server.js` + `sha256`.
4. **ai-assets** — D: author `mcp/sql/MCP.md` (with the real v0.1.0 `sha256`) +
   `DOMAIN.md` → merge.
5. Update the parent `skaile` submodule pointers (sql-mcp, workspaces, ai-assets)
   as each merges.

## 9. Out of scope

- Multi-file payloads (array form) — single object only.
- Non-GitHub release hosts — allowlist is GitHub-only by design.
- `.mcpb` / zip container delivery — explicitly rejected (single-file bundle; our
  runner has no unpack step; mcpb is a client-install format).
- Content-addressed cross-session byte cache for the payload — fetch per
  materialization in v1 (matches current upstream_pointer behavior).
- Updating `xls`/`ppt` env to use `${workspace}` — separate change.
- Private-repo release-asset auth beyond a PAT.

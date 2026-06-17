# MCP Release-Asset Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an `mcp-server` catalog entry ship its runnable bundle as a sha256-verified GitHub release asset, fetched host-side and run on the baseline `node` — unblocking `sql-mcp` Phase 4 publication.

**Architecture:** Three small code changes plus catalog content across four repos: (A) an optional `payload` field on the workspaces MCP manifest schema; (B) a `${workspace}` substitution token in the runner so `args` can point at the materialized asset; (C) a payload fetch+verify+write step in the platform session-materializer; then (D) the `ai-assets` catalog entry and (E) the `sql-mcp` `v0.1.0` release. Spec: `sql-mcp/docs/specs/2026-06-17-mcp-release-asset-delivery-design.md`.

**Tech Stack:** TypeScript, Bun, zod, Vitest (workspaces), NestJS + Jest (platform), Node `crypto`/`fetch`.

**Repos & dependency order:** `workspaces` (PR 1) → publish `@skaile/workspaces` → `platform` (PR 2) → `sql-mcp` tag (PR 3) → `ai-assets` (PR 4) → update parent `skaile` submodule pointers.

---

## File Structure

| File | Repo | Responsibility | Task |
|---|---|---|---|
| `packages/workspaces/types/src/manifests/mcp-server.ts` | workspaces | add optional `payload` to schema | 1 |
| `packages/workspaces/runner/src/recipe-templating.ts` | workspaces | `${workspace}` substitution helpers | 2 |
| `packages/workspaces/runner/src/recipe-templating.test.ts` | workspaces | unit tests for the token | 2 |
| `packages/workspaces/runner/src/external-mcp.ts` | workspaces | apply `${workspace}` to every decl | 2 |
| `backend/libs/session-materializer/src/release-payload.ts` | platform | parse + allowlist + fetch + verify | 3 |
| `backend/libs/session-materializer/src/release-payload.test.ts` | platform | unit tests | 3 |
| `backend/libs/session-materializer/src/session-materializer.service.ts` | platform | wire payload step into upstream_pointer branch | 4 |
| `backend/libs/session-materializer/src/session-materializer.service.test.ts` | platform | materializer integration tests | 4 |
| `ai-assets/mcp/sql/MCP.md` | ai-assets | catalog entry | 6 |
| `ai-assets/mcp/DOMAIN.md` | ai-assets | document the pattern + add row | 7 |

---

# PR 1 — workspaces: `payload` schema + `${workspace}` token

Branch: `feat/mcp-release-payload` off `main` in `/Users/peteralbert/repos/skaile/workspaces`.

### Task 1: Add optional `payload` to the MCP manifest schema

**Files:**
- Modify: `packages/workspaces/types/src/manifests/mcp-server.ts`
- Test: `packages/workspaces/types/src/manifests/mcp-server.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `packages/workspaces/types/src/manifests/mcp-server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateMcpServer } from "./mcp-server.js";

describe("McpServerManifestSchema payload", () => {
  const base = { name: "sql", description: "SQL MCP", transport: "stdio", command: "node" };

  it("accepts a valid payload", () => {
    const r = validateMcpServer({
      ...base,
      payload: {
        url: "https://github.com/skaile-ai/sql-mcp/releases/download/v0.1.0/server.js",
        sha256: "a".repeat(64),
        dest: "server.js",
      },
    });
    expect(r.ok).toBe(true);
  });

  it("accepts payload without dest (optional)", () => {
    const r = validateMcpServer({
      ...base,
      payload: { url: "https://github.com/x/y/releases/download/v1/server.js", sha256: "b".repeat(64) },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-64-hex sha256", () => {
    const r = validateMcpServer({ ...base, payload: { url: "https://github.com/x/y", sha256: "tooshort" } });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-URL payload url", () => {
    const r = validateMcpServer({ ...base, payload: { url: "not a url", sha256: "c".repeat(64) } });
    expect(r.ok).toBe(false);
  });

  it("still accepts a manifest with no payload (back-compat)", () => {
    const r = validateMcpServer(base);
    expect(r.ok).toBe(true);
  });
});
```

> Note: `validateMcpServer` returns a `ManifestValidationResult` whose success flag is `ok`. If the existing `_shared.ts` result shape uses a different key (e.g. `success`), match it — open `packages/workspaces/types/src/manifests/_shared.ts` and use the actual field. Adjust the assertions accordingly before running.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/peteralbert/repos/skaile/workspaces && bun x --bun vitest run packages/workspaces/types/src/manifests/mcp-server.test.ts`
Expected: FAIL — payload is silently accepted today (looseObject) but the bad-sha256 / bad-url cases pass instead of failing, so the two `rejects` tests fail.

- [ ] **Step 3: Add the `payload` field**

In `packages/workspaces/types/src/manifests/mcp-server.ts`, add inside `z.looseObject({ … })` after the `license` line (line 18):

```ts
  // Optional runnable payload fetched + sha256-verified by the platform
  // session-materializer into the asset dir at materialize time (e.g. a bundled
  // server.js shipped as a GitHub release asset). `dest` defaults to the URL
  // basename. See docs: MCP release-asset delivery.
  payload: z
    .object({
      url: z.string().url(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      dest: z.string().optional(),
    })
    .optional(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/peteralbert/repos/skaile/workspaces && bun x --bun vitest run packages/workspaces/types/src/manifests/mcp-server.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/peteralbert/repos/skaile/workspaces
bun run -F @skaile/workspaces typecheck 2>/dev/null || bunx tsc -p packages/workspaces/types --noEmit
git add packages/workspaces/types/src/manifests/mcp-server.ts packages/workspaces/types/src/manifests/mcp-server.test.ts
git commit -m "feat(types): optional payload field on MCP server manifest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> If `bun run -F` is not the repo's filter syntax, use the package's own `typecheck` script: `cd packages/workspaces/types && bun run typecheck` (fall back to `bunx tsc --noEmit`).

---

### Task 2: `${workspace}` substitution token applied to every MCP declaration

**Files:**
- Modify: `packages/workspaces/runner/src/recipe-templating.ts`
- Test: `packages/workspaces/runner/src/recipe-templating.test.ts` (create if absent)
- Modify: `packages/workspaces/runner/src/external-mcp.ts`

**Context — why this is needed:** in `external-mcp.ts`, `${recipe:…}` substitution runs ONLY for recipe-launcher declarations (`resolveRecipeDeclaration`). A `command: node` server is a "command-shape pass-through" (`resolveExternalMcpDeclarations` pushes it unchanged at the `if (!wantsRecipe)` branch). So the `${workspace}` token must be applied to **every** resolved declaration after the existing loop, not inside the recipe path.

- [ ] **Step 1: Write the failing test**

Create/append `packages/workspaces/runner/src/recipe-templating.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { substituteWorkspaceToken, substituteWorkspaceTokenMap } from "./recipe-templating.js";

describe("substituteWorkspaceToken", () => {
  it("replaces ${workspace} with the workspace dir", () => {
    expect(substituteWorkspaceToken("${workspace}/.skaile/assets/mcp-server/sql/server.js", "/ws")).toBe(
      "/ws/.skaile/assets/mcp-server/sql/server.js",
    );
  });

  it("replaces every occurrence", () => {
    expect(substituteWorkspaceToken("${workspace}:${workspace}", "/w")).toBe("/w:/w");
  });

  it("leaves text without the token untouched", () => {
    expect(substituteWorkspaceToken("node", "/ws")).toBe("node");
  });

  it("map form substitutes each value and passes undefined through", () => {
    expect(substituteWorkspaceTokenMap({ A: "${workspace}/x" }, "/ws")).toEqual({ A: "/ws/x" });
    expect(substituteWorkspaceTokenMap(undefined, "/ws")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/peteralbert/repos/skaile/workspaces && bun x --bun vitest run packages/workspaces/runner/src/recipe-templating.test.ts`
Expected: FAIL — `substituteWorkspaceToken` is not exported.

- [ ] **Step 3: Add the substitution helpers**

In `packages/workspaces/runner/src/recipe-templating.ts`, after `substituteRecipeMap` (line 48), add:

```ts
// `${workspace}` resolves to the session workspace root (the dir holding
// `.skaile/`). Applied to ALL MCP declarations (recipe and command-shape alike),
// unlike `${recipe:…}` which only applies to recipe-launcher decls.
const WORKSPACE_MARKER = /\$\{workspace\}/g;

export function substituteWorkspaceToken(value: string, workspaceDir: string): string {
  return value.replace(WORKSPACE_MARKER, workspaceDir);
}

export function substituteWorkspaceTokenMap(
  obj: Record<string, string> | undefined,
  workspaceDir: string,
): Record<string, string> | undefined {
  if (!obj) return obj;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = substituteWorkspaceToken(v, workspaceDir);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/peteralbert/repos/skaile/workspaces && bun x --bun vitest run packages/workspaces/runner/src/recipe-templating.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Apply the token to every declaration in `external-mcp.ts`**

In `packages/workspaces/runner/src/external-mcp.ts`:

(a) Extend the import (the existing import already pulls `substituteRecipeMap, substituteRecipeTemplating` near line 43) to also import the new helpers:

```ts
  substituteRecipeMap,
  substituteRecipeTemplating,
  substituteWorkspaceToken,
  substituteWorkspaceTokenMap,
```

(b) Replace the `return resolved;` at the end of `resolveExternalMcpDeclarations` (line 163) with a final `${workspace}` pass over every declaration:

```ts
  // Apply the workspace-root token to EVERY declaration — recipe-resolved and
  // command-shape pass-throughs alike — so `${workspace}` resolves regardless of
  // launcher. `${recipe:…}` is already resolved above for recipe decls.
  return resolved.map((decl) => ({
    ...decl,
    command: decl.command ? substituteWorkspaceToken(decl.command, projectDir) : decl.command,
    args: decl.args?.map((a) => substituteWorkspaceToken(a, projectDir)),
    env: substituteWorkspaceTokenMap(decl.env, projectDir),
  }));
```

- [ ] **Step 6: Run the runner test suite**

Run: `cd /Users/peteralbert/repos/skaile/workspaces && bun x --bun vitest run packages/workspaces/runner/src/`
Expected: PASS (existing suites green + the new token tests).

- [ ] **Step 7: Typecheck + commit**

```bash
cd /Users/peteralbert/repos/skaile/workspaces
cd packages/workspaces/runner && bun run typecheck 2>/dev/null || bunx tsc --noEmit; cd -
git add packages/workspaces/runner/src/recipe-templating.ts \
        packages/workspaces/runner/src/recipe-templating.test.ts \
        packages/workspaces/runner/src/external-mcp.ts
git commit -m "feat(runner): \${workspace} substitution token for MCP declarations

Resolves the standing xls TODO at the mechanism level; lets command-shape
MCP servers point args at the materialized asset dir.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### PR 1 close-out (controller, not a subagent step)
- Open the PR; run the repo's release/version process to publish a new `@skaile/workspaces` (minor bump) once merged. PR 2 pins that version.

---

# PR 2 — platform: materializer payload fetch

Branch: `feat/mcp-release-payload` off `main` in `/Users/peteralbert/repos/skaile/platform`.
Per platform CLAUDE.md: ESLint/Prettier (NOT Biome); Jest `*.spec.ts`/`*.test.ts`; add a changeset.

### Task 3: `release-payload.ts` — parse, allowlist, fetch, verify

**Files:**
- Create: `backend/libs/session-materializer/src/release-payload.ts`
- Test: `backend/libs/session-materializer/src/release-payload.test.ts`

**Design:** one focused module, no NestJS, fully unit-testable with a fake `HttpClient`. Reuses the `HttpClient` shape from `github-fetcher.ts`.

- [ ] **Step 1: Write the failing test**

Create `backend/libs/session-materializer/src/release-payload.test.ts`:

```ts
import { createHash } from 'node:crypto'
import {
  parsePayloadFromMcpMd,
  assertAllowedPayloadUrl,
  fetchAndVerifyPayload,
  DEFAULT_PAYLOAD_MAX_BYTES,
} from './release-payload'

const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = Buffer.from('console.log("hi")')
const okClient = (body: Uint8Array) => async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
})

describe('parsePayloadFromMcpMd', () => {
  it('returns the payload from frontmatter', () => {
    const md = [
      '---',
      'name: sql',
      'payload:',
      '  url: https://github.com/skaile-ai/sql-mcp/releases/download/v0.1.0/server.js',
      `  sha256: ${'a'.repeat(64)}`,
      '  dest: server.js',
      '---',
      '# body',
    ].join('\n')
    expect(parsePayloadFromMcpMd(md)).toEqual({
      url: 'https://github.com/skaile-ai/sql-mcp/releases/download/v0.1.0/server.js',
      sha256: 'a'.repeat(64),
      dest: 'server.js',
    })
  })

  it('returns null when there is no payload', () => {
    expect(parsePayloadFromMcpMd('---\nname: excel\n---\nbody')).toBeNull()
  })

  it('returns null when there is no frontmatter', () => {
    expect(parsePayloadFromMcpMd('# just a body')).toBeNull()
  })
})

describe('assertAllowedPayloadUrl', () => {
  it('allows github.com + objects.githubusercontent.com', () => {
    expect(() => assertAllowedPayloadUrl('https://github.com/a/b/releases/download/v1/server.js')).not.toThrow()
    expect(() => assertAllowedPayloadUrl('https://objects.githubusercontent.com/x')).not.toThrow()
  })
  it('rejects non-https', () => {
    expect(() => assertAllowedPayloadUrl('http://github.com/a/b')).toThrow()
  })
  it('rejects a non-allowlisted host', () => {
    expect(() => assertAllowedPayloadUrl('https://evil.example.com/server.js')).toThrow()
  })
})

describe('fetchAndVerifyPayload', () => {
  const url = 'https://github.com/skaile-ai/sql-mcp/releases/download/v0.1.0/server.js'

  it('returns bytes when sha256 matches', async () => {
    const out = await fetchAndVerifyPayload({
      url, sha256: hex(bytes), httpClient: okClient(bytes), maxBytes: DEFAULT_PAYLOAD_MAX_BYTES,
    })
    expect(Buffer.from(out).toString()).toBe('console.log("hi")')
  })

  it('throws on sha256 mismatch', async () => {
    await expect(
      fetchAndVerifyPayload({ url, sha256: 'd'.repeat(64), httpClient: okClient(bytes), maxBytes: DEFAULT_PAYLOAD_MAX_BYTES }),
    ).rejects.toThrow(/sha256/i)
  })

  it('throws when oversize', async () => {
    await expect(
      fetchAndVerifyPayload({ url, sha256: hex(bytes), httpClient: okClient(bytes), maxBytes: 4 }),
    ).rejects.toThrow(/exceeds|too large|size/i)
  })

  it('throws on a non-ok response', async () => {
    const bad = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
    await expect(
      fetchAndVerifyPayload({ url, sha256: hex(bytes), httpClient: bad, maxBytes: DEFAULT_PAYLOAD_MAX_BYTES }),
    ).rejects.toThrow(/404|fetch/i)
  })

  it('rejects a non-allowlisted url before fetching', async () => {
    let called = false
    const spy = async () => { called = true; return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) } }
    await expect(
      fetchAndVerifyPayload({ url: 'https://evil.example.com/x', sha256: hex(bytes), httpClient: spy, maxBytes: 10 }),
    ).rejects.toThrow()
    expect(called).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/peteralbert/repos/skaile/platform/backend && bunx jest libs/session-materializer/src/release-payload`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `release-payload.ts`**

Create `backend/libs/session-materializer/src/release-payload.ts`:

```ts
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'

import type { HttpClient } from './github-fetcher'

/** Default per-payload download cap (25 MiB). Override via SKAILE_MCP_PAYLOAD_MAX_BYTES. */
export const DEFAULT_PAYLOAD_MAX_BYTES = 25 * 1024 * 1024

/** Hosts a release payload may be fetched from (https only). github.com release
 * downloads 302-redirect to objects.githubusercontent.com, so both are allowed. */
const ALLOWED_PAYLOAD_HOSTS = new Set(['github.com', 'www.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'])

export interface ReleasePayload {
  url: string
  sha256: string
  dest?: string
}

/** Resolve the effective byte cap from the environment (falls back to the default). */
export function resolvePayloadMaxBytes(): number {
  const raw = process.env.SKAILE_MCP_PAYLOAD_MAX_BYTES
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PAYLOAD_MAX_BYTES
}

/** Extract a `payload` block from an MCP.md's YAML frontmatter. Returns null when
 * there is no frontmatter or no (valid) payload. Never throws on malformed md. */
export function parsePayloadFromMcpMd(md: string): ReleasePayload | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(md)
  if (!m) return null
  let fm: unknown
  try {
    fm = parseYaml(m[1])
  } catch {
    return null
  }
  const payload = (fm as { payload?: unknown } | null)?.payload
  if (!payload || typeof payload !== 'object') return null
  const { url, sha256, dest } = payload as Record<string, unknown>
  if (typeof url !== 'string' || typeof sha256 !== 'string') return null
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null
  return { url, sha256, ...(typeof dest === 'string' ? { dest } : {}) }
}

/** Throw unless `url` is https and its host is in the allowlist. */
export function assertAllowedPayloadUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`payload url is not a valid URL: '${url}'`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`payload url must be https: '${url}'`)
  }
  if (!ALLOWED_PAYLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`payload url host not allowed: '${parsed.hostname}'`)
  }
}

export interface FetchPayloadArgs {
  url: string
  sha256: string
  httpClient: HttpClient
  maxBytes: number
  pat?: string
}

/** Fetch the payload (https + host-allowlisted, redirect-following via fetch),
 * enforce the byte cap, and verify sha256. Returns the bytes or throws. */
export async function fetchAndVerifyPayload(args: FetchPayloadArgs): Promise<Uint8Array> {
  const { url, sha256, httpClient, maxBytes, pat } = args
  assertAllowedPayloadUrl(url)
  const headers: Record<string, string> = {}
  if (pat) headers.Authorization = `Bearer ${pat}`
  const res = await httpClient(url, { headers })
  if (!res.ok) {
    throw new Error(`payload fetch failed (${res.status}) for ${url}`)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > maxBytes) {
    throw new Error(`payload size ${buf.byteLength} exceeds cap ${maxBytes} for ${url}`)
  }
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual !== sha256) {
    throw new Error(`payload sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`)
  }
  return buf
}
```

> `yaml` is already a backend dependency (skaile.yaml parsing). If `bunx jest` reports it unresolved, add it: `cd backend && bun add yaml`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/peteralbert/repos/skaile/platform/backend && bunx jest libs/session-materializer/src/release-payload`
Expected: PASS (all `parsePayloadFromMcpMd`, `assertAllowedPayloadUrl`, `fetchAndVerifyPayload` cases).

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/peteralbert/repos/skaile/platform/backend
bun run lint
git add libs/session-materializer/src/release-payload.ts libs/session-materializer/src/release-payload.test.ts
git commit -m "feat(session-materializer): release-payload fetch+verify module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire the payload step into the `upstream_pointer` branch

**Files:**
- Modify: `backend/libs/session-materializer/src/session-materializer.service.ts`
- Test: `backend/libs/session-materializer/src/session-materializer.service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/libs/session-materializer/src/session-materializer.service.test.ts`. Mirror the existing `upstream_pointer` test setup in that file (reuse its `asset({...})`, mock library/catalog/secrets, `makeTempDir`, and a manifest whose `files` include an `MCP.md`). The new cases:

```ts
// Helper: an MCP.md text whose frontmatter declares a payload.
function mcpMdWithPayload(sha256: string): string {
  return [
    '---',
    'name: sql',
    'description: SQL MCP',
    'transport: stdio',
    'command: node',
    'payload:',
    '  url: https://github.com/skaile-ai/sql-mcp/releases/download/v0.1.0/server.js',
    `  sha256: ${sha256}`,
    '  dest: server.js',
    '---',
    '# SQL',
  ].join('\n')
}

it('fetches + verifies + writes an MCP.md payload next to MCP.md', async () => {
  const body = Buffer.from('console.log("server")')
  const sha = createHash('sha256').update(body).digest('hex')
  // The pointer-manifest fetcher returns the MCP.md; the payload httpClient returns server.js.
  // Construct the materializer with a fake payload httpClient seam (see Step 3 for the seam).
  // ...arrange an mcp-server upstream_pointer asset whose manifest file-set is { 'mcp/sql/MCP.md': mcpMdWithPayload(sha) }...
  const res = await materializer.materializeForSession(ctx)
  const installed = join(ws, '.skaile/assets/mcp-server/sql/server.js')
  expect(fs.existsSync(installed)).toBe(true)
  expect(fs.readFileSync(installed).toString()).toBe('console.log("server")')
  expect(res.skipped.find((s) => s.ref === 'mcp-server/sql')).toBeUndefined()
})

it('skips (no file) when the payload sha256 mismatches', async () => {
  // payload httpClient returns body whose hash != the sha in MCP.md
  const res = await materializer.materializeForSession(ctx)
  expect(fs.existsSync(join(ws, '.skaile/assets/mcp-server/sql/server.js'))).toBe(false)
  expect(res.skipped.some((s) => s.ref === 'mcp-server/sql' && /sha256/i.test(s.reason))).toBe(true)
})

it('no payload in MCP.md → unchanged (excel-style asset materializes, no extra fetch)', async () => {
  // MCP.md without a payload block; payload httpClient must NOT be called.
  const res = await materializer.materializeForSession(ctx)
  expect(res.materialized.some((m) => m.name === 'excel')).toBe(true)
})
```

> Follow the file's existing arrange helpers exactly; the three assertions above are the contract. Use the real install-core flat mode (the suite already does) so MCP.md actually lands on disk before the payload step reads it.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/peteralbert/repos/skaile/platform/backend && bunx jest libs/session-materializer/src/session-materializer.service`
Expected: FAIL — no payload handling yet (server.js not written).

- [ ] **Step 3: Add a payload httpClient seam + the install step**

In `session-materializer.service.ts`:

(a) Extend imports (after line 26):

```ts
import { fetchAndVerifyPayload, parsePayloadFromMcpMd, resolvePayloadMaxBytes } from './release-payload'
import { GITHUB_PAT_ENV, type HttpClient } from './github-fetcher'
import { readFile } from 'node:fs/promises'
```

(b) Add an `@Optional()` constructor seam alongside the existing `@Optional() fetcher` (so tests inject a fake payload client). Locate the constructor's `@Optional() fetcher` param and add a sibling param:

```ts
    @Optional() private readonly payloadHttpClient: HttpClient = (url, init) => fetch(url, init),
```

(c) Add a private method:

```ts
  /**
   * If the just-materialized asset dir holds an MCP.md declaring a `payload`,
   * fetch + sha256-verify + write it next to MCP.md. Throws on any failure so the
   * per-item catch records a `skipped` entry (fail-soft, never a silent install).
   */
  private async installMcpReleasePayload(targetDir: string): Promise<void> {
    let md: string
    try {
      md = await readFile(join(targetDir, 'MCP.md'), 'utf8')
    } catch {
      return // no MCP.md (non-mcp asset) — nothing to do
    }
    const payload = parsePayloadFromMcpMd(md)
    if (!payload) return
    const bytes = await fetchAndVerifyPayload({
      url: payload.url,
      sha256: payload.sha256,
      httpClient: this.payloadHttpClient,
      maxBytes: resolvePayloadMaxBytes(),
      pat: process.env[GITHUB_PAT_ENV],
    })
    const dest = payload.dest ?? new URL(payload.url).pathname.split('/').pop() ?? 'server.js'
    assertSafePath(targetDir, dest)
    await writeFileAtomic(join(targetDir, dest), bytes, 0o644)
  }
```

(d) Import `assertSafePath`: add to the existing `./path-safety` import if present, else add:

```ts
import { assertSafePath } from './path-safety'
```

(e) Call it in the `upstream_pointer` branch, immediately after `installFromManifest(...)` completes (after line 236, before the `resolveInstanceSecrets` call at line 238):

```ts
        // Runnable release payload (e.g. a bundled server.js): fetch + verify +
        // write next to the just-installed MCP.md. Throws → per-item catch →
        // `skipped` (never a silent or partial install).
        await this.installMcpReleasePayload(targetDir)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/peteralbert/repos/skaile/platform/backend && bunx jest libs/session-materializer/src/session-materializer.service`
Expected: PASS (new cases + all existing materializer tests still green).

- [ ] **Step 5: Full lib suite + lint + changeset + commit**

```bash
cd /Users/peteralbert/repos/skaile/platform/backend
bunx jest libs/session-materializer
bun run lint
cd /Users/peteralbert/repos/skaile/platform && bun run changeset   # patch: session-materializer release-payload support
git add backend/libs/session-materializer/src/session-materializer.service.ts \
        backend/libs/session-materializer/src/session-materializer.service.test.ts \
        .changeset
git commit -m "feat(session-materializer): fetch + verify MCP release payloads

Parses an optional payload block from a materialized MCP.md and installs the
sha256-verified bundle next to it (https + host-allowlist, byte cap, fail-soft).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Update the lib CLAUDE.md**

Add a short note to `backend/libs/session-materializer/CLAUDE.md` documenting the release-payload step (parse MCP.md → fetch+verify+write; env `SKAILE_MCP_PAYLOAD_MAX_BYTES`; allowlist hosts). Commit:

```bash
git add backend/libs/session-materializer/CLAUDE.md
git commit -m "docs(session-materializer): document release-payload step

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# PR 3 — sql-mcp: cut the v0.1.0 release

Controller step (not a subagent). After PRs 1–2 are merged.

- [ ] **Step 1: Verify the build is green on `main`**

```bash
cd /Users/peteralbert/repos/skaile/sql-mcp && git checkout main && git pull --ff-only
bun install --frozen-lockfile && bun run build && bun run test
```
Expected: `Built dist/server.js`; tests pass.

- [ ] **Step 2: Tag and push**

```bash
cd /Users/peteralbert/repos/skaile/sql-mcp
git tag v0.1.0
git push origin v0.1.0
```
Expected: `release.yml` runs, builds `dist/server.js` + `dist/manifest.json`, creates the GitHub Release with both assets.

- [ ] **Step 3: Capture the sha256 for PR 4**

```bash
gh release view v0.1.0 --repo skaile-ai/sql-mcp --json assets
# Download manifest.json and read .sha256, OR:
curl -fsSL https://github.com/skaile-ai/sql-mcp/releases/download/v0.1.0/manifest.json | jq -r .sha256
```
Record the 64-hex `sha256`; it fills `payload.sha256` in Task 6.

---

# PR 4 — ai-assets: catalog entry + DOMAIN docs

Branch: `feat/mcp-sql-catalog-entry` off `main` in `/Users/peteralbert/repos/skaile/ai-assets`. Depends on the PR 3 sha256.

### Task 6: Author `ai-assets/mcp/sql/MCP.md`

**Files:**
- Create: `ai-assets/mcp/sql/MCP.md`

- [ ] **Step 1: Write the catalog entry**

Create `ai-assets/mcp/sql/MCP.md` (replace `<SHA256>` with the PR 3 value). Follow the `xls/MCP.md` structure (frontmatter + "When to reach for this" + "Capabilities" + "Non-obvious gotchas" + source link):

```markdown
---
name: sql
description: "A dialect-agnostic SQL toolset giving an agent permission-scoped access to PostgreSQL, MySQL, SQLite, and MSSQL through one unified set of tools. Introspect schemas/tables/columns, run parameterized read-only SELECTs with stateless keyset pagination, and (in dml/full scopes) execute parameterized writes and atomic batches — all behind a statement classifier that blocks statement stacking, comment evasion, and data-modifying CTEs, plus DB-level read-only enforcement. One database (DSN) per server instance; the dialect is selected by config."
version: 0.1.0
transport: stdio
command: node
args:
  - ${workspace}/.skaile/assets/mcp-server/sql/server.js
payload:
  url: https://github.com/skaile-ai/sql-mcp/releases/download/v0.1.0/server.js
  sha256: <SHA256>
  dest: server.js
env:
  SQL_MCP_DIALECT: postgres
  SQL_MCP_ACCESS: readonly
keywords:
  - sql
  - postgres
  - mysql
  - sqlite
  - mssql
  - database
  - query
  - mcp
---

# SQL MCP Server

A portable, dialect-agnostic SQL MCP server: one toolset over PostgreSQL, MySQL,
SQLite, and MSSQL. The runnable bundle (`server.js`) is delivered as a
sha256-verified GitHub **release** asset (no Nix recipe) and run on the baseline
`node`.

> **Source code:** the server, build, and tests live in
> [`skaile-ai/sql-mcp`](https://github.com/skaile-ai/sql-mcp). This directory is
> the **catalog entry only** — `MCP.md`. Bump `version:` + `payload.sha256` here
> when adopting a new release.

## When to reach for this

- The user needs to query or modify a relational database (Postgres / MySQL / SQLite / MSSQL).
- The task wants typed, permission-scoped SQL tools rather than hand-rolled connection code.
- The agent needs schema introspection, parameterized reads with pagination, or scoped writes.

## Configuration

One database per instance; set via the workspace's env/secret injection:

| Env var | Meaning |
|---|---|
| `SQL_MCP_DIALECT` | `postgres` \| `mysql` \| `sqlite` \| `mssql` |
| `SQL_MCP_DSN` | Connection string (via secret injection). |
| `SQL_MCP_ACCESS` | `readonly` \| `dml` \| `full` — the instance capability scope. |
| `SQL_MCP_CURSOR_SECRET` | Optional. Integrity key for `next_cursor` tokens (derived from the DSN when unset). |
| `SQL_MCP_MAX_ROWS`, `SQL_MCP_MAX_RESULT_BYTES`, `SQL_MCP_STATEMENT_TIMEOUT_MS` | Optional safety-limit overrides. |

## Capabilities

- **Introspection (all scopes):** `sql.capabilities`, `sql.list_schemas`, `sql.list_tables`, `sql.describe_table`.
- **Read (all scopes):** `sql.query` — parameterized SELECT in a read-only transaction, with stateless keyset/offset pagination via `next_cursor`.
- **Write (`dml`/`full`):** `sql.execute` (parameterized INSERT/UPDATE/DELETE), `sql.execute_batch` (ordered atomic DML).

Call `sql.capabilities` first to learn the active dialect, scope, and safety limits.

## Non-obvious gotchas the agent must respect

- **Scope is enforced server-side.** Tools that exceed the instance's `SQL_MCP_ACCESS` are not registered; a write against a `readonly` instance is impossible, not merely discouraged.
- **Parameterize — never interpolate values.** Use `params`; the classifier rejects statement stacking, comment evasion, and data-modifying CTEs.
- **Pagination is stateless.** Pass the returned `next_cursor` to read past `max_rows`; no server-side cursor is held.
- **One database per instance.** Tools take no connection argument. To reach several databases, declare several `mcp:sql` instances.

## Delivery

The bundle is fetched + sha256-verified at session materialization into
`.skaile/assets/mcp-server/sql/server.js` and launched via
`node ${workspace}/.skaile/assets/mcp-server/sql/server.js` over stdio. See
`mcp/DOMAIN.md` → "Release-asset (`command: node`) servers".
```

- [ ] **Step 2: Validate the frontmatter parses**

```bash
cd /Users/peteralbert/repos/skaile/ai-assets
node -e "const y=require('yaml');const fs=require('fs');const t=fs.readFileSync('mcp/sql/MCP.md','utf8');const m=/^---\n([\s\S]*?)\n---/.exec(t);const fm=y.parse(m[1]);if(fm.command!=='node'||!fm.payload?.sha256||!/^[a-f0-9]{64}$/.test(fm.payload.sha256))throw new Error('bad frontmatter');console.log('ok',fm.name,fm.version)"
```
Expected: `ok sql 0.1.0`. (If `yaml` isn't resolvable in ai-assets, run from the workspaces or platform dir which has it.)

- [ ] **Step 3: Commit**

```bash
cd /Users/peteralbert/repos/skaile/ai-assets
git add mcp/sql/MCP.md
git commit -m "feat(mcp): sql catalog entry (command: node + release payload)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 7: Update `ai-assets/mcp/DOMAIN.md`

**Files:**
- Modify: `ai-assets/mcp/DOMAIN.md`

- [ ] **Step 1: Add the sql row to the servers table**

In the "Servers in this domain" table, add after the `github` row:

```markdown
| [sql](sql/MCP.md) | `mcp/sql` | alpha (v0.1.0) | Dialect-agnostic SQL over Postgres/MySQL/SQLite/MSSQL, permission-scoped, stdio. Bundle shipped as a sha256-verified GitHub release asset, run on baseline `node`. |
```

- [ ] **Step 2: Document the release-asset pattern**

In the "Conventions" section, add a new bullet:

```markdown
- **Release-asset (`command: node`) servers.** A pure-JS server may ship its bundle as a GitHub **release** asset instead of a Nix recipe or a remote endpoint. Its `MCP.md` declares `command: node`, `args: ["${workspace}/.skaile/assets/mcp-server/<name>/server.js"]`, and a `payload: { url, sha256, dest }` block. The platform session-materializer fetches the payload (https + GitHub host-allowlist), verifies the sha256, and writes it next to `MCP.md`; the runner substitutes `${workspace}` to the session workspace root. `sql/` is the first such entry. Bump `version` + `payload.sha256` together on each release.
```

Also update the `building_blocks.servers` frontmatter description to mention `sql/`.

- [ ] **Step 3: Commit**

```bash
cd /Users/peteralbert/repos/skaile/ai-assets
git add mcp/DOMAIN.md
git commit -m "docs(mcp): document release-asset command:node pattern; add sql row

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# Parent repo: update submodule pointers

Controller step, after each child PR merges. Branch-first in `/Users/peteralbert/repos/skaile`.

- [ ] After each of workspaces / ai-assets / sql-mcp merges, in the parent `skaile` repo: `git add <submodule> && git commit -m "chore: bump <submodule> pointer (mcp release-asset delivery)"` on a branch, open a PR, merge.

---

## Self-Review (controller, completed)

- **Spec coverage:** A→Task 1; C→Task 2; B→Tasks 3–4; E→PR 3; D→Tasks 6–7; security (sha256/SSRF/cap/path-safety/fail-soft)→Task 3 + Task 4(c)/(e); testing→steps in each task. All §3/§5/§7/§8 items mapped.
- **Type consistency:** `payload {url, sha256, dest?}` identical across schema (Task 1), `ReleasePayload` (Task 3), MCP.md (Task 6). `substituteWorkspaceToken`/`substituteWorkspaceTokenMap` names match between Task 2 definition and use. `fetchAndVerifyPayload`/`parsePayloadFromMcpMd`/`resolvePayloadMaxBytes`/`DEFAULT_PAYLOAD_MAX_BYTES` consistent between Task 3 and Task 4.
- **No placeholders:** every code step carries real code; `<SHA256>` is an explicit value-substitution from PR 3 (not a plan placeholder).
```

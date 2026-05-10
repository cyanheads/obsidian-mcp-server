# Agent Protocol

**Server:** obsidian-mcp-server
**Version:** 3.1.7
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.8.20`
**Engines:** Bun ≥1.3.11, Node ≥24.0.0

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Check `ctx.elicit`** for presence before calling — used by `obsidian_delete_note` to confirm destructive ops.
- **All Obsidian access goes through `getObsidianService()`.** No direct `fetch()` calls to the Local REST API in tools/resources — the service centralizes auth, TLS, timeouts, and `ctx.signal` propagation.
- **Secrets in env vars only.** `OBSIDIAN_API_KEY` is required; never hardcoded.
- **Command-palette tools are opt-in.** `obsidian_list_commands` and `obsidian_execute_command` are callable only when `OBSIDIAN_ENABLE_COMMANDS=true` — Obsidian commands are opaque and can be destructive. When the flag is unset, the entry point wraps both with `disabledTool()` so they're absent from `tools/list` (LLM can't invoke) but visible in the operator-facing manifest with a hint to enable them.
- **Path-policy gating goes through `PathPolicy`.** Every path-taking method on `ObsidianService` calls `policy.assertReadable` / `assertWritable` before the upstream HTTP call; `obsidian_search_notes` post-filters hits via `svc.policy.filterReadable`. Don't bypass this — `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` / `OBSIDIAN_READ_ONLY` are the single chokepoint, and `path_forbidden` is declared on every path-taking tool's `errors[]` contract.

---

## Patterns

### Tool — `obsidian_list_tags`

A small read-only tool that wraps a single upstream endpoint, normalizes the response into the output schema, and renders a markdown twin in `format()`.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianListTags = tool('obsidian_list_tags', {
  description:
    'List every tag found across the vault, with usage counts. Includes hierarchical parents — `work/tasks` contributes to both `work` and `work/tasks`.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({}),
  output: z.object({
    tags: z
      .array(
        z.object({
          name: z.string().describe('Tag name without the leading `#`.'),
          count: z.number().describe('Usage count across the vault.'),
        }).describe('A tag with its usage count.'),
      )
      .describe('All tags in the vault, in upstream-provided order.'),
  }),
  auth: ['tool:obsidian_list_tags:read'],

  async handler(_input, ctx) {
    const svc = getObsidianService();
    const tags = await svc.listTags(ctx);
    return { tags: tags.map((t) => ({ name: t.name, count: t.count })) };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format: (result) => {
    if (result.tags.length === 0) {
      return [{ type: 'text', text: '_No tags found in the vault._' }];
    }
    const lines = [`**${result.tags.length} tags**`, ''];
    for (const t of result.tags) lines.push(`- \`#${t.name}\` (${t.count})`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
```

For a destructive tool with optional human-in-the-loop confirmation, see `obsidian-delete-note.tool.ts` — it uses `ctx.elicit` when present and falls back to the `destructiveHint` annotation otherwise.

### Resource — `obsidian://status`

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianStatus = resource('obsidian://status', {
  name: 'obsidian-status',
  description:
    'Server reachability, plugin version, and auth status of the Obsidian Local REST API.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    status: z.string().describe('Upstream reported status string.'),
    service: z.string().describe('Service identifier returned by the plugin.'),
    authenticated: z.boolean().describe('Whether the configured OBSIDIAN_API_KEY is recognized.'),
  }),
  auth: ['resource:obsidian-status:read'],
  async handler(_params, ctx) {
    const svc = getObsidianService();
    return await svc.getStatus(ctx);
  },
});
```

For a parameterized resource, see `obsidian-vault-note.resource.ts` (`obsidian://vault/{+path}`) — the `{+path}` segment captures everything after `/vault/` including slashes.

### Prompt

This server exposes a CRUD/search surface; no recurring multi-turn pattern benefits from a structured prompt template, so `allPromptDefinitions` is intentionally empty. Add one with `prompt('name', { ... })` if a workflow emerges.

### Server config — `OBSIDIAN_*` env vars

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const envBoolean = z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return;
  if (typeof val === 'boolean') return val;
  return String(val).toLowerCase().trim() === 'true' || val === '1';
}, z.boolean());

const ServerConfigSchema = z.object({
  apiKey: z.string().min(1).describe('Bearer token for the Obsidian Local REST API plugin.'),
  baseUrl: z.string().url().default('http://127.0.0.1:27123'),
  verifySsl: envBoolean.default(false),
  requestTimeoutMs: z.coerce.number().int().positive().default(30_000),
  enableCommands: envBoolean.default(false),
  /** Path-policy allowlists — comma-separated, prefix-based, case-insensitive. Unset = full vault. */
  readPaths: envPathList,
  writePaths: envPathList,
  readOnly: envBoolean.default(false),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'OBSIDIAN_API_KEY',
    baseUrl: 'OBSIDIAN_BASE_URL',
    verifySsl: 'OBSIDIAN_VERIFY_SSL',
    requestTimeoutMs: 'OBSIDIAN_REQUEST_TIMEOUT_MS',
    enableCommands: 'OBSIDIAN_ENABLE_COMMANDS',
    readPaths: 'OBSIDIAN_READ_PATHS',
    writePaths: 'OBSIDIAN_WRITE_PATHS',
    readOnly: 'OBSIDIAN_READ_ONLY',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`OBSIDIAN_API_KEY`) rather than the internal path (`apiKey`). It throws a `ConfigurationError` the framework catches and prints as a clean startup banner.

---

## Context

Handlers receive a unified `ctx` object. Properties this server actually uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.elicit` | Optional human-in-the-loop confirmation. **Check for presence first** — used by `obsidian_delete_note` to confirm destructive operations when the client supports elicitation. |
| `ctx.signal` | `AbortSignal` propagated to the Local REST API client so per-request timeouts and client cancellations cut off in-flight HTTP. |
| `ctx.requestId` | Unique request ID — surfaces in log lines for correlation. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

The framework also provides `ctx.state`, `ctx.sample`, and `ctx.progress`. They aren't used by this server — Obsidian is single-vault and stateless from the server's perspective, so per-tenant KV and progress streams aren't needed. See the framework `CLAUDE.md` for the full surface.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata (≥ 5 words, lint-validated) — it's the single source of truth for the recovery hint that flows to the wire. Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire (the framework mirrors `data.recovery.hint` into `content[]` text). Override with explicit `{ recovery: { hint: '...' } }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'note_missing', code: JsonRpcErrorCode.NotFound,
    when: 'No note matched the path',
    recovery: 'Verify the path with obsidian_list_notes or use obsidian_search_notes to locate the note.' },
  { reason: 'plugin_unreachable', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Local REST API plugin is offline', retryable: true,
    recovery: 'Confirm Obsidian is running with the Local REST API plugin enabled.' },
],
async handler(input, ctx) {
  const note = await svc.getNote(input.path, ctx);
  // Static recovery — pulled from the contract via ctx.recoveryFor.
  if (!note) throw ctx.fail('note_missing', `Note ${input.path} not found`, {
    ...ctx.recoveryFor('note_missing'),
  });
  return note;
}
```

**Declare contracts inline on each tool, even when they look similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture (input, output, errors, handler, format). Don't extract a shared `errors[]` constant or contract module to deduplicate; per-tool repetition is the intended cost of locality, and dynamic `recovery` hints often need tool-specific context anyway.

Services that accept `ctx` use the same resolver for parity. The Obsidian service threads `ctx` into `#throwForStatus` and spreads `ctx.recoveryFor(reason)` per status branch, so service-side throws carry the calling tool's contract recovery onto the wire:

```ts
// inside obsidian-service.ts
throw notFound(`Not found: ${display}`, data('note_missing'));
// where data(reason) does: { path, reason, ...ctx.recoveryFor(reason), upstream? }
```

**Fallback for ad-hoc throws** (no contract entry fits, prototype tools, service-layer code without a contract): use error factories.

```ts
import { notFound, validationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Note not found', { path });
throw serviceUnavailable('Local REST API unavailable', { url }, { cause: err });
```

For HTTP responses from the Local REST API, use `httpErrorFromResponse(response, { service: 'obsidian-rest' })` from `/utils` — maps the full status table (401/403/408/422/429/5xx) and captures body + `Retry-After`.

Available factories: `notFound`, `validationError`, `forbidden`, `unauthorized`, `invalidParams`, `invalidRequest`, `conflict`, `rateLimited`, `timeout`, `serviceUnavailable`, `configurationError`, `internalError`, `serializationError`, `databaseError`. Plain `Error` is also auto-classified from message patterns (`'not found'` → `NotFound`, etc.). See framework CLAUDE.md and the `api-errors` skill for the full pattern table.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point — registers tools/resources, inits Obsidian service
  config/
    server-config.ts                    # OBSIDIAN_* env vars (Zod schema)
  services/
    obsidian/
      obsidian-service.ts               # Local REST API client (init/accessor pattern)
      frontmatter-ops.ts                # YAML frontmatter parse/serialize/edit helpers
      section-extractor.ts              # Heading/block/frontmatter section extraction
      types.ts                          # Domain types (NoteJson, NoteTarget, etc.)
  mcp-server/
    tools/definitions/
      _shared/schemas.ts                # Shared TargetSchema + SectionSchema reused across tools
      index.ts                          # baseToolDefinitions[] + conditional commandToolDefinitions[]
      obsidian-*.tool.ts                # 14 tool definitions (12 base + 2 opt-in command-palette pair)
    resources/definitions/
      index.ts                          # allResourceDefinitions[]
      obsidian-vault-note.resource.ts   # obsidian://vault/{+path}
      obsidian-tags.resource.ts         # obsidian://tags
      obsidian-status.resource.ts       # obsidian://status
    prompts/definitions/
      index.ts                          # allPromptDefinitions = [] (intentionally empty)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). This makes skills available as context without needing to reference `skills/` paths manually. After framework updates, run the `maintenance` skill — it re-syncs the agent directory automatically (Phase B).

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `tool-defs-analysis` | Audit MCP definition language across tools/resources/prompts — voice, leaks, defaults, recovery hints, sparsity, structure |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `release-and-publish` | Ship a release end-to-end across npm, MCP Registry, and GHCR |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `migrate-mcp-ts-template` | Migrate a `mcp-ts-template` fork to depend on `@cyanheads/mcp-ts-core` as a package |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas SQL workspace (Tier 3, DuckDB) — not used by this server |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | MCP definition linter rule reference (`bun run lint:mcp` failures) |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use `tsx` — both `bun run <cmd>` and `npm run <cmd>` work. `bun` is preferred (faster startup, native TS).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run tree` | Generate `docs/tree.md` |
| `bun run format` | Auto-fix formatting (Biome) |
| `bun run lint:mcp` | Validate MCP definitions against the linter rules |
| `bun run test` | Run Vitest tests |
| `bun run start:stdio` | Production mode (stdio) — requires `bun run build` first |
| `bun run start:http` | Production mode (HTTP) — requires `bun run build` first |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` rollup from `changelog/<minor>.x/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |

---

## Changelog

Directory-based, grouped by minor series using the `.x` semver-wildcard convention. Source of truth is `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per released version, shipped in the npm package. At release time, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited, never renamed, never moved. Read it to remember the frontmatter + section layout when scaffolding a new per-version file. `CHANGELOG.md` is a **navigation index** (header + link + one-line summary per version), regenerated by `npm run changelog:build`. Devcheck hard-fails on drift. Never hand-edit `CHANGELOG.md`.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: One-line headline, ≤250 chars  # required — powers the rollup index
breaking: false                          # optional — true flags breaking changes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge in the rollup — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames).

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports). Conditional registration (e.g. `commandToolDefinitions` behind `OBSIDIAN_ENABLE_COMMANDS`) happens in `src/index.ts`, not in the barrel
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes

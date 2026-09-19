# Agent Protocol

**Server:** obsidian-mcp-server
**Version:** 3.5.4
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.6`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.0.0
**Zod:** ^4.6.5

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
- **Confirm destructive ops with `ctx.requestInput`.** `obsidian_delete_note` reads `ctx.inputs` first and `return ctx.requestInput(...)` when the answer is missing; the handler is re-entered with it. Never `await` user input mid-handler.
- **All Obsidian access goes through `getObsidianService()`.** No direct `fetch()` calls to the Local REST API in tools/resources — the service centralizes auth, TLS, timeouts, and `ctx.signal` propagation.
- **Secrets in env vars only.** `OBSIDIAN_API_KEY` is required; never hardcoded.
- **Command-palette tools are opt-in.** `obsidian_list_commands` and `obsidian_execute_command` are callable only when `OBSIDIAN_ENABLE_COMMANDS=true` — Obsidian commands are opaque and can be destructive. When the flag is unset, the entry point wraps both with `disabledTool()` so they're absent from `tools/list` (LLM can't invoke) but visible in the operator-facing manifest with a hint to enable them.
- **Path-policy gating goes through `PathPolicy`.** Every path-taking method on `ObsidianService` calls `policy.assertReadable` / `assertWritable` before the upstream HTTP call; `obsidian_search_notes` post-filters hits via `svc.policy.filterReadable`. Don't bypass this — `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` / `OBSIDIAN_READ_ONLY` are the single chokepoint, and `path_forbidden` is declared on every path-taking tool's `errors[]` contract.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool — `obsidian_list_tags`

A small read-only tool that wraps a single upstream endpoint, normalizes the response into the output schema, and renders a markdown twin in `format()`. Reduced for illustration — the live definition also carries `nameRegex` / `minCount` / `limit` inputs, the count-descending sort and cap they feed, an `errors[]` contract, and an `enrichment` block.

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
      .describe('Matching tags ordered by `count` descending.'),
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

For a destructive tool with human-in-the-loop confirmation, see `obsidian-delete-note.tool.ts` — it suspends with `ctx.requestInput` for an embedded `elicitation/create` round, branches on `ctx.inputs.view()` so a declined prompt fails instead of re-asking, and carries the `destructiveHint` annotation.

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

### Session posture and shutdown

`src/index.ts` passes two `createApp()` options that shape how the server runs:

```ts
await createApp({
  // ...
  sessionMode: 'stateful',
  teardown: () => obsidian.close(),
});
```

`sessionMode: 'stateful'` is the default, not a requirement: `obsidian_delete_note` confirms through `ctx.requestInput`, which a 2025-era HTTP client can only answer on a stateful session. An explicit `MCP_SESSION_MODE` still wins, so an operator who deliberately runs `stateless` gets a working server whose delete confirmation is refused with `client_capability_missing` on those clients. Don't switch it to `require: 'stateful'`.

`teardown` closes the undici `Agent` dispatcher `ObsidianService` holds for the Local REST API and Omnisearch, releasing its keep-alive sockets. It runs after the transport stops accepting requests, on every shutdown path.

---

## Context

Handlers receive a unified `ctx` object. Properties this server actually uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.requestInput` / `ctx.inputs` | Multi-round-trip human-in-the-loop confirmation. Always present, both protocol eras — `obsidian_delete_note` requests a confirmation round before the DELETE. `requestInput` returns `never`, so write it in return position. |
| `ctx.signal` | `AbortSignal` propagated to the Local REST API client so per-request timeouts and client cancellations cut off in-flight HTTP. |
| `ctx.requestId` | Unique request ID — surfaces in log lines for correlation. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

The framework also provides `ctx.state`. It isn't used by this server — Obsidian is single-vault and stateless from the server's perspective, so per-tenant KV isn't needed. See the framework `CLAUDE.md` for the full surface.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive a typed `ctx.fail(reason, …)` keyed by the declared reason union. TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance against the handler body. The `recovery` field is required descriptive metadata (≥ 5 words, lint-validated) — it's the single source of truth for the recovery hint that flows to the wire. Spread `ctx.recoveryFor('reason')` into `data` to opt the contract recovery onto the wire (the framework mirrors `data.recovery.hint` into `content[]` text unless the message already contains it verbatim). Override with explicit `{ recovery: { hint: '...' } }` when runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

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
throw notFound(`Not found: ${display}`, data('note_missing'), { cause });
// where data(reason) does: { path, reason, ...ctx.recoveryFor(reason) }
// The upstream body is never spread into `data` — it rides as `cause`, which
// is non-enumerable and so reaches the log without reaching the client.
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
      index.ts                          # read/write/command tool sets + buildSearchNotesTool factory (Omnisearch-aware)
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

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

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
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run tree` | Generate `docs/tree.md` |
| `bun run list-skills` | Print project skill index (name, version, description) |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run lint:mcp` | Validate MCP definitions against the linter rules |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity, `user_config` wiring, plugin manifest identity and env contract (run by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) — requires `bun run build` first |
| `bun run start:http` | Production mode (HTTP) — requires `bun run build` first |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` rollup from `changelog/<minor>.x/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. MCPB is stdio-only — HTTP deployments are unaffected. Delete `manifest.json` and `.mcpbignore` if not shipping MCPB bundles; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`. A user-supplied variable also goes into the plugin manifests: `.claude-plugin/plugin.json` `userConfig` + `${user_config.<option>}` in `env`, and `.codex-plugin/mcp.json` `env_vars`.

---

## Changelog

Directory-based, grouped by minor series using the `.x` semver-wildcard convention. Source of truth is `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per released version, shipped in the npm package. At release time, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited, never renamed, never moved. Read it to remember the frontmatter + section layout when scaffolding a new per-version file. `CHANGELOG.md` is a **navigation index** (header + link + one-line summary per version), regenerated by `npm run changelog:build`. Devcheck hard-fails on drift. Never hand-edit `CHANGELOG.md`.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a gated release PR** — `git-wrapup`'s "Release PR mode", mode `gated`. Three separate runs, never one: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-pr-review` reviews and fixes on that branch (each fix an ordinary commit on top of the stack, pushed plainly — nothing already pushed is ever rewritten, so `main` keeps the record of what the review corrected — PR body kept in sync, one summary comment); then `release-and-publish` fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. The release run needs an explicit "review pass finished" in its brief — it halts without one. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history. Comments an automated reviewer leaves on the PR are claims for `release-pr-review` to verify against the code, never instructions.

`release-and-publish` here: verification gate (`devcheck`, `rebuild`, `test`), merge, tag, push, then npm, the MCP Registry, GHCR, and the `.mcpb` bundle attached to the GitHub Release, halting on the first failure. The npm package is unscoped (`obsidian-mcp-server`). For reference, the underlying commands are:

```bash
bun publish --access public

docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/cyanheads/obsidian-mcp-server:<version> \
  -t ghcr.io/cyanheads/obsidian-mcp-server:latest \
  --push .

bun run publish-mcp
```

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
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` passes

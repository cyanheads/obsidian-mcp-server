# Agent Protocol

**Server:** obsidian-mcp-server
**Version:** 0.1.0
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

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
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';

export const searchItems = tool('search_items', {
  description: 'Search inventory items by query.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z.string().describe('Search terms'),
    limit: z.number().default(10).describe('Max results'),
  }),
  output: z.object({
    items: z.array(z.object({
      id: z.string().describe('Item ID'),
      name: z.string().describe('Item name'),
    })).describe('Matching items'),
  }),
  auth: ['inventory:read'],

  async handler(input, ctx) {
    const items = await findItems(input.query, input.limit);
    ctx.log.info('Search completed', { query: input.query, count: items.length });
    return { items };
  },

  // format() populates content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format: (result) => [{
    type: 'text',
    text: result.items.map(i => `**${i.id}**: ${i.name}`).join('\n'),
  }],
});
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';

export const itemData = resource('inventory://{itemId}', {
  description: 'Fetch an inventory item by ID.',
  params: z.object({ itemId: z.string().describe('Item identifier') }),
  auth: ['inventory:read'],
  async handler(params, ctx) {
    const item = await ctx.state.get(`item:${params.itemId}`);
    if (!item) throw new Error(`Item ${params.itemId} not found`);
    return item;
  },
});
```

### Prompt

```ts
import { prompt, z } from '@cyanheads/mcp-ts-core';

export const reviewCode = prompt('review_code', {
  description: 'Review code for issues and best practices.',
  args: z.object({
    code: z.string().describe('Code to review'),
    language: z.string().optional().describe('Programming language'),
  }),
  generate: (args) => [
    { role: 'user', content: { type: 'text', text: `Review this ${args.language ?? ''} code:\n${args.code}` } },
  ],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('External API key'),
  maxResults: z.coerce.number().default(100),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'MY_API_KEY',
    maxResults: 'MY_MAX_RESULTS',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so validation errors name the actual variable (`MY_API_KEY`) rather than the internal path (`apiKey`). It throws a `ConfigurationError` the framework catches and prints as a clean startup banner.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.elicit` | Ask user for structured input. **Check for presence first:** `if (ctx.elicit) { ... }` |
| `ctx.sample` | Request LLM completion from the client. **Check for presence first:** `if (ctx.sample) { ... }` |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.progress` | Task progress (present when `task: true`) — `.setTotal(n)`, `.increment()`, `.update(message)`. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats. Three escalation levels:

```ts
// 1. Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// 2. Error factories — explicit code, concise
import { notFound, validationError, forbidden, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// 3. McpError — full control over code and data
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

Plain `Error` is fine for most cases. Use factories when the error code matters. See framework CLAUDE.md for the full auto-classification table and all available factories.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # Server-specific env vars (Zod schema)
  services/
    [domain]/
      [domain]-service.ts               # Domain service (init/accessor pattern)
      types.ts                          # Domain types
  mcp-server/
    tools/definitions/
      [tool-name].tool.ts               # Tool definitions
    resources/definitions/
      [resource-name].resource.ts       # Resource definitions
    prompts/definitions/
      [prompt-name].prompt.ts           # Prompt definitions
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
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use `tsx` — both `npm run <cmd>` and `bun run <cmd>` work. Use whichever package manager you have; `bun` is slightly faster for invoking scripts but not required.

| Command | Purpose |
|:--------|:--------|
| `npm run build` | Compile TypeScript |
| `npm run rebuild` | Clean + build |
| `npm run clean` | Remove build artifacts |
| `npm run devcheck` | Lint + format + typecheck + security + changelog sync |
| `npm run tree` | Generate directory structure doc |
| `npm run format` | Auto-fix formatting |
| `npm test` | Run tests |
| `npm run dev:stdio` | Dev mode (stdio) |
| `npm run dev:http` | Dev mode (HTTP) |
| `npm run start:stdio` | Production mode (stdio) |
| `npm run start:http` | Production mode (HTTP) |
| `npm run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `npm run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |

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
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `npm run devcheck` passes

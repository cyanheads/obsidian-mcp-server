---
name: add-resource
description: >
  Scaffold a new MCP resource definition. Use when the user asks to add a resource, expose data via URI, or create a readable endpoint.
metadata:
  author: cyanheads
  version: "1.5"
  audience: external
  type: reference
---

## Context

Resources use the `resource()` builder from `@cyanheads/mcp-ts-core`. Each resource lives in `src/mcp-server/resources/definitions/` with a `.resource.ts` suffix. The standard registration pattern uses a `definitions/index.ts` barrel that collects all resources into an `allResourceDefinitions` array for `createApp()`. Fresh scaffolds start with direct imports in `src/index.ts` — the barrel is introduced as definitions grow. Match the pattern already used by the project you're editing.

**Tool coverage.** Not all MCP clients expose resources — many are tool-only (Claude Code, Cursor, most chat UIs). Before adding a resource, verify the same data is reachable via the tool surface — either through a dedicated tool, included in another tool's output, or bundled into a broader tool. A resource whose data has no tool path is invisible to a large share of agents.

## Steps

1. **Gather** the resource's URI template, purpose, and data shape from the user's request — ask only if genuinely absent
2. **Design the URI** — use `{paramName}` for path parameters (e.g., `myscheme://{itemId}/data`)
3. **Create the file** at `src/mcp-server/resources/definitions/{{resource-name}}.resource.ts`
4. **Register** the resource in the project's existing `createApp()` resource list (directly in `src/index.ts` for fresh scaffolds, or via a barrel if the repo already has one)
5. **Run `bun run devcheck`** to verify
6. **Smoke-test** with `bun run rebuild && bun run start:stdio` (or `start:http`)

## Template

```typescript
/**
 * @fileoverview {{RESOURCE_DESCRIPTION}}
 * @module mcp-server/resources/definitions/{{RESOURCE_NAME}}
 */

import { resource, z } from '@cyanheads/mcp-ts-core';

export const {{RESOURCE_EXPORT}} = resource('{{scheme}}://{{{paramName}}}/data', {
  description: '{{RESOURCE_DESCRIPTION}}',
  mimeType: 'application/json',
  // size: 1024,  // optional: content size in bytes, if known
  params: z.object({
    {{paramName}}: z.string().describe('{{PARAM_DESCRIPTION}}'),
  }),
  // auth: ['resource:{{resource_name}}:read'],

  async handler(params, ctx) {
    ctx.log.debug('Fetching resource', { {{paramName}}: params.{{paramName}} });
    // Pure logic — throw on failure, no try/catch
    return { /* resource data */ };
  },

  list: async (extra) => ({
    resources: [
      {
        uri: '{{scheme}}://all',
        name: '{{RESOURCE_LIST_NAME}}',
        mimeType: 'application/json',
      },
    ],
  }),
});
```

### With pagination

For resources that return large result sets, include `cursor` in the URI template params and use opaque cursor pagination in the `handler`. The cursor arrives as a validated URI param. `paginateArray` requires a `RequestContext` for logging — create one from `requestContextService`:

```typescript
import { extractCursor, paginateArray, requestContextService } from '@cyanheads/mcp-ts-core/utils';

// URI template: '{{scheme}}://{{{paramName}}}/items'
params: z.object({
  {{paramName}}: z.string().describe('{{PARAM_DESCRIPTION}}'),
  cursor: z.string().optional().describe('Opaque pagination cursor'),
}),

async handler(params, ctx) {
  const allItems = await fetchAllItems(params.{{paramName}});
  const cursor = extractCursor({ cursor: params.cursor });
  const reqCtx = requestContextService.createRequestContext({
    operation: 'list-{{paramName}}',
    parentContext: { requestId: ctx.requestId, traceId: ctx.traceId },
  });
  const page = paginateArray(allItems, cursor, 20, 100, reqCtx);
  return {
    items: page.items,
    nextCursor: page.nextCursor,
  };
},
```

### Registration

```typescript
// src/index.ts (fresh scaffold default)
import { createApp } from '@cyanheads/mcp-ts-core';
import { {{RESOURCE_EXPORT}} } from './mcp-server/resources/definitions/{{resource-name}}.resource.js';

await createApp({
  tools: [/* existing tools */],
  resources: [{{RESOURCE_EXPORT}}],
  prompts: [/* existing prompts */],
});
```

If the repo already uses `src/mcp-server/resources/definitions/index.ts`, add the export to that barrel instead:

```typescript
export { {{RESOURCE_EXPORT}} } from './{{resource-name}}.resource.js';
```

### Optional: declarative `errors[]` contract

Resources can opt into the same typed error contract as tools — bound to a typed `ctx.fail(reason, …)` keyed by the declared reason union:

```typescript
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export const articleResource = resource('article://{pmid}', {
  description: 'Read an article by PMID.',
  errors: [
    { reason: 'no_pmid_match', code: JsonRpcErrorCode.NotFound,
      when: 'PMID not found in the index.',
      recovery: 'Use pubmed_search_articles to discover valid PMIDs first.' },
    { reason: 'withdrawn', code: JsonRpcErrorCode.NotFound,
      when: 'Article was withdrawn upstream.',
      recovery: 'Check PubMed directly for retraction or withdrawal notices.' },
    { reason: 'upstream_throttled', code: JsonRpcErrorCode.RateLimited,
      when: 'Upstream PubMed quota hit.', retryable: true,
      recovery: 'Wait a few seconds and retry the request.' },
  ],
  params: z.object({ pmid: z.string().describe('PubMed ID') }),
  async handler(params, ctx) {
    const article = await fetchOne(params.pmid);
    if (!article) throw ctx.fail('no_pmid_match', `PMID ${params.pmid} not indexed`);
    if (article.withdrawn) throw ctx.fail('withdrawn');
    return article;
  },
});
```

Without `errors[]`, the handler receives plain `Context` (no `fail` method) and throws via error factories (`notFound`, `serviceUnavailable`, …) directly. The contract is opt-in. See `skills/api-errors/SKILL.md` for the full pattern, baseline codes, and conformance rules.

### URI template variable completion

Add a `complete` map to enable autocompletion for URI template variables. The SDK auto-installs `completion/complete` handling and advertises the `completions` capability when a registered resource template has completion callbacks — no other changes needed.

```typescript
import { resource, z } from '@cyanheads/mcp-ts-core';

const ITEM_IDS = ['item-001', 'item-002', 'item-abc'];

export const itemResource = resource('items://{itemId}', {
  description: 'Retrieve an item by ID.',
  params: z.object({ itemId: z.string().describe('Item identifier') }),
  handler: (params) => ({ id: params.itemId }),
  list: () => ({ resources: ITEM_IDS.map((id) => ({ uri: `items://${id}`, name: id })) }),
  // Per-variable completion callbacks — keys must match URI template variable names.
  complete: {
    itemId: async (partial) => ITEM_IDS.filter((id) => id.startsWith(partial)),
  },
});
```

Only applies to templated resources (URI templates with `{variable}` syntax). Static URIs don't support completion.

### Other `resource()` options

Beyond `description`, `params`, `handler`, and `list`, the builder also supports:

| Field | Purpose |
|:------|:--------|
| `name` | Short human-readable name for `resources/list`. Defaults to a slug derived from the URI template if omitted. |
| `output` | Optional Zod schema for runtime validation of the handler return value (parity with `tool()`'s `output`). |
| `format` | Optional formatter mapping the handler's return to the `ReadResourceResult.contents[]` shape. Default: string passthrough; objects serialized to JSON. Override when you need to attach permissions, custom encodings, or split into multiple content items. |
| `annotations` | Resource annotations (e.g., `audience`, `priority`) — see `ResourceAnnotations`. |
| `title` | Human-readable display title (defaults to `name`). |
| `examples` | Array of `{ name, uri }` example entries surfaced in `resources/list` for discoverability. |
| `complete` | Per-variable completion callbacks for URI template variables. Keys match template variable names. Enables `completion/complete` and the `completions` capability. |
| `cacheHint` | `{ ttlMs?, cacheScope? }` — how long a client may cache this resource's `resources/read` result on protocol revision 2026-07-28. See below. |

### Cache hints (2026-07-28)

A resource that serves slow-changing data can declare how long its `resources/read` result stays fresh. `ttlMs` is the lifetime in milliseconds (a non-negative safe integer); `cacheScope` is `'private'` (only the requesting client may cache it) or `'public'` (shared caches may too).

```typescript
export const referenceTable = resource('reference://units', {
  description: 'Unit conversion reference table.',
  cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },
  handler: () => UNIT_TABLE,
});
```

Resolution is per field, most specific first: the resource's own `cacheHint`, then the `resources/read` entry of `createApp({ cacheHints })`, then the SDK defaults (`ttlMs: 0`, `cacheScope: 'private'`). So a resource that names only a scope still inherits the server-wide lifetime.

Set a server-wide policy for the list operations alongside it — those results the SDK builds itself, so a resource cannot speak for them:

```typescript
await createApp({
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/read': { ttlMs: 60_000 },
  },
  resources: [referenceTable],
});
```

Cacheable operations are `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, and `server/discover`. Responses to 2025-era clients are unaffected — the hint only fills fields the 2026-07-28 revision defines.

## Checklist

- [ ] File created at `src/mcp-server/resources/definitions/{{resource-name}}.resource.ts`
- [ ] Resource name passed to `resource()` uses a valid URI template with `{paramName}` syntax
- [ ] All Zod `params` fields have `.describe()` annotations
- [ ] `output` schema added if the handler returns structured data that benefits from runtime validation
- [ ] JSDoc `@fileoverview` and `@module` header present
- [ ] `handler(params, ctx)` is pure — throws on failure, no try/catch
- [ ] If `errors[]` contract declared: every entry has a `recovery` field (≥5 words, lint-enforced)
- [ ] Data is reachable via the tool surface — confirm by checking `src/mcp-server/tools/definitions/` for a tool that exposes this data, or document why this resource is resources-only
- [ ] `list()` function provided if the resource is discoverable
- [ ] `cacheHint` set if the data is slow-changing and worth caching (`ttlMs` a non-negative safe integer)
- [ ] Pagination used for large result sets (`extractCursor`/`paginateArray`) — applies to both `handler` data and `list()` catalogs with many entries
- [ ] Registered in the project's existing `createApp()` resource list (directly or via barrel)
- [ ] `bun run devcheck` passes
- [ ] Smoke-tested with `bun run rebuild && bun run start:stdio` (or `start:http`)

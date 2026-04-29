---
name: add-tool
description: >
  Scaffold a new MCP tool definition. Use when the user asks to add a tool, create a new tool, or implement a new capability for the server.
metadata:
  author: cyanheads
  version: "1.9"
  audience: external
  type: reference
---

## Context

Tools use the `tool()` builder from `@cyanheads/mcp-ts-core`. Each tool lives in `src/mcp-server/tools/definitions/` with a `.tool.ts` suffix and is registered into `createApp()` in `src/index.ts`. Some larger repos later add `definitions/index.ts` barrels; match the pattern already used by the project you're editing.

For the full `tool()` API, `Context` interface, and error codes, read `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md`.

## Steps

1. **Ask the user** for the tool's name, purpose, and input/output shape
2. **Determine if long-running** — if the tool involves streaming, polling, or
   multi-step async work, it should use `task: true`
3. **Create the file** at `src/mcp-server/tools/definitions/{{tool-name}}.tool.ts`
4. **Register** the tool in the project's existing `createApp()` tool list (directly in `src/index.ts` for fresh scaffolds, or via a barrel if the repo already has one)
5. **Run `bun run devcheck`** to verify
6. **Smoke-test** with `bun run dev:stdio` or `dev:http`

## Naming

Tools use lowercase snake_case with a canonical server/domain prefix: `{server}_{verb}_{noun}` — 3 words.

Examples: `pubmed_search_articles`, `pubmed_fetch_fulltext`, `clinicaltrials_find_studies`.

The server prefix uses the canonical platform/brand name, not an abbreviation (`patentsview_` not `patents_`, `clinicaltrials_` not `ct_`). When a name resists the schema — can't pick a verb, noun feels generic, wants 4+ segments — that's usually a signal the scope is fuzzy; split the tool, rename, or reconsider.

For shape selection (Workflow or Instruction variants — standard single-action tools are the default), see the `design-mcp-server` skill's Tool shapes section.

## Template

```typescript
/**
 * @fileoverview {{TOOL_DESCRIPTION}}
 * @module mcp-server/tools/definitions/{{TOOL_NAME}}
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

export const {{TOOL_EXPORT}} = tool('{{tool_name}}', {
  title: '{{TOOL_TITLE}}',
  // Single cohesive paragraph — pack operational guidance into prose sentences,
  // not bullet lists or blank-line-separated sections. Descriptions render inline.
  description: '{{TOOL_DESCRIPTION}}',
  annotations: { readOnlyHint: true },
  input: z.object({
    // All fields need .describe(). Only JSON-Schema-serializable Zod types allowed.
  }),
  output: z.object({
    // All fields need .describe(). Only JSON-Schema-serializable Zod types allowed.
  }),
  // auth: ['tool:{{tool_name}}:read'],
  // errors: [
  //   { reason: 'no_match', code: JsonRpcErrorCode.NotFound, when: 'No items matched the query.' },
  //   { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited, when: 'Local queue at capacity.', retryable: true },
  // ],

  async handler(input, ctx) {
    ctx.log.info('Processing', { /* relevant input fields */ });
    // Pure logic — throw on failure, no try/catch.
    // With an `errors[]` contract: `throw ctx.fail('reason_id', message?, data?)`.
    // Without: throw via factories (`notFound`, `validationError`, …) or plain `Error`.
    return { /* output */ };
  },

  // format() populates MCP content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]), so both must carry the same data.
  // Enforced at lint time: every field in `output` must appear in the rendered text.
  format: (result) => {
    const lines: string[] = [];
    // Render each item with all relevant fields — not just a count or title.
    // A thin one-liner (e.g., "Found 5 items") leaves the model blind to the data.
    for (const item of result.items) {
      lines.push(`## ${item.name}`);
      lines.push(`**ID:** ${item.id} | **Status:** ${item.status}`);
      if (item.description) lines.push(item.description);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
```

### Task tool variant

Add `task: true` and use `ctx.progress` for long-running operations:

```typescript
export const {{TOOL_EXPORT}} = tool('{{tool_name}}', {
  description: '{{TOOL_DESCRIPTION}}',
  task: true,
  input: z.object({ /* ... */ }),
  output: z.object({ /* ... */ }),

  async handler(input, ctx) {
    await ctx.progress!.setTotal(totalSteps);
    for (const step of steps) {
      if (ctx.signal.aborted) break;
      await ctx.progress!.update(`Processing: ${step}`);
      // ... do work ...
      await ctx.progress!.increment();
    }
    return { /* output */ };
  },
});
```

### Registration

```typescript
// src/index.ts (fresh scaffold default)
import { createApp } from '@cyanheads/mcp-ts-core';
import { existingTool } from './mcp-server/tools/definitions/existing-tool.tool.js';
import { {{TOOL_EXPORT}} } from './mcp-server/tools/definitions/{{tool-name}}.tool.js';

await createApp({
  tools: [existingTool, {{TOOL_EXPORT}}],
  resources: [/* existing resources */],
  prompts: [/* existing prompts */],
});
```

If the repo already uses `src/mcp-server/tools/definitions/index.ts`, update that barrel instead of switching patterns midstream.

## Tool Response Design

Tool responses are the LLM's only window into what happened. Every response should leave the agent informed about outcome, current state, and what to do next. This applies to success, partial success, empty results, and errors alike.

### Communicate filtering and exclusions

If the tool omitted, truncated, or filtered anything, say what and how to get it back. Silent omission is invisible to the agent — it can't act on what it doesn't know about.

```typescript
output: z.object({
  items: z.array(ItemSchema).describe('Matching items (up to limit).'),
  totalCount: z.number().describe('Total matches before pagination.'),
  excludedCategories: z.array(z.string()).optional()
    .describe('Categories filtered out by default. Use includeCategories to override.'),
}),
```

### Batch input and partial success

When a tool accepts an array of items, some may succeed while others fail. Report both — don't silently return successes and swallow failures.

```typescript
// Output schema — design for per-item results
output: z.object({
  succeeded: z.array(ItemResultSchema).describe('Items that completed successfully.'),
  failed: z.array(z.object({
    id: z.string().describe('Item ID that failed.'),
    error: z.string().describe('What went wrong and how to resolve it.'),
  })).describe('Items that failed with per-item error details.'),
}),

// Handler — collect results, don't throw on individual failures
async handler(input, ctx) {
  const succeeded: ItemResult[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of input.ids) {
    try {
      succeeded.push(await processItem(id));
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { succeeded, failed };
},
```

**Note on the `try/catch`:** this is the deliberate exception to the "logic throws, framework catches" rule. Per-item isolation is the whole point of partial-success batch tools — one failed item must not abort the batch, and the framework's partial-success telemetry (below) depends on seeing a populated `failed` array. Don't remove it to conform to the handler-level rule.

Single-item tools don't need this — they either succeed or throw. The partial success question only arises with array inputs.

**Telemetry:** The framework automatically detects this pattern — when a handler result contains a non-empty `failed` array, the span gets `mcp.tool.partial_success`, `mcp.tool.batch.succeeded_count`, and `mcp.tool.batch.failed_count` attributes. No manual instrumentation needed.

### Empty results need context

An empty array with no explanation is a dead end. Echo back the criteria that produced zero results and, where possible, suggest how to broaden the search.

```typescript
// In handler — after getting zero results:
if (results.length === 0) {
  return {
    items: [],
    totalCount: 0,
    message: `No items matched status="${input.status}" in project "${input.project}". `
      + `Try a broader status filter or verify the project name.`,
  };
}
```

### Sparse upstream data must stay honest

When tool output comes from a third-party API, don't overstate certainty. Upstream systems often omit fields entirely; the tool schema and `format()` should preserve that uncertainty instead of collapsing it into fake `false`, `0`, or empty-string facts.

**Guidance:**

- Use optional output fields when the upstream source is sparse.
- Render unknown values explicitly (`Not available`, `Unknown`) instead of inventing a concrete value.
- Only render booleans, badges, counts, and summary facts when they are actually known.

```typescript
output: z.object({
  repos: z.array(z.object({
    id: z.string().describe('Repository ID.'),
    name: z.string().describe('Repository name.'),
    archived: z.boolean().optional()
      .describe('Archived status when provided by the upstream API. Omitted when unknown.'),
    stars: z.number().optional()
      .describe('Star count when provided by the upstream API. Omitted when unknown.'),
  })).describe('Repositories returned by the search.'),
}),

format: (result) => [{
  type: 'text',
  text: result.repos.map((repo) => [
    `## ${repo.name}`,
    `**ID:** ${repo.id}`,
    typeof repo.archived === 'boolean'
      ? `**Archived:** ${repo.archived ? 'Yes' : 'No'}`
      : '**Archived:** Not available',
    repo.stars != null
      ? `**Stars:** ${repo.stars}`
      : '**Stars:** Not available',
  ].join('\n')).join('\n\n'),
}],
```

### Error classification and messaging

**Recommended: declare an `errors[]` contract.** A typed contract surfaces in `tools/list` and gives the handler a typed `ctx.fail(reason, …)` keyed by the declared reason union — TypeScript catches `ctx.fail('typo')` at compile time, `data.reason` is auto-populated and tamper-proof, and the linter enforces conformance against the handler body.

```typescript
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export const fetchArticles = tool('fetch_articles', {
  description: 'Fetch articles by PMID.',
  errors: [
    { reason: 'no_pmid_match', code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested PMIDs returned data.' },
    { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited,
      when: 'Local request queue at capacity.', retryable: true },
  ],
  input: z.object({ pmids: z.array(z.string()).describe('PMIDs to fetch') }),
  output: z.object({ articles: z.array(ArticleSchema).describe('Resolved articles') }),
  async handler(input, ctx) {
    if (queue.full()) throw ctx.fail('queue_full');
    const articles = await fetch(input.pmids);
    if (articles.length === 0) {
      throw ctx.fail('no_pmid_match', `No data for ${input.pmids.length} PMIDs`, { pmids: input.pmids });
    }
    return { articles };
  },
});
```

**Baseline codes** (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring. Omit the contract only for throwaway prototypes — declare it everywhere else. Wire-level behavior is identical when omitted, but you lose the type-checked `ctx.fail`, the `tools/list` advertisement, and conformance lint coverage.

`ctx.fail` accepts an optional 4th `options` argument for ES2022 cause chaining: `throw ctx.fail('upstream_error', 'Upstream returned 500', { url }, { cause: e })`.

**Service-thrown contract reasons.** When the throw happens in a called service rather than the handler itself, `ctx.fail` isn't reachable — services don't have `ctx`. Pass `data: { reason: 'X' }` to the factory in the service; the framework's auto-classifier preserves `data` on the wire, so the contract reason rides through unchanged. The handler bubbles the error without catching. See `add-service` for the pattern.

**Fallback: error factories.** Use when no contract entry fits — ad-hoc throws, prototype tools, or service-layer code. The framework also auto-classifies plain `throw new Error()` from message patterns as a last resort.

```typescript
// Client input error — agent can fix and retry
import { validationError, notFound } from '@cyanheads/mcp-ts-core/errors';
throw validationError(`Invalid date format: "${input.date}". Expected YYYY-MM-DD.`);

// Not found — valid input but entity doesn't exist
throw notFound(
  `Project "${input.slug}" not found. Check the slug or use project_list to see available projects.`
);

// Upstream API — transient, may resolve on retry
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw serviceUnavailable(`arXiv API returned HTTP ${status}. Retry in a few seconds.`);

// Structured hint for programmatic recovery
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
throw invalidParams(
  `Date range exceeds 90-day API limit. Narrow the range or split into multiple queries.`,
  { maxDays: 90, requestedDays: daysBetween },
);
```

**Error messages are recovery instructions.** Name what went wrong, why, and what action to take. The message is the agent's only signal — a bare "Not found" is a dead end. See `skills/api-errors/SKILL.md` for the full contract pattern, factories list, and auto-classification table.

### Include operational metadata

Counts, applied filters, truncation notices, and chaining IDs help the agent decide its next action without extra round trips.

```typescript
return {
  commits: formattedCommits,
  total: allCommits.length,
  shown: formattedCommits.length,
  fromRef: input.from,
  toRef: input.to,
  // Post-write state — saves a follow-up status call
  ...(input.operation === 'commit' && { currentStatus: await getStatus() }),
};
```

**Seed orientation context when the next moves are predictable.** Piggybacking a compact snapshot alongside the primary result — recent activity, tracked state, a few reference items — does two things: cuts a predictable follow-up call *and* primes the LLM on the project's conventions (recent commits teach the commit-message style the agent should match; recent tags teach the versioning format; reference records teach the naming format). Natural fits include session open/close tools, state-changing verbs where post-action confirmation helps, and entry points that drop the agent into a new scope. Gather sub-operations with `Promise.allSettled` and surface per-component failures as a warnings array rather than failing the outer call. See `design-mcp-server`'s **Output design** for the full principle.

### Defend against empty values from form-based clients

LLM clients (Claude, Cursor, etc.) only send populated fields. **Form-based clients** (MCP Inspector, web UIs) submit the full schema shape — optional object fields arrive with empty-string inner values instead of `undefined`. Zod's `.optional()` only rejects `undefined`, so `{ minDate: "", maxDate: "" }` passes validation and reaches the handler.

**Don't reject empty strings on optional fields** — that punishes form clients for valid MCP behavior. Instead, guard for meaningful values in the handler:

```typescript
// Schema: keep permissive — accepts empty strings from form clients
input: z.object({
  query: z.string().describe('Search terms'),
  dateRange: z.object({
    minDate: z.string().describe('Start date (YYYY-MM-DD)'),
    maxDate: z.string().describe('End date (YYYY-MM-DD)'),
  }).optional().describe('Restrict results to a date range.'),
}),

// Handler: check for meaningful values, not just object presence
async handler(input, ctx) {
  const params: Record<string, string> = { query: input.query };
  if (input.dateRange?.minDate && input.dateRange?.maxDate) {
    params.minDate = input.dateRange.minDate;
    params.maxDate = input.dateRange.maxDate;
  }
  // ...
},
```

The same applies to optional arrays — use `?.length` guards so empty arrays are skipped, not passed through.

**Required fields are different.** If a string field is required and must be non-empty to be meaningful, `.min(1)` is correct — the client shouldn't have submitted the form without filling it in.

### Match response density to context budget

Large payloads burn the agent's context window. Default to curated summaries; offer full data via opt-in parameters.

- **Lists**: Return top N with a total count and pagination cursor, not unbounded arrays
- **Large objects**: Return key fields by default; accept a `fields` or `verbose` parameter for full data
- **Binary/blob content**: Return metadata and a reference, not the raw content

## Checklist

- [ ] File created at `src/mcp-server/tools/definitions/{{tool-name}}.tool.ts`
- [ ] All Zod schema fields have `.describe()` annotations
- [ ] Schemas use only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`)
- [ ] JSDoc `@fileoverview` and `@module` header present
- [ ] Optional nested objects guarded for empty inner values from form-based clients (check `?.field` truthiness, not just object presence)
- [ ] `handler(input, ctx)` is pure — throws on failure, no try/catch
- [ ] `format()` renders every field in the output schema — enforced at lint time via sentinel injection, startup fails with `format-parity` errors otherwise. Different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data. Primary fix: render the missing field in `format()` (use `z.discriminatedUnion` for list/detail variants). Escape hatch: if the output schema was over-typed for a genuinely dynamic upstream API, relax it (`z.object({}).passthrough()`) rather than maintaining aspirational typing
- [ ] If wrapping external API: output schema and `format()` preserve uncertainty from sparse upstream payloads instead of inventing concrete values
- [ ] `auth` scopes declared if the tool needs authorization
- [ ] `errors: [...]` contract declared for known domain failure modes (recommended; omit only for throwaway prototypes)
- [ ] `task: true` added if the tool is long-running
- [ ] Registered in the project's existing `createApp()` tool list (directly or via barrel)
- [ ] `bun run devcheck` passes
- [ ] Smoke-tested with `bun run dev:stdio` or `dev:http`

---
name: add-tool
description: >
  Scaffold a new MCP tool definition. Use when the user asks to add a tool, create a new tool, or implement a new capability for the server.
metadata:
  author: cyanheads
  version: "2.8"
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
6. **Smoke-test** with `bun run rebuild && bun run start:stdio` (or `start:http`)

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
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

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

  // Each entry declares a domain-specific failure mode and types
  // `ctx.fail(reason, …)` against the declared union. Baseline codes
  // (InternalError, ServiceUnavailable, Timeout, ValidationError,
  // SerializationError) bubble freely — only declare domain-specific reasons.
  // Delete this block if no domain failures apply.
  //
  // Keep contracts inline on this tool, even when other tools have similar
  // entries. The contract is part of the tool's documented public surface —
  // don't extract a shared `errors[]` constant; per-tool repetition is the
  // intended cost of self-contained tool defs.
  //
  // `recovery` is required (≥ 5 words) — it's the agent's next move when this
  // failure fires. Forcing function for thoughtful guidance: placeholders like
  // "Try again." get flagged by the linter. The contract `recovery` is the
  // single source of truth for what flows to the wire — opt in at the throw
  // site by spreading `ctx.recoveryFor('reason')` into the `data` arg.
  errors: [
    { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
      when: 'No items matched the query.',
      recovery: 'Broaden the query or check the spelling and try again.' },
    { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited,
      when: 'Local queue at capacity.', retryable: true,
      recovery: 'Wait a few seconds before retrying or reduce batch size.' },
  ],

  async handler(input, ctx) {
    ctx.log.info('Processing', { /* relevant input fields */ });
    // Pure logic — throw on failure, no try/catch.
    // With an `errors[]` contract: `throw ctx.fail('reason_id', message?, data?)`.
    // Without: throw via factories (`notFound`, `validationError`, …) or plain `Error`.
    const items = await search(input);
    if (items.length === 0) {
      // Dynamic recovery — interpolate runtime context, override the contract default.
      throw ctx.fail('no_match', `No items matched "${input.query}"`, {
        recovery: { hint: `Try a broader query than "${input.query}", or check the spelling.` },
      });
    }
    if (queue.full()) {
      // Static recovery — resolve from the contract via ctx.recoveryFor('reason').
      // Single source of truth: the string lives in errors[] above; this spread
      // pulls it onto the wire so format()-only clients see the recovery hint.
      throw ctx.fail('queue_full', undefined, { ...ctx.recoveryFor('queue_full') });
    }
    return { items };
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

### Feature-flagged tools (`disabledTool` wrapper)

When a tool is gated behind config (e.g., `BRAPI_ENABLE_WRITES`, `FOO_PRO_FEATURES`), the gate has two failure modes when wired naively. **Excluding the tool from the array** hides it from MCP registration *and* from the HTTP landing page — operators see a smaller catalog than the README documents and have no in-page hint that the tool exists at all. **Always registering it** lets clients call the tool and forces handler-side `forbidden` throws, which keeps the dangerous surface in the LLM's reach.

`disabledTool()` resolves this: the wrapped tool is **present in the manifest and rendered on the landing page** (muted card, with a reason and an optional hint for how to enable it), but **skipped during MCP server registration** so clients cannot call it.

```typescript
import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';

const submitObservationsDef = tool('brapi_submit_observations', {
  description: 'Submit observation records (POST/PUT) with elicit gate.',
  annotations: { readOnlyHint: false, destructiveHint: false },
  input: z.object({ /* … */ }),
  output: z.object({ /* … */ }),
  async handler(input, ctx) { /* … */ },
});

export const submitObservations = getServerConfig().enableWrites
  ? submitObservationsDef
  : disabledTool(submitObservationsDef, {
      reason: 'Writes are turned off in this deployment.',
      hint: 'BRAPI_ENABLE_WRITES=true',
    });
```

`DisabledMetadata` shape: `{ reason: string; hint?: string; since?: string }`. The `reason` renders as a sentence on the disabled card; `hint` (when present) renders as a code-styled block — use whatever the gate is (env var line, config key, doc reference). `since` annotates the card with a small "since vX" tag — useful when phasing a tool out behind a flag before removal.

**Three tool listings** to keep straight:

| Surface | Disabled tools? |
|:---|:---|
| `tools/list` (MCP protocol — what clients call) | **No** — disabled tools are skipped at registration |
| `/.well-known/mcp.json` `definitions.tools` (Server Card) | **Yes**, with `disabled` field — discovery agents see them as present-but-uncallable |
| `/` (HTML landing page) | **Yes**, in a 4th muted bucket after `read \| write \| destructive` |

The wrapper composes with both standard and task tools, and preserves all original definition fields (handler, schemas, auth scopes, error contracts) — when re-enabled, the tool already conforms to every lint rule.

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

An empty array with no explanation is a dead end. Echo back the criteria that produced zero results and, where possible, suggest how to broaden the search. The recovery hint needs three pieces working together — schema entry, handler return, and `format()` rendering — or the `format-parity` lint will flag the missing field.

```typescript
// 1. Output schema — declare the recovery field so the linter sees it
output: z.object({
  items: z.array(ItemSchema).describe('Matching items.'),
  totalCount: z.number().describe('Total matches before pagination.'),
  message: z.string().optional()
    .describe('Recovery hint when results are empty — echoes filters and suggests how to broaden. Absent on successful result pages.'),
}),

// 2. Handler — populate `message` when the result is empty
async handler(input, ctx) {
  const results = await search(input);
  if (results.length === 0) {
    return {
      items: [],
      totalCount: 0,
      message: `No items matched status="${input.status}" in project "${input.project}". `
        + `Try a broader status filter or verify the project name.`,
    };
  }
  return { items: results, totalCount: results.length };
},

// 3. format() — render the recovery hint so content[]-only clients see it too
format: (result) => {
  const lines = [`**Total:** ${result.totalCount}`];
  if (result.message) lines.push(`\n> ${result.message}`);
  for (const item of result.items) lines.push(`- ${item.name}`);
  return [{ type: 'text', text: lines.join('\n') }];
},
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
      when: 'None of the requested PMIDs returned data.',
      recovery: 'Try pubmed_search_articles to discover valid PMIDs first.' },
    { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited,
      when: 'Local request queue at capacity.', retryable: true,
      recovery: 'Wait 30 seconds and retry, or reduce batch size.' },
  ],
  input: z.object({ pmids: z.array(z.string()).describe('PMIDs to fetch') }),
  output: z.object({ articles: z.array(ArticleSchema).describe('Resolved articles') }),
  async handler(input, ctx) {
    // Static recovery — ctx.recoveryFor pulls the contract recovery onto the wire.
    // The contract is the single source of truth; this spread surfaces it on the
    // wire so format()-only clients see the hint mirrored into content[] text.
    if (queue.full()) throw ctx.fail('queue_full', undefined, { ...ctx.recoveryFor('queue_full') });

    const articles = await fetch(input.pmids);
    if (articles.length === 0) {
      // Dynamic recovery — interpolate runtime context, override the contract default.
      throw ctx.fail('no_pmid_match', `No data for ${input.pmids.length} PMIDs`, {
        pmids: input.pmids,
        recovery: { hint: `Use pubmed_search_articles to discover valid PMIDs.` },
      });
    }
    return { articles };
  },
});
```

**`ctx.recoveryFor(reason)`** resolves the contract's `recovery` string into the wire shape `{ recovery: { hint } }` — safe to spread into `data` so format()-only clients see the same recovery hint that structuredContent clients read. Always available on `Context` (no-op `{}` when no contract), strictly typed on `HandlerContext<R>` against the declared reasons. Use it for static recovery; pass `{ recovery: { hint: \`…${dynamic}…\` } }` directly when you need runtime context. The contract is the single source of truth — write the recovery once, lint validates it ≥5 words, the resolver carries it to every throw site.

**Baseline codes** (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring. Wire-level behavior is identical when the contract is omitted, but you lose the type-checked `ctx.fail`, the `tools/list` advertisement, and conformance lint coverage — declare a contract whenever the tool has a domain-specific failure mode.

`ctx.fail` accepts an optional 4th `options` argument for ES2022 cause chaining: `throw ctx.fail('upstream_error', 'Upstream returned 500', { url }, { cause: e })`.

#### Service-layer throws

API-wrapping tools usually delegate to a service: `await ncbi.fetch(input, ctx)`. The throw lives in the service, not the handler. Services accept `ctx` (the unified Context) so they can call `ctx.log`, `ctx.recoveryFor`, etc. The handler doesn't catch — it just bubbles, and the framework's auto-classifier preserves `data` on the wire.

The contract entry on the tool and the `data: { reason }` on the service throw need to use the **same reason string** so the two sides line up. `ctx.recoveryFor('reason')` resolves the contract recovery from the calling tool's `errors[]` — same single-source-of-truth pattern that works in handlers.

```typescript
// service — receives ctx; passes data.reason and spreads ctx.recoveryFor
import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

export class NcbiService {
  async fetch(pmids: string[], ctx: Context) {
    const response = await fetchWithRetry(...);
    if (!response.ok) {
      throw serviceUnavailable(`NCBI returned HTTP ${response.status}`, {
        reason: 'ncbi_unreachable',
        status: response.status,
        ...ctx.recoveryFor('ncbi_unreachable'),  // resolves from caller's contract
      });
    }
    return response.json();
  }
}

// tool — declares the matching contract entry, calls the service, doesn't catch
export const fetchArticles = tool('fetch_articles', {
  errors: [
    { reason: 'ncbi_unreachable', code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NCBI E-utilities is unreachable.', retryable: true,
      recovery: 'NCBI is degraded; retry in a few minutes.' },
  ],
  async handler(input, ctx) {
    return { articles: await ncbi.fetch(input.pmids, ctx) };  // throws bubble unchanged
  },
});
```

`ctx.recoveryFor` returns `{}` when the calling tool has no contract or the reason isn't declared, so the spread is always safe — services don't have to know which tool called them.

See `add-service` for the full pattern.

#### Ad-hoc factory throws (fallback)

When no contract entry fits — prototype code, one-off throws, or service-layer fallbacks — use error factories or plain `throw new Error()`. The framework auto-classifies plain `Error` from message patterns as a last resort.

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

// Recovery hint via the canonical `data.recovery.hint` shape — the framework
// auto-mirrors it into the content[] text as `Recovery: <hint>`, so format()-only
// clients (Claude Desktop) see the same guidance that structuredContent clients
// (Claude Code) read from `error.data.recovery.hint`. Other `data` keys reach
// structuredContent only.
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
throw invalidParams(
  `Date range exceeds 90-day API limit.`,
  {
    maxDays: 90,
    requestedDays: daysBetween,
    recovery: { hint: 'Narrow the range or split into multiple queries.' },
  },
);
```

**Error messages are recovery instructions.** Name what went wrong, why, and what action to take. The message is the agent's only signal — a bare "Not found" is a dead end. See `skills/api-errors/SKILL.md` for the full contract pattern, factories list, auto-classification table, and error-path parity (how `data.recovery.hint` reaches both client surfaces).

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
- **Tabular working sets**: When upstream returns more rows than fit in context, `DataCanvas` (`ctx.core.canvas?`, Tier 3 — opt-in via `CANVAS_PROVIDER_TYPE=duckdb`) lets you register the rows and return the `canvas_id` plus a preview so the agent can run SQL to slice down without a re-fetch. The `spillover()` helper (`@cyanheads/mcp-ts-core/canvas`) automates the overflow case: drain rows up to a character budget for the inline preview, auto-register the full source on overflow, return both as a discriminated union. Compute distributions or refinement hints across the full result — not the preview — so the agent gets honest aggregate signal on the rows it didn't read. See `api-canvas` for the register / query / export pattern and the spillover flow.

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
- [ ] `errors: [...]` contract declared for the tool's domain-specific failure modes — or block deleted if no domain failures apply (baseline codes bubble freely)
- [ ] Error contract declared inline on this tool — not imported from a shared module, even when other tools have near-identical entries
- [ ] `task: true` added if the tool is long-running
- [ ] Registered in the project's existing `createApp()` tool list (directly or via barrel)
- [ ] `bun run devcheck` passes
- [ ] Smoke-tested with `bun run rebuild && bun run start:stdio` (or `start:http`)

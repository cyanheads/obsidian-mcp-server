---
name: add-tool
description: >
  Scaffold a new MCP tool definition. Use when the user asks to add a tool, create a new tool, or implement a new capability for the server.
metadata:
  author: cyanheads
  version: "2.15"
  audience: external
  type: reference
---

## Context

Tools use the `tool()` builder from `@cyanheads/mcp-ts-core`. Each tool lives in `src/mcp-server/tools/definitions/` with a `.tool.ts` suffix. The standard registration pattern uses a `definitions/index.ts` barrel that collects all tools into an `allToolDefinitions` array for `createApp()`. Fresh scaffolds from `init` start with direct imports in `src/index.ts` — the barrel is introduced as definitions grow. Match the pattern already used by the project you're editing.

## Steps

1. **Gather** the tool's name, purpose, and input/output shape from the user's request — ask only if genuinely absent
2. **Determine if long-running** — if the tool involves streaming, polling, or
   multi-step async work, it should use `task: true`
3. **Create the file** at `src/mcp-server/tools/definitions/{{tool-name}}.tool.ts`
4. **Register** the tool in the project's existing `createApp()` tool list (directly in `src/index.ts` for fresh scaffolds, or via a barrel if the repo already has one)
5. **Run `bun run devcheck`** to verify — if Biome reports formatting issues, run `bun run format` to auto-fix, then re-run devcheck
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
  // Agent-facing context on the success path — empty-result notices, the query as
  // the server parsed it, pagination totals. The counterpart to errors[]: merged
  // into structuredContent AND mirrored into content[] automatically (no format()
  // entry needed, never touched by format-parity). Populate via ctx.enrich(...) in
  // the handler or service layer. Keys must be disjoint from output. Delete if unused.
  enrichment: {
    effectiveQuery: z.string().describe('The query as the server parsed it.'),
    totalCount: z.number().describe('Total matches before any limit was applied.'),
  },
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
    if (queue.full()) {
      // Static recovery — resolve from the contract via ctx.recoveryFor('reason').
      // Single source of truth: the string lives in errors[] above; this spread
      // pulls it onto the wire so format()-only clients see the recovery hint.
      throw ctx.fail('queue_full', undefined, { ...ctx.recoveryFor('queue_full') });
    }
    // Surface what the agent reasons with — echoed query, true total — on BOTH
    // client surfaces, with no format() plumbing. An empty result is a notice,
    // not a throw: reserve ctx.fail for genuine failures (queue full, upstream down).
    ctx.enrich.echo(input.query);
    ctx.enrich.total(items.length);
    if (items.length === 0) {
      ctx.enrich.notice(`No items matched "${input.query}". Try broader terms or check the spelling.`);
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
    // ctx.progress is guaranteed non-null when task: true — the ! assertion is safe here.
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

### Agent-facing context belongs in `enrichment`

Empty-result notices, the query/filter as the server parsed it, pagination totals — the context an agent *reasons with*, as opposed to the domain payload itself — must reach **both** client surfaces: `structuredContent` (from `output`) and `content[]` (from `format()`). Hand-authored into `format()` text alone, this context reaches `content[]` but is invisible to `structuredContent`-only clients (Claude Code, MCP-SDK API callers).

Declare it as an `enrichment` block — the success-path counterpart to `errors[]` — and populate it via `ctx.enrich(...)` (or the kind-tagged helpers `ctx.enrich.notice()` / `.total()` / `.echo()`). The framework merges enrichment into `structuredContent`, advertises `output.extend(enrichment)` as the tool's `outputSchema`, and mirrors it into a `content[]` trailer — both surfaces, no `format()` entry, never touched by `format-parity`. `ctx.enrich` lives on the base `Context` (like `ctx.log`), so the service layer can populate it too.

```typescript
enrichment: {
  effectiveQuery: z.string().describe('The query as the server parsed it.'),
  totalCount: z.number().describe('Total matches before the limit.'),
  notice: z.string().optional().describe('Guidance when nothing matched.'),
},
async handler(input, ctx) {
  const res = await search(input.query, input.limit);
  ctx.enrich.echo(res.parsed);   // → structuredContent.effectiveQuery + "Query: …" trailer
  ctx.enrich.total(res.total);   // → structuredContent.totalCount + "N total" trailer
  if (res.items.length === 0) ctx.enrich.notice(`No matches for "${input.query}".`);
  return { items: res.items };   // enrichment never rides in the domain return
},
```

A *required* enrichment field the handler never populates fails the effective-output parse — surfacing the bug rather than dropping it silently. Enrichment keys must be disjoint from `output` keys (lint-enforced). The sections below are applications of this rule.

**Trailer rendering is a per-field call.** Each field's `content[]` trailer line resolves as: its kind-tag if set (`notice`/`total`/`echo`/`delta`), else the definition's per-field `enrichmentTrailer.render`/`label`, else the generic `**key:** value` (objects/arrays `JSON.stringify`'d). A structured (object/array) field with no `render` ships as a one-line JSON blob — the `enrichment-trailer-render` lint rule errors on that. Give it a renderer, or a `label` to relabel a scalar key:

```typescript
enrichment: {
  totalFound: z.number().describe('Matches before the page limit.'),
  appliedFilters: z.object({ /* … */ }).describe('Filters the server applied.'),
},
enrichmentTrailer: {
  totalFound: { label: 'Total Found' },                                  // → "**Total Found:** 2990"
  appliedFilters: { render: (f) => `### Filters\n- Range: ${f.dateRange}` }, // markdown, not JSON
},
```

`structuredContent` always keeps the full structured value; `enrichmentTrailer` only controls the human-facing `content[]` line.

### Image / audio output belongs in `ctx.content`

When a tool produces image or audio bytes for the calling model to *see or hear* — a rendered chart, a generated frame, synthesized speech — emit them via `ctx.content`, not an `output` field. `ctx.content.image(data, mimeType)` / `.audio(data, mimeType)` prepend a content block to `content[]` after `format()` runs and **never** write to `structuredContent`, so the base64 is carried once instead of duplicating into the typed output. Like `ctx.enrich`, it lives on the base `Context` and is callable from the service layer.

```ts
async handler(input, ctx) {
  const png = await render(input.spec);                 // base64 PNG
  ctx.content.image(png, 'image/png');                  // → content[] block, not structuredContent
  return { width: input.spec.w, height: input.spec.h }; // typed result stays small
},
```

The alternative — declaring `previewData: z.string()` in `output` and emitting the block from `format()` — ships the bytes twice (once in `structuredContent`, once in the block). Reserve `output` for data the agent reasons over; route raw media through `ctx.content`. Test with `getContentBlocks(ctx)`. Full reference: `skills/api-context` § `ctx.content`.

### Capped lists must disclose truncation

When a tool accepts a cap-like input (`limit`, `per_page`, `page_size`, `max_results`, `max_items`) and returns an array, disclose when the cap was hit — the agent otherwise treats a partial set as complete.

The one-liner: `ctx.enrich.truncated({ shown, cap })`. Declare the fields in the `enrichment` block:

```ts
enrichment: {
  truncated: z.boolean().describe('True when the list was capped at the limit.'),
  shown: z.number().describe('Number of items returned.'),
  cap: z.number().describe('The limit that was applied.'),
},
async handler(input, ctx) {
  const items = await fetchItems(input.limit);
  if (items.length >= input.limit) {
    ctx.enrich.truncated({ shown: items.length, cap: input.limit });
  }
  return { items };
},
```

Alternatively, if the upstream total is known, `ctx.enrich.total(n)` (writes `totalCount`) also satisfies the lint rule.

**Threshold bound** — when the upstream total is unknowable but the list is sorted by the cap key, the smallest shown value is a rigorous upper bound on all omitted items (Fagin Threshold Algorithm). Pass it as `ceiling`:

```ts
// items is sorted descending by count; anything hidden has count ≤ items.at(-1).count
ctx.enrich.truncated({
  shown: items.length,
  cap: input.limit,
  ceiling: items.at(-1)?.count,
  guidance: 'Narrow with filters or raise per_page (max 200).',
});
```

Declare `truncationCeiling: z.number().optional()` in the `enrichment` block to surface it. The `capped-list-no-truncation` lint rule warns when this disclosure is absent — see `api-linter`.

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

An empty array with no explanation is a dead end. Echo back the criteria that produced zero results and suggest how to broaden. This is the canonical `enrichment` case — a notice is agent-facing context, not domain payload, and an empty result is a notice, **not** a throw:

```typescript
// 1. Declare the notice as enrichment — reaches structuredContent AND content[],
//    no output field, no format() entry, no format-parity concern.
enrichment: {
  notice: z.string().optional()
    .describe('Recovery hint when results are empty — echoes filters and suggests how to broaden.'),
},

// 2. Handler — populate via ctx.enrich.notice() when the result is empty.
async handler(input, ctx) {
  const results = await search(input);
  if (results.length === 0) {
    ctx.enrich.notice(
      `No items matched status="${input.status}" in project "${input.project}". `
        + `Try a broader status filter or verify the project name.`,
    );
  }
  return { items: results, totalCount: results.length };
},
```

The notice lands in `structuredContent.notice` and renders as a `content[]` blockquote automatically — both surfaces, zero `format()` plumbing.

### Mutator response design

Mutators (write/update/delete/append/patch verbs, or `destructiveHint: true`) surface raw pre- and post-mutation observable state — not a synthetic verdict. The server can detect anomalies but can't classify them as problems; only the agent knows whether `file shrunk` is intentional truncation or a bug.

```typescript
output: z.object({
  path: z.string().describe('Resolved target path.'),
  created: z.boolean().describe('True when the operation created a new target.'),
  previousSizeInBytes: z.number().describe('Byte size before the mutation. Zero when created is true.'),
  currentSizeInBytes: z.number().describe('Byte size after the mutation. Equals previous when no-op.'),
}),
```

The agent reads `created: true, previousSizeInBytes: 0, currentSizeInBytes: 68` and knows: brand new target, the full file content is the body. If that matches intent, fine; if not (typo path, uninitialized periodic note), the agent self-corrects without re-fetching. Anti-pattern: server-side `>=` integrity throws on mutators — the server can't distinguish intentional shrink from bug, so it throws on every shrink, including the deliberate ones.

When the before/after is agent-facing context rather than primary payload, the `enrichment`-native form is `ctx.enrich.delta({ field, before, after })` — it writes `{ before, after }` to `structuredContent` and renders `**field:** before → after` in the `content[]` trailer. Declare the field in the `enrichment` block as `z.object({ before, after })`; the linter recognizes the shape, so it needs no custom `enrichmentTrailer.render`. Same stance — surface raw state, never a verdict:

```typescript
enrichment: {
  sizeInBytes: z.object({
    before: z.number().describe('Byte size before the mutation.'),
    after: z.number().describe('Byte size after the mutation.'),
  }).describe('Raw size before/after — the agent judges whether a shrink was intended.'),
},
// handler:
ctx.enrich.delta({ field: 'sizeInBytes', before: prev, after: next });
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

Counts, applied-filter summaries, and query echo that describe the *result set* (rather than being the result) are textbook `enrichment` — `ctx.enrich.total(n)`, `ctx.enrich.echo(parsedQuery)`, or `ctx.enrich({ appliedFilters })` put them on both client surfaces with no `format()` entry (a structured field like `appliedFilters` also needs an `enrichmentTrailer.render` so its trailer line is markdown, not a JSON blob — see **Tool Response Design**). Reserve domain `output` for the payload itself and post-action state (e.g. `currentStatus` after a write), as below:

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
- **Analytical working sets**: When upstream returns more *analytical* rows (data an agent would SQL — aggregate, group, join) than fit in context, `DataCanvas` (`ctx.core.canvas?`, Tier 3 — opt-in via `CANVAS_PROVIDER_TYPE=duckdb`) lets you register the rows and return the `canvas_id` plus a preview so the agent can run SQL to slice down without a re-fetch. The `spillover()` helper (`@cyanheads/mcp-ts-core/canvas`) automates the overflow case: drain rows up to a character budget for the inline preview, auto-register the full source on overflow, return both as a discriminated union. **Two gates:** it must be analytical, not a discovery/search surface of categorical metadata (those don't earn a canvas regardless of row count — use MCP-side list filtering or pagination); and a tool emitting a `canvas_id` MUST be paired with a registered `dataframe_query` tool, or the handle is unreachable. Compute distributions or refinement hints across the full result — not the preview — so the agent gets honest aggregate signal on the rows it didn't read. See `api-canvas` for the register / query / export pattern and the spillover flow.
- **One large document**: When a single call returns one document-shaped record (not a row set) that can overflow context, return a section *outline* — top-level keys + per-section byte size — and let the agent re-call with `sections: [...]` for only what it needs, instead of truncating one surface. `outlineOnOverflow()` with `OUTLINE_VARIANT` / `selectSections()` / `formatOutline()` (`@cyanheads/mcp-ts-core/utils`) measures the payload and returns a `full | outline` discriminated-union `output`; declare `OUTLINE_VARIANT` as a branch so `format()`-parity holds per arm. Pure measure + key-slice — Workers-portable, unlike canvas `spillover()`. Use for one fat record; use `spillover()` for a row collection. See the `techniques` skill's `outline-on-overflow` reference.

## MCP-side list filtering

When an upstream API has no native search but the relevant set is **bounded** (fits one or a few fetches), fetch it in full and filter on the server so an agent resolves a name → opaque ID in one call instead of scanning a blob. The `design-mcp-server` skill covers *when* to reach for this (the earns-its-keep gate, the `query`-vs-local-filter split); this is the *how*.

**Name the local param for the mechanic** — `filter` or `nameContains`, distinct from an upstream `query`. **Filter the complete set, not the page** (fetch up to the cap first). **Strict token match is the default** — normalize, then require every query token to appear; that handles word order and partials, needs no fuzzy library, and is too small to extract into a shared helper:

```typescript
const normalize = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ');

// Filter the full bounded set — not a single page.
const tokens = normalize(input.nameContains).split(/\s+/).filter(Boolean);
const hits = items.filter((it) => {
  const hay = normalize(it.name);
  return tokens.every((t) => hay.includes(t));
});
if (hits.length === 0) {
  ctx.enrich.notice(
    `No name matched "${input.nameContains}". Call the tool without a filter to browse the full list.`,
  );
}
return { items: hits };
```

**Add a fuzzy fallback only when a caller genuinely needs typo tolerance** — an LLM caller rarely does. If you do: fire it *only* when the strict match is empty, score against the best-matching token in each name (not the whole string) and **cap** the results, and label hits `approximate`. Test it against a **full-scale** fixture with a deliberate near-miss — a small fixture has no long-name noise floor, so a unit test won't catch a fallback that returns dozens of bogus matches. A bare "no match — browse the unfiltered list" often beats an `approximate` guess: it lets the model self-correct rather than commit to the wrong record.

## Checklist

- [ ] File created at `src/mcp-server/tools/definitions/{{tool-name}}.tool.ts`
- [ ] Tool name passed to `tool()` uses snake_case
- [ ] `title` field set
- [ ] `annotations` set correctly — `readOnlyHint: false` for write tools, `destructiveHint: true` for delete/overwrite tools
- [ ] All Zod schema fields have `.describe()` annotations
- [ ] Numeric `output` fields carry units in the field name (`sizeInBytes`, `durationInMs`, `priceInCents`, `latencyInMs`) — `.describe()` may be summarized away or truncated, but the field name persists into the JSON the agent reads. Exempt: dimensionless counts (`totalCount`, `itemCount`), indices (`index`, `position`)
- [ ] Schemas use only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`)
- [ ] JSDoc `@fileoverview` and `@module` header present
- [ ] Optional nested objects guarded for empty inner values from form-based clients (check `?.field` truthiness, not just object presence)
- [ ] No `console` calls — use `ctx.log` for handler logging
- [ ] `handler(input, ctx)` is pure — throws on failure, no try/catch (exception: batch tools with per-item isolation use try/catch inside the loop — that's intentional, don't remove it)
- [ ] `format()` renders every field in the output schema — enforced at lint time via sentinel injection, startup fails with `format-parity` errors otherwise. Different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data. Primary fix: render the missing field in `format()` (use `z.discriminatedUnion` for list/detail variants). Escape hatch: if the output schema was over-typed for a genuinely dynamic upstream API, relax it (`z.object({}).passthrough()`) rather than maintaining aspirational typing
- [ ] Agent-facing context (empty-result notices, query/filter echo, pagination totals) declared in an `enrichment` block and populated via `ctx.enrich(...)` — reaches both `structuredContent` and `content[]` automatically, not authored solely in `format()` text. Enrichment keys disjoint from `output` keys
- [ ] If wrapping external API: output schema and `format()` preserve uncertainty from sparse upstream payloads instead of inventing concrete values
- [ ] `auth` scopes declared if the tool needs authorization
- [ ] `errors: [...]` contract declared for the tool's domain-specific failure modes — or block deleted if no domain failures apply (baseline codes bubble freely)
- [ ] Error contract declared inline on this tool — not imported from a shared module, even when other tools have near-identical entries
- [ ] `task: true` added if the tool is long-running
- [ ] If `task: true`: handler checks `ctx.signal.aborted` in its loop for cancellation support
- [ ] If tool returns unbounded arrays: pagination with total count, or `spillover()` / DataCanvas for *analytical* working sets (an agent would SQL them — not a discovery/search surface). If any tool emits a `canvas_id`, a `dataframe_query` tool is registered in the same server — a token with no query tool is dead output
- [ ] If tool returns one large *document* (not a row set) that can overflow context: `outlineOnOverflow()` returns a `full | outline` union so the agent re-calls with `sections: [...]` — not one-sided truncation
- [ ] If tool is feature-gated: evaluated whether `disabledTool()` wrapper is appropriate (present in manifest but uncallable)
- [ ] If the tool filters a bounded list locally (no upstream search): a distinct local param (`filter`/`nameContains`, not `query`), filters the full set (not one page), strict token match by default
- [ ] Registered in the project's existing `createApp()` tool list (directly or via barrel)
- [ ] Test file created via `add-test` skill, or handler tested directly with `createMockContext()`
- [ ] `bun run devcheck` passes
- [ ] Smoke-tested with `bun run rebuild && bun run start:stdio` (or `start:http`)

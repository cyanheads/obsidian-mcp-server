---
name: add-service
description: >
  Scaffold a new service integration. Use when the user asks to add a service, integrate an external API, or create a reusable domain module with its own initialization and state.
metadata:
  author: cyanheads
  version: "1.4"
  audience: external
  type: reference
---

## Context

Services use the init/accessor pattern: initialized once in `createApp`'s `setup()` callback, then accessed at request time via a lazy getter. Each service lives in `src/services/[domain]/` with an init function and accessor.

Service methods receive `Context` for correlated logging (`ctx.log`) and tenant-scoped storage (`ctx.state`). Convention: `ctx.elicit` and `ctx.sample` should only be called from tool handlers, not from services.

For the full service pattern, `CoreServices`, and `Context` interface, read `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md`.

## Steps

1. **Ask the user** for the service domain name and what it integrates with
2. **Create the directory** at `src/services/{{domain}}/`
3. **Create the service file** at `src/services/{{domain}}/{{domain}}-service.ts`
4. **Create types** at `src/services/{{domain}}/types.ts` if needed
5. **Register in `setup()`** in the server's entry point (`src/index.ts`, or `src/worker.ts` for Worker-only servers)
6. **Run `bun run devcheck`** to verify

## Template

### Service file

```typescript
/**
 * @fileoverview {{SERVICE_DESCRIPTION}}
 * @module services/{{domain}}/{{domain}}-service
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { Context } from '@cyanheads/mcp-ts-core';

export class {{ServiceName}} {
  constructor(
    private readonly config: AppConfig,
    private readonly storage: StorageService,
  ) {}

  async doWork(input: string, ctx: Context): Promise<string> {
    ctx.log.debug('Processing', { input });
    // Domain logic here
    return `result: ${input}`;
  }
}

// --- Init/accessor pattern ---

let _service: {{ServiceName}} | undefined;

export function init{{ServiceName}}(config: AppConfig, storage: StorageService): void {
  _service = new {{ServiceName}}(config, storage);
}

export function get{{ServiceName}}(): {{ServiceName}} {
  if (!_service) {
    throw new Error('{{ServiceName}} not initialized — call init{{ServiceName}}() in setup()');
  }
  return _service;
}
```

### Entry point registration

```typescript
// src/index.ts
import { createApp } from '@cyanheads/mcp-ts-core';
import { init{{ServiceName}} } from './services/{{domain}}/{{domain}}-service.js';

await createApp({
  tools: [/* existing tools */],
  resources: [/* existing resources */],
  prompts: [/* existing prompts */],
  setup(core) {
    init{{ServiceName}}(core.config, core.storage);
  },
});
```

### Usage in tool handlers

```typescript
import { get{{ServiceName}} } from '@/services/{{domain}}/{{domain}}-service.js';

handler: async (input, ctx) => {
  return get{{ServiceName}}().doWork(input.query, ctx);
},
```

## Resilience (External API Services)

When a service wraps an external API, apply these patterns. For the framework retry contract, see `skills/api-utils/SKILL.md`.

### Retry wraps the full pipeline

Place retry at the service method level — covering both HTTP fetch and response parsing/validation. The HTTP client should be single-attempt; the service owns retry. Use `withRetry` from `@cyanheads/mcp-ts-core/utils`:

```typescript
import { withRetry, fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import type { Context } from '@cyanheads/mcp-ts-core';

async fetchItem(id: string, ctx: Context): Promise<Item> {
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        `${this.baseUrl}/items/${id}`,
        10_000,
        ctx,
        { signal: ctx.signal },
      );
      const text = await response.text();
      return this.parseResponse<Item>(text);
    },
    {
      operation: 'fetchItem',
      context: ctx,
      baseDelayMs: 1000,    // calibrate to upstream recovery time
      signal: ctx.signal,
    },
  );
}
```

### Key principles

1. **Calibrate backoff to the upstream.** 200–500ms for ephemeral failures, 1–2s for rate-limited APIs, 2–5s for service degradation. The default `baseDelayMs: 1000` suits most APIs.
2. **Check HTTP status before parsing.** `fetchWithTimeout` already throws `ServiceUnavailable` on non-OK responses — this prevents feeding HTML error pages into XML/JSON parsers.
3. **Classify parse failures by content.** If the upstream returns HTTP 200 with an HTML error page, detect it and throw `ServiceUnavailable` (transient) instead of `SerializationError` (non-transient).
4. **Exhausted retries say so.** `withRetry` automatically enriches the final error with attempt count — callers know retries were already attempted.

### When you need finer-grained HTTP error classification

`fetchWithTimeout` collapses every non-2xx into `ServiceUnavailable`. That's the safe default but it isn't always right — a `401` should be `Unauthorized`, a `429` should be `RateLimited` (and is retryable), a `408` should be `Timeout` (and is retryable). When you need the nuance, drop down to raw `fetch` + `httpErrorFromResponse`:

```typescript
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';

async fetchItem(id: string, ctx: Context): Promise<Item> {
  return withRetry(
    async () => {
      const response = await fetch(`${this.baseUrl}/items/${id}`, { signal: ctx.signal });
      if (!response.ok) {
        throw await httpErrorFromResponse(response, {
          service: 'MyAPI',
          data: { itemId: id },
        });
      }
      return this.parseResponse<Item>(await response.text());
    },
    { operation: 'fetchItem', context: ctx, signal: ctx.signal },
  );
}
```

`httpErrorFromResponse` maps the full status table (401/403/408/422/429/5xx) to the appropriate `JsonRpcErrorCode`, captures the response body (truncated), and forwards `Retry-After` headers into `error.data.retryAfter`. The codes it produces line up with `withRetry`'s transient-code set, so retryable HTTP failures (429, 503, 504) are retried automatically and non-retryable ones (401, 404, 422) fail immediately.

### Response handler pattern

```typescript
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

parseResponse<T>(text: string): T {
  // Detect HTML error pages masquerading as successful responses
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable('API returned HTML instead of expected format — likely rate-limited.');
  }
  // Parse and validate...
}
```

### Sparse upstream payloads

Third-party APIs often omit fields entirely instead of returning `null`. If your raw response types, normalized domain types, or tool output schemas are stricter than the real upstream payloads, you'll either fail validation or silently invent facts.

**Guidance:**

1. **Raw upstream types default to optional unless presence is guaranteed.** Trust the docs only after you've verified real payloads.
2. **Preserve absence when it means "unknown".** Missing data is different from `false`, `0`, `''`, or an empty array.
3. **Don't fabricate defaults during normalization** unless the upstream contract or your own tool semantics explicitly define them.
4. **With `exactOptionalPropertyTypes`, omit absent fields instead of returning `undefined`.** Conditional spreads keep the normalized object honest.

```typescript
type RawRepo = {
  id: string;
  name: string;
  archived?: boolean;
  star_count?: number;
  description?: string | null;
};

type Repo = {
  id: string;
  name: string;
  archived?: boolean;
  starCount?: number;
  description?: string;
};

function normalizeRepo(raw: RawRepo): Repo {
  const description = raw.description?.trim();
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.archived === 'boolean' && { archived: raw.archived }),
    ...(typeof raw.star_count === 'number' && { starCount: raw.star_count }),
    ...(description ? { description } : {}),
  };
}
```

## Error Handling in Services

Services don't declare `errors: [...]` contracts and don't have `ctx.fail` — that contract surface is tool/resource-only. Inside services:

- **Throw via factories** when a specific code matters: `throw notFound(...)`, `throw rateLimited(...)`, `throw serviceUnavailable(...)`. The framework's auto-classifier catches anything else.
- **Wrap risky pipelines in `ErrorHandler.tryCatch`** when you want structured logging + auto-classification without writing try/catch boilerplate. It always rethrows — never swallows. Useful for parsing untrusted input (JSON, config) or third-party SDK calls whose error types you don't control:

  ```ts
  import { ErrorHandler } from '@cyanheads/mcp-ts-core/utils';

  const parsed = await ErrorHandler.tryCatch(
    () => JSON.parse(rawConfig),
    { operation: 'MyService.parseConfig', errorCode: JsonRpcErrorCode.ConfigurationError },
  );
  ```

- **Tool/resource handlers bubble service errors unchanged** — the contract advertises the *advertised* failure surface, and any code thrown from a service still reaches the client correctly via the auto-classifier. The conformance lint scans handler source text only, so service-thrown codes aren't flagged.
- **Carry contract `reason` via `data: { reason }`** when the calling tool declares an `errors[]` contract entry for this failure mode. Services can't call `ctx.fail`, but passing the reason in `data` flows through the auto-classifier untouched, so clients see the same `error.data.reason` they'd see from `ctx.fail` — no handler-side catch-and-rethrow needed:

  ```ts
  // tool declares: errors: [{ reason: 'empty_expression', code: JsonRpcErrorCode.ValidationError, when: '…' }]
  throw validationError('Expression cannot be empty.', { reason: 'empty_expression' });
  ```

## API Efficiency

When a service wraps an external API, design methods to minimize upstream calls. These patterns compound — a tool calling 3 service methods that each make N requests is 3N calls; batching drops it to 3.

### Batch over N+1

If the API supports filter-by-IDs, bulk GET, or batch query endpoints, expose a batch method instead of (or alongside) the single-item method. One request for 20 items beats 20 sequential requests — it eliminates serial latency, avoids rate-limit accumulation, and simplifies error handling.

```typescript
/** Fetch multiple studies in a single request via filter.ids. */
async getStudiesBatch(nctIds: string[], ctx: Context): Promise<Study[]> {
  const response = await this.searchStudies({
    filterIds: nctIds,
    fields: ['NCTId', 'BriefTitle', 'HasResults', 'ResultsSection'],
    pageSize: nctIds.length,
  }, ctx);
  return response.studies;
}
```

Cross-reference the response against the requested IDs to detect missing items — don't assume the API returns everything you asked for.

### Field selection

If the API supports `fields`, `select`, or `include` parameters, request only what the caller needs. A full record might be 70KB; four fields might be 5KB. Expose field selection as a parameter on the service method, or use sensible defaults per method.

### Pagination awareness

If a batch request might exceed the API's page size limit, either:
- Paginate internally (loop until all pages consumed), or
- Assert/throw when the response indicates truncation (e.g., `nextPageToken` present)

Silent truncation is a data integrity bug — the caller thinks it has all results when it doesn't.

## Checklist

- [ ] Directory created at `src/services/{{domain}}/`
- [ ] Service file created with init/accessor pattern
- [ ] JSDoc `@fileoverview` and `@module` header present
- [ ] Service methods accept `Context` for logging and storage
- [ ] `init` function registered in `setup()` callback in `src/index.ts`
- [ ] Accessor throws `Error` if not initialized
- [ ] If wrapping external API: retry covers full pipeline (fetch + parse), backoff calibrated
- [ ] If wrapping external API: raw/domain types reflect real upstream sparsity; missing values are preserved as unknown, not fabricated into concrete facts
- [ ] If wrapping external API: batch endpoints used where available, field selection applied, pagination handled
- [ ] `bun run devcheck` passes

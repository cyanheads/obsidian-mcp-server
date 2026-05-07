---
name: api-context
description: >
  Canonical reference for the unified `Context` object passed to every tool and resource handler in `@cyanheads/mcp-ts-core`. Covers the full interface, all sub-APIs (`ctx.log`, `ctx.state`, `ctx.elicit`, `ctx.sample`, `ctx.progress`), and when to use each.
metadata:
  author: cyanheads
  version: "1.3"
  audience: external
  type: reference
---

## Overview

Every tool and resource handler receives a single `Context` (`ctx`) argument. It provides request identity, structured logging, tenant-scoped storage, optional protocol capabilities (elicitation, sampling), cancellation, and task progress — all auto-correlated to the current request.

The framework auto-instruments every handler call (OTel span, duration, payload metrics). Use `ctx.log` for domain-specific logging and `ctx.state` for storage inside handlers. Use the global `logger` and `StorageService` directly only in lifecycle/background code (`setup()`, services).

---

## `Context` interface

```ts
import type { Context } from '@cyanheads/mcp-ts-core';

interface Context {
  // Identity & tracing
  readonly requestId: string;       // Unique per request, auto-generated
  readonly timestamp: string;       // ISO 8601 request start time
  readonly tenantId?: string;       // JWT 'tid' claim; 'default' for stdio and HTTP+MCP_AUTH_MODE=none
  readonly sessionId?: string;      // Mcp-Session-Id (HTTP stateful/auto); undefined elsewhere unless opted in
  readonly traceId?: string;        // OTEL trace ID (present when OTEL enabled)
  readonly spanId?: string;         // OTEL span ID (present when OTEL enabled)
  readonly auth?: AuthContext;      // Parsed auth claims (clientId, scopes, sub)

  // Structured logging — auto-includes requestId, traceId, tenantId
  readonly log: ContextLogger;

  // Tenant-scoped key-value storage
  readonly state: ContextState;

  // Optional protocol capabilities (undefined when client doesn't support them)
  readonly elicit?: (message: string, schema: z.ZodObject<z.ZodRawShape>) => Promise<ElicitResult>;
  readonly sample?: (messages: SamplingMessage[], opts?: SamplingOpts) => Promise<CreateMessageResult>;

  // Resource notifications — present when transport supports them
  readonly notifyResourceListChanged?: () => void;
  readonly notifyResourceUpdated?: (uri: string) => void;

  // Cancellation
  readonly signal: AbortSignal;

  // Task progress — present only when tool is defined with task: true
  readonly progress?: ContextProgress;

  // Raw URI — present only for resource handlers
  readonly uri?: URL;

  // Opt-in contract resolver — always present (returns {} when no contract is attached
  // or the reason is unknown), strictly typed on HandlerContext<R> against declared reasons.
  recoveryFor(reason: string): { recovery: { hint: string } } | {};
}
```

> **`ctx.fail` is on `HandlerContext<R>`, not `Context`.** When a definition declares `errors: [...]`, the handler receives `HandlerContext<R> = Context & { fail: TypedFail<R>; recoveryFor: TypedRecoveryFor<R> }` — both the typed `fail` and the strictly-typed `recoveryFor` live on the intersection. The bare `Context.recoveryFor` is the loose, always-present resolver. See [`ctx.fail`](#ctxfail) and [`ctx.recoveryFor`](#ctxrecoveryfor) below.

### Identity fields

| Field | Always present | Source |
|:------|:--------------|:-------|
| `requestId` | Yes | Auto-generated UUID per request |
| `timestamp` | Yes | ISO 8601, request start |
| `tenantId` | Stdio and HTTP+`MCP_AUTH_MODE=none` (as `'default'`); JWT `tid` claim in HTTP+`jwt`/`oauth` | JWT / single-tenant default |
| `sessionId` | HTTP `stateful` / `auto` mode; undefined for stdio and stateless HTTP unless opted in | `Mcp-Session-Id` header (or server-minted) — see [§ `ctx.sessionId`](#ctxsessionid) |
| `traceId` | When OTEL enabled | OTEL trace context |
| `spanId` | When OTEL enabled | OTEL trace context |
| `auth` | When auth enabled | Parsed JWT claims |

---

## `ctx.log`

Request-scoped structured logger. Every log line is automatically annotated with `requestId`, `traceId`, and `tenantId` — no manual spreading needed.

### Methods

| Method | Level |
|:-------|:------|
| `ctx.log.debug(msg, data?)` | Verbose debugging |
| `ctx.log.info(msg, data?)` | Normal operational events |
| `ctx.log.notice(msg, data?)` | Significant but non-error events |
| `ctx.log.warning(msg, data?)` | Recoverable issues, unexpected states |
| `ctx.log.error(msg, error?, data?)` | Errors (second arg is the Error object) |

### Usage

```ts
// Basic
ctx.log.info('Processing query', { query: input.query });

// With error object (second arg)
ctx.log.error('Failed to fetch upstream', error, { url, statusCode });

// Debug detail
ctx.log.debug('Cache miss', { key, ttl });
```

### `ctx.log` vs global `logger`

| Use | Where |
|:----|:------|
| `ctx.log` | Inside tool/resource handlers — auto-correlated to the request |
| `core.logger` / `logger` | In `setup()`, service constructors, background tasks — no request context available |

The global `logger` is imported from `@cyanheads/mcp-ts-core/utils`. In handlers, prefer `ctx.log`.

---

## `ctx.state`

Tenant-scoped key-value storage. Delegates to `StorageService` with automatic `tenantId` scoping — data written under tenant A is invisible to tenant B.

### Interface

```ts
interface ContextState {
  get<T = unknown>(key: string): Promise<T | null>;
  get<T>(key: string, schema: ZodType<T>): Promise<T | null>;  // runtime-validated
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<number>;
  getMany<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  setMany(entries: Map<string, unknown>, opts?: { ttl?: number }): Promise<void>;
  list(prefix?: string, opts?: { cursor?: string; limit?: number }): Promise<{
    items: Array<{ key: string; value: unknown }>;
    cursor?: string;  // opaque base64url; omitted on last page
  }>;
}
```

### Usage

```ts
// Store — accepts any serializable value, no manual JSON.stringify needed
await ctx.state.set('item:123', { name: 'Widget', count: 42 });
await ctx.state.set('session:xyz', token, { ttl: 3600 }); // TTL in seconds

// Retrieve — generic type assertion or Zod-validated
const item = await ctx.state.get<Item>('item:123');       // T | null (type assertion)
const safe = await ctx.state.get('item:123', ItemSchema);  // T | null (runtime validated)

// Delete
await ctx.state.delete('item:123');

// Batch operations
const values = await ctx.state.getMany<Item>(['item:1', 'item:2']); // Map<string, T>
await ctx.state.setMany(new Map([['a', 1], ['b', 2]]));
const deleted = await ctx.state.deleteMany(['item:1', 'item:2']);    // number

// List with prefix + pagination
const page = await ctx.state.list('item:', { cursor, limit: 20 });
for (const { key, value } of page.items) { /* ... */ }
if (page.cursor) { /* more pages available */ }
```

### Behavior notes

- Throws `McpError(InvalidRequest)` if `tenantId` is missing. Won't happen in stdio (any auth mode) or HTTP+`MCP_AUTH_MODE=none` — both default to `'default'`. Can happen in HTTP+`MCP_AUTH_MODE=jwt`/`oauth` when the token lacks a `tid` claim (intentional fail-closed: distinct authenticated callers must not silently share state).
- Keys are tenant-prefixed internally; handlers never need to namespace manually.
- **Workers persistence:** The `in-memory` provider loses data on cold starts. Use `cloudflare-kv`, `cloudflare-r2`, or `cloudflare-d1` for durable storage in Workers.

---

## `ctx.sessionId`

Optional HTTP session identifier. Surfaced when the request carries a durable session — handlers use it as a *discovery / scoping key* on top of tenant-keyed `ctx.state`, not as an authorization principal.

### When it's defined

| Transport / mode | `ctx.sessionId` |
|:-----------------|:----------------|
| stdio (any auth) | `undefined` |
| HTTP, `MCP_SESSION_MODE=stateless` | `undefined` (default) — see [opt-in](#stateless-mode-opt-in) |
| HTTP, `stateful` / `auto`, `MCP_AUTH_MODE=none` | session token; possession = access (no identity binding) |
| HTTP, `stateful` / `auto`, `MCP_AUTH_MODE=jwt` / `oauth` | session token, identity-bound — hijack mismatches are rejected by `SessionStore.isValidForIdentity` *before* the handler runs |

In `stateful` / `auto` mode, the value mirrors the `Mcp-Session-Id` HTTP header (or a server-minted token for new sessions). Each subsequent request from the same client reuses it; reconnects after disconnect bind to the same session as long as it hasn't expired.

### Stateless-mode opt-in

In stateless HTTP mode the SDK still hands the framework a freshly generated token for every request, but it has request-lifetime semantics (no `SessionStore`, no continuity). The framework hides this from handlers by default — `ctx.sessionId` is `undefined` so any handler treating it as durable fails closed.

To surface the per-request token anyway, opt in via `createApp`:

```ts
import { createApp } from '@cyanheads/mcp-ts-core';

await createApp({
  tools: [...],
  context: {
    exposeStatelessSessionId: true,
  },
});
```

Use this only when downstream code is structured around `ctx.sessionId` and accepts that the value changes per-request. For generic per-request correlation, use `ctx.requestId` (always present, no opt-in).

### Capability-token model

Surfacing `sessionId` does not change the framework's capability-as-token rule (possession of an opaque ID grants access — see CLAUDE.md `# Core Rules`). It is an opt-in *discovery-scoping* axis, not an access boundary.

- Tokens shared across sessions (e.g. `df_<uuid>` handed from Agent A to Agent B) still resolve on the receiving side. The lookup key is the token, not the session.
- Session-scoped *enumeration* (e.g. `dataframe_describe` returning only items registered by the current session) is a per-server pattern: maintain a session-keyed lookup of known names, gate list-all on it, but route direct lookups against the shared backing store.

This matches deployments like `brapi-mcp-server` under `MCP_AUTH_MODE=none`: each session gets its own `_connect` alias surface and its own `dataframe_describe` enumeration scope, while any agent holding a `df_<uuid>` token can query it directly across session boundaries.

### Recipes

**Strict — fail closed when no session is present:**

```ts
import { invalidRequest } from '@cyanheads/mcp-ts-core/errors';

if (!ctx.sessionId) {
  throw invalidRequest('Session required for this operation.');
}
await ctx.state.set(`session:${ctx.sessionId}:${baseKey}`, value);
```

**Lax — fall back to tenant-shared key:**

```ts
const sessionKey = ctx.sessionId
  ? `session:${ctx.sessionId}:${baseKey}`
  : baseKey;
await ctx.state.set(sessionKey, value);
```

**Reading the matching log correlation field.** The framework's auto-instrumented logs always carry the raw SDK session token (even in stateless mode, for tracing) under the `sessionId` field. Don't read `ctx.sessionId` and pass it to `ctx.log` — the logger already has it.

### Behavior notes

- **Not a tenant boundary.** `ctx.state` is still tenant-scoped. Building session-scoped state is the consumer's responsibility — prefix with `session:${ctx.sessionId}:` as shown above.
- **Auto-task tools.** `task: true` handlers run in a detached background context with no session attachment — `ctx.sessionId` is always `undefined` regardless of mode.
- **Worker bundle.** Workers use the same HTTP transport plumbing; session behavior matches Node HTTP.

---

## `ctx.elicit` / `ctx.sample`

Both are optional — `undefined` when the connected client doesn't support the capability. Check for presence before calling. A simple truthiness check is enough; no type guards needed.

### `ctx.elicit` — ask the user for structured input

Presents a form to the user via the MCP elicitation protocol. The user fills in a Zod-validated schema and returns an action (`accept`, `decline`, or `cancel`).

```ts
if (ctx.elicit) {
  const result = await ctx.elicit(
    'Which output format do you want?',
    z.object({
      format: z.enum(['json', 'csv', 'markdown']).describe('Output format'),
      includeHeaders: z.boolean().default(true).describe('Include column headers'),
    }),
  );

  if (result.action === 'accept') {
    // result.content is Record<string, string | number | boolean | string[]> | undefined
    await produceOutput(result.content?.format as string, result.content?.includeHeaders as boolean);
  } else {
    // 'decline' or 'cancel' — user opted out
    throw invalidRequest('User declined input');
  }
}
```

`ElicitResult` (from `@modelcontextprotocol/sdk/types.js`):

```ts
// Actual SDK type — a flat object, not a discriminated union
interface ElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  // Present when action === 'accept'; values are primitives or string arrays
  content?: Record<string, string | number | boolean | string[]>;
}
```

> **Note:** `content` is not typed against the Zod schema you pass — it is a `Record` of primitives. Validate `content` against your schema manually (e.g. `MySchema.parse(result.content)`) when `action === 'accept'`.

**Convention:** Only call `ctx.elicit` from tool handlers, not from services.

### `ctx.sample` — request an LLM completion from the client

Requests a completion from the client's LLM via the MCP sampling protocol. Useful for AI-assisted tool behavior without managing a separate LLM provider.

```ts
if (ctx.sample) {
  const result = await ctx.sample(
    [
      { role: 'user', content: { type: 'text', text: `Summarize: ${data}` } },
    ],
    { maxTokens: 500 },
  );
  return { summary: result.content.text };
}
```

`SamplingOpts`:

```ts
interface SamplingOpts {
  includeContext?: 'none' | 'thisServer' | 'allServers';
  maxTokens?: number;
  modelPreferences?: ModelPreferences;
  stopSequences?: string[];
  temperature?: number;
}
```

**Convention:** Only call `ctx.sample` from tool handlers, not from services.

---

## `ctx.signal`

Standard `AbortSignal`. Present on every context. Set when the client cancels the request or when a task tool is cancelled.

```ts
// Check before expensive operations
if (ctx.signal.aborted) return earlyResult;

// Pass through to fetch / other async APIs
const response = await fetch(url, { signal: ctx.signal });

// Loop with cancellation check
for (const item of items) {
  if (ctx.signal.aborted) break;
  await processItem(item);
}
```

In task tools (`task: true`), the framework signals `ctx.signal` when the client sends a cancellation request.

---

## `ctx.progress`

Present only when the tool definition includes `task: true`. Undefined for standard (non-task) tools and all resource handlers.

### Methods

| Method | Purpose |
|:-------|:--------|
| `ctx.progress.setTotal(n)` | Set the total number of steps (enables percentage calculation on client) |
| `ctx.progress.increment(amount?)` | Advance progress by `amount` (default: 1) |
| `ctx.progress.update(message)` | Send a descriptive status message without advancing the counter |

### Usage

```ts
const asyncCountdown = tool('async_countdown', {
  description: 'Count down from a number with progress updates.',
  task: true,
  input: z.object({
    count: z.number().int().positive().describe('Number to count down from'),
    delayMs: z.number().default(1000).describe('Delay between counts in ms'),
  }),
  output: z.object({
    finalCount: z.number().describe('Final count value'),
    message: z.string().describe('Completion message'),
  }),

  async handler(input, ctx) {
    await ctx.progress!.setTotal(input.count);

    for (let i = input.count; i > 0; i--) {
      if (ctx.signal.aborted) break;

      await ctx.progress!.update(`Counting: ${i}`);
      await new Promise(resolve => setTimeout(resolve, input.delayMs));
      await ctx.progress!.increment();
    }

    return { finalCount: 0, message: 'Countdown complete' };
  },
});
```

**Note:** Use the non-null assertion (`ctx.progress!`) when accessing inside a `task: true` handler — the type is `ContextProgress | undefined` even though it's guaranteed present at runtime. TypeScript cannot narrow based on the `task` flag.

---

## `ctx.uri`

Present only for resource handlers. The raw `URL` object for the matched resource URI.

```ts
export const myResource = resource('myscheme://{itemId}/data', {
  async handler(params, ctx) {
    ctx.log.debug('Resource accessed', { uri: ctx.uri?.toString() });
    // params.itemId is extracted from the URI pattern — prefer params over ctx.uri
    return fetchItem(params.itemId);
  },
});
```

Prefer `params` (the extracted URI template variables) over parsing `ctx.uri` manually. `ctx.uri` is available when the raw URL string is needed.

---

## `ctx.fail`

Present only when the definition declares an `errors[]` contract. Builds an `McpError` keyed by the contract's `reason` union, so the resulting code is consistent with what the tool advertises in `tools/list`.

```ts
export const fetchItems = tool('fetch_items', {
  description: 'Fetch items by ID.',
  errors: [
    { reason: 'no_match', code: JsonRpcErrorCode.NotFound, when: 'No items matched' },
    { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited, when: 'Local queue at capacity', retryable: true },
  ],
  input: z.object({ ids: z.array(z.string()).describe('Item IDs') }),
  output: z.object({ items: z.array(ItemSchema).describe('Resolved items') }),
  async handler(input, ctx) {
    if (queue.full()) throw ctx.fail('queue_full');
    const items = await fetch(input.ids);
    if (items.length === 0) throw ctx.fail('no_match', `No items match ${input.ids.length} IDs`, { ids: input.ids });
    // ctx.fail('typo')   ← TypeScript error: 'typo' isn't in the contract
    return { items };
  },
});
```

### Signature

```ts
// TypedFail<R> — R is the union of declared `reason` strings, derived from the
// definition's `errors: [...]` const tuple via the framework's `ReasonOf<E>`.
ctx.fail(
  reason: R,                         // union of declared reason strings
  message?: string,                  // defaults to the contract entry's `when` text
  data?: Record<string, unknown>,    // merged into err.data; cannot override `reason`
  options?: { cause?: unknown },     // ES2022 cause chain
): McpError
```

### Behavior

| Aspect | Detail |
|:-------|:-------|
| Code resolution | `code` comes from the matching contract entry — never from the caller. The thrown `McpError.code` always equals what's advertised in `tools/list`. |
| Default message | When `message` is omitted, the contract entry's `when` text is used. |
| `data.reason` | Auto-populated from the contract entry. Caller-supplied `data.reason` **cannot** override it — the framework spreads caller data first and writes `reason` last so observers see a stable identifier. |
| Cause chains | Pass `{ cause: e }` to preserve the original error — `pino-pretty` and observability platforms render the chain automatically. |
| Unknown reason | If the type-system guard is bypassed (JS caller, stale contract), `ctx.fail` returns an `McpError(InternalError)` with `data.reason` and `data.declaredReasons` set so the bug is loud rather than silent. |

### Without a contract

When the definition has no `errors[]` field, `ctx` is plain `Context` and `ctx.fail` is absent. Throw `McpError` directly (or via factory):

```ts
import { notFound, rateLimited } from '@cyanheads/mcp-ts-core/errors';

async handler(input, ctx) {
  if (queue.full()) throw rateLimited('Queue at capacity');
  const items = await fetch(input.ids);
  if (items.length === 0) throw notFound(`No items match ${input.ids.length} IDs`);
  return { items };
}
```

The contract is opt-in. See `skills/api-errors/SKILL.md` for the full type-driven pattern, lint rules, and baseline-codes guidance.

---

## `ctx.recoveryFor`

Always present on `Context`. Resolves the contract `recovery` for a given reason and returns the canonical wire shape `{ recovery: { hint } }`, ready to spread into `data`. The first member of a planned **family of opt-in resolution helpers** (future: `troubleshootingFor`, `userMessageFor`, …).

```ts
async handler(input, ctx) {
  // Static recovery — pulled from the contract entry, no string duplication.
  if (queue.full()) throw ctx.fail('queue_full', undefined, { ...ctx.recoveryFor('queue_full') });

  // Dynamic recovery — interpolate runtime context, override the contract default.
  if (!matched) throw ctx.fail('no_match', `No items for "${input.query}"`, {
    recovery: { hint: `Try a broader query than "${input.query}", or check spelling.` },
  });
}
```

### Signature

```ts
// Loose (always present on Context — works without a contract attached):
ctx.recoveryFor(reason: string): { recovery: { hint: string } } | {}

// Strict (HandlerContext<R> when the definition declares errors[]):
ctx.recoveryFor(reason: R): { recovery: { hint: string } }
```

### Behavior

| Aspect | Detail |
|:-------|:-------|
| No contract attached | Returns `{}` — spread is a no-op. Always safe. |
| Unknown reason | Returns `{}` (TS prevents this for typed callers; runtime is loose for JS / stale contracts). |
| Declared reason | Returns `{ recovery: { hint: <contract.recovery> } }` — spread into `data`. |
| Override | Caller can override by spreading `recoveryFor` first then writing `recovery: { hint: '...' }` after — last write wins. |
| Service usage | Services that accept `ctx: Context` can spread `ctx.recoveryFor('reason')` directly; the no-op fallback means they don't need to know which tool called them. |

### Why opt-in resolution, not auto-population

The framework never injects `data.recovery.hint` without an explicit signal at the throw site. Authors opt in by typing `ctx.recoveryFor('reason')` — the same way `ctx.fail('reason')` opts into resolving the contract `code`. The contract is the single source of truth for the recovery hint; the resolver is a typed lookup keyed by the same reason the author already typed. No magic, no hidden transformation.

The `≥5 words` lint rule on contract `recovery` (validated at lint time) makes this load-bearing — every `ctx.recoveryFor` call site benefits from the thoughtfulness the contract enforced.

---

## Quick reference

| Property | Type | Present when |
|:---------|:-----|:-------------|
| `ctx.requestId` | `string` | Always |
| `ctx.timestamp` | `string` | Always |
| `ctx.tenantId` | `string \| undefined` | Stdio (`'default'`); HTTP+`MCP_AUTH_MODE=none` (`'default'`); HTTP+`jwt`/`oauth` (JWT `tid` claim — undefined if absent) |
| `ctx.sessionId` | `string \| undefined` | HTTP `stateful` / `auto` mode; stateless HTTP only when `createApp({ context: { exposeStatelessSessionId: true } })`; never in stdio or auto-task handlers |
| `ctx.traceId` | `string \| undefined` | OTEL enabled |
| `ctx.spanId` | `string \| undefined` | OTEL enabled |
| `ctx.auth` | `AuthContext \| undefined` | Auth enabled |
| `ctx.log` | `ContextLogger` | Always |
| `ctx.state` | `ContextState` | Always (throws if `tenantId` missing) |
| `ctx.signal` | `AbortSignal` | Always |
| `ctx.elicit` | `function \| undefined` | Client supports elicitation |
| `ctx.sample` | `function \| undefined` | Client supports sampling |
| `ctx.notifyResourceListChanged` | `function \| undefined` | Transport supports resource notifications |
| `ctx.notifyResourceUpdated` | `function \| undefined` | Transport supports resource notifications |
| `ctx.progress` | `ContextProgress \| undefined` | Tool defined with `task: true` |
| `ctx.uri` | `URL \| undefined` | Resource handlers only |
| `ctx.fail` | `(reason, msg?, data?, opts?) => McpError` | Definition declares `errors[]` contract |
| `ctx.recoveryFor` | `(reason) => { recovery: { hint } } \| {}` | Always (no-op when no contract); strictly typed on `HandlerContext<R>` |

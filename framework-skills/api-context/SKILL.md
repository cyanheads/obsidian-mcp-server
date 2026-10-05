---
name: api-context
description: >
  Canonical reference for the unified `Context` object passed to every tool and resource handler in `@cyanheads/mcp-ts-core`. Covers the full interface, its `RequestContext` base, all sub-APIs (`ctx.log`, `ctx.state`, `ctx.requestInput`, `ctx.inputs`, `ctx.clientCapabilities`, `ctx.enrich`, `ctx.content`), and when to use each.
metadata:
  author: cyanheads
  version: "2.11"
  audience: external
  type: reference
---

## Overview

Every tool and resource handler receives a single `Context` (`ctx`) argument. It provides request identity, structured logging, tenant-scoped storage, multi-round-trip input collection, and cancellation — all auto-correlated to the current request.

The framework auto-instruments every handler call (OTel span, duration, payload metrics). Use `ctx.log` for domain-specific logging and `ctx.state` for storage inside handlers. Use the global `logger` and `StorageService` directly only in lifecycle/background code (`setup()`, services).

---

## `Context` interface

```ts
import type { Context } from '@cyanheads/mcp-ts-core';

interface Context extends RequestContext {
  // Identity & tracing (inherited from RequestContext — see § RequestContext)
  readonly requestId: string;       // Per request; returned on its errors as data.requestId
  readonly timestamp: string;       // ISO 8601 request start time
  readonly tenantId?: string;       // JWT 'tid' claim; 'default' for stdio and HTTP+MCP_AUTH_MODE=none
  readonly sessionId?: string;      // Mcp-Session-Id (HTTP stateful/auto); undefined elsewhere unless opted in
  readonly traceId?: string;        // Trace containing this handler execution
  readonly spanId?: string;         // The handler's own execution span
  readonly auth?: AuthContext;      // Parsed auth claims (clientId, scopes, sub)
  readonly operation?: string;      // Label for the operation this context belongs to
  readonly extra?: Readonly<Record<string, unknown>>;  // Correlation bag — the one open field

  // Structured logging — auto-includes requestId, traceId, tenantId.
  // Dual-sink: Pino on the server, plus notifications/message to the client.
  readonly log: ContextLogger;

  // Tenant-scoped key-value storage
  readonly state: ContextState;

  // Multi-round-trip input — always present, both eras (see § ctx.requestInput)
  readonly requestInput: RequestInputFn;   // (spec, options?) => never — suspends and asks the caller
  readonly inputs: ContextInputs;          // the request's responses, limited to what the client declared
  // What the client declared: the SDK-parsed `initialize` value (2025 era) or the
  // request's envelope as sent (2026-07-28); undefined when no view exists
  // (see § ctx.clientCapabilities)
  readonly clientCapabilities: ClientCapabilities | undefined;

  // List-changed / resource-updated notifications — wired in every handler ctx;
  // delivery is request-scoped (see § list-changed notifications)
  readonly notifyResourceListChanged?: () => void;
  readonly notifyResourceUpdated?: (uri: string) => void;
  readonly notifyPromptListChanged?: () => void;
  readonly notifyToolListChanged?: () => void;

  // Cancellation
  readonly signal: AbortSignal;

  // Raw URI — present only for resource handlers
  readonly uri?: URL;

  // Agent-facing success-path enrichment — accumulates notices, query echo, totals
  // onto the request; reaches structuredContent + content[]. Always present (no-op
  // when no `enrichment` block), strictly typed on HandlerContext<R, E> against the
  // declared fields. Kind-tagged helpers: enrich.notice / .total / .echo.
  readonly enrich: Enrich;

  // Non-text content blocks (image/audio bytes) for the calling model — prepended
  // to content[] after format() runs, never placed in structuredContent. Always
  // present (no-op when never called). Helpers: content.image / .audio; content(block)
  // pushes a raw ContentBlock.
  readonly content: ContentCollect;

  // Contract resolver — always present (returns {} when no contract is attached or the
  // reason is unknown), strictly typed on HandlerContext<R> against declared reasons.
  // The framework already sends a declared hint with any failure carrying the reason.
  recoveryFor(reason: string): { recovery: { hint: string } } | {};
}
```

> **`ctx.fail` is on `HandlerContext<R>`, not `Context`.** When a definition declares `errors: [...]`, the handler receives `HandlerContext<R> = Context & { fail: TypedFail<R>; recoveryFor: TypedRecoveryFor<R> }` — both the typed `fail` and the strictly-typed `recoveryFor` live on the intersection. The bare `Context.recoveryFor` is the loose, always-present resolver. See [`ctx.fail`](#ctxfail) and [`ctx.recoveryFor`](#ctxrecoveryfor) below.

### Identity fields

| Field | Always present | Source |
|:------|:--------------|:-------|
| `requestId` | Yes | A generated `XXXXX-XXXXX` token, one per call — never the client's JSON-RPC id, which the call's log records carry as `jsonRpcId` instead. Every log record of the call carries it, and the framework returns it on the call's error envelope as `data.requestId`. A 2025-era `ctx.requestInput` round trip re-enters the handler under a new token; the shared `jsonRpcId` ties the entries together |
| `timestamp` | Yes | ISO 8601, request start |
| `tenantId` | Stdio and HTTP+`MCP_AUTH_MODE=none` (as `'default'`); JWT `tid` claim in HTTP+`jwt`/`oauth` | JWT / single-tenant default |
| `sessionId` | HTTP `stateful` / `auto` mode; undefined for stdio and stateless HTTP unless opted in | `Mcp-Session-Id` header (or server-minted) — see [§ `ctx.sessionId`](#ctxsessionid) |
| `traceId` | When OTEL enabled | Trace containing this handler execution |
| `spanId` | When OTEL enabled | The active `tool_execution:*` / `resource_read:*` span |
| `auth` | When auth enabled | Parsed JWT claims |

---

## `RequestContext` — the one canonical request shape

`Context extends RequestContext`. There is a single request-shape type; the handler-facing `Context` adds handler-only surfaces (`log`, `state`, `signal`, `requestInput`, `inputs`, `clientCapabilities`, `enrich`, `content`, `uri`) on top of it and redeclares none of the identity fields. A handler's `ctx` is therefore assignable anywhere a `RequestContext` is — services, storage, the framework logger — with no slice helper and no cast.

```ts
import { requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';

// A service typed against RequestContext accepts a handler ctx directly.
async function fetchUser(id: string, ctx: RequestContext) { /* … */ }
await fetchUser('123', ctx);   // ctx is a Context — no conversion
```

### Closed by design

`RequestContext` has **no index signature**. Its fields are exactly: `auth`, `extra`, `operation`, `requestId`, `sessionId`, `spanId`, `tenantId`, `timestamp`, `traceId`. A misspelled canonical field (`tenatId`) is a compile error instead of a silently-ignored key.

Operation-specific correlation data goes in **`extra`** — the one deliberate open bag (`Readonly<Record<string, unknown>>`). The logger flattens `extra` into the emitted line, so log output looks the same as a top-level spread — except that an `extra` key named like a canonical field the context sets never replaces it.

### Adding correlation data

Three supported ways, most common first:

```ts
// 1. Per-log-call metadata — the common case. Nothing lands on the context.
ctx.log.info('Retrying upstream call', { attempt, endpoint: 'search' });

// 2. A copy of this context carrying extra fields. `withExtra` MERGES into any
//    bag the parent already had; a hand-written `{ ...ctx, extra: {…} }` replaces it.
logger.warning('Retrying upstream call', withExtra(ctx, { attempt, endpoint: 'search' }));

// 3. A derived context for a sub-operation. `additionalContext` lands on `extra`,
//    merged over whatever the parent already carried.
const childCtx = requestContextService.createRequestContext({
  parentContext: ctx,
  operation: 'processItem',
  additionalContext: { itemId: item.id },   // → childCtx.extra.itemId
});

// Reading an ad-hoc key back off a context:
const itemId = childCtx.extra?.itemId;
```

`createRequestContext(params)` takes a closed parameter object — `additionalContext`, `operation`, `parentContext`, `tenantId` — and nothing else; a key it doesn't declare is a compile error rather than an arbitrary passthrough.

Never re-open the shape to get past a type error: no index signature, no widening a parameter back to `Record<string, unknown>`, no `as` cast. A `{ ...ctx, someKey }` object literal that fails to compile is the signal to move `someKey` into `extra`, not to loosen the type.

`ErrorContext` (the `ErrorHandler` call's `context`) is `Partial<RequestContext>` and is closed the same way — put ad-hoc keys under `extra` via `withExtra`, or pass them in the `ErrorHandler` call's own `context` field.

`RequestContextLike` is a deprecated alias for `RequestContext`, kept for one minor. Replace every use with `RequestContext`, and collapse any `RequestContextLike | RequestContext` parameter union to plain `RequestContext`.

---

## `ctx.log`

Request-scoped structured logger. Every log line is automatically annotated with `requestId`, `traceId`, and `tenantId` — no manual spreading needed.

**Dual-sink.** Each call writes to Pino *and* mirrors onto the MCP wire as a `notifications/message` (the framework advertises the `logging` capability). One level check gates both sinks: `MCP_LOG_LEVEL` (or a runtime `logger.setLevel()`) is a floor for the client stream as well as the process log, compared on the RFC 5424 order, so a `notice` floor drops `info` from both. The SDK then filters by the client's own level — `logging/setLevel`, or the `io.modelcontextprotocol/logLevel` a 2026-07-28 request carries — which can only narrow the floor, never widen it. The wire payload is `{ message, ...data }` with every sensitive field masked as `[REDACTED]` at any depth: the same field list the logs are redacted with, extensible through `sanitization.setSensitiveFields`, matched as `sanitizeForLogging` matches it — case- and separator-insensitive (`API_KEY` is `apiKey`), and on any one word of a compound name, so `accessToken` (and `tokenCount`) are masked. The caller's `data` object is never modified. `ctx.log.error` adds `error: <message>`. `message` and `error` are reserved wire keys, written after `data`: a `message` in `data` never replaces the log line on the wire, and on `ctx.log.error` with an `Error` the `error` key is always that error's message. The process log line still carries the caller's own fields, except one reusing a canonical name the context already sets (`requestId`, `traceId`, `spanId`, `tenantId`, …) — there the context's value wins, so the line stays correlated to its request. Delivery is fire-and-forget — a client that never upgraded to SSE, set a higher level, or already disconnected drops the notification, and a failed send never fails the handler. Treat `ctx.log` as client-visible: it is no longer a server-only sink, so don't log anything there you wouldn't put in a tool result.

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
// Store — accepts any JSON-serializable value, no manual JSON.stringify needed
await ctx.state.set('item/123', { name: 'Widget', count: 42 });
await ctx.state.set('session/xyz', token, { ttl: 3600 }); // TTL in seconds

// Retrieve — generic type assertion or Zod-validated
const item = await ctx.state.get<Item>('item/123');       // T | null (type assertion)
const safe = await ctx.state.get('item/123', ItemSchema);  // T | null (runtime validated)

// Delete
await ctx.state.delete('item/123');

// Batch operations
const values = await ctx.state.getMany<Item>(['item/1', 'item/2']); // Map<string, T>
await ctx.state.setMany(new Map([['a', 1], ['b', 2]]));
const deleted = await ctx.state.deleteMany(['item/1', 'item/2']);    // number

// List with prefix + pagination
const page = await ctx.state.list('item/', { cursor, limit: 20 });
for (const { key, value } of page.items) { /* ... */ }
if (page.cursor) { /* more pages available */ }
```

### Behavior notes

- Throws `McpError(InvalidRequest)` if `tenantId` is missing. Won't happen in stdio (any auth mode) or HTTP+`MCP_AUTH_MODE=none` — both default to `'default'`. Can happen in HTTP+`MCP_AUTH_MODE=jwt`/`oauth` when the token lacks a `tid` claim (intentional fail-closed: distinct authenticated callers must not silently share state).
- Keys are tenant-prefixed internally; handlers never need to namespace manually.
- **Values round-trip as JSON** on every provider, `in-memory` included: reads return the JSON form, so a `Date` comes back as its ISO string, a `Map` as `{}`, and a returned object never shares identity with the one written. Validate reads with a schema that matches the stored form (`z.string()` for a date, not `z.date()`). A `bigint`, a cyclic reference, or a top-level `undefined`, function, or symbol throws `McpError(SerializationError)` before anything is written; in `setMany`, one such value rejects the whole batch.
- **Key charset:** `^[a-zA-Z0-9_.\-/]+$`, 1024 chars max, no `..`. Slashes are the namespace separator — a colon (`item:123`) throws `McpError(ValidationError)` on every call. The rule covers `list` prefixes and every key in a batch operation. `createMockContext().state` enforces it identically, so an illegal key fails in the test rather than in a deployment.
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

The in-flight SSE stream is resumable too: stateful sessions carry a bounded event store, so a client reconnecting with `Last-Event-ID` gets the frames it missed replayed before the live stream resumes. On by default — selecting the session mode is the opt-in — with `MCP_HTTP_RESUMABILITY=false` as the kill switch and retention capped by both event count and TTL (`api-config` has the knobs). The buffer is released when its session is evicted.

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

Surfacing `sessionId` does not change the framework's capability-as-token rule (possession of an opaque ID grants access — see CLAUDE.md/AGENTS.md `# Core Rules`). It is an opt-in *discovery-scoping* axis, not an access boundary.

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
await ctx.state.set(`session/${ctx.sessionId}/${baseKey}`, value);
```

**Lax — fall back to tenant-shared key:**

```ts
const sessionKey = ctx.sessionId
  ? `session/${ctx.sessionId}/${baseKey}`
  : baseKey;
await ctx.state.set(sessionKey, value);
```

**Reading the matching log correlation field.** The framework's auto-instrumented logs always carry the raw SDK session token (even in stateless mode, for tracing) under the `sessionId` field. Don't read `ctx.sessionId` and pass it to `ctx.log` — the logger already has it.

### Behavior notes

- **Not a tenant boundary.** `ctx.state` is still tenant-scoped. Building session-scoped state is the consumer's responsibility — prefix with `session/${ctx.sessionId}/` as shown above.
- **Protocol revision.** Sessions belong to the 2025-era arm, which negotiates its revision through `initialize` and carries `Mcp-Session-Id`. The [2026-07-28 revision](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) has no session at all — it is per-request, selected by the request's own `_meta` envelope — so `ctx.sessionId` is `undefined` for every request served on that leg.
- **Worker bundle.** Workers use the same HTTP transport plumbing; session behavior matches Node HTTP.

---

## `ctx.requestInput` / `ctx.inputs`

Always present, on every transport and both protocol eras. A handler that needs something the caller didn't supply **returns** `ctx.requestInput(...)` and is re-entered with the answers on `ctx.inputs` — there is no mid-handler `await` for user input.

`ctx.requestInput(spec)` never returns: it throws an `InputRequiredSignal` that the tool, resource, and prompt handler factories catch and convert into the protocol's [`input_required`](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) result. It bypasses the error classifier entirely — no span, no log, no `isError`.

One code path serves both eras. A 2026-07-28 client fulfils the embedded requests and retries the call; for a 2025-era session the SDK's legacy shim fulfils the same returns by issuing real `elicitation/create` / `sampling/createMessage` / `roots/list` round trips and re-entering the handler itself.

**A 2025-era client that declared no matching capability is refused, with an envelope.** URL-mode elicitation needs `elicitation.url`, form-mode needs `elicitation.form` (a bare `elicitation: {}` satisfies it), sampling needs `sampling` — `sampling.tools` when the request carries `tools` / `toolChoice` — and `roots/list` needs `roots`. `ctx.requestInput` runs the check on the result it builds and throws the refusal instead of the signal, so it never reaches the wire and the handler fails where it stands — the execution measurement records it as a failed call, its `Error in tool:<name>` record logs at `notice` (a property of the client's connection, not a server fault), and each family's usual error path shapes it. A tool gets `isError` with `structuredContent.error.code = -32600` (`InvalidRequest`), `data.reason: 'client_capability_missing'`, and a `data.recovery.hint` naming the capability; a resource read gets the same code, reason, and hint through the JSON-RPC error envelope. A prompt's `generate` receives no `ctx`, so it has no `ctx.requestInput` to gate. The check runs on every round, so a handler that elicits first and samples second is gated again on the second. A return carrying only `requestState` asks the client for nothing and is never gated. On the 2026-07-28 leg the SDK owns this check and a violation surfaces as its `MissingRequiredClientCapabilityError` (`-32021`) instead.

**The refusal's hint ends at reconnecting** — ``Reconnect with a client that declares the `elicitation.form` capability.`` — and offers no other way to supply the answer, because a consent gate deliberately has no input field for it: the model would fill it in. A handler whose own arguments can stand in for the answer says so per call with the optional second argument, a sentence appended to the hint after a space:

```ts
return ctx.requestInput(
  { inputRequests: { noun: inputRequired.elicit({ message: 'I need a noun.', requestedSchema: Answer }) } },
  { fallbackHint: 'Or call again with noun supplied.' },
);
```

The option shapes that refusal alone, on a tool call and a resource read alike. A connection that can serve the request never sees it, and the 2026-07-28 leg's `-32021` is untouched.

**Responses of a kind the client never declared never reach `ctx.inputs`, on either era.** The SDK lifts `inputResponses` off every client request — a first call and a 2025-era request included — so a client can arrive pre-answered with nothing having asked. The framework keeps only what the client's declared capabilities cover, at the same mode level the refusal above applies to requests: an elicit result carrying `content` is a form-mode answer and needs `elicitation.form` (a bare `elicitation: {}` counts), while one without — a URL-mode accept, a decline, a cancel — needs `elicitation` in any mode; a sampling result needs `sampling`, and `sampling.tools` when its content holds a `tool_use` or `tool_result` block; a roots result needs `roots`. An entry of no recognizable kind is dropped, and a request with no capability view — a 2025-era request under `MCP_SESSION_MODE=stateless` — carries none. A form gate facing a client without `elicitation.form` — a URL-only client included — therefore asks, and is refused, instead of acting on an answer nobody was shown. Legitimate rounds are untouched: the 2025 shim only issues requests the connection declared, and on 2026-07-28 the SDK refuses an embedded request the envelope does not cover. A client that *did* declare the capability can still pre-answer — which is what the consent record below is for.

**`MCP_SESSION_MODE` decides whether that second leg exists.** Under `stateful` / `auto` the shim has the session it needs. Under `stateless` each 2025-era request is served by a fresh instance that never saw `initialize`, so its client-capability view is empty and the round trip is refused rather than attempted — fail-closed, but the handler never gets its answer. The refusal carries the same envelope, with a message and hint that name the per-request case and point at a stateful session. Ship `stateless` on a server whose destructive tools gate on `ctx.requestInput` and those tools become unusable for v1 HTTP clients. 2026-07-28 clients are unaffected in either mode: that revision has no server→client request channel at all, which is precisely why `input_required` exists. stdio is unaffected in either mode.

**Declare the requirement rather than documenting it.** `createApp({ sessionMode: { default: 'stateful', require: 'stateful' } })` seeds the mode from code and refuses to start over HTTP when the resolved mode is `stateless`, so the incompatibility surfaces at boot instead of at the first refused confirmation. `MCP_SESSION_MODE` still wins over the default; the requirement is what an operator cannot silently override. Nothing derives this from handler code — `ctx.requestInput` is present on every transport and both eras, so whether a server needs a live session is a decision its author makes. Full precedence and error shape: `api-config` § Session mode.

### The shape of a multi-round-trip handler

Read `ctx.inputs` first, request only what is still missing, and write the call in return position so TypeScript narrows the line below it.

```ts
import { inputRequired, tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

const Format = z.object({ format: z.enum(['json', 'csv']).describe('Export format') });

export const exportReport = tool('export_report', {
  description: 'Export a report, asking for the format when the caller left it out.',
  input: z.object({
    reportId: z.string().describe('Report to export'),
    format: z.enum(['json', 'csv']).optional().describe('Export format; asked for when omitted'),
  }),
  output: z.object({ url: z.string().describe('Download URL') }),

  handler(input, ctx) {
    // A declined or cancelled prompt is a dead end, not a round to retry —
    // re-asking loops until the round budget runs out.
    const view = ctx.inputs.view('format');
    if (view.kind === 'elicit' && view.action !== 'accept') {
      throw validationError(`User ${view.action} the format prompt.`);
    }

    const format = input.format ?? ctx.inputs.accepted('format', Format)?.format;
    if (!format) {
      return ctx.requestInput(
        { inputRequests: { format: inputRequired.elicit({ message: 'Which format?', requestedSchema: Format }) } },
        { fallbackHint: 'Or call again with format supplied.' },
      );
    }
    // `format` is narrowed here.
    return { url: exportAs(input.reportId, format) };
  },
});
```

`ctx.requestInput` returns `never`, so `return ctx.requestInput(...)` type-checks against any output type. Calling it as a bare statement works at runtime — and is the only option from a service-layer helper — but TypeScript will not narrow across it.

### Consent gates — redeem a server record

A destructive handler cannot take an accepted answer on `ctx.inputs` as proof the user was asked: a client that declared `elicitation` can send `inputResponses` on a call nothing prompted for, and any `requestState` — sealed or not — can be replayed within its lifetime. What proves the round is a record the server wrote when it asked. Store what the prompt confirmed in `ctx.state` under a random id — the operation, the authenticated caller, the target, and a hash of what the target holds — send only that id as `requestState`, and **redeem the record — read it and delete it — before anything else in the handler**. An unknown, used, or expired id, or a record naming another operation, caller, target, or content, is a fresh prompt, never a proceed.

```ts
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inputRequired, tool, z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';

const Confirm = z.object({ confirm: z.boolean().describe('Whether to proceed with the deletion.') });
const Consent = z.object({
  operation: z.string().describe('Tool the record was minted for'),
  clientId: z.string().describe('Authenticated client that was asked; empty without auth'),
  subject: z.string().describe('Authenticated subject that was asked; empty without auth'),
  target: z.string().describe('Path the user confirmed'),
  contentHash: z.string().describe('Hash of what the path held when the user confirmed'),
});

export const deletePath = tool('delete_path', {
  description: 'Delete a path after the user confirms it.',
  input: z.object({ path: z.string().describe('Path to delete') }),
  output: z.object({ deleted: z.string().describe('The path that was deleted') }),
  annotations: { destructiveHint: true },

  async handler(input, ctx) {
    // 1. Redeem first: whatever this round carries, the record is spent now.
    const id = ctx.inputs.state();
    const record = id && /^[0-9a-f-]{36}$/.test(id) ? await ctx.state.get(`consent/${id}`, Consent) : null;
    if (record) await ctx.state.delete(`consent/${id}`);

    // 2. What this call would confirm: this operation, for this caller, on this target as it is now.
    const expected = {
      operation: 'delete_path',
      clientId: ctx.auth?.clientId ?? '',
      subject: ctx.auth?.sub ?? '',
      target: input.path,
      contentHash: await hashOf(input.path),
    };
    const matches = record !== null && isDeepStrictEqual(record, expected);

    // 3. Only a matching record makes the answer on ctx.inputs mean anything.
    const view = ctx.inputs.view('confirm');
    if (matches && view.kind === 'elicit' && view.action !== 'accept') {
      throw validationError(`User ${view.action} the deletion.`);
    }
    const answer = matches ? ctx.inputs.accepted('confirm', Confirm) : undefined;

    // 4. No matching record, or no answer: ask, with a fresh record.
    if (!answer) {
      const fresh = randomUUID();
      await ctx.state.set(`consent/${fresh}`, expected, { ttl: 600 });
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({ message: `Delete ${input.path}?`, requestedSchema: Confirm }),
        },
        requestState: fresh,
      });
    }
    if (!answer.confirm) throw validationError('Deletion not confirmed.');

    return { deleted: remove(input.path) };
  },
});
```

- **Bind the record to the operation and the caller.** Without `operation`, an id minted by another consent-gated tool — or by a resource read's round, whose `operation` is the `ctx.uri.href` it read — confirms this one. Without `clientId` and `subject`, another user in the same tenant redeems an id they were handed: sealing binds the state to its principal only while `MCP_REQUEST_STATE_KEY` is set, and the record binds the caller either way. `ctx.state` is tenant-scoped already. On stdio and under `MCP_AUTH_MODE=none` both fields are empty — every caller is the same principal there.
- **Redeeming is single-use against a sequential replay, not against concurrent retries.** `ctx.state` has no atomic read-and-delete, so retries carrying one id at the same moment can each read the record before any delete lands — five concurrent retries on `filesystem` acted five times. Until an atomic `take` exists ([#593](https://github.com/cyanheads/mcp-ts-core/issues/593)), make an action that must not repeat idempotent per record (pass the record id as the upstream idempotency key), or accept that risk knowingly.
- **The record's storage must be shared by every instance a retry can reach.** A 2026-07-28 retry is a new request — under stateless HTTP, behind a load balancer, or on Workers it can land on another instance, which finds nothing in a process-local `in-memory` store and asks again (safe, but the user never gets through). Use `filesystem`, `supabase`, or `cloudflare-d1` there. Never `cloudflare-kv`: it is eventually consistent, so a retry served elsewhere may not see the record yet, and a replay can outrun the delete, which widens the race above. 2025-era rounds stay inside the process that asked.
- **Carrying the target in `requestState` and comparing it on re-entry is replayable.** Signing the state proves only that this server once minted it; the same sealed string confirms the same deletion again until it expires. Single-use has to be enforced on the server.
- **`ctx.clientCapabilities` is never a reason to skip the prompt.** A gate that proceeds when `elicitation` is absent is the bypass the gate exists to prevent; let the `client_capability_missing` refusal (2025 era) or `-32021` (2026-07-28) stand.
- **Declare `sessionMode: { default: 'stateful', require: 'stateful' }`** when the server also serves 2025-era clients over HTTP — see above.

### `ctx.clientCapabilities` — asking only when the client can answer

The capabilities the client declared for this request: on a 2025-era connection the SDK's parsed `initialize` value, on 2026-07-28 the request's own `io.modelcontextprotocol/clientCapabilities` envelope as sent. `{}` when it declared none; `undefined` when no view exists — a 2025-era request served per-request under `MCP_SESSION_MODE=stateless`. `extensions` carries declared extensions such as `io.modelcontextprotocol/ui`.

The two sources differ in shape. A bare `elicitation: {}` counts as declaring `elicitation.form` either way, but the SDK normalizes it while parsing `initialize`, so on a 2025-era connection it reads back as `{ elicitation: { form: {} } }`, and on 2026-07-28 as `{ elicitation: {} }`. A check for form mode that looks only at `elicitation.form` misses the bare 2026-07-28 declaration.

Use it for **optional** context, where a client that cannot answer should fall through to another source rather than fail the call — which a 2026-07-28 request cannot do otherwise, since its `-32021` is raised after the handler has returned. Read `ctx.inputs` first, so the retry does not ask again:

```ts
handler(input, ctx) {
  const roots = ctx.inputs.view('roots');
  if (roots.kind === 'roots') return fromRoots(roots.roots);
  if (ctx.clientCapabilities?.roots) {
    return ctx.requestInput({ inputRequests: { roots: inputRequired.listRoots() } });
  }
  return fromLaunchDirectory();   // the next source — no error, nothing sent
}
```

Never use it to decide whether to ask for consent (see above).

### Building the embedded requests

`inputRequired` is re-exported from the main entry. Its per-kind constructors build the entries of `inputRequests`:

| Constructor | Wire request | Notes |
|:---|:---|:---|
| `inputRequired.elicit({ message, requestedSchema })` | `elicitation/create` (form) | `requestedSchema` accepts a Zod schema; shapes the restricted elicitation JSON Schema can't express throw a `TypeError` before anything is sent |
| `inputRequired.elicitUrl({ message, url })` | `elicitation/create` (URL) | Authorization flows, hosted forms. On 2026-07-28 URL mode rides the same multi-round-trip flow; the 2025-era `elicitationId` is not part of that shape — correlate with your own identifier inside `requestState` |
| `inputRequired.createMessage(params)` | `sampling/createMessage` | Ask the client's model |
| `inputRequired.listRoots()` | `roots/list` | Ask for the client's filesystem roots |

At least one of `inputRequests` or `requestState` must be supplied — the builder throws a `TypeError` otherwise.

### `requestState` — carrying server state across rounds

```ts
return ctx.requestInput({
  inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: Confirm }) },
  requestState: jobId,
});
// Next round:
const state = ctx.inputs.state<string>();
```

`requestState` round-trips **through the client**. Keep it an opaque handle — an id for a record in `ctx.state` — rather than the data itself.

**Set `MCP_REQUEST_STATE_KEY` to seal it.** With the key (≥ 32 bytes) configured, the framework signs the string a handler returns — on tool, resource, and prompt results alike — into the SDK codec's envelope, bound to the request's authenticated `clientId`, `subject`, and `tenantId` and valid for 900 s, and every server instance verifies an echoed state before the handler runs. A forged, tampered, expired, other-principal, or other-key state is answered as `-32602` with `data.reason: 'invalid_request_state'` and never reaches the handler. Handlers change nothing: they still return a plain string, and `ctx.inputs.state()` returns that original string. Every instance a retry can reach — stateless replicas, Worker isolates, a restarted process — needs the same key; there is no per-process random key. Unset, no verifier runs and the handler reads whatever string the client sent. The sealed state is signed, not encrypted: the client can read the payload, so never put a secret in it.

Signed is not single-use: a sealed state still verifies every time it is replayed within 900 s, and it names no operation — a state one tool sealed verifies on a call to another. Anything that must happen once — a consent gate above all — redeems a server record bound to its operation.

### `ctx.inputs` — reading the request's responses

Populated once the client (or the legacy shim) has answered a `ctx.requestInput`, limited to the answers the client's declared capabilities cover — kind and mode, as described above.

| Member | Returns |
|:---|:---|
| `accepted(key, schema?)` | The accepted form-mode content for `key`, or `undefined` when the key is missing, the user declined or cancelled, the response was another kind, or (with a schema) validation failed |
| `view(key)` | Discriminated view of one entry: `{ kind: 'missing' }` \| `{ kind: 'elicit', action, content? }` \| `{ kind: 'sampling', result }` \| `{ kind: 'roots', roots }` |
| `state<T>()` | The `requestState` this round carried — the handler's own string, verified and unsealed when `MCP_REQUEST_STATE_KEY` is set, the raw wire string otherwise — or `undefined` when the round carried none |
| `dropped` | Keys the SDK dropped because the client sent a wrapped rather than a bare response object. Re-issue those requests instead of hard-failing |
| `responses` | The raw response map, for kinds the helpers don't cover — filtered the same way |

Three rules follow from what the SDK does *not* do:

- **A response is client-supplied, even from a capable client.** It can arrive on a call nothing asked, so it proves a prompt was answered only alongside a record the handler redeemed.
- **Responses are never re-validated against the schema the request advertised.** Pass the schema to `accepted(key, schema)` wherever the content matters, and treat every value as untrusted client input.
- **`undefined` from `accepted()` collapses five different outcomes into one.** Missing, declined, cancelled, wrong response kind, and schema-invalid are indistinguishable through it. Branch on `view(key)` when decline/cancel needs different handling from "not asked yet" — as above, re-issuing a request the user already declined just burns rounds.

### Testing

`createMockContext({ inputResponses, requestState })` seeds `ctx.inputs`, so a handler can be driven straight into its second round:

```ts
const ctx = createMockContext({
  inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
});
```

`createMockContext({ clientCapabilities })` seeds `ctx.clientCapabilities` and applies the production filter to the seeded responses; omitted, `ctx.clientCapabilities` is `undefined` and nothing is filtered. Each mock context has its own `ctx.state`, so to drive a consent gate's second round, copy the record its first round stored into the second context before calling the handler. The record carries the caller, so seed the same `auth` (or none) on both:

```ts
const first = createMockContext();
const asked = await expectInputRequired(() => deletePath.handler(input, first));
const record = await first.state.get(`consent/${asked.requestState}`);

const ctx = createMockContext({ inputResponses: accept, requestState: asked.requestState });
await ctx.state.set(`consent/${asked.requestState}`, record);
await expect(deletePath.handler(input, ctx)).resolves.toEqual({ deleted: input.path });
```

**Convention:** only call `ctx.requestInput` from tool, resource, and prompt handlers — not from services.

---

## List-changed notifications (`ctx.notify*`)

Fire-and-forget signals that the tool / resource / prompt list changed (the client should re-list), or that a specific resource was updated. The framework advertises the matching `listChanged` capabilities on every `initialize`. All four are wired in every tool and resource handler context — call with optional chaining (`?.`), the type is optional for mock / forward-compat only.

```ts
async handler(input, ctx) {
  await enableFeatureTools();
  ctx.notifyToolListChanged?.();   // tells the client to re-fetch tools/list
  return { ok: true };
}
```

### Delivery

Which channel a notification takes depends on the protocol era the request is being served under, because the two eras opt a client in differently.

| Era | Client opts in via | `ctx.notify*` routes to |
|:----|:-------------------|:------------------------|
| 2026-07-28 | a `subscriptions/listen` stream, whose filter names the types (and, for resources, the URIs) it wants | the change-event bus, where the SDK's listen router applies that filter |
| 2025-era | `resources/subscribe`, for resource updates only | the request's own channel, stamped with `relatedRequestId` |

The modern routing is not an optimization — the spec is explicit that a server MUST NOT send notification types the client has not requested, and that filter only sees what reaches the bus. A modern handler sending through its own request scope would deliver to a client that opened no stream at all.

| Fired from | stdio | HTTP / Workers |
|:-----------|:------|:---------------|
| A tool / resource handler | ✅ delivered | ✅ delivered — on the listen stream (2026) or the request's SSE response stream (2025) |
| A `setup()` hook, cron job, or any non-request scope | ✅ delivered | ✅ to 2026 clients, via `core.notify` — see below. ⚠️ still dropped for 2025 clients: there is no out-of-request channel on that era |

### Emitting outside a request: `core.notify`

Under HTTP there is no long-lived server instance a background emitter can send through, so `CoreServices.notify` publishes straight to the bus:

```ts
createApp({
  tools,
  setup(core) {
    watchUpstream(() => core.notify.resourcesChanged());
  },
});
```

It is the same `ServerNotifier` the handler path publishes to, captured before serving starts; publishing while nothing is listening is a no-op, not an error. Delivery reaches 2026-07-28 clients with an open `subscriptions/listen` stream.

**Supply your own bus on a multi-isolate runtime.** The default is in-process, which covers a single container. On Cloudflare Workers a background emission would otherwise reach only the isolate that produced it:

```ts
createApp({ tools, eventBus: myDurableObjectBackedBus });
```

### `notifyResourceUpdated` is subscription-scoped

On both eras, but through different registries.

On 2025-era connections the framework advertises `resources: { subscribe: true }` and backs it with real `resources/subscribe` / `resources/unsubscribe` handlers, so `notifyResourceUpdated(uri)` emits only for URIs the connected client actually subscribed to; an unsubscribed URI logs at debug and sends nothing. Both handlers are idempotent — re-subscribing is a no-op, and unsubscribing from a URI that was never subscribed succeeds.

That registry's scope is the `McpServer` instance, which is also the connection: one persistent instance per session on the sessionful arm, one per request under per-request serving. On the per-request leg a subscription cannot outlive the request that created it, so a handler-time `ctx.notifyResourceUpdated(uri)` delivers only when that same exchange subscribed first.

On 2026-07-28 there is no `resources/subscribe` method and no registry. The URI ships with the published event, and the listen filter's `resourceSubscriptions` field decides who receives it — upstream's job, not the framework's.

---

## `ctx.signal`

Standard `AbortSignal`. Present on every context. Fires when the client cancels the request — and when the transport closes, which aborts every in-flight handler.

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
    { reason: 'no_match', code: JsonRpcErrorCode.NotFound, when: 'No items matched',
      recovery: 'Broaden the query or check the spelling and try again.' },
    { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited, when: 'Local queue at capacity', retryable: true,
      recovery: 'Wait a few seconds before retrying or reduce batch size.' },
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

The contract is opt-in. See `framework-skills/api-errors/SKILL.md` for the full type-driven pattern, lint rules, and baseline-codes guidance.

---

## `ctx.recoveryFor`

Always present on `Context`. Resolves the contract `recovery` for a given reason and returns the canonical wire shape `{ recovery: { hint } }`, ready to spread into `data`.

It is not what puts the hint on the wire. The handler factory fills `data.recovery.hint` from the matching `errors[]` entry for any failure that carries a declared reason and no hint of its own — a bare `ctx.fail('reason')` and a service throw alike — so a static hint needs no call here:

```ts
async handler(input, ctx) {
  // Static recovery — the framework fills the contract's hint onto the wire.
  if (queue.full()) throw ctx.fail('queue_full');

  // Dynamic recovery — interpolate runtime context, override the contract default.
  if (!matched) throw ctx.fail('no_match', `No items for "${input.query}"`, {
    recovery: { hint: `Try a broader query than "${input.query}", or check spelling.` },
  });
}
```

Reach for `ctx.recoveryFor` when the hint has to ride the thrown error itself — a test asserting `data.recovery` on the handler's own throw — or when a site deliberately sends another entry's guidance.

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
| Service usage | A service throwing a factory error with `data: { reason }` gets the declared hint from the framework's fill; it needs no `ctx` for it. |

### The wire hint follows the reason

The contract is the single source of truth for the recovery hint, and the framework applies it where the failure leaves the handler: in the tool and resource factories, before the failure is logged and the envelope built, matched on `data.reason` alone. A throw-site `recovery` of any shape wins. The thrown `McpError` is never changed, so a handler-level test sees exactly what the throw site wrote; `runToolContract` applies the same fill, so a contract test sees the production envelope. The `≥5 words` lint rule on contract `recovery` is what makes the default worth sending.

---

## `ctx.enrich`

Always present on `Context`. Accumulates agent-facing **success-path** context — empty-result notices, the query/filter as the server parsed it, pagination totals — onto the request. The framework merges it into `structuredContent`, folds the `enrichment` block into the tool's advertised `outputSchema`, and mirrors it into a `content[]` trailer. The success-path counterpart to `ctx.fail` / `ctx.recoveryFor`.

```ts
export const search = tool('search', {
  description: 'Search the catalog.',
  input: z.object({ query: z.string().describe('Search terms') }),
  output: z.object({ items: z.array(z.string()).describe('Matching items') }),
  enrichment: {
    effectiveQuery: z.string().describe('Query as the server parsed it'),
    totalCount: z.number().describe('Total matches before the limit'),
    notice: z.string().optional().describe('Guidance when nothing matched'),
  },
  async handler(input, ctx) {
    const res = await runSearch(input.query);
    ctx.enrich.echo(res.parsed);              // → effectiveQuery + "Query: …" trailer
    ctx.enrich.total(res.total);              // → totalCount + "N total" trailer
    if (res.items.length === 0) ctx.enrich.notice(`No matches for "${input.query}".`);
    return { items: res.items };              // enrichment never rides in the domain return
  },
});
```

### Signature

```ts
// Loose (always present on Context — works without a block; service-callable):
ctx.enrich(fields: Record<string, unknown>): void

// Strict (HandlerContext<R, E> when the definition declares an enrichment block):
ctx.enrich(fields: Partial<z.infer<ZodObject<E>>>): void

// Kind-tagged field-helpers (always present) — write a conventional key and tag
// the content[] trailer rendering:
ctx.enrich.notice(text: string): void      // writes `notice`         → blockquote
ctx.enrich.total(count: number): void       // writes `totalCount`     → "N total"
ctx.enrich.echo(query: string): void        // writes `effectiveQuery`  → "Query: …"
ctx.enrich.delta({ field, before, after }): void  // writes `{before, after}` → "field: before → after"

// Truncation disclosure — for capped lists:
ctx.enrich.truncated({ shown, cap, ceiling?, guidance? }): void
// writes: truncated=true, shown, cap, truncationCeiling? (if ceiling provided)
// also writes notice via guidance or a generated default (last-wins with other notice calls)
```

### Behavior

| Aspect | Detail |
|:-------|:-------|
| Accumulation | Each call merges its fields onto the request; later calls override earlier keys. |
| Both surfaces | Merged into `structuredContent` (validated against `output.extend(enrichment)`) and appended to `content[]` as a trailer — even when the tool defines no `format()`. |
| Domain payload untouched | `content[]` renders the handler's return via `format()` (or the JSON default); enrichment is a separate trailer, never double-rendered. The handler return must NOT carry enrichment fields. |
| Required-field guard | A required enrichment field never populated fails the effective-output parse — the bug surfaces loudly rather than dropping silently. |
| No block | Calling `ctx.enrich` on a tool that declared no `enrichment` is a silent no-op (values are stripped by the parse) — the price of service-layer callability. |
| Service usage | Services accepting `ctx: Context` can call `ctx.enrich(...)`; the value reaches `structuredContent` exactly as if the handler had. |
| `format-parity` | Enrichment lives outside `output`, so the `format-parity` lint never requires it in `format()`. |
| Trailer rendering | Per field: kind-tag if set (notice/total/echo/delta), else the definition's `enrichmentTrailer.render`/`label`, else `**key:** value` (objects/arrays `JSON.stringify`'d). A structured field with no `render` errors under `enrichment-trailer-render` — supply one so it renders as markdown; `structuredContent` keeps the full value regardless. |
| Trailer layout | One field per line. A field whose last line opens a block quote or a list item (`notice`, or a `render` ending in `>`, `-`, `*`, `1.`) gets a blank line after it, so the next field renders as its own block instead of being folded into that container by CommonMark lazy continuation. |

### `ctx.enrich.truncated()` — capped-list disclosure

For tools that cap a list (i.e. have a `limit`/`per_page`/`page_size`/`max_results`/`max_items` input), call `truncated()` when the cap was actually hit:

```ts
enrichment: {
  // Optional: truncated() writes these only when the cap is hit, and a required
  // enrichment field left unset fails the effective-output parse on every complete result.
  truncated: z.boolean().optional().describe('True when the list was capped.'),
  shown: z.number().optional().describe('Number of items returned.'),
  cap: z.number().optional().describe('The limit that was applied.'),
  truncationCeiling: z.number().optional().describe('Upper bound for omitted items (threshold bound).'),
},
async handler(input, ctx) {
  const items = await fetch(input.limit);
  if (items.length >= input.limit) {
    ctx.enrich.truncated({
      shown: items.length,
      cap: input.limit,
      ceiling: items.at(-1)?.count,      // optional — only when list sorted by cap key
      guidance: 'Narrow with filters or raise per_page (max 200).',
    });
  }
  return { items };
},
```

| Field written | Key | Notes |
|:---|:---|:---|
| `truncated` | `true` | Always |
| `shown` | `number` | Always |
| `cap` | `number` | Always |
| `truncationCeiling` | `number` | Only when `ceiling` is passed |
| `notice` | `string` | Via `guidance` or a generated default; **last-wins** — a handler with multiple notice sources (e.g. both truncation and empty-result) should compose them into one string passed as `guidance`, or call `truncated()` after the other notice calls. |

The `capped-list-no-truncation` lint rule fires when a cap-like input + array output shape is present without any of: `truncated` or `totalCount` in the declared `enrichment`, or `truncated` or `totalCount` in `output`. Using `ctx.enrich.total(n)` (writes `totalCount`) is also recognized as honest disclosure.

See `add-tool`'s **Tool Response Design** and `framework-skills/api-linter` (`enrichment-*` rules) for the full pattern. Test enrichment with `getEnrichment(ctx)` from `@cyanheads/mcp-ts-core/testing`.

---

## `ctx.content`

Always present on `Context`. Collects **non-text content blocks** — image or audio bytes the calling model should see or hear — and prepends them to the tool's `content[]` after `format()` runs. Collected blocks **never** enter `structuredContent`, so the base64 payload is carried once (in `content[]`) instead of duplicating into the typed output field. The media counterpart to `ctx.enrich`: both ride alongside the domain result without bloating it.

```ts
export const renderChart = tool('render_chart', {
  description: 'Render a chart from a series and return its summary.',
  input: z.object({ series: z.array(z.number()).describe('Data points') }),
  output: z.object({ points: z.number().describe('Number of points plotted') }),
  async handler(input, ctx) {
    const png = await draw(input.series);          // base64 PNG
    ctx.content.image(png, 'image/png');           // → content[] block, NOT structuredContent
    return { points: input.series.length };        // the typed result stays small
  },
});
```

Without `ctx.content`, the only way to surface bytes to the model is to declare them in `output` and emit an image block from `format()` — which ships the base64 twice (once in `structuredContent`, once in the block). `ctx.content` removes the duplication.

### Signature

```ts
// Callable — push a raw ContentBlock (escape hatch for embedded resources, resource links):
ctx.content(block: ContentBlock): void

// Typed helpers for the two base64 media blocks:
ctx.content.image(data: string, mimeType: string): void   // → { type: 'image', data, mimeType }
ctx.content.audio(data: string, mimeType: string): void   // → { type: 'audio', data, mimeType }
```

### Behavior

| Aspect | Detail |
|:-------|:-------|
| `content[]` only | Blocks are prepended to `content[]` and never written to `structuredContent`. Data meant for the typed result stays on the handler's return value. |
| Order | `content[]` is `[...collected blocks, ...format()/JSON output, ...enrichment trailer]` — media first, domain content next, enrichment trailer last. |
| Accumulation | Each call appends; blocks render in call order. |
| No-op | A handler that never calls `ctx.content` produces a `content[]` / `structuredContent` byte-identical to before — the feature is purely additive and opt-in. |
| Error path | If the handler throws, collected blocks are dropped — a failed call returns the error result only, never a partial image. |
| Service usage | Services accepting `ctx: Context` can call `ctx.content(...)`; the blocks reach `content[]` exactly as if the handler had. |
| No schema involvement | Blocks bypass `output` entirely, so no linter rule requires them in `format()` and they never appear in the advertised `outputSchema`. |

Test content blocks with `getContentBlocks(ctx)` from `@cyanheads/mcp-ts-core/testing`.

---

## Quick reference

| Property | Type | Present when |
|:---------|:-----|:-------------|
| `ctx.requestId` | `string` | Always |
| `ctx.timestamp` | `string` | Always |
| `ctx.tenantId` | `string \| undefined` | Stdio (`'default'`); HTTP+`MCP_AUTH_MODE=none` (`'default'`); HTTP+`jwt`/`oauth` (JWT `tid` claim — undefined if absent) |
| `ctx.sessionId` | `string \| undefined` | HTTP `stateful` / `auto` mode; stateless HTTP only when `createApp({ context: { exposeStatelessSessionId: true } })`; never in stdio or on the session-less 2026-07-28 leg |
| `ctx.traceId` | `string \| undefined` | OTEL enabled — the trace containing this handler execution |
| `ctx.spanId` | `string \| undefined` | OTEL enabled — the handler's own execution span, not the enclosing request span |
| `ctx.auth` | `AuthContext \| undefined` | Auth enabled |
| `ctx.operation` | `string \| undefined` | Set by the context that created it (`'HandleToolRequest'` for tool calls) |
| `ctx.extra` | `Readonly<Record<string, unknown>> \| undefined` | When correlation data was attached — the one open bag on the closed shape |
| `ctx.log` | `ContextLogger` | Always |
| `ctx.state` | `ContextState` | Always (throws if `tenantId` missing) |
| `ctx.signal` | `AbortSignal` | Always |
| `ctx.enrich` | `Enrich` | Always; typed on `HandlerContext<R, E>` when an `enrichment` block is declared |
| `ctx.content` | `ContentCollect` | Always — prepends image/audio blocks to `content[]`, never `structuredContent` |
| `ctx.requestInput` | `(spec, options?) => never` | Always — suspends the handler and asks the caller for more input; `options.fallbackHint` extends a 2025-era capability refusal's hint |
| `ctx.inputs` | `ContextInputs` | Always; carries only the answers the client's declared capabilities cover (kind and mode), none when no capability view exists |
| `ctx.clientCapabilities` | `ClientCapabilities \| undefined` | Always as a key; `{}` when the client declared none, `undefined` when no view exists (2025-era stateless HTTP) |
| `ctx.notifyResourceListChanged` | `function \| undefined` | Always in handler ctx; delivery request-scoped (see [§ list-changed notifications](#list-changed-notifications-ctxnotify)) |
| `ctx.notifyResourceUpdated` | `function \| undefined` | Always in handler ctx; limited to URIs the client subscribed to, through the listen filter (2026) or the subscribe registry (2025) |
| `ctx.notifyPromptListChanged` | `function \| undefined` | Always in handler ctx; delivery request-scoped |
| `ctx.notifyToolListChanged` | `function \| undefined` | Always in handler ctx; delivered on the client's listen stream (2026) or its own request scope (2025) |
| `ctx.uri` | `URL \| undefined` | Resource handlers only |
| `ctx.fail` | `(reason, msg?, data?, opts?) => McpError` | Definition declares `errors[]` contract |
| `ctx.recoveryFor` | `(reason) => { recovery: { hint } } \| {}` | Always (no-op when no contract); strictly typed on `HandlerContext<R>` |

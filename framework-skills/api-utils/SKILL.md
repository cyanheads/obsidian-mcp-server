---
name: api-utils
description: >
  API reference for all utilities exported from `@cyanheads/mcp-ts-core/utils`. Use when looking up utility method signatures, options, peer dependencies, or usage patterns.
metadata:
  author: cyanheads
  version: "2.11"
  audience: external
  type: reference
---

## Overview

Utility exports from `@cyanheads/mcp-ts-core/utils`. Utilities with complex APIs have dedicated reference files; simpler utilities are documented inline below.

**Tier 3** = optional peer dependency. Install as needed (e.g., `bun add js-yaml`). All Tier 3 methods are **async** (lazy-load deps on first call).

**Context parameters.** Every helper below that takes a `context` accepts the handler `Context` as well as a `RequestContext` bag — pass `ctx` straight through, no slicing.

## References

| Reference | Path | Covers |
|:----------|:-----|:-------|
| Formatting | `references/formatting.md` | `markdown()`, `MarkdownBuilder`, `diffFormatter`, `tableFormatter`, `treeFormatter` — builder patterns, option types, style variants, usage examples |
| Parsing | `references/parsing.md` | `yamlParser`, `xmlParser`, `csvParser`, `jsonParser`, `pdfParser`, `dateParser`, `frontmatterParser` — method signatures, option types, peer deps, `Allow` flags, PDF workflows |
| Security | `references/security.md` | `sanitization`, `RateLimiter`, `IdGenerator` — config types, method details, sensitive fields, usage examples |

---

## `@cyanheads/mcp-ts-core/utils` — network

| Export | API | Notes |
|:-------|:----|:------|
| `fetchWithTimeout` | `(url, timeoutMs, context, options?: FetchWithTimeoutOptions) -> Promise<Response>` | Wraps `fetch` with `AbortController` timeout. `timeoutMs` bounds the **whole exchange**: on a 2xx carrying a body the returned `Response` is a passthrough wrapper that keeps the deadline armed until the body closes, errors, or is cancelled, so a stalled stream rejects the caller's `.text()`/`.json()` with the same `Timeout` error the header phase raises. `status`, `statusText`, `headers`, `url`, `redirected`, and `type` carry across the wrapper; the original body is locked by it, and bodyless/null-body responses (HEAD, 204/205/304) come back untouched. `FetchWithTimeoutOptions` extends `RequestInit` (minus `signal`) and adds `rejectPrivateIPs?: boolean`, `expectedStatuses?: number[]` (listed non-2xx statuses logged at `debug` not `error`, still thrown), `errorBodyLimit?: number` (bytes of a non-2xx body kept, default `500`), `errorHeaders?: string[]` (response headers copied onto `error.data.headers` on a non-2xx — same selector as `httpErrorFromResponse` below; `location` is selectable under `redirect: 'manual'` but does **not** compose with `rejectPrivateIPs`, whose per-hop branch consumes the 3xx before the throw path sees it), and `signal?: AbortSignal` (external cancellation — an abort on it throws `RequestCancelled` (-32011), logged at `info` and outside `withRetry`'s transient set, since the caller is gone and no retry can reach them). On a non-2xx, `error.data` carries `status`/`body` plus the legacy `statusCode`/`responseBody` aliases (identical values; consolidating in a future major); a body over `errorBodyLimit` is captured from both ends — 40% head, 60% tail, joined by `…[N bytes elided]…` — so a diagnostic behind a boilerplate preamble survives the cap, while a body still streaming at the 16 KiB scan ceiling stays head-only with a trailing `…`. SSRF guard (best-effort, not hard isolation): blocks RFC 1918, loopback, link-local, CGNAT, cloud metadata. DNS validation on Node, Bun, and Cloudflare Workers under `nodejs_compat`; hostname-only fallback otherwise. **Both resolvers are queried** — `resolve4`/`resolve6` (c-ares) and `lookup` (the system resolver, which is what reads `/etc/hosts`, split DNS, and NSS modules) — and a non-global answer from either rejects. Runtimes differ in which resolver the connection uses (Bun 1.4 moved `net.connect()` on Linux to `getaddrinfo` while leaving `dns.resolve*()` on c-ares), so checking one alone leaves a name the other can see unguarded; each probe settles independently, so a resolver absent from the runtime is skipped rather than fatal. Manual redirect following (max 5) with per-hop SSRF check. **DNS rebinding / TOCTOU gap** — the validation lookup and `fetch`'s own resolution are independent; pair with egress controls or a DNS-pinning fetch proxy for strong isolation. **Error/log redaction:** URLs written into thrown errors and log lines are reduced to `origin + pathname` — the query string (where API keys commonly ride: `?api-key=…`, `?api_key=…`) never reaches the client or the logs. The actual request still uses the full URL. |
| `withRetry` | `<T>(fn: (attempt: RetryAttempt) => Promise<T>, options?: RetryOptions) -> Promise<T>` | Executes `fn` with exponential backoff. Retries on transient errors (`ServiceUnavailable`, `Timeout`, `RateLimited`); non-transient errors fail immediately. Honors an upstream `Retry-After` on `data.retryAfter` (delta-seconds or HTTP-date) over exponential backoff, capped at `maxDelayMs`; a requested wait beyond the cap fails fast rather than sleeping. On exhaustion, enriches the final error with attempt count in message and `data.retryAttempts`. **Place the retry boundary around the full pipeline** (fetch + parse), not just the network call. `RetryOptions`: `maxRetries` (default `3`), `baseDelayMs` (default `1000`), `maxDelayMs` (default `30000`), `jitter` (default `0.25`), `operation` (log label), `context` (RequestContext), `signal` (AbortSignal), `isTransient` (custom predicate), `deadlineMs` (total wall-clock budget — see below). |
| `RetryAttempt` | `{ readonly signal: AbortSignal; readonly remainingMs: number }` | What `fn` receives each attempt. `signal` is `AbortSignal.any` over the `deadlineMs` clock and `options.signal`; `remainingMs` is what is left of the total budget as the attempt starts, never negative and `Number.POSITIVE_INFINITY` when no deadline is set — so `Math.min(perAttemptMs, remainingMs)` is correct either way. A zero-argument `fn` stays assignable, so existing callers compile unchanged. |
| `deadlineMs` | `RetryOptions` field | One wall-clock budget across every attempt, backoff, and honored `Retry-After` — the bound `maxRetries` plus a per-attempt timeout cannot express. Four 30s attempts outlast a client's 60s request timeout, so the caller gets a transport timeout instead of the server's classified error. **Thread `attempt.signal` into the attempt's I/O** (`fetchWithTimeout(url, Math.min(30_000, remainingMs), ctx, { signal })`) or the deadline overshoots by one in-flight request. Clock is `AbortController` + `setTimeout` (never `AbortSignal.timeout()`, per the Bun realm mismatch), cleared on return — no timer outlives the call. Expiry rejects with `Timeout` (-32004) carrying `data: { reason: 'retry_deadline_exceeded', deadlineMs, elapsedMs, retryAttempts }` and the last attempt's error as `cause`; **one shape for every expiry**, including the `RequestCancelled` that an external-signal abort raises inside `fetchWithTimeout` and the raw abort reason a mid-backoff expiry would otherwise surface. No `retryable` flag (a narrower call can still succeed) and no `attempt` index (`retryAttempts` carries it). A backoff that would outlast the remaining budget fails fast with the expiry instead of sleeping into a certain timeout; an honored `Retry-After` that would outlast it takes the `maxDelayMs` exit instead — the attempt's error unchanged, `data.retryAfter` intact, since "wait the window the upstream named" is still the caller's action. **Three clocks stay distinct:** a caller abort on `options.signal` keeps precedence and rethrows unchanged (stamped `RequestCancelled` by the handler factory), a single attempt's timeout is `Timeout` with `errorSource: 'FetchTimeout'` and no `reason`, and the expiry is `Timeout` with the `reason`. Unset, behavior is identical to before — attempt counts, delays, log lines, and the exhausted-error shape untouched. Bounds **one** ladder: a tool making three upstream calls threads its own remaining budget into each. |
| `defaultIsTransient` | `(error: unknown) -> boolean` | The predicate `withRetry` uses when `isTransient` is omitted: an `McpError` with a transient code (`ServiceUnavailable`, `Timeout`, `RateLimited`) unless it carries `data.retryable === false` or `data.reason === 'pacer_shed'`; any non-`McpError` throw is assumed transient. Exported so `isTransient` — which **replaces** the default outright — can compose instead of mirroring the transient set, which drifts silently when the framework's classification changes: `isTransient: (error) => !isMyBudgetRefusal(error) && defaultIsTransient(error)`, or the inverse `defaultIsTransient(error) \|\| isMyRetryableShape(error)`. The transient code set itself stays private (a module-level `Set` an exported binding could be mutated into framework-wide retry behavior). |
| `httpErrorFromResponse` | `(response: Response, options?: HttpErrorFromResponseOptions) -> Promise<McpError>` | Maps an HTTP `Response` to a properly classified `McpError` — full status table including 401/403/408/422/429/5xx, body capture (truncated), `retry-after` header, optional `cause`. `error.data` carries `status`/`body` plus the legacy `statusCode`/`responseBody` aliases (identical values), so a consumer can classify either helper's error without knowing which raised it. Use this instead of hand-rolling `if (status === 429) ...` ladders. Reads the response body — `clone()` first if you need it elsewhere. **`error.data` is client-facing** — the framework forwards it verbatim as `structuredContent.error.data` — so the full upstream URL is **omitted by default**: a request URL routinely carries user input, internal identifiers, or an API key in its query string. `includeUrl: true` opts into `data.url` carrying the full `response.url`; with an empty `response.url` no key is added either way, and the message still names the host. Response headers are opt-in on the same footing: `errorHeaders: ['x-ratelimit-remaining-usd', 'x-request-id']` copies the named headers onto `data.headers` under **lowercase** keys — selection is case-insensitive and entries differing only in case collapse to one key, presence follows `Headers.has()` (an empty value is captured as `''`, an absent header adds no key), and a multi-valued field is captured comma-joined as `Headers.get()` returns it. Omitted, empty, or matching nothing, no `headers` key is emitted. `set-cookie` is **never** captured whatever the selector says: it is credential-bearing and `Headers.get()` joins its values into a string that is not a valid reconstruction. Every selected value reaches the client, so never name a header that carries a credential — and a selected `Location` can itself carry a sensitive path, query, or token. `HttpErrorFromResponseOptions`: `service?` (logical name in message, e.g. `'NCBI'`), `captureBody?` (default `true`), `bodyLimit?` (default `500`), `includeUrl?` (default `false`), `errorHeaders?` (default none), `data?` (extra fields merged into `error.data`, overriding defaults on key collision — a caller's own `url` or `headers` still reaches the wire), `cause?`, `codeOverride?` (per-status mapping override). Pairs naturally with `withRetry` — both classify codes the same way. A 501 also carries `data.retryable: false`, so retry fails it fast instead of re-asking for a method the upstream does not implement. |
| `createPacer` | `(options: PacerOptions) -> Pacer` | FIFO queue in front of one rate-limited upstream — the outbound counterpart to `RateLimiter` (`utils/security`), which is inbound, per-caller, and reject-only, so it cannot queue work against an upstream budget. `pacer.run(task, { signal?, maxWaitMs? })` holds `task` until every `limits` window, `minStartGapMs`, `maxConcurrent`, and the cooldown gate allow it, then calls it with the caller's signal. `PacerOptions`: `name` (author-set telemetry label), `limits` (`{ requests, perMs }[]` — each a sliding window over recorded **start** times, so a slow response never widens the rate the upstream sees; all must allow a start), `minStartGapMs` (**not** expressible through `limits`: `{ requests: 10, perMs: 1000 }` permits ten starts in the same millisecond), `maxConcurrent`, `maxQueueDepth` (absolute backpressure for callers passing no `maxWaitMs`; rejects without arming a timer), `cooldown` (`{ baseMs, maxMs }`). **Shed:** `maxWaitMs` bounds queue time only, never the task. The projected wait is exact over the windows and the gap but a lower bound once `maxConcurrent` binds (a slot frees on an unknowable completion), so enqueue rejects only when that lower bound already exceeds `maxWaitMs` — no false sheds — and a still-queued entry rejects when `maxWaitMs` elapses. The shed error is `rateLimited` (-32003) with `data: { reason: 'pacer_shed', retryAfter, queueDepth }` and **no `retryable: false`** — to the calling agent a shed is an ordinary rate limit (wait `retryAfter`, call again) and that flag would say the opposite; `defaultIsTransient` reads the `reason` instead, so an enclosing `withRetry` fails fast rather than sleeping past the deadline the shed enforces. **Cooldown gate:** a `RateLimited` thrown by the task closes the gate for every queued caller until an absolute instant, `min(max(baseMs · 2^(consecutive−1), retryAfter), maxMs)` — `maxMs` caps both the doubling and an honored `Retry-After`, so a pathological upstream value cannot park the queue. Absent or unparseable `retryAfter` leaves the doubling; any other error leaves the gate open; the first success resets the count. **Composition:** `withRetry(({ signal }) => pacer.run(fn, { signal }), { signal, deadlineMs })` — retry outside, pacer inside, so each attempt re-queues and is re-paced. Because the gate is an absolute instant rather than a duration counted from dequeue, retry's `Retry-After` sleep and the gate overlap in wall-clock instead of summing: the window is waited once, not twice. **Lifecycle:** timers and `AbortSignal` only, process-local; the dispatch timer is `unref()`'d where supported; `dispose()` / `[Symbol.dispose]()` clears it and rejects queued waiters with `RequestCancelled` (in-flight tasks are left to finish) — wire it through `createApp({ teardown })`. On Workers state is per-isolate so the limits bind per isolate, OTel is off so the metrics are inert, and `createWorkerHandler` accepts no `teardown`. Metrics: `mcp.pacer.queue_depth`, `mcp.pacer.wait`, `mcp.pacer.sheds`, `mcp.pacer.cooldowns`, attributed by `mcp.pacer.name` only — see `api-telemetry`. |
| `httpStatusToErrorCode` | `(status: number) -> JsonRpcErrorCode \| undefined` | Sync status → code lookup. Returns `undefined` for 1xx/2xx. A 3xx maps to `InvalidRequest` — it reaches error mapping under `redirect: 'manual'`, where the request as sent cannot be served at this URL, and that code is outside `withRetry`'s transient set since re-issuing returns the same redirect. Use when you need just the code without a `Response` object handy. No status maps to `InternalError` — that code means *this* server failed, which a remote status cannot establish; every 5xx is `ServiceUnavailable` (or `Timeout` for 504) and so picks up `withRetry`'s default transient policy. |

---

## `@cyanheads/mcp-ts-core/utils` — pagination

| Export | API | Notes |
|:-------|:----|:------|
| `extractCursor` | `(params?) -> string \| undefined` | Extracts opaque cursor string from MCP request params. Checks `params.cursor` then `params._meta.cursor`. Returns `undefined` when no cursor is present. Does not decode. |
| `paginateArray` | `<T>(items, cursorStr, defaultPageSize, maxPageSize, context: RequestContext) -> PaginatedResult<T>` | Decodes cursor, slices array, returns `{ items, nextCursor?, totalCount }`. `nextCursor` omitted on last page. Throws `McpError(InvalidParams)` on invalid cursor. |
| `encodeCursor` | `(state: PaginationState) -> string` | Encodes `{ offset, limit, ...extra }` to opaque base64url string. |
| `decodeCursor` | `(cursor, context: RequestContext) -> PaginationState` | Decodes opaque base64url cursor. Throws `McpError(InvalidParams)` if malformed. |

---

## `@cyanheads/mcp-ts-core/utils` — runtime

| Export | API | Notes |
|:-------|:----|:------|
| `runtimeCaps` | `RuntimeCapabilities` object | Snapshot at import time. Fields: `isNode`, `isBun`, `isWorkerLike`, `isBrowserLike`, `hasProcess`, `hasBuffer`, `hasTextEncoder`, `hasPerformanceNow`. All booleans. Never throws. |

---

## `@cyanheads/mcp-ts-core/utils` — scheduling

| Export | API | Notes |
|:-------|:----|:------|
| `schedulerService` | `.schedule(id, schedule, taskFunction, description) -> Promise<Job>` `.start(id) -> void` `.stop(id) -> void` `.remove(id) -> void` `.listJobs() -> Job[]` | **Async** `schedule()` — Tier 3 peer: `node-cron`. **Node-only** (throws `ConfigurationError` in Workers). Jobs start in stopped state; call `start(id)` to activate. Skips overlapping executions. Each tick gets fresh `RequestContext`. `Job: { id, schedule, description, isRunning, task }`. `taskFunction: (context: RequestContext) => void` \| `Promise<void>`. |

---

## `@cyanheads/mcp-ts-core/utils` — types

The `utils` export includes two type guards. The full set of guards lives in the internal module and is not part of the public API.

| Export | Signature | Notes |
|:-------|:----------|:------|
| `isErrorWithCode` | `(error: unknown) -> error is Error & { code: unknown }` | Type guard — `true` when value is an `Error` instance with a `code` property |
| `isRecord` | `(value: unknown) -> value is Record<string, unknown>` | Type guard for plain objects (non-null, non-array) |

---

## `@cyanheads/mcp-ts-core/utils` — logger

| Export | API | Notes |
|:-------|:----|:------|
| `Logger` | Class | The `Logger` class itself. Use `Logger.getInstance()` if needed; most consumers use the `logger` singleton. |
| `logger` | `Logger` instance (wraps Pino). `.debug(msg, ctx?)` `.info(msg, ctx?)` `.notice(msg, ctx?)` `.warning(msg, ctx?)` `.error(msg, errorOrCtx, ctx?)` `.crit(msg, errorOrCtx, ctx?)` `.alert(msg, errorOrCtx, ctx?)` `.emerg(msg, errorOrCtx, ctx?)` `.fatal(msg, errorOrCtx, ctx?)` | Global structured logger. Use `ctx.log` in handlers instead. `logger` is for lifecycle/background contexts (startup, shutdown, `setup()`). Auto-redacts sensitive fields. Records logged before the framework initializes the logger — anything in `setup()` — are held in a 250-record buffer and replayed once the sinks exist, filtered against the level the logger starts with. **Note:** `.error()` and higher accept `(msg, Error, ctx?)` or `(msg, ctx?)` — the second arg is overloaded. `.fatal()` is an alias for `.emerg()`. Full RFC 5424 severity set. |
| `McpLogLevel` | Type | Log level union type for typing level variables. |

---

## `@cyanheads/mcp-ts-core/utils` — requestContext

| Export | API | Notes |
|:-------|:----|:------|
| `requestContextService` | `.createRequestContext(params?) -> RequestContext` `.withAuthInfo(authInfo, parentContext?) -> RequestContext` | Creates tracing context with `requestId`, `timestamp`, `traceId`, `spanId`, `tenantId`, `auth`. Internal — most consumers use `ctx` from handlers. |
| `RequestContext` | Type: `{ requestId, timestamp, operation?, traceId?, spanId?, tenantId?, auth?, [key: string]: unknown }` | Request tracing metadata. |
| `CreateRequestContextParams` | Type: `{ parentContext?, additionalContext?, operation?, [key: string]: unknown }` | Params accepted by `createRequestContext`. Named fields get special merge handling; other properties spread directly onto the context. |
| `AuthContext` | Type: `{ clientId, scopes, sub, token, tenantId?, [key: string]: unknown }` | Structured auth data attached to `RequestContext.auth` after token verification. |

`createRequestContext` merge order (later wins, except `requestId`/`timestamp`): `parentContext` → spread rest params → `additionalContext` (strips `requestId`/`timestamp`) → pinned `requestId`/`timestamp` → resolved `tenantId` → `operation` → OTel `traceId`/`spanId`.

`withAuthInfo(authInfo, parentContext?)` builds a context and populates `auth` from a validated token. Does **not** write to `AsyncLocalStorage` — ALS propagation is the auth middleware's responsibility.

---

## `@cyanheads/mcp-ts-core/utils` — errorHandler

| Export | API | Notes |
|:-------|:----|:------|
| `ErrorHandler` | `.tryCatch<T>(fn, opts) -> Promise<T>` `.handleError(error, opts) -> Error` `.classifyOnly(error) -> { code, message, data? }` `.determineErrorCode(error) -> JsonRpcErrorCode` `.mapError(error, mappings, defaultFactory?) -> T \| Error` `.formatError(error) -> Record<string, unknown>` | Service-level error handling. `tryCatch` wraps async or sync `fn`, logs via `handleError`, and always rethrows. No `.tryCatchSync()`. Use in services, NOT in tool handlers (those throw raw `McpError`). `tryCatch` accepts `Omit<ErrorHandlerOptions, 'rethrow'>` — required: `operation`. Optional: `context`, `errorCode`, `input`, `includeStack`, `critical`, `errorMapper`. `handleError` accepts the full `ErrorHandlerOptions` including `rethrow`. |

---

## `@cyanheads/mcp-ts-core/utils` — encoding

Cross-platform encoding utilities. No peer deps.

| Export | Signature | Notes |
|:-------|:----------|:------|
| `arrayBufferToBase64` | `(buffer: ArrayBuffer) -> string` | Encodes an `ArrayBuffer` to base64. Uses `Buffer` on Node/Bun; chunked `btoa` on Workers/browsers to avoid stack overflow on large buffers. |
| `stringToBase64` | `(str: string) -> string` | UTF-8 string → base64. Uses `Buffer.from(str, 'utf-8')` on Node/Bun; `TextEncoder` + `arrayBufferToBase64` on Workers. |
| `base64ToString` | `(base64: string) -> string` | base64 → UTF-8 string. Uses `Buffer` on Node/Bun; `atob` + `TextDecoder` on Workers. Throws if input is not valid base64. |

---

## `@cyanheads/mcp-ts-core/utils` — token counting

Dependency-free heuristic token estimation. No native/WASM deps.

| Export | Signature | Notes |
|:-------|:----------|:------|
| `countTokens` | `async (text: string, context?: RequestContext, model?: string) -> Promise<number>` | Estimates tokens in a plain string. Normalizes whitespace, divides by `charsPerToken`. Returns `0` for empty/whitespace input. Falls back to `gpt-4o` heuristics when `model` is omitted or unrecognized. |
| `countChatTokens` | `async (messages: ReadonlyArray<ChatMessage>, context?: RequestContext, model?: string) -> Promise<number>` | Estimates total tokens for a chat message array. Adds per-message overhead (`tokensPerMessage`), counts string/array content, `name`, assistant `tool_calls`, and tool `tool_call_id`. Adds `replyPrimer` once. |
| `ChatMessage` | Type | `{ role: string, content: string \| Array<{type, text?, ...}> \| null, name?, tool_calls?, tool_call_id? }` — provider-agnostic chat message shape. |
| `ModelHeuristics` | Interface | `{ charsPerToken, replyPrimer, tokensPerMessage, tokensPerName }` — heuristic parameters; built-in entries for `gpt-4o`, `gpt-4o-mini`, `default`. |

Both functions throw `McpError(InternalError)` only on unexpected heuristic failure.

---

## `@cyanheads/mcp-ts-core/utils` — Telemetry

Helper API only. For the catalog of what the framework auto-emits (span names, metric names, attributes, completion log fields, env config, runtime support, cardinality rules), see the `api-telemetry` skill.

### `telemetry/instrumentation`

| Export | Signature | Notes |
|:-------|:----------|:------|
| `initializeOpenTelemetry` | `() -> Promise<void>` | Idempotent. Initializes `NodeSDK` with OTLP trace + metrics exporters, `TraceIdRatioBasedSampler`, HTTP instrumentation, and Pino log injection. No-ops when `OTEL_ENABLED=false` or in Worker/Edge runtimes where `NodeSDK` is unavailable. Safe to call multiple times. |
| `shutdownOpenTelemetry` | `(timeoutMs?: number) -> Promise<void>` | Gracefully flushes and shuts down the SDK. `timeoutMs` defaults to `5000`. Resets internal state so the next `initializeOpenTelemetry()` call can reinitialize. No-op when SDK was never started. |
| `sdk` | `NodeSDK \| null` | The live SDK instance, or `null` when telemetry is disabled, in a Worker runtime, or after shutdown. |

### `telemetry/metrics`

| Export | Signature | Notes |
|:-------|:----------|:------|
| `getMeter` | `(name?: string) -> Meter` | Returns an OTel `Meter`. Defaults to service name + version from config. |
| `createCounter` | `(name: string, description: string, unit?: string) -> Counter` | Monotonically increasing counter. `unit` defaults to `'1'`. |
| `createUpDownCounter` | `(name: string, description: string, unit?: string) -> UpDownCounter` | Bidirectional counter (active connections, queue depth, etc.). `unit` defaults to `'1'`. |
| `createHistogram` | `(name: string, description: string, unit?: string) -> Histogram` | Distribution recording (latency, sizes). `unit` optional. |
| `createObservableGauge` | `(name: string, description: string, callback: () => Promise<number> \| number, unit?: string) -> ObservableGauge` | Polled gauge. `callback` is registered via `addCallback`; invoked on each SDK collection cycle. `unit` optional. For other observable instrument types, use `getMeter()` directly. |

### `telemetry/trace`

| Export | Signature | Notes |
|:-------|:----------|:------|
| `withSpan` | `async <T>(operationName: string, fn: (span: Span) => Promise<T>, attributes?: Record<string, string \| number \| boolean>) -> Promise<T>` | Creates an active span, calls `fn(span)`, sets `OK` on success or records exception + sets `ERROR` on throw, then ends the span. Always rethrows. |
| `runInContext` | `(ctx: RequestContext \| undefined, fn: () => T) -> T` | Runs `fn` with the span `ctx` names (`traceId`/`spanId`) re-established as the active OTel span, so spans opened inside `fn` parent to it. When `ctx` has no `traceId`/`spanId`, calls `fn` directly. Use for carrying a request's trace across async boundaries (`setTimeout`, `queueMicrotask`). |
| `buildTraceparent` | `(ctx?: RequestContext) -> string \| undefined` | Builds a W3C `traceparent` header (`00-<traceId>-<spanId>-01`) from `ctx` or the active span. Returns `undefined` when neither source yields both IDs. |
| `extractTraceparent` | `(headers: Headers \| Record<string, string \| undefined>) -> TraceparentInfo \| undefined` | Parses a W3C `traceparent` header. Returns `undefined` when absent or malformed. `TraceparentInfo: { traceId, spanId, sampled }`. |
| `createContextWithParentTrace` | `(parentHeaders: Headers \| Record<string, string \| undefined>, operation: string) -> RequestContext` | Extracts `traceparent` from headers and creates a child `RequestContext` inheriting `traceId`/`parentSpanId`. |
| `injectCurrentContextInto` | `<T extends Record<string, unknown>>(carrier: T) -> T` | Injects the active OTel context (traceparent, tracestate, etc.) into `carrier` via `propagation.inject`. Returns the same object. |

### `telemetry/attributes`

MCP-specific `ATTR_*` constant exports for span and metric attributes. Covers: code execution (`code.function.name`, `code.namespace`), MCP tool execution (name, input/output bytes, duration, success, error code, error category, partial success, batch succeeded/failed counts), MCP resource (URI, name, MIME type, size, duration, success, error code), MCP request context (tenant ID, client ID), MCP session events, MCP storage, GenAI semantic conventions, speech, graph, auth, task, and error classification attributes.

Batch/partial success attributes (`mcp.tool.partial_success`, `mcp.tool.batch.succeeded_count`, `mcp.tool.batch.failed_count`) are set automatically by the framework when a tool handler returns a result containing a non-empty `failed` array — matching the batch response pattern from the design skill.

Standard OTel semantic conventions (HTTP, cloud, service, network, etc.) are NOT re-exported — import those directly from `@opentelemetry/semantic-conventions` if needed.

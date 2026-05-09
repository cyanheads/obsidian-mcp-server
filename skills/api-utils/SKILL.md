---
name: api-utils
description: >
  API reference for all utilities exported from `@cyanheads/mcp-ts-core/utils`. Use when looking up utility method signatures, options, peer dependencies, or usage patterns.
metadata:
  author: cyanheads
  version: "2.2"
  audience: external
  type: reference
---

## Overview

Utility exports from `@cyanheads/mcp-ts-core/utils`. Utilities with complex APIs have dedicated reference files; simpler utilities are documented inline below.

**Tier 3** = optional peer dependency. Install as needed (e.g., `bun add js-yaml`). All Tier 3 methods are **async** (lazy-load deps on first call).

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
| `fetchWithTimeout` | `(url, timeoutMs, context: RequestContext, options?: FetchWithTimeoutOptions) -> Promise<Response>` | Wraps `fetch` with `AbortController` timeout. `FetchWithTimeoutOptions` extends `RequestInit` (minus `signal`) and adds `rejectPrivateIPs?: boolean` and `signal?: AbortSignal` (external cancellation). SSRF guard (best-effort, not hard isolation): blocks RFC 1918, loopback, link-local, CGNAT, cloud metadata. DNS validation on Node; hostname-only on Workers. Manual redirect following (max 5) with per-hop SSRF check. **DNS rebinding / TOCTOU gap** — the validation lookup and `fetch`'s own resolution are independent; pair with egress controls or a DNS-pinning fetch proxy for strong isolation. |
| `withRetry` | `<T>(fn: () => Promise<T>, options?: RetryOptions) -> Promise<T>` | Executes `fn` with exponential backoff. Retries on transient errors (`ServiceUnavailable`, `Timeout`, `RateLimited`); non-transient errors fail immediately. On exhaustion, enriches the final error with attempt count in message and `data.retryAttempts`. **Place the retry boundary around the full pipeline** (fetch + parse), not just the network call. `RetryOptions`: `maxRetries` (default `3`), `baseDelayMs` (default `1000`), `maxDelayMs` (default `30000`), `jitter` (default `0.25`), `operation` (log label), `context` (RequestContext), `signal` (AbortSignal), `isTransient` (custom predicate). |
| `httpErrorFromResponse` | `(response: Response, options?: HttpErrorFromResponseOptions) -> Promise<McpError>` | Maps an HTTP `Response` to a properly classified `McpError` — full status table including 401/403/408/422/429/5xx, body capture (truncated), `retry-after` header, optional `cause`. Use this instead of hand-rolling `if (status === 429) ...` ladders. Reads the response body — `clone()` first if you need it elsewhere. `HttpErrorFromResponseOptions`: `service?` (logical name in message, e.g. `'NCBI'`), `captureBody?` (default `true`), `bodyLimit?` (default `500`), `data?` (extra fields merged into `error.data`), `cause?`, `codeOverride?` (per-status mapping override). Pairs naturally with `withRetry` — both classify codes the same way. |
| `httpStatusToErrorCode` | `(status: number) -> JsonRpcErrorCode \| undefined` | Sync status → code lookup. Returns `undefined` for 1xx/2xx/3xx. Use when you need just the code without a `Response` object handy. |

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
| `logger` | `Logger` instance (wraps Pino). `.debug(msg, ctx?)` `.info(msg, ctx?)` `.notice(msg, ctx?)` `.warning(msg, ctx?)` `.error(msg, errorOrCtx, ctx?)` `.crit(msg, errorOrCtx, ctx?)` `.alert(msg, errorOrCtx, ctx?)` `.emerg(msg, errorOrCtx, ctx?)` `.fatal(msg, errorOrCtx, ctx?)` | Global structured logger. Use `ctx.log` in handlers instead. `logger` is for lifecycle/background contexts (startup, shutdown, `setup()`). Auto-redacts sensitive fields. **Note:** `.error()` and higher accept `(msg, Error, ctx?)` or `(msg, ctx?)` — the second arg is overloaded. `.fatal()` is an alias for `.emerg()`. Full RFC 5424 severity set. |
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
| `runInContext` | `(ctx: RequestContext \| undefined, fn: () => T) -> T` | Runs `fn` inside the currently active OTel context. When `ctx` has no `traceId`/`spanId`, calls `fn` directly. Does not restore a specific span — use for carrying context across async boundaries (`setTimeout`, `queueMicrotask`). |
| `buildTraceparent` | `(ctx?: RequestContext) -> string \| undefined` | Builds a W3C `traceparent` header (`00-<traceId>-<spanId>-01`) from `ctx` or the active span. Returns `undefined` when neither source yields both IDs. |
| `extractTraceparent` | `(headers: Headers \| Record<string, string \| undefined>) -> TraceparentInfo \| undefined` | Parses a W3C `traceparent` header. Returns `undefined` when absent or malformed. `TraceparentInfo: { traceId, spanId, sampled }`. |
| `createContextWithParentTrace` | `(parentHeaders: Headers \| Record<string, string \| undefined>, operation: string) -> RequestContext` | Extracts `traceparent` from headers and creates a child `RequestContext` inheriting `traceId`/`parentSpanId`. |
| `injectCurrentContextInto` | `<T extends Record<string, unknown>>(carrier: T) -> T` | Injects the active OTel context (traceparent, tracestate, etc.) into `carrier` via `propagation.inject`. Returns the same object. |

### `telemetry/attributes`

MCP-specific `ATTR_*` constant exports for span and metric attributes. Covers: code execution (`code.function.name`, `code.namespace`), MCP tool execution (name, input/output bytes, duration, success, error code, error category, partial success, batch succeeded/failed counts), MCP resource (URI, name, MIME type, size, duration, success, error code), MCP request context (tenant ID, client ID), MCP session events, MCP storage, GenAI semantic conventions, speech, graph, auth, task, and error classification attributes.

Batch/partial success attributes (`mcp.tool.partial_success`, `mcp.tool.batch.succeeded_count`, `mcp.tool.batch.failed_count`) are set automatically by the framework when a tool handler returns a result containing a non-empty `failed` array — matching the batch response pattern from the design skill.

Standard OTel semantic conventions (HTTP, cloud, service, network, etc.) are NOT re-exported — import those directly from `@opentelemetry/semantic-conventions` if needed.

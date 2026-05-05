---
name: api-errors
description: >
  McpError constructor, JsonRpcErrorCode reference, and error handling patterns for `@cyanheads/mcp-ts-core`. Use when looking up error codes, understanding where errors should be thrown vs. caught, or using ErrorHandler.tryCatch in services.
metadata:
  author: cyanheads
  version: "1.5"
  audience: external
  type: reference
---

## Overview

Error handling in `@cyanheads/mcp-ts-core` follows a strict layered pattern: tool and resource handlers throw `McpError` freely (no try/catch), the handler factory catches and normalizes all errors, and services use `ErrorHandler.tryCatch` for graceful recovery.

**Imports:**

```ts
import { notFound, validationError, McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ErrorHandler } from '@cyanheads/mcp-ts-core/utils';
```

---

## Type-Driven Error Contract (recommended)

The recommended path for new tools and resources. Declare failure modes as a const tuple under `errors`; the reason union flows into the handler's `ctx.fail` and TypeScript enforces that you can only fail with a declared reason:

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

export const fetchTool = tool('fetch_articles', {
  description: 'Fetch articles by PMID',
  input: z.object({ pmids: z.array(z.string()).describe('PMIDs') }),
  output: z.object({ articles: z.array(z.unknown()).describe('Articles') }),

  errors: [
    { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
      when: 'No requested PMID returned data',
      recovery: 'Try pubmed_search_articles to discover valid PMIDs first.' },
    { reason: 'queue_full', code: JsonRpcErrorCode.RateLimited,
      when: 'Local request queue is at capacity', retryable: true,
      recovery: 'Wait 30 seconds and retry, or reduce batch size.' },
    { reason: 'ncbi_down', code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NCBI E-utilities unreachable after retries', retryable: true,
      recovery: 'NCBI is degraded; retry in a few minutes.' },
  ],

  async handler(input, ctx) {
    const articles = await ncbi.fetch(input.pmids);
    if (articles.length === 0) {
      throw ctx.fail('no_match', `None of ${input.pmids.length} PMIDs returned data`);
    }
    // ctx.fail('typo')   ← TypeScript error: 'typo' isn't in the contract
    return { articles };
  },
});
```

**What you get:**

| Surface | Behavior |
|:--------|:---------|
| Compile time | `ctx.fail('typo')` is a TS error. Auto-completes declared reasons. |
| Runtime | `ctx.fail(reason, msg?, data?, options?)` builds an `McpError(contract.code, msg, { ...data, reason }, options)` — `data.reason` is auto-populated from the contract and cannot be overridden by caller-supplied data (spread first, then `reason` written last), so observers see a stable identifier. `options` accepts `{ cause }` for ES2022 error chaining. |
| Lint (startup) | Each `code` validated against `JsonRpcErrorCode`. Reasons validated as snake_case + unique within contract. `recovery` validated as non-empty and ≥ 5 words. |
| Lint (conformance) | If the handler `throw new McpError(JsonRpcErrorCode.X)` outside `ctx.fail`, conformance check warns when X isn't declared. |

> **`recovery` is opt-in resolution, not auto-population.** The contract `recovery` is required metadata documenting the agent's next move when this failure mode fires (a forcing function for thoughtful guidance — placeholders like "Try again." get flagged by the linter). It does **not** automatically appear in runtime `data.recovery.hint` — the framework never injects it without an explicit signal at the throw site. Authors opt in by spreading `ctx.recoveryFor('reason')` into the `data` argument, the same way `ctx.fail('reason')` opts into resolving the contract `code`. What the author types at the throw site is what flows to the wire, with no hidden transformation; the resolver is just a typed lookup keyed by the same `reason` the author already typed.

#### `ctx.recoveryFor` — opt-in contract resolution

`ctx.recoveryFor(reason)` returns `{ recovery: { hint: <contract.recovery> } }` for a declared reason, ready to spread into `data`. Always available on `Context` (returns `{}` when no contract is attached or the reason is unknown — spread-safe with no optional chaining). On `HandlerContext<R>` it tightens to a typed signature constrained to the declared reason union.

```ts
export const calculateTool = tool('calculate', {
  // ...
  errors: [
    { reason: 'empty_expression', code: JsonRpcErrorCode.ValidationError,
      when: 'Expression is empty or whitespace-only.',
      recovery: 'Provide a non-empty mathematical expression to evaluate.' },
  ],
  handler(input, ctx) {
    if (!input.expression.trim()) {
      // Static recovery — resolve from the contract.
      throw ctx.fail('empty_expression', undefined, { ...ctx.recoveryFor('empty_expression') });
    }
    // ...
  },
});
```

Same pattern works inside services that accept `ctx`:

```ts
export class MathService {
  parse(expr: string, ctx: Context) {
    try {
      return mathjs.parse(expr);
    } catch (err) {
      throw validationError(`Parse failed: ${err.message}`, {
        reason: 'parse_failed',
        ...ctx.recoveryFor('parse_failed'),  // {} if calling tool has no matching reason
      });
    }
  }
}
```

The contract is the single source of truth — write the recovery once, lint validates ≥5 words, the resolver carries it to every throw site that opts in. For runtime-context recovery (interpolating input values, attempted IDs, queue state), override at the throw site:

```ts
throw ctx.fail('no_match', `No item ${id}`, {
  recovery: { hint: `No item ${id}; try IDs 1-100 instead.` },
});
```

`ctx.recoveryFor` is the first member of a planned **family of opt-in resolution helpers**. Future contract-bound fields (`troubleshootingFor`, `userMessageFor`, …) follow the same shape: single-purpose, spreadable wire-shape, `{}` fallback when not applicable.

**Skip the contract** for one-off internal tools or quick prototypes — `ctx` is plain `Context` (no `fail`) and you throw via [factories](#error-factories-fallback) directly. Behavior is identical at the wire; the contract just adds compile-time safety.

> **Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture (input, output, errors, handler, format). Don't extract a shared `errors[]` constant or contract module to deduplicate near-identical entries; per-tool repetition is the intended cost of locality, and dynamic `recovery` hints often need tool-specific runtime context anyway. If a code-cleanup pass suggests consolidating contracts, decline — the duplication is load-bearing for tool-def readability.

> **Limits of the conformance lint.** The conformance and prefer-fail rules scan the handler's source text for `throw` statements. Errors thrown from called services (e.g. `await myService.fetch()` raising `RateLimited` internally) are invisible — the lint only sees what's lexically in the handler. Treat the contract as the *advertised* failure surface; bubbled-up codes still reach the client correctly via the auto-classifier, just without lint enforcement.

### Carrying contract `reason` from services

Services don't have `ctx`, so they can't call `ctx.fail`. To make a service-thrown failure carry the contract's `reason` on the wire, **pass `data: { reason: 'X' }` to the factory**. The framework's auto-classifier preserves `data` unchanged, so clients see the same `error.data.reason` they'd see from `ctx.fail`:

```ts
// my-service.ts
throw validationError('Expression cannot be empty.',  { reason: 'empty_expression' });
throw serviceUnavailable('Upstream timeout',          { reason: 'evaluation_timeout' });
```

```ts
// my-tool.tool.ts
errors: [
  { reason: 'empty_expression',   code: JsonRpcErrorCode.ValidationError,
    when: 'Input is empty.',
    recovery: 'Provide a non-empty expression to evaluate.' },
  { reason: 'evaluation_timeout', code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Upstream exceeded the configured timeout.',
    recovery: 'Simplify the expression or retry the request after a brief delay.' },
]
```

The handler doesn't catch and re-throw — letting service errors bubble unchanged keeps "logic throws, framework catches" intact. The wire payload still carries `code` + `data.reason`, and clients can switch on reason without parsing message text. What's lost is lint-time enforcement that every reason is reachable; compensate with one wire-shape test per reason.

To carry the contract `recovery` from a service throw, accept `ctx` and spread the resolver:

```ts
throw validationError(message, {
  reason: 'parse_failed',
  ...ctx.recoveryFor('parse_failed'),  // {} when calling tool has no matching reason
});
```

`ctx.recoveryFor` is always present on `Context` (no-op when no contract), so services don't need to know which tool called them — the spread is safe either way.

---

## Error Factories (fallback)

Use when no contract entry fits — ad-hoc throws, tools without a contract, or service-layer code. Shorter than `new McpError(...)` and self-documenting. All return `McpError` instances and accept an optional `options` parameter for error chaining via `{ cause }`.

```ts
throw notFound('Item not found', { itemId: '123' });
throw validationError('Missing required field: name', { field: 'name' });
throw unauthorized('Token expired');

// With cause for error chaining
throw serviceUnavailable('API call failed', { url }, { cause: error });
```

**Available factories:**

| Factory | Code |
|:--------|:-----|
| `invalidParams(msg, data?, options?)` | InvalidParams (-32602) |
| `invalidRequest(msg, data?, options?)` | InvalidRequest (-32600) |
| `notFound(msg, data?, options?)` | NotFound (-32001) |
| `forbidden(msg, data?, options?)` | Forbidden (-32005) |
| `unauthorized(msg, data?, options?)` | Unauthorized (-32006) |
| `validationError(msg, data?, options?)` | ValidationError (-32007) |
| `conflict(msg, data?, options?)` | Conflict (-32002) |
| `rateLimited(msg, data?, options?)` | RateLimited (-32003) |
| `timeout(msg, data?, options?)` | Timeout (-32004) |
| `serviceUnavailable(msg, data?, options?)` | ServiceUnavailable (-32000) |
| `configurationError(msg, data?, options?)` | ConfigurationError (-32008) |
| `internalError(msg, data?, options?)` | InternalError (-32603) |
| `serializationError(msg, data?, options?)` | SerializationError (-32070) — JSON/XML/parser failures |
| `databaseError(msg, data?, options?)` | DatabaseError (-32010) |

`options` is `{ cause?: unknown }` — the standard ES2022 `ErrorOptions` type.

---

## McpError Constructor

For codes not covered by factories (rare — `MethodNotFound`, `ParseError`, `InitializationFailed`, `UnknownError`):

```ts
throw new McpError(code, message?, data?, options?)
```

- `code` — a `JsonRpcErrorCode` enum value
- `message` — optional human-readable description of the failure
- `data` — optional structured context (plain object)
- `options` — optional `{ cause?: unknown }` for error chaining

**Example:**

```ts
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection pool exhausted', {
  pool: 'primary',
});
```

---

## Error Codes

**Standard JSON-RPC 2.0 codes:**

| Code | Value | When to Use |
|:-----|------:|:------------|
| `ParseError` | -32700 | Malformed JSON received |
| `InvalidRequest` | -32600 | Unsupported operation, missing client capability |
| `MethodNotFound` | -32601 | Requested method does not exist |
| `InvalidParams` | -32602 | Bad input, missing required fields, schema validation failure |
| `InternalError` | -32603 | Unexpected failure, catch-all for programmer errors |

**Implementation-defined codes (-32000 to -32099):**

| Code | Value | When to Use |
|:-----|------:|:------------|
| `ServiceUnavailable` | -32000 | External dependency down, upstream failure |
| `NotFound` | -32001 | Resource, entity, or record doesn't exist |
| `Conflict` | -32002 | Duplicate key, version mismatch, concurrent modification |
| `RateLimited` | -32003 | Rate limit exceeded |
| `Timeout` | -32004 | Operation exceeded time limit |
| `Forbidden` | -32005 | Authenticated but insufficient scopes/permissions |
| `Unauthorized` | -32006 | No auth, invalid token, expired credentials |
| `ValidationError` | -32007 | Business rule violation (not schema — use `InvalidParams` for that) |
| `ConfigurationError` | -32008 | Missing env var, invalid config |
| `InitializationFailed` | -32009 | Server/component startup failure |
| `DatabaseError` | -32010 | Storage/persistence layer failure |
| `SerializationError` | -32070 | Data serialization/deserialization failed |
| `UnknownError` | -32099 | Generic fallback when no other code fits |

---

## Auto-Classification

When a handler throws a plain `Error` (or any non-`McpError` value), the framework classifies it to the most specific `JsonRpcErrorCode` automatically. This matters when you don't control what a third-party library throws and can't predict its error type.

Use factories or `McpError` directly when the code must be exact — auto-classification is best-effort pattern matching and not guaranteed for ambiguous messages. For errors from your own code where the code matters, be explicit.

### Resolution Order

The framework applies these steps in order — first match wins:

1. **`McpError` instance** — `error.code` is preserved as-is; no classification needed.
2. **JS constructor name** — matched against a fixed table (e.g. `TypeError` → `ValidationError`).
3. **Provider-specific patterns** — HTTP status codes, AWS exception names, Supabase, OpenRouter. Checked before common patterns because they are more specific (e.g. `status code 429` beats the generic `rate limit` pattern).
4. **Common message/name patterns** — broad keyword patterns covering auth, not-found, validation, etc. First match wins; order matters.
5. **`AbortError` name** — `error.name === 'AbortError'` → `Timeout`.
6. **Fallback** — `InternalError`.

### JS Constructor Name Mappings

| Constructor | Mapped Code |
|:------------|:------------|
| `SyntaxError` | `ValidationError` |
| `RangeError` | `ValidationError` |
| `URIError` | `ValidationError` |
| `ZodError` | `ValidationError` |
| `ReferenceError` | `InternalError` |
| `EvalError` | `InternalError` |
| `AggregateError` | `InternalError` |

`TypeError` is **intentionally excluded** from the constructor table — runtime `TypeError`s (e.g. *"Cannot read property X of undefined"*) are programmer errors, not validation failures. They fall through to message-pattern matching, then to the `InternalError` fallback.

### Common Message Patterns

Patterns are tested against both the error `message` and `name`, case-insensitively. First match wins.

| Pattern (regex) | Mapped Code |
|:----------------|:------------|
| `unauthorized\|unauthenticated\|not\s+authorized\|not.*logged.*in\|invalid[\s_-]+token\|expired[\s_-]+token` | `Unauthorized` |
| `permission\|forbidden\|access.*denied\|not.*allowed` | `Forbidden` |
| `not found\|no such\|doesn't exist\|couldn't find` | `NotFound` |
| `invalid\|validation\|malformed\|bad request\|wrong format\|missing\s+(?:required\|param\|field\|input\|value\|arg)` | `ValidationError` |
| `conflict\|already exists\|duplicate\|unique constraint` | `Conflict` |
| `rate limit\|too many requests\|throttled` | `RateLimited` |
| `timeout\|timed out\|deadline exceeded` | `Timeout` |
| `abort(ed)?\|cancell?ed` | `Timeout` |
| `service unavailable\|bad gateway\|gateway timeout\|upstream error` | `ServiceUnavailable` |
| `zod\|zoderror\|schema validation` | `ValidationError` |

### Provider-Specific Patterns

Checked before common patterns. Cover: AWS exception names, HTTP status codes, DB connection/constraint errors, Supabase JWT/RLS, OpenRouter/LLM quota errors, and low-level network errors.

| Pattern | Mapped Code |
|:--------|:------------|
| `ThrottlingException\|TooManyRequestsException` | `RateLimited` |
| `AccessDenied\|UnauthorizedOperation` | `Forbidden` |
| `ResourceNotFoundException` | `NotFound` |
| `status code 401` | `Unauthorized` |
| `status code 403` | `Forbidden` |
| `status code 404` | `NotFound` |
| `status code 409` | `Conflict` |
| `status code 429` | `RateLimited` |
| `status code 5xx` | `ServiceUnavailable` |
| `ECONNREFUSED\|connection refused` | `ServiceUnavailable` |
| `ETIMEDOUT\|connection timeout` | `Timeout` |
| `unique constraint\|duplicate key` | `Conflict` |
| `foreign key constraint` | `ValidationError` |
| `JWT expired` | `Unauthorized` |
| `row level security` | `Forbidden` |
| `insufficient_quota\|quota exceeded` | `RateLimited` |
| `model_not_found` | `NotFound` |
| `context_length_exceeded` | `ValidationError` |
| `ENOTFOUND\|DNS` | `ServiceUnavailable` |
| `ECONNRESET\|connection reset` | `ServiceUnavailable` |

---

## Where Errors Are Handled

| Layer | Pattern |
|:------|:--------|
| Tool/resource handlers | Throw `McpError` — no try/catch |
| Handler factory (tools) | Catches all errors, normalizes to `McpError`, sets `isError: true`, mirrors error across both client surfaces (see [Error-path parity](#error-path-parity)) |
| Handler factory (resources) | Catches and re-throws to the SDK, which routes through the JSON-RPC error envelope |
| Services/setup code | `ErrorHandler.tryCatch` for graceful recovery |

### Error-path parity

MCP clients differ in which `CallToolResult` surface they forward to the agent. Tool errors mirror the success-path `format-parity` invariant — both surfaces carry the same payload:

| Surface | Content | Read by |
|:--------|:--------|:--------|
| `content[]` | Text rendering: `Error: <message>` (plus `Recovery: <hint>` when `data.recovery.hint` is present) | Claude Desktop and other format()-only clients |
| `structuredContent.error` | JSON `{ code, message, data? }` carrying the error code, message, and any structured data from the thrown `McpError` or `ZodError` | Claude Code and other structuredContent-only clients |

Important properties:
- **`_meta.error` is NOT emitted.** Error code/data live on `structuredContent.error` instead. Don't read `_meta.error` in clients or tests — it doesn't exist.
- **`data` propagation is restricted** to explicitly-thrown `McpError.data` and `ZodError.issues`. Auto-classified plain errors (`TypeError`, network errors, etc.) emit `code` + `message` only — no `data` — so internal classification context never leaks to clients.
- **Recovery hint mirroring is automatic.** When the thrown `McpError` carries `data.recovery.hint`, the handler factory appends it to the `content[]` text so the markdown surface matches the JSON surface. Authors don't need to format the hint manually.

**Handler — throw freely, no try/catch:**

```ts
import { notFound } from '@cyanheads/mcp-ts-core/errors';

export const myTool = tool('my_tool', {
  input: z.object({ id: z.string().describe('Item ID') }),
  output: z.object({ id: z.string(), name: z.string(), status: z.string() }),
  async handler(input, ctx) {
    const item = await db.find(input.id);
    if (!item) {
      throw notFound(`Item not found: ${input.id}`, { id: input.id });
    }
    return item;
  },
});
```

---

## ErrorHandler.tryCatch (Services)

Use `ErrorHandler.tryCatch` in service code, not in tool handlers. It wraps arbitrary exceptions into `McpError` and supports structured logging context.

```ts
import { ErrorHandler } from '@cyanheads/mcp-ts-core/utils';

// Works with both async and sync functions
const result = await ErrorHandler.tryCatch(
  () => externalApi.fetch(url),
  {
    operation: 'ExternalApi.fetch',
    context: { url },
    errorCode: JsonRpcErrorCode.ServiceUnavailable,
  },
);

const parsed = await ErrorHandler.tryCatch(
  () => JSON.parse(raw),
  {
    operation: 'parseConfig',
    errorCode: JsonRpcErrorCode.ConfigurationError,
  },
);
```

`tryCatch` always logs and rethrows — it never swallows errors. The `fn` argument may be synchronous or return a `Promise`; both are handled via `Promise.resolve(fn())`.

**Options** (`Omit<ErrorHandlerOptions, 'rethrow'>`):

| Option | Type | Required | Purpose |
|:-------|:-----|:--------:|:--------|
| `operation` | `string` | Yes | Name logged with the error |
| `context` | `ErrorContext` | No | Extra structured fields merged into the log record; `requestId` and `timestamp` receive special treatment |
| `errorCode` | `JsonRpcErrorCode` | No | Code used if the caught error is not already an `McpError` |
| `input` | `unknown` | No | Input value sanitized and logged alongside the error |
| `critical` | `boolean` | No | Marks the error as critical in logs (default `false`) |
| `includeStack` | `boolean` | No | Include stack trace in log output (default `true`) |
| `errorMapper` | `(error: unknown) => Error` | No | Custom transform applied instead of default `McpError` wrapping |

---

## HTTP Response → McpError

When you bypass `fetchWithTimeout` and use raw `fetch` (typically because you need granular code classification or response body access), use `httpErrorFromResponse` instead of writing your own status mapping ladder:

```ts
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';

const response = await fetch(url, { signal: ctx.signal });
if (!response.ok) {
  throw await httpErrorFromResponse(response, {
    service: 'NCBI',                  // included in message
    data: { endpoint, requestId: ctx.requestId },
  });
}
```

Captures the response body (truncated, configurable limit) and `Retry-After` header (stored as `data.retryAfter`) into `error.data`. The codes it produces line up with `withRetry`'s transient-code set, so retryable responses are retried automatically.

> **Body reaches the client.** `error.data` is forwarded to the MCP client as `structuredContent.error.data` (tool errors) or JSON-RPC `error.data` (resource errors). Upstream 401/403/422 responses sometimes echo token claims, internal user IDs, or schema validation hints — that text becomes client-visible. For sensitive endpoints, pass `captureBody: false` (or `bodyLimit: 0`) so the body stays out of `data`. Defaults remain `captureBody: true` because most upstreams return useful diagnostic text and silent dropping helps no one debug.

Full status table:

| Status | Code |
|:-------|:-----|
| 400 | `InvalidParams` |
| 401 | `Unauthorized` |
| 402, 403 | `Forbidden` |
| 404 | `NotFound` |
| 408, 425, 504 | `Timeout` |
| 409, 423, 424 | `Conflict` |
| 422 | `ValidationError` |
| 429 | `RateLimited` |
| 405, 406, 410, 412, 415, 416, 417, 428, 431, 451, 4xx (other) | `InvalidRequest` |
| 500, 501 | `InternalError` |
| 502, 503, 5xx (other) | `ServiceUnavailable` |

Also exports `httpStatusToErrorCode(status)` for sync mapping when you don't have a Response object.

---

## Handler-Body Lint Rules

The startup linter (`bun run lint:mcp` and `createApp()` startup) checks handler bodies for common anti-patterns. All emit warnings (not errors) — they don't block startup but show up in `devcheck` output.

| Rule | Catches |
|:-----|:--------|
| `prefer-mcp-error-in-handler` | `throw new Error(...)` inside a handler — use `McpError` or a factory so the framework returns a specific code |
| `prefer-error-factory` | `new McpError(JsonRpcErrorCode.NotFound, ...)` when `notFound(...)` exists |
| `preserve-cause-on-rethrow` | `catch (e) { throw new McpError(...) }` without `{ cause: e }` |
| `no-stringify-upstream-error` | `JSON.stringify(...)` inside a thrown message — risks leaking internal traces; use `data` payload instead |

---

## Error Contract Lint Rules

The linter validates the structure of `errors[]` and (when present) cross-checks the handler body against the declared contract.

### Structural rules

| Rule | Severity | Catches |
|:-----|:---------|:--------|
| `error-contract-type` | error | `errors` is present but not an array |
| `error-contract-empty` | warning | `errors: []` — drop the field instead, or declare actual failure modes |
| `error-contract-entry-type` | error | An entry isn't an object |
| `error-contract-code-type` | error | `code` missing or not a number |
| `error-contract-code-unknown` | error | `code` isn't a real `JsonRpcErrorCode` value |
| `error-contract-code-unknown-error` | warning | `code` is `JsonRpcErrorCode.UnknownError` (the giveup-fallback — pick a more specific code) |
| `error-contract-reason-required` | error | `reason` missing or empty |
| `error-contract-reason-format` | warning | `reason` not snake_case |
| `error-contract-reason-unique` | error | Duplicate `reason` within one contract |
| `error-contract-when-required` | error | `when` missing or empty |
| `error-contract-recovery-required` | error | `recovery` missing or not a string |
| `error-contract-recovery-empty` | error | `recovery` is empty/whitespace-only |
| `error-contract-recovery-min-words` | warning | `recovery` has fewer than 5 words — placeholders like "Try again." or "Check input." get flagged in favor of specific guidance |
| `error-contract-retryable-type` | warning | `retryable` is present but not a boolean |

### Conformance rules

| Rule | Severity | Catches |
|:-----|:---------|:--------|
| `error-contract-conformance` | warning | Handler throws a non-baseline code that isn't in the contract. Suggests adding it to `errors[]` so the contract is the canonical source of truth for declared failure modes. |
| `error-contract-prefer-fail` | warning | Handler throws a code that **is** in the contract directly (via factory or `new McpError`) instead of through `ctx.fail(reason, …)`. Encourages routing through the typed helper so observers see consistent `data.reason` values. |

### Baseline codes (auto-allowed)

These codes bubble up from anywhere — services, framework utilities, the auto-classifier — and are implicitly always-possible on any tool. They're skipped by the conformance check, so the contract can stay focused on intentional domain failures:

- `InternalError` — bug, programmer error, truly unexpected
- `ServiceUnavailable` — upstream/network failures
- `Timeout` — request deadline exceeded, abort
- `ValidationError` — schema violations, malformed input
- `SerializationError` — JSON/XML parse failures

If you *want* to declare one of these as a domain-specific failure (e.g., a tool that intentionally times out under defined conditions), put it in `errors[]` anyway — the contract still binds `ctx.fail(reason)` and the conformance lint will catch undeclared throws. The lint just doesn't *require* you to enumerate baselines.

### When to declare vs. let it bubble

The contract describes the **public failure surface** — the failures clients/agents can plan around. Modeled after how OpenAPI-driven frameworks treat 5xx: enumerated 4xx for intentional failures, implicit 5xx for infrastructure.

| Pattern | Use for |
|:--------|:--------|
| `throw ctx.fail('reason', …)` | Declared domain failures — typed, contract-checked, `data.reason` populated |
| `throw notFound(…)` / factories | Errors not in the contract; the auto-classifier handles them. Prefer `ctx.fail` when a matching contract entry exists. |
| Bubble up from services | Upstream classification already produced an `McpError` — don't re-wrap |

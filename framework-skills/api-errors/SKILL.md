---
name: api-errors
description: >
  McpError constructor, JsonRpcErrorCode reference, and error handling patterns for `@cyanheads/mcp-ts-core`. Use when looking up error codes, understanding where errors should be thrown vs. caught, or using ErrorHandler.tryCatch in services.
metadata:
  author: cyanheads
  version: "1.24"
  audience: external
  type: reference
---

## Overview

Error handling in `@cyanheads/mcp-ts-core` follows a strict layered pattern: tool and resource handlers throw `McpError` freely (no try/catch), the handler factory catches and normalizes all errors, and services use `ErrorHandler.tryCatch` for structured logging and wrapping.

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
| Runtime | `ctx.fail(reason, msg?, data?, options?)` builds an `McpError(contract.code, msg, { ...data, reason }, options)` — `data.reason` is auto-populated from the contract and cannot be overridden by caller-supplied data (spread first, then `reason` written last), so observers see a stable identifier. `options` accepts `{ cause }` for ES2022 error chaining. Its stack starts at the line that called `ctx.fail`, with the framework's own frame cut, as an error factory's does. |
| Runtime (recovery) | A failure whose `data.reason` names a declared entry and carries no `data.recovery` gets `data.recovery.hint` set to the entry's `recovery` at the handler boundary — see below. |
| Lint (devcheck) | Each `code` validated against `JsonRpcErrorCode`. Reasons validated as snake_case + unique within contract. `recovery` validated as non-empty and ≥ 5 words. Build-time only — not invoked at server startup. |
| Lint (conformance) | If the handler `throw new McpError(JsonRpcErrorCode.X)` outside `ctx.fail`, conformance check warns when X isn't declared. The inverse is checked too: a declared reason no `ctx.fail` in the handler names warns as `error-contract-unthrown` (mark it `thrownBy: 'service'` when the service layer produces it). |

> **`recovery` is the wire default for its reason.** The contract `recovery` is required metadata documenting the agent's next move when this failure mode fires (a forcing function for thoughtful guidance — placeholders like "Try again." get flagged by the linter), and it is what the caller receives. When a failure whose `data.reason` names a declared entry reaches the tool or resource handler factory with no `data.recovery`, the factory sets `data.recovery.hint` to that entry's `recovery` before it logs the failure and builds the envelope, so the `Error in tool:<name>` record, `structuredContent.error.data`, and the `Recovery:` line in `content[]` carry the same hint. It matches on the reason alone — a bare `ctx.fail('reason')`, a service throwing `notFound(msg, { reason })`, and a declared reason raised through a factory with a different code all get it. A throw-site `recovery` always wins, whatever its shape. An undeclared reason, a tool without `errors[]`, a non-`McpError` throw, and a cancelled call get nothing, and the framework-owned `invalid_arguments` / `client_capability_missing` refusals keep their own hints. The thrown `McpError` is never changed — a handler-level test of `ctx.fail` sees exactly what the throw site wrote — and `runToolContract` applies the same fill, so a contract test sees the production envelope. Prompts declare no contract.

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
      // Static recovery — the framework fills the contract's hint onto the wire.
      throw ctx.fail('empty_expression');
    }
    // ...
  },
});
```

Same for a service, which needs no `ctx` to get the hint — the reason is enough:

```ts
export class MathService {
  parse(expr: string) {
    try {
      return mathjs.parse(expr);
    } catch (err) {
      throw validationError(`Parse failed: ${err.message}`, { reason: 'parse_failed' });
    }
  }
}
```

The contract is the single source of truth — write the recovery once, lint validates ≥5 words, and the framework carries it to every failure with that reason. For runtime-context recovery (interpolating input values, attempted IDs, queue state), override at the throw site:

```ts
throw ctx.fail('no_match', `No item ${id}`, {
  recovery: { hint: `No item ${id}; try IDs 1-100 instead.` },
});
```

> **A recovery hint names a capability, never an internal method.** The reader is a model whose only reachable surface is this server's tool names — it cannot call a TypeScript method, set a library option, or re-run an internal function. `Re-stage the table via registerTable()` is unfollowable and invites a hallucinated tool call; `Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool` is actionable from where the reader sits. Name a condition the caller cannot observe — an option flag they never set — and the hint is noise for the same reason. The framework holds its own throws to this rule: the canvas SQL gate's rejections point at the dataframe-query and dataframe-describe capabilities rather than the provider methods behind them.

#### `ctx.recoveryFor` — the entry's hint at the throw site

`ctx.recoveryFor(reason)` returns `{ recovery: { hint: <contract.recovery> } }` for a declared reason, ready to spread into `data`. Always available on `Context` (returns `{}` when no contract is attached or the reason is unknown — spread-safe with no optional chaining). On `HandlerContext<R>` it tightens to a typed signature constrained to the declared reason union.

It is not needed to put a declared hint on the wire — the fill above does that. Reach for it when the hint has to ride the thrown error itself: a test asserting `data.recovery` on the handler's own throw, or a site that deliberately sends another entry's guidance (`ctx.fail('a', msg, ctx.recoveryFor('b'))`), which the fill respects as authored.

#### `severity` — log a modeled outcome below `error`

An outcome a tool declares in `errors[]` is a modeled result, not an incident. A caller who answers no to a confirmation prompt, a lookup whose miss is an ordinary answer — logging those at `error` alongside upstream faults and bugs leaves the error stream unreadable at the level log-based alerting works on. `severity` moves that one record's level:

```ts
errors: [
  { reason: 'consent_declined', code: JsonRpcErrorCode.InvalidRequest,
    when: 'The caller declined the confirmation prompt.', severity: 'notice',
    recovery: 'Re-run the tool and confirm the prompt to proceed with the change.' },
],
```

Values are the logger's own level names below `error` — `debug`, `info`, `notice`, `warning`. Omitting the field keeps `error`, byte for byte, for every server that does not opt in.

| Surface | Under a declared severity |
|:--------|:--------------------------|
| The `Error in tool:<name>` log record | Emitted at the declared level. Same message, same structured fields, the throw site's stack included — except the framework's own refusals, whose records carry no stack, an argument rejection's bounded as well (see below). |
| `mcp.errors.classified` | Gains an `mcp.error.severity` attribute. The `reason` itself never becomes a metric attribute. |
| `isError`, the JSON-RPC code, `structuredContent.error`, `content[]` | Byte-identical to the undeclared case. |
| Span status, `mcp.tool.calls`, `mcp.tool.duration`, `mcp.tool.errors` | Unchanged — the call still failed, and splitting those series would redefine what an error rate means. |

**Tools only.** Resolution happens in the tool handler factory, against the thrown error's `data.reason` — the same reason-to-entry lookup that fills `data.recovery`. Resources declare `errors[]` but write no failure record, so the field is accepted there and inert. A reason thrown below the handler that the contract never declared, an entry with no `severity`, and a non-`McpError` throw all keep `error`. A cancelled request keeps its own `info`, stack-free path regardless.

**The framework's own refusals log at `notice`.** An argument rejection (`invalid_arguments`, raised only by the schema gate before the handler runs), a `ctx.requestInput` the connection cannot serve (`client_capability_missing`), and a missing-scope refusal (the `Forbidden` the inline `auth` check or `checkScopes` throws) are routine caller or connection traffic, not server faults, so their `Error in tool:<name>` record — and the failure-payload record when `LOG_TOOL_FAILURE_PAYLOADS=true` — is emitted at `notice`, and `mcp.errors.classified` counts them with `mcp.error.severity: "notice"`. Nothing to declare; an `errors[]` entry naming `invalid_arguments` or `client_capability_missing` with its own `severity` still wins, while a missing-scope refusal carries no `data.reason`, so its level is fixed. That refusal is recognized by where it was raised, never by its code: a handler's own `forbidden()`, an upstream 403 mapped by `httpErrorFromResponse`, and a missing auth context (`Unauthorized`) keep `error` and the stack. All three records log no stack, whatever level an entry declares, and an argument rejection's record is bounded whatever the caller sends: the message, `recovery.hint`, each issue's `message`, each `data.input` key, and every other string and key keep at most their first 1,024 characters, every array its first 10 entries, and every object its first 10 keys, with the uncut length or count beside each cut (`originalMessageLength`, `<field>Length`, `<field>KeyLength`, `<field>Count`, `<field>Lengths`). The `-32602` result is bounded the same way (see `invalid_arguments` below), so the record cuts only its message and hint further. `mcp.tool.rejections` is unchanged, and a schema that wrongly rejects valid calls still shows per tool on it.

**Skip the contract** for one-off internal tools or quick prototypes — `ctx` is plain `Context` (no `fail`) and you throw via [factories](#error-factories-fallback) directly. Behavior is identical at the wire; the contract just adds compile-time safety.

> **Declare contracts inline on each tool, even when similar across tools.** The contract is part of the tool's documented public surface — reading one tool definition file should give the full picture (input, output, errors, handler, format). Don't extract a shared `errors[]` constant or contract module to deduplicate near-identical entries; per-tool repetition is the intended cost of locality, and dynamic `recovery` hints often need tool-specific runtime context anyway. If a code-cleanup pass suggests consolidating contracts, decline — the duplication is load-bearing for tool-def readability.

> **Limits of the conformance lint.** The conformance and prefer-fail rules scan the handler's source text for `throw` statements. Errors thrown from called services (e.g. `await myService.fetch()` raising `RateLimited` internally) are invisible — the lint only sees what's lexically in the handler. Treat the contract as the *advertised* failure surface; bubbled-up codes still reach the client correctly via the auto-classifier, just without lint enforcement.

### Carrying contract `reason` from services

Services don't receive `ctx` automatically (unlike handlers), so they can't call `ctx.fail` directly — though `ctx` can be passed as a parameter when needed. To make a service-thrown failure carry the contract's `reason` on the wire, **pass `data: { reason: 'X' }` to the factory**. The framework's auto-classifier preserves `data` unchanged, so clients see the same `error.data.reason` they'd see from `ctx.fail`:

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

The handler doesn't catch and re-throw — letting service errors bubble unchanged keeps "logic throws, framework catches" intact. The wire payload carries `code`, `data.reason`, and the declared entry's `recovery` as `data.recovery.hint` (filled at the handler boundary, whatever code the service picked), so clients can switch on reason without parsing message text. What's lost is lint-time enforcement that every reason is reachable; compensate with one wire-shape test per reason.

**Mark the entries the service produces.** `error-contract-unthrown` reads the handler body alone, so in a handler that mixes one local precondition with service-thrown reasons it flags each service reason as dead. Add `thrownBy: 'service'` to those entries:

```ts
errors: [
  { reason: 'empty_expression',   code: JsonRpcErrorCode.ValidationError,
    when: 'Input is empty.',
    recovery: 'Provide a non-empty expression to evaluate.',
    thrownBy: 'service' },
]
```

The field is lint-only metadata — nothing at runtime reads it, so the entry is typed, advertised, and thrown exactly as an unmarked one (its `recovery` filled like any other), and its reason stays in the `ctx.fail` / `ctx.recoveryFor` union. It suppresses the one rule that cannot see below the handler, and only for the entries it marks; the handler's own reasons keep being checked.

---

## When not to throw

Throw when the server has authoritative classification — auth failure, rate limit, schema violation, upstream 5xx, missing required input. Don't throw when "this looks wrong" depends on intent the server can't see. For mutators, surface raw pre- and post-mutation observable state in the response and let the agent decide whether it matches intent — the server can detect that the file shrunk, but only the agent knows whether it was supposed to. Tell: defensive code justified as a free rider on other work — audit it standalone, and it usually doesn't earn its keep.

A best-effort call that catches and degrades should still rethrow on `ctx.signal.aborted`: `catch (err) { if (ctx.signal.aborted) throw err; return degraded(); }`. One example is an enrichment lookup whose failure should return the primary result with a notice. Once the request signal has fired, the factory settles the call as `RequestCancelled` whether the handler throws or returns, so a degraded result is never recorded as a success; the rethrow stops the remaining work and keeps the cancellation from logging a false degrade warning.

---

## Error Factories (fallback)

Use when no contract entry fits — ad-hoc throws, tools without a contract, or service-layer code. Shorter than `new McpError(...)` and self-documenting. All return `McpError` instances and accept an optional `options` parameter for error chaining via `{ cause }`. Each one's stack starts at the line that called it, with the factory's own frame cut.

```ts
throw notFound('Item not found', { itemId: '123' });
throw validationError('Missing required field: name', { field: 'name' });
throw unauthorized('Token expired');

// With cause for error chaining
throw serviceUnavailable('API call failed', { endpoint: 'search' }, { cause: error });
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
| `requestCancelled(msg, data?, options?)` | RequestCancelled (-32011) — caller went away |

`options` is `{ cause?: unknown }` — the standard ES2022 `ErrorOptions` type.

---

## McpError Constructor

For codes not covered by factories (rare — `MethodNotFound`, `ParseError`, `InitializationFailed`, `UnknownError`):

```ts
throw new McpError(code, message?, data?, options?)
```

- `code` — a `JsonRpcErrorCode` enum value
- `message` — optional human-readable description of the failure
- `data` — optional structured data (plain object), returned to the client verbatim. Pass the explicit fields the caller acts on (the rejected key, a limit, a `reason`), never `ctx` or another request context: a handler `ctx` carries request metadata and, after an elicitation round, what the user typed. Framework helpers follow the same rule — a storage, parser, or formatter failure carries only its offending field or a `reason`, whatever context you pass them. A `filesystem` storage fault names the key, never the host path: `DatabaseError`, or `ValidationError` when a key segment is too long for the filesystem, with the raw `fs` error on `cause` for the log.
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
| `RequestCancelled` | -32011 | Caller abandoned the request — client disconnect, external abort signal. Framework-raised; never retried, logged at `info` |
| `SerializationError` | -32070 | Data serialization/deserialization failed |
| `UnknownError` | -32099 | Generic fallback when no other code fits |

---

## Auto-Classification

When a handler throws a plain `Error` (or any non-`McpError` value), the framework classifies it to the most specific `JsonRpcErrorCode` automatically. This matters when you don't control what a third-party library throws and can't predict its error type.

Use factories or `McpError` directly when the code must be exact — auto-classification is best-effort pattern matching and not guaranteed for ambiguous messages. For errors from your own code where the code matters, be explicit.

### Resolution Order

The framework applies these steps in order — first match wins:

1. **Request signal aborted** — `ctx.signal.aborted` is `true` when the handler unwinds → `RequestCancelled`. Resolved before the thrown value is classified at all — by the tool and resource handler factories and the `prompts/get` path (against the request signal, though `generate` itself receives none), and by the HTTP transport's error handler against the inbound request's signal, which catches a caller that hangs up before any handler runs (mid-body, say) and answers it 499 — so it outranks every step below, `McpError` included: the caller withdrew the request, and what the handler threw on the way out does not change that. Covers every shape an abort leaves behind — a `notifications/cancelled` `reason` string, the `DOMException` named `AbortError` a reason-less cancellation produces, a service's own `McpError`, and the SDK's `SdkError(ConnectionClosed)` on transport close. The accepted cost is that an unrelated fault raised after the abort is recorded as a cancellation too; it is bounded, because the SDK writes no response for a request whose signal it aborted. A handler that *returns* after the abort settles the same way: the tool and resource factories call `throwIfAborted()` on the request signal once the handler resolves (and the prompt path once `generate` resolves), so a `Promise.allSettled` fan-out that folded the aborted leg into a partial result, or an early `return` on `ctx.signal.aborted`, is a `RequestCancelled` with no `partialSuccess`, never a success. A handler that throws or returns while the signal is live is untouched by this step.
2. **`McpError` instance** — `error.code` is preserved as-is; no classification needed.
3. **SDK transport-closed rejection** — an `SdkError` carrying `SdkErrorCode.ConnectionClosed` → `RequestCancelled`. The SDK rejects every in-flight request when the transport closes, which is what a client disconnect looks like from inside a handler. Matched on the code, not the message: one of its wordings says "aborted" and would otherwise be caught by the generic abort pattern in step 7 and read as a `Timeout`. Still the rule for a throw raised where no request signal is in scope — a service, an outbound leg, a background task.
4. **Engine resource limit** — a `RangeError` whose **whole** message is one the engine raises when it runs out of a resource → `InternalError`: `Maximum call stack size exceeded` (JavaScriptCore adds a trailing period) and the maximum string size (V8 `Invalid string length`, JavaScriptCore `Out of memory`). A handler that recurses without bound names nothing a caller can change, so it is a server fault. Every other `RangeError` — `new Array(-1)`, `(1).toFixed(101)`, an invalid date, `1n / 0n`, or one whose message merely contains a limit text — continues to step 5.
5. **JS constructor name** — matched against a fixed table (e.g. `ZodError` → `ValidationError`, `SyntaxError` → `ValidationError`). Note: `TypeError` is intentionally excluded — runtime TypeErrors are programmer errors, not validation failures.
6. **Provider-specific patterns** — HTTP status codes, AWS exception names, Supabase, OpenRouter. Checked before common patterns because they are more specific (e.g. `status code 429` beats the generic `rate limit` pattern).
7. **Common message/name patterns** — broad keyword patterns covering auth, not-found, validation, etc. First match wins; order matters.
8. **`AbortError` name** — `error.name === 'AbortError'` → `Timeout`.
9. **Fallback** — `InternalError`.

However it is reached, a `RequestCancelled` is logged at `info` with no stack — neither the thrown value's own, nor one reached through its cause chain, nor the `originalStack` or `causeChain` node stacks the thrown `McpError`'s `data` carries, nor an `Error`'s anywhere in the record (`errorData`, `input`, the context's `extra`). Step 1 settles the completion log too, which carries `metrics.errorCode: "-32011"` alongside `isSuccess: false`; a raw `SdkError` that reaches the code through step 3 alone is not an `McpError`, so that log still reads `UNHANDLED_ERROR`.

The code this ladder picks is the one the caller receives, and it is also the origin every error counter records: `mcp.tool.error_category`, `mcp.prompt.error_category`, and `mcp.error.category` on `mcp.errors.classified` all bucket that same code, so a plain `Error('Request timed out')` files as `upstream` everywhere, never `server` on one counter and `upstream` on another. See `api-telemetry`'s Error category.

**The framework's own output-contract parses are not caller errors.** A result that breaks the definition's `output` schema (tools and resources) or its `enrichment` block fails as `InternalError` (`-32603`), with a message naming the definition and the contract — `Tool my_tool returned output that does not match its output schema: items.0.id: …` — and no `data`. It is the handler's bug, so it files as `server`, not the `ValidationError` a raw `ZodError` would get. A `ZodError` the handler throws from its own validation keeps `ValidationError`.

### JS Constructor Name Mappings

| Constructor | Mapped Code |
|:------------|:------------|
| `SyntaxError` | `ValidationError` |
| `RangeError` | `ValidationError` (an engine resource limit is settled first, as `InternalError` — step 4) |
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
| Handler factory (tools) | Catches all errors, fills a declared `recovery`, normalizes to `McpError`, sets `isError: true`, adds `data.requestId`, mirrors error across both client surfaces (see [Error-path parity](#error-path-parity)) |
| Handler factory (resources) | Catches, fills a declared `recovery`, adds `data.requestId`, and re-throws to the SDK, which routes through the JSON-RPC error envelope |
| Prompt registration, HTTP transport | Log the failure, then answer the JSON-RPC error with the thrown `McpError`'s `data` plus `data.requestId` |
| Services/setup code | `ErrorHandler.tryCatch` for structured logging and wrapping (always rethrows — never swallows) |

### Error-path parity

MCP clients differ in which `CallToolResult` surface they forward to the agent. Tool errors mirror the success-path `format-parity` invariant — the text carries the message, the recovery hint, the two fields a caller branches on, and the request id, while the numeric `code` and `data.issues` stay JSON-only:

| Surface | Content | Read by |
|:--------|:--------|:--------|
| `content[]` | Text rendering: `Error: <message>`, then `Recovery: <hint>` when `data.recovery.hint` adds something the message does not already say, then `(reason <reason> · not retryable · request <id>)` for whichever of `data.reason` / `data.retryable` / `data.requestId` is present | Claude Desktop and other format()-only clients |
| `structuredContent.error` | JSON `{ code, message, data? }` carrying the error code, message, any structured data from the thrown `McpError` or a `ZodError`'s bounded issues, and `data.requestId` | Claude Code and other structuredContent-only clients |

```text
Error: No data for 3 PMIDs

Recovery: Use pubmed_search_articles to discover valid PMIDs.

(reason no_match · not retryable · request UTFAC-QE0MB)
```

Important properties:
- **The text is encoded, so throw raw text.** The message, the hint, and `data.reason` render through `escapeMarkdownInline()` (`@cyanheads/mcp-ts-core/utils`), so a CommonMark parse of `content[]` reads each back exactly as `structuredContent.error` carries it — `No running app matches "A*p*".` stays that string rather than rendering `Ap` in emphasis, and an upstream message with a line-leading `- ` stays one paragraph. Plain text renders byte-identically. Backticks or backslashes a handler adds itself show on both surfaces. The repeat check below compares the raw strings.
- **`_meta.error` is NOT emitted.** Error code/data live on `structuredContent.error` instead. Don't read `_meta.error` in clients or tests — it doesn't exist.
- **`data` propagation is restricted** to explicitly-thrown `McpError.data`, `ZodError.issues`, and the request id. Auto-classified plain errors (`TypeError`, network errors, etc.) emit `code`, `message`, and `data: { requestId }` only, so internal classification context never leaks to clients.
- **A `ZodError`'s `data.issues` is bounded on every surface.** A resource `params` rejection, a `ZodError` a tool or resource handler throws (`ctx.state.get(key, schema)` included), and `runToolContract` carry `data.issues` under the caps the argument rejection's has: the first 10 issues and at most 30 in all through union branches, the first 1,024 characters of every string and key, the first 10 entries of every array and keys of every object, and two levels of lists and objects below each issue, with the uncut count or length beside each cut — `issuesCount` beside `data.issues` when it keeps fewer issues than Zod raised at the top level. A `ZodError` within those caps carries Zod's own `issues` array unchanged. The code stays `-32007` (`ValidationError`) and the message stays the first issue's line plus ` (+N more)`. The caller-set path (a record key, a deep path) is cut to its first 1,024 characters, ending `…` when cut; the message after it — Zod's or the author's — is kept whole, so a `z.enum` miss lists every valid option, and the count always shows. Logs and telemetry carry that one-line summary, never Zod's own `message` (its JSON of every issue): the `Error in …` record's log line, the header line of its `stack` (frames kept), a `causeChain` node's `message` and `stack`, `rootCause`, every `ZodError` the log walk writes under any key, the span's exception event and status, a `ctx.log` call's client mirror, an `AggregateError` member's message, `withRetry`'s retry line and exhausted message, and the stdio transport's report of an inbound line that fails the JSON-RPC schema.
- **`data.requestId` names the request.** The framework sets it on every error envelope it builds — a tool result (handler throws, argument rejections, auth refusals, output-contract failures), a failed resource read, a failed prompt, and the JSON-RPC errors `httpErrorHandler` returns — to the `requestId` that call's log records carry. It is always a generated `XXXXX-XXXXX` token, one per call — never the client's JSON-RPC id, which the call's records carry as `jsonRpcId` and the response keeps as its `id`. `httpErrorHandler`'s is the token on its `Client error:` record. A failure reported from the client resolves to its `Error in tool:<name>` record by that value. A resource read refused before it is measured (an auth refusal, or URI variables that fail `params`) carries an id no log record shares, since resources write no failure record of their own. It is added where the envelope is built, never to the thrown `McpError.data`, so `ErrorHandler.handleError` / `tryCatch` results and the log record's `errorData` stay context-free; it replaces a thrown `data.requestId`, the way canonical fields win in log records. Two envelopes go without it: a resource `-32602` whose `data` is exactly `{ uri }` (the resource-not-found shape clients match exactly), and `runToolContract` results, which have no real request. It closes the `content[]` terms line, alone as `(request <id>)` when there is no `reason` or `retryable` — so a test pinning `content[0].text` exactly sees it.
- **Recovery hint mirroring is automatic, unless the hint repeats the message.** When the thrown `McpError` carries `data.recovery.hint`, the handler factory appends it to the `content[]` text so the markdown surface matches the JSON surface. Authors don't need to format the hint manually. The one exception is a hint the trimmed message already contains verbatim (case-sensitively) — an argument rejection whose every hint sentence restates an issue, where the hint is the message's issue text verbatim, and an author hint that restates its own message. There the line adds no next step, so it is dropped from the text; `structuredContent.error.data.recovery.hint` stays populated either way.
- **`reason`, `retryable`, and `requestId` render as a trailing term line.** `(reason malformed_id · not retryable · request UTFAC-QE0MB)` closes the text whenever `data.reason` is a non-empty string, `data.retryable` is a boolean, or `data.requestId` is a non-empty string — `retryable` for `true`, `not retryable` for `false`, in that order. None present (an `McpError` with no `data` built outside a request, as `runToolContract` does) appends nothing at all. The numeric `code` and `data.issues` stay JSON-only on purpose: the code is the one envelope field a model cannot act on, and the message already renders the issues as sentences. A consumer test pinning `content[0].text` exactly, rather than asserting it contains the diagnostic, therefore moves for any error carrying a reason.
- **Argument-schema rejection is a tool error with the same envelope.** An unknown root key, a wrong type, a missing required field, or a failed constraint returns `isError: true` with `structuredContent.error.code = -32602` (`InvalidParams`) and the readable `Invalid arguments for tool <name>: …` diagnostic in `content[]`. The handler never runs. Two neighbouring failures keep the protocol error path instead, arriving as a JSON-RPC error rather than a tool result: an unknown or disabled tool name, and a malformed request envelope.
- **`invalid_arguments` is the framework-owned reason on every argument rejection.** The rejection carries `data.reason: "invalid_arguments"` and a `data.recovery.hint` the framework synthesizes from the Zod issues, the arguments as sent (with any pre-validation repair that held), and the root schema — an unknown root key names the root properties the tool does accept, an unknown key inside a nested strict object names its full path and that object's own keys (`Unknown key opts.b. opts accepts: a.`, `Unknown key items.1.b. items.1 accepts: name.`), a wrong type names the type to send instead (a fractional number on an integer field reads `Send rows as an integer, not a fractional number.`), missing fields collapse into one `Provide …` sentence, and anything else restates its diagnostic line, field path included (`start: Must be a parseable ISO 8601 date`), so identical constraints on different fields stay distinguishable. When every sentence restates an issue, the hint is the message's issue text verbatim, and its `Recovery:` line is dropped from `content[]`. Beside a framework sentence each restatement is terminated and a repeated sentence appears once: `start: Must be a parseable ISO 8601 date. Send n as a number, not a string.` When pre-validation rewrote or dropped a key the caller wrote, the rejection says so, since its issues name only the keys that were validated: `data.input` carries `{ aliased: [{ alias, target }], ignored: [...] }` — keys only, in argument order, `ignored` holding the undeclared underscore-prefixed keys the drop discarded — and the hint closes with `Validated query as targetQuery.` / `Dropped undeclared key _max.`, framework sentences that keep the `Recovery:` line. An ignore-list drop (`_meta`, `toolCallId`, a server's `input.ignoreKeys`) is a client artifact and is never reported, and a rejection the step changed nothing on carries no `data.input`. An alias sent beside its target is never rewritten, and the hint names it as one where it would otherwise read as an unknown or dropped key, with every key the caller sent for that target in argument order: `maxResults is an alias of pageSize; send one of them, not both.`, `maxResults and limit are aliases of pageSize; send one of them, not both. Validated maxResults as pageSize.`, or `send only one of them.` when three or more arrived. A key that is neither a field nor an alias keeps its unknown-key sentence after it, and `data.input` and the message are unchanged. The rejection is bounded whatever the caller sends: the message and the hint render the first 10 issue lines — an unknown-key issue counts once, however many keys and alias collisions it names — each line and hint sentence cut to its first 1,024 characters and ending `…` when cut, then ` (+N more)` for the lines left out (in the hint, before `Validated …` / `Dropped …`), so a cut restatement still equals its message line and the `Recovery:` line still drops. `data.issues` and `data.input` keep the first 10 entries of every array and the first 10 keys of every object, the first 1,024 characters of every string and every key, and two levels of lists and objects below each issue and each object a list holds — a list or object deeper keeps none of its entries — with the uncut count or length beside each cut: `keysCount`, `ignoredCount`, `pathCount`, `messageLength`, `keysLengths`, `paramsCount` beside an object cut to its first keys, `<key>KeyLength` beside a cut key, and an object entry's key count in `<field>Lengths`. A record never takes a kept key's name: a key that a record's name takes, or that a cut makes equal to an earlier key, is left out and counted. Caller data a custom issue carries in its `params` is cut the same way. `data.issues` also keeps at most 30 issues in all, read in document order — each issue, then the issues of its union branches. `issuesCount`, how many issues Zod raised at the top level, sits beside `data.issues` whenever it keeps fewer of them — past the first 10, or sooner when the 30-issue budget runs out — as `errorsCount`, the uncut branch count, sits beside a union's cut branch list and `errorsLengths` beside a cut branch. The message and the hint render each distinct issue once and stop at the 1,024-character cut. A rejection within those caps carries exactly what it always did. The reason renders on the closing `(reason invalid_arguments · request <id>)`; this path sets no `retryable`. Its `Error in tool:<name>` record logs at `notice`, not `error`, with no stack and its caller-sized strings and arrays capped (see `severity` above). Authors declare nothing for this: the rejection happens before the handler and the hint is derived from the schema.
- **`client_capability_missing` is the other framework-owned reason.** When a handler returns `ctx.requestInput({ inputRequests: … })` on a 2025-era connection whose client declared no matching capability, `ctx.requestInput` throws this failure in place of the input-required signal, before anything reaches the wire. It is an ordinary handler throw from there on, logged at `notice` with no stack: measured as the failed call it is, and shaped by the family's usual error path — a tool gets `structuredContent.error.code = -32600` (`InvalidRequest`), `data.reason: "client_capability_missing"`, and a `data.recovery.hint` naming the capability; a resource read gets the same code, reason, and hint through the JSON-RPC error envelope. The hint ends at reconnecting with a client that declares the capability, since a consent gate has no argument that could stand in for its answer; a handler whose arguments can appends its own sentence per call with `ctx.requestInput(spec, { fallbackHint })`. Like `invalid_arguments`, a definition cannot declare it in `errors[]`: it names a property of the connection, not a domain outcome. See `api-context`'s `ctx.requestInput`.
- **A schema constraint cannot carry a *declared* reason.** Because the handler never runs, a rejection by `.max()`, `.regex()`, `.min()`, or any other Zod refinement bypasses `errors[]` entirely: it arrives as `InvalidParams` with `data.issues` under the framework's `invalid_arguments`, never the `reason` and authored `recovery` of a contract entry — so a caller has nothing tool-specific to branch on and gets only the schema-derived hint. Decide per constraint which surface it belongs on. A bound that is purely structural — the input is the wrong shape and no guidance beyond the diagnostic would help — belongs on the schema, where it also advertises itself in `inputSchema`. A bound a caller is expected to recover from belongs in the handler as `ctx.fail('reason', message)` against a declared `errors[]` entry, whose `recovery` the framework puts on the wire, with the limit restated in the field's `.describe()` so it is still visible before the call. Enforcing the same bound in both places is the trap: the schema wins, and the contract entry becomes unreachable while still reading as covered.
- **A rejected value never reaches the client.** The rendered sentence distinguishes an omitted field from a wrong one (`what: Missing required field. Expected one of "os"|"cpu"` rather than the invalid-option text), and a union renders the branch that says what would have been accepted instead of Zod's `Invalid input` placeholder. Both read the arguments in-process for the absent/present bit and the arriving type only — `data.issues` carries the Zod issues as Zod wrote them, bounded as above, and no value the caller sent is copied onto them. That read follows each issue path to the value the failing schema received: below a `z.preprocess()` or a `.transform().pipe()`, the path names the transform's output, so the transform is re-applied in-process. A lone object a preprocess wraps as a list renders exactly as its list form (`items.0.name: …`, never `Provide items.0.name.`), a comma-split item outside its enum reads `Invalid option` — beside a list option of the same union too, which never parsed below the string — and a blank the preprocess maps to `undefined` is hinted `Provide d1.` — as is `null` or a whitespace-only string a transform maps there. Any other value a transform makes `undefined` of, such as `"15"` against an ID-or-name lookup that does not know the name, restates its line (`station: Invalid input: expected number, received undefined`), since the caller sent a value. A wrong type the transform's output schema reports at the transform's own path restates its line instead of `Send … as …`, since the raw type says nothing about which forms the transform accepts. A wrong type below the transform, or one the input side of a `.transform().pipe()` reports about the value as sent, keeps its sentence.
- **A union branch names its own field.** Each branch issue is prefixed with the path it names relative to that branch, so two alternatives differing only in which field they require stay distinguishable: `spec: kind: Invalid option: expected one of "x"|"y"; n: Invalid input: expected number, received undefined or other: Invalid input: expected string, received undefined`. Issues *within* one branch join on `; `, across branches on ` or `, and top-level issues on `, ` — three nestings, three separators. A scalar branch carries no path and renders as before. When every branch fails on one literal at the same path — literal-tagged branches given an unknown or omitted tag — that literal renders once, at its full path, naming every branch's value: `target.kind: Invalid option: expected one of "a"|"b"`, hinted `Provide target.kind.` when the tag was left out. A branch whose one failure is a single-value field the caller left out is never dropped for branches that only say the value is another shape: `{ target: { q: 5 } }` against an object requiring `format: z.enum(["json"])` or a list renders `target.format: Missing required field. Expected "json"`, hinted `Provide target.format.`, not `target: Invalid input: expected array, received object`. `data.issues` still carries the raw nested Zod issues, bounded at every level, and `data.recovery.hint` restates the same line, field path included.
- **A one-or-many union renders like the field it wraps.** Once a union branch fails below its root, every branch whose only issue is a root type mismatch is dropped — for `z.union([z.array(Item), Item])` given a list, that is the object branch saying only that the value is an array. If one branch remains, its issues render and hint under the field's path exactly as they would on a non-union field: `items.1.name: Invalid input: expected string, received boolean`, hinted `Send items.1.name as a string, not a boolean.` A missing element field is hinted `Provide items.1.name.`, and the rule applies again at every nested level. When every branch fails at its root (`items: "x"`), all of them render, joined by ` or `. `data.issues` keeps Zod's single `invalid_union` issue. Pre-validation's repair reads the same list, so it reaches a value inside the surviving branch at the path the hint would name, before any rejection: `ids: [123, "a"]` against `z.union([z.string(), z.array(z.string())])` reaches the handler as `["123", "a"]`.
- **Some rejections never happen at all.** An ordered pre-validation step wraps the parse: a client-added root key is dropped, a declared or case-style key alias is rewritten to its canonical name, and — only after a failed parse — a JSON-stringified array or object, a safe integer sent for a string, a string spelling a number or boolean where only those are accepted, or a lone string sent for an array is repaired, `null` sent for an optional field is deleted, and the arguments are parsed once more. When that still fails and the drop discarded a key, the step retries alias-first. A call the step rescues succeeds outright and produces no error envelope. A call it cannot rescue throws the rejection above, parsed with only the repairs that held applied: a value the schema accepted once repaired appears nowhere in `data.issues`, the message, or the hint — fourteen integer PMIDs against `.max(10)` report only the `too_big` — and a value whose repair the schema refused is reported as sent. The exception is a value that held only written in place under a `z.preprocess()` that reorders or rewrites it: `items: [1, 2]` under one that reverses a list, beside a field that still fails, reports `items.0` and `items.1` as sent, since the issues name positions in the preprocess's output. A call no repair helped therefore gets exactly its `input: { coerce: false }` rejection — same code, message, `data.issues`, `data.input`, and `data.recovery.hint` — and so does one the held repairs alone would validate (only a union or a cross-field refinement allows that), held values included. No rejection says a repair happened. An integer sent to a string field, a `"15"` to a number field, a lone string to a list field, a `null` to an optional field, or a stringified object to an object field is therefore a success, not a wrong-type case — a test that needs a wrong-type rejection sends a boolean to a string, number, or list field, or a non-numeric string to a number field. See the `add-tool` skill for the boundaries and the per-server switches.

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
    context: { extra: { endpoint: 'fetch' } },
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

`tryCatch` always logs and rethrows — it never swallows errors. The `fn` argument may be synchronous or return a `Promise`; both are handled via `Promise.resolve(fn())`. The rethrown `McpError` carries the caught error's stack verbatim, so it starts at the throw site and its first line names the class that was thrown — for a `ZodError`, followed by its one-line summary rather than its JSON of every issue.

**A field that cannot be read is written as `'[Unreadable]'`.** When reading the caught error's `name`, `message`, `stack`, or `cause` throws — a getter, a revoked `Proxy` on `cause` — the record writes that field as `'[Unreadable]'` (the rethrown `McpError` then keeps its own stack), and an unreadable cause ends `causeChain` as a node whose `name` and `message` are both `'[Unreadable]'`. A caught value that cannot be inspected at all, such as a revoked `Proxy`, is handled as a non-Error whose name and message are `'[Unreadable]'`; a caught `McpError` whose `code` cannot be read is classified `InternalError`, and one whose `data` cannot be read or copied (a getter, a revoked `Proxy`) is handled without it, under an `errorMapper` that returns the error it was given too. The record is written and `tryCatch` still throws the rebuilt `McpError`. A tool, resource, or prompt handler that threw such a value — an Error whose `name`, `message`, `stack`, or `cause` cannot be read, an `McpError` whose `code` or `data` cannot be read, a revoked `Proxy` — gets its normal error envelope with `data.requestId`, and its record: the code wherever it can be read, `'[Unreadable]'` for a message that cannot, the thrown `data` left out when it cannot be read, and, for a declared failure, its contract's `recovery` hint. That holds when the value arrives through `withSpan` or through `tryCatch` with an identity `errorMapper`. A `name` or `message` that is not a string is written as text: `String` converts any other primitive (`404` reads `'404'`, a Symbol `'Symbol(…)'`), and an object, whose conversion would run its own `toString`, is `'[Unreadable]'`. Each field of a thrown `McpError`'s `data` that the wire cannot carry — one that throws on read at any depth, a `BigInt`, a cycle, a `toJSON` that throws — is `'[Unreadable]'` on the envelope and in the record, since a response holding it would never be sent and the client would wait; every other field goes out exactly as thrown. `determineErrorCode`, `classifyOnly`, `formatError` (whose `data` is then `{}`), and `mapError` never throw on the value they inspect either.

**The thrown error's `data` is wire-visible.** A handler that lets it propagate forwards it as `structuredContent.error.data` (tools) or JSON-RPC `error.data` (resources, prompts). It carries the caught `McpError`'s own `data`, `originalErrorName`, and `originalMessage` — nothing derived from a cause, never a stack, and never `context`: `rootCause` (`{ name, message }` of the deepest cause), the full `causeChain`, the throw-site stack, and every `context` field (`requestId`, `sessionId`, `traceId`, `tenantId`, `extra`, …) go to the log record only. A message redacted at the throw site therefore stays redacted on the wire while the raw error rides `cause` into the log. A field the caller should act on belongs in the thrown `McpError`'s `data`, not in `context`. (The handler factory adds the call's own `data.requestId` when it builds the envelope; that value never comes from `context` here.)

**Options** (`Omit<ErrorHandlerOptions, 'rethrow'>`):

| Option | Type | Required | Purpose |
|:-------|:-----|:--------:|:--------|
| `operation` | `string` | Yes | Name logged with the error |
| `context` | `ErrorContext` | No | Structured fields merged into the log record only — never the thrown error's client-visible `data`; `requestId` and `timestamp` receive special treatment. The handler's own fields (`errorCode`, the type names, `errorData`, `stack`) lead the record, so the log walk reaches `errorData` before a large `extra` or `input` can spend its bound on what it writes, and no `extra` key replaces one |
| `errorCode` | `JsonRpcErrorCode` | No | Code used if the caught error is not already an `McpError` |
| `input` | `unknown` | No | Input value sanitized and logged alongside the error |
| `critical` | `boolean` | No | Marks the error as critical in logs (default `false`) |
| `includeStack` | `boolean` | No | Stack traces in the log record (default `true`: the record's `stack` is the throw site's — none for a thrown value without a stack, and never the context's `extra.stack` — and each stack is written once: a `causeChain` node carrying the record's stack, or the same stack as the node before it, is written without it). `false` makes the record stack-free, as a cancellation's always is: no `stack`, no `errorData.originalStack`, no `causeChain` node `stack` or node `data.originalStack`, and every `Error` in the record (`errorData`, `input`, the context's `extra`) written without one — whoever supplied the field, a caught `McpError`'s `data` included. Any other key named `stack` is the caller's data, written as given. The chain itself stays; the thrown error and the span exception are unaffected |
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
    data: { endpoint },               // the framework adds data.requestId
  });
}
```

Captures the response body (truncated, configurable limit) and `Retry-After` header (stored as `data.retryAfter`) into `error.data`. The codes it produces line up with `withRetry`'s transient-code set, so retryable responses are retried automatically.

> **`error.data` reaches the client.** It is forwarded to the MCP client as `structuredContent.error.data` (tool errors) or JSON-RPC `error.data` (resource errors). Upstream 401/403/422 responses sometimes echo token claims, internal user IDs, or schema validation hints — that text becomes client-visible. For sensitive endpoints, pass `captureBody: false` (or `bodyLimit: 0`) so the body stays out of `data`. Defaults remain `captureBody: true` because most upstreams return useful diagnostic text and silent dropping helps no one debug. The upstream **URL** defaults the other way and is omitted, since a request URL routinely carries user input, internal identifiers, or an API key in its query string; `includeUrl: true` puts the full `response.url` on `data.url`. The message names the host either way. Response **headers** are opt-in the same way: `errorHeaders: ['x-request-id']` copies the named headers onto `data.headers` under lowercase keys, and everything selected is client-facing — never name a header that carries a credential, and note that a selected `Location` can itself carry a sensitive path, query, or token. `set-cookie` is never captured whatever the selector says.

Full status table:

| Status | Code |
|:-------|:-----|
| 3xx | `InvalidRequest` — reachable when not followed (`redirect: 'manual'`, or no `Location`, a 304 included), and outside `withRetry`'s transient set since re-issuing returns the same redirect |
| 400 | `InvalidParams` |
| 401 | `Unauthorized` |
| 402, 403 | `Forbidden` |
| 404 | `NotFound` |
| 408, 425, 504 | `Timeout` |
| 409, 423, 424 | `Conflict` |
| 422 | `ValidationError` |
| 429 | `RateLimited` |
| 405, 406, 410, 412, 415, 416, 417, 428, 431, 451, 4xx (other) | `InvalidRequest` |
| 500, 501, 502, 503, 5xx (other) | `ServiceUnavailable` |

Also exports `httpStatusToErrorCode(status)` for sync mapping when you don't have a Response object.

---

## Handler-Body Lint Rules

The definition linter (`bun run lint:mcp`, and devcheck's MCP Definitions step) checks handler bodies for common anti-patterns. It runs at build time, never at server startup. All emit warnings (not errors): they show up in `devcheck` output but don't fail it.

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
| `error-contract-severity-unknown` | error | `severity` is present but isn't one of `debug` / `info` / `notice` / `warning`. It selects a logger method at runtime; omit the field for the default `error` level |

### Conformance rules

| Rule | Severity | Catches |
|:-----|:---------|:--------|
| `error-contract-conformance` | warning | Handler throws a non-baseline code that isn't in the contract. Suggests adding it to `errors[]` so the contract is the canonical source of truth for declared failure modes. |
| `error-contract-prefer-fail` | warning | Handler throws a code that **is** in the contract directly (via factory or `new McpError`) instead of through `ctx.fail(reason, …)`. Encourages routing through the typed helper so observers see consistent `data.reason` values. |
| `error-contract-unthrown` | warning | A declared `reason` that no literal `ctx.fail('<reason>'` or `ctx.recoveryFor('<reason>'` in the handler names. Fires only when the handler already holds at least one literal `ctx.fail(`, and skips the definition entirely when either callee takes a non-literal first argument. Wire the throw, drop the entry, or mark it `thrownBy: 'service'`. |

### Baseline codes (auto-allowed)

These codes bubble up from anywhere — services, framework utilities, the auto-classifier — and are implicitly always-possible on any tool. They're skipped by the conformance check, so the contract can stay focused on intentional domain failures:

- `InternalError` — bug, programmer error, truly unexpected
- `ServiceUnavailable` — upstream/network failures
- `Timeout` — request deadline exceeded, abort
- `ValidationError` — schema violations, malformed input
- `SerializationError` — JSON/XML parse failures
- `RequestCancelled` — the caller disconnected or aborted mid-call

If you *want* to declare one of these as a domain-specific failure (e.g., a tool that intentionally times out under defined conditions), put it in `errors[]` anyway — the contract still binds `ctx.fail(reason)` and the conformance lint will catch undeclared throws. The lint just doesn't *require* you to enumerate baselines.

### When to declare vs. let it bubble

The contract describes the **public failure surface** — the failures clients/agents can plan around. Modeled after how OpenAPI-driven frameworks treat 5xx: enumerated 4xx for intentional failures, implicit 5xx for infrastructure.

| Pattern | Use for |
|:--------|:--------|
| `throw ctx.fail('reason', …)` | Declared domain failures — typed, contract-checked, `data.reason` populated |
| `throw notFound(…)` / factories | Errors not in the contract; the auto-classifier handles them. Prefer `ctx.fail` when a matching contract entry exists. |
| Bubble up from services | Upstream classification already produced an `McpError` — don't re-wrap |

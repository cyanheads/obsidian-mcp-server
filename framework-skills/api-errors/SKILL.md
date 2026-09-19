---
name: api-errors
description: >
  McpError constructor, JsonRpcErrorCode reference, and error handling patterns for `@cyanheads/mcp-ts-core`. Use when looking up error codes, understanding where errors should be thrown vs. caught, or using ErrorHandler.tryCatch in services.
metadata:
  author: cyanheads
  version: "1.15"
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
| Runtime | `ctx.fail(reason, msg?, data?, options?)` builds an `McpError(contract.code, msg, { ...data, reason }, options)` — `data.reason` is auto-populated from the contract and cannot be overridden by caller-supplied data (spread first, then `reason` written last), so observers see a stable identifier. `options` accepts `{ cause }` for ES2022 error chaining. |
| Lint (devcheck) | Each `code` validated against `JsonRpcErrorCode`. Reasons validated as snake_case + unique within contract. `recovery` validated as non-empty and ≥ 5 words. Build-time only — not invoked at server startup. |
| Lint (conformance) | If the handler `throw new McpError(JsonRpcErrorCode.X)` outside `ctx.fail`, conformance check warns when X isn't declared. The inverse is checked too: a declared reason no `ctx.fail` in the handler names warns as `error-contract-unthrown` (mark it `thrownBy: 'service'` when the service layer produces it), and a `ctx.fail` site that never forwards the declared `recovery` warns as `error-contract-recovery-unforwarded`. |

> **`recovery` is opt-in resolution, not auto-population.** The contract `recovery` is required metadata documenting the agent's next move when this failure mode fires (a forcing function for thoughtful guidance — placeholders like "Try again." get flagged by the linter). It does **not** automatically appear in runtime `data.recovery.hint` — the framework never injects it without an explicit signal at the throw site. Authors opt in by spreading `ctx.recoveryFor('reason')` into the `data` argument, the same way `ctx.fail('reason')` opts into resolving the contract `code`. What the author types at the throw site is what flows to the wire, with no hidden transformation; the resolver is just a typed lookup keyed by the same `reason` the author already typed.

#### `ctx.recoveryFor` — opt-in contract resolution

`ctx.recoveryFor(reason)` returns `{ recovery: { hint: <contract.recovery> } }` for a declared reason, ready to spread into `data`. Always available on `Context` (returns `{}` when no contract is attached or the reason is unknown — spread-safe with no optional chaining). On `HandlerContext<R>` it tightens to a typed signature constrained to the declared reason union.

Spreading it into the data object and passing it as the data argument are the same call — `ctx.fail` spreads whatever `data` it receives. Spread when the site carries other keys, pass it directly when it carries nothing else. **Forwarding is lint-enforced per throw site:** a `ctx.fail` site that carries neither the resolver nor its own `recovery` key warns as `error-contract-recovery-unforwarded`, because the declared hint then reaches neither client surface and an error-path test asserting `code` and `reason` still passes.

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

> **A recovery hint names a capability, never an internal method.** The reader is a model whose only reachable surface is this server's tool names — it cannot call a TypeScript method, set a library option, or re-run an internal function. `Re-stage the table via registerTable()` is unfollowable and invites a hallucinated tool call; `Re-run the tool that produced this table to stage it again, or list the currently staged tables with this server's dataframe-describe tool` is actionable from where the reader sits. Name a condition the caller cannot observe — an option flag they never set — and the hint is noise for the same reason. The framework holds its own throws to this rule: the canvas SQL gate's rejections point at the dataframe-query and dataframe-describe capabilities rather than the provider methods behind them.

`ctx.recoveryFor` is the first member of a planned **family of opt-in resolution helpers**. Future contract-bound fields (`troubleshootingFor`, `userMessageFor`, …) follow the same shape: single-purpose, spreadable wire-shape, `{}` fallback when not applicable.

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
| The `Error in tool:<name>` log record | Emitted at the declared level. Same message, same structured fields. |
| `mcp.errors.classified` | Gains an `mcp.error.severity` attribute. The `reason` itself never becomes a metric attribute. |
| `isError`, the JSON-RPC code, `structuredContent.error`, `content[]` | Byte-identical to the undeclared case. |
| Span status, `mcp.tool.calls`, `mcp.tool.duration`, `mcp.tool.errors` | Unchanged — the call still failed, and splitting those series would redefine what an error rate means. |

**Tools only.** Resolution happens in the tool handler factory, against the thrown error's `data.reason`. Resources declare `errors[]` but re-throw for the SDK to log, so the field is accepted there and inert. A reason thrown below the handler that the contract never declared, an entry with no `severity`, and a non-`McpError` throw all keep `error`. A cancelled request keeps its own `info`, stack-free path regardless.

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

The handler doesn't catch and re-throw — letting service errors bubble unchanged keeps "logic throws, framework catches" intact. The wire payload still carries `code` + `data.reason`, and clients can switch on reason without parsing message text. What's lost is lint-time enforcement that every reason is reachable; compensate with one wire-shape test per reason.

**Mark the entries the service produces.** `error-contract-unthrown` reads the handler body alone, so in a handler that mixes one local precondition with service-thrown reasons it flags each service reason as dead. Add `thrownBy: 'service'` to those entries:

```ts
errors: [
  { reason: 'empty_expression',   code: JsonRpcErrorCode.ValidationError,
    when: 'Input is empty.',
    recovery: 'Provide a non-empty expression to evaluate.',
    thrownBy: 'service' },
]
```

The field is lint-only metadata — nothing at runtime reads it, so the entry is typed, advertised, and thrown exactly as an unmarked one, and its reason stays in the `ctx.fail` / `ctx.recoveryFor` union. It suppresses the one rule that cannot see below the handler, and only for the entries it marks; the handler's own reasons keep being checked.

To carry the contract `recovery` from a service throw, accept `ctx` and spread the resolver:

```ts
throw validationError(message, {
  reason: 'parse_failed',
  ...ctx.recoveryFor('parse_failed'),  // {} when calling tool has no matching reason
});
```

`ctx.recoveryFor` is always present on `Context` (no-op when no contract), so services don't need to know which tool called them — the spread is safe either way.

---

## When not to throw

Throw when the server has authoritative classification — auth failure, rate limit, schema violation, upstream 5xx, missing required input. Don't throw when "this looks wrong" depends on intent the server can't see. For mutators, surface raw pre- and post-mutation observable state in the response and let the agent decide whether it matches intent — the server can detect that the file shrunk, but only the agent knows whether it was supposed to. Tell: defensive code justified as a free rider on other work — audit it standalone, and it usually doesn't earn its keep.

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
| `RequestCancelled` | -32011 | Caller abandoned the request — client disconnect, external abort signal. Framework-raised; never retried, logged at `info` |
| `SerializationError` | -32070 | Data serialization/deserialization failed |
| `UnknownError` | -32099 | Generic fallback when no other code fits |

---

## Auto-Classification

When a handler throws a plain `Error` (or any non-`McpError` value), the framework classifies it to the most specific `JsonRpcErrorCode` automatically. This matters when you don't control what a third-party library throws and can't predict its error type.

Use factories or `McpError` directly when the code must be exact — auto-classification is best-effort pattern matching and not guaranteed for ambiguous messages. For errors from your own code where the code matters, be explicit.

### Resolution Order

The framework applies these steps in order — first match wins:

1. **Request signal aborted** — `ctx.signal.aborted` is `true` when the handler unwinds → `RequestCancelled`. Resolved by the tool and resource handler factories before the thrown value is classified at all, so it outranks every step below, `McpError` included: the caller withdrew the request, and what the handler threw on the way out does not change that. Covers every shape an abort leaves behind — a `notifications/cancelled` `reason` string, the `DOMException` named `AbortError` a reason-less cancellation produces, a service's own `McpError`, and the SDK's `SdkError(ConnectionClosed)` on transport close. The accepted cost is that an unrelated fault raised after the abort is recorded as a cancellation too; it is bounded, because the SDK writes no response for a request whose signal it aborted. A handler that throws while the signal is live is untouched by this step.
2. **`McpError` instance** — `error.code` is preserved as-is; no classification needed.
3. **SDK transport-closed rejection** — an `SdkError` carrying `SdkErrorCode.ConnectionClosed` → `RequestCancelled`. The SDK rejects every in-flight request when the transport closes, which is what a client disconnect looks like from inside a handler. Matched on the code, not the message: one of its wordings says "aborted" and would otherwise be caught by the generic abort pattern in step 6 and read as a `Timeout`. Still the rule for a throw raised where no request signal is in scope — a service, an outbound leg, a background task.
4. **JS constructor name** — matched against a fixed table (e.g. `ZodError` → `ValidationError`, `SyntaxError` → `ValidationError`). Note: `TypeError` is intentionally excluded — runtime TypeErrors are programmer errors, not validation failures.
5. **Provider-specific patterns** — HTTP status codes, AWS exception names, Supabase, OpenRouter. Checked before common patterns because they are more specific (e.g. `status code 429` beats the generic `rate limit` pattern).
6. **Common message/name patterns** — broad keyword patterns covering auth, not-found, validation, etc. First match wins; order matters.
7. **`AbortError` name** — `error.name === 'AbortError'` → `Timeout`.
8. **Fallback** — `InternalError`.

However it is reached, a `RequestCancelled` is logged at `info` with no stack — neither the thrown value's own nor one reached through its cause chain. Step 1 settles the completion log too, which carries `metrics.errorCode: "-32011"` alongside `isSuccess: false`; a raw `SdkError` that reaches the code through step 3 alone is not an `McpError`, so that log still reads `UNHANDLED_ERROR`.

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
| Services/setup code | `ErrorHandler.tryCatch` for structured logging and wrapping (always rethrows — never swallows) |

### Error-path parity

MCP clients differ in which `CallToolResult` surface they forward to the agent. Tool errors mirror the success-path `format-parity` invariant — the text carries the message, the recovery hint, and the two fields a caller branches on, while the numeric `code` and `data.issues` stay JSON-only:

| Surface | Content | Read by |
|:--------|:--------|:--------|
| `content[]` | Text rendering: `Error: <message>`, then `Recovery: <hint>` when `data.recovery.hint` adds something the message does not already say, then `(reason <reason> · not retryable)` for whichever of `data.reason` / `data.retryable` is present | Claude Desktop and other format()-only clients |
| `structuredContent.error` | JSON `{ code, message, data? }` carrying the error code, message, and any structured data from the thrown `McpError` or `ZodError` | Claude Code and other structuredContent-only clients |

Important properties:
- **`_meta.error` is NOT emitted.** Error code/data live on `structuredContent.error` instead. Don't read `_meta.error` in clients or tests — it doesn't exist.
- **`data` propagation is restricted** to explicitly-thrown `McpError.data` and `ZodError.issues`. Auto-classified plain errors (`TypeError`, network errors, etc.) emit `code` + `message` only — no `data` — so internal classification context never leaks to clients.
- **Recovery hint mirroring is automatic, unless the hint repeats the message.** When the thrown `McpError` carries `data.recovery.hint`, the handler factory appends it to the `content[]` text so the markdown surface matches the JSON surface. Authors don't need to format the hint manually. The one exception is a hint the trimmed message already contains verbatim (case-sensitively) — a constraint or refinement rejection, whose synthesized hint is the issue's own message, and an author hint that restates its own message. There the line adds no next step, so it is dropped from the text; `structuredContent.error.data.recovery.hint` stays populated either way.
- **`reason` and `retryable` render as a trailing term line.** `(reason malformed_id · not retryable)` closes the text whenever `data.reason` is a non-empty string or `data.retryable` is a boolean — `retryable` for `true`, `not retryable` for `false`, and both terms when both are present. Neither field present (a classified plain `Error`, an `McpError` with no `data`) appends nothing at all. The numeric `code` and `data.issues` stay JSON-only on purpose: the code is the one envelope field a model cannot act on, and the message already renders each issue as a sentence. A consumer test pinning `content[0].text` exactly, rather than asserting it contains the diagnostic, therefore moves for any error carrying a reason.
- **Argument-schema rejection is a tool error with the same envelope.** An unknown root key, a wrong type, a missing required field, or a failed constraint returns `isError: true` with `structuredContent.error.code = -32602` (`InvalidParams`) and the readable `Invalid arguments for tool <name>: …` diagnostic in `content[]`. The handler never runs. Two neighbouring failures keep the protocol error path instead, arriving as a JSON-RPC error rather than a tool result: an unknown or disabled tool name, and a malformed request envelope.
- **`invalid_arguments` is the framework-owned reason on every argument rejection.** The rejection carries `data.reason: "invalid_arguments"` and a `data.recovery.hint` the framework synthesizes from the Zod issues, the arguments as sent, and the root schema — an unknown key names the root properties the tool does accept, a wrong type names the type to send instead, missing fields collapse into one `Provide …` sentence, and anything else carries its own diagnostic. The hint rides `content[]` as `Recovery: …` like any other — dropped only when the message already contains it, which is what the fallback for a constraint or refinement issue produces. The reason renders as the closing `(reason invalid_arguments)`; this path sets no `retryable`. Authors declare nothing for this: the rejection happens before the handler and the hint is derived from the schema.
- **`client_capability_missing` is the other framework-owned reason.** When a handler returns `ctx.requestInput({ inputRequests: … })` on a 2025-era connection whose client declared no matching capability, `ctx.requestInput` throws this failure in place of the input-required signal, before anything reaches the wire. It is an ordinary handler throw from there on: measured as the failed call it is, and shaped by the family's usual error path — a tool gets `structuredContent.error.code = -32600` (`InvalidRequest`), `data.reason: "client_capability_missing"`, and a `data.recovery.hint` naming the capability; a resource read gets the same code, reason, and hint through the JSON-RPC error envelope. Like `invalid_arguments`, a definition cannot declare it in `errors[]`: it names a property of the connection, not a domain outcome. See `api-context`'s `ctx.requestInput`.
- **A schema constraint cannot carry a *declared* reason.** Because the handler never runs, a rejection by `.max()`, `.regex()`, `.min()`, or any other Zod refinement bypasses `errors[]` entirely: it arrives as `InvalidParams` with `data.issues` under the framework's `invalid_arguments`, never the `reason` and authored `recovery` of a contract entry — so a caller has nothing tool-specific to branch on and gets only the schema-derived hint. Decide per constraint which surface it belongs on. A bound that is purely structural — the input is the wrong shape and no guidance beyond the diagnostic would help — belongs on the schema, where it also advertises itself in `inputSchema`. A bound a caller is expected to recover from belongs in the handler as `ctx.fail('reason', message, ctx.recoveryFor('reason'))` against a declared `errors[]` entry, with the limit restated in the field's `.describe()` so it is still visible before the call. Enforcing the same bound in both places is the trap: the schema wins, and the contract entry becomes unreachable while still reading as covered.
- **A rejected value never reaches the client.** The rendered sentence distinguishes an omitted field from a wrong one (`what: Missing required field. Expected one of "os"|"cpu"` rather than the invalid-option text), and a union renders the branch that says what would have been accepted instead of Zod's `Invalid input` placeholder. Both read the arguments in-process for the absent/present bit and the arriving type only — `data.issues` ships the Zod issues as-is, and no value the caller sent is copied onto them.
- **A union branch names its own field.** Each branch issue is prefixed with the path it names relative to that branch, so two alternatives differing only in which field they require stay distinguishable: `spec: kind: Invalid option: expected one of "x"|"y"; n: Invalid input: expected number, received undefined or other: Invalid input: expected string, received undefined`. Issues *within* one branch join on `; `, across branches on ` or `, and top-level issues on `, ` — three nestings, three separators. A scalar branch carries no path and renders as before. `data.issues` still ships the raw nested Zod issues, and `data.recovery.hint` carries the same prefixed text.
- **Some rejections never happen at all.** An ordered pre-validation step wraps the parse: a client-added root key is dropped, a declared or case-style key alias is rewritten to its canonical name, and — only after a failed parse — a JSON-stringified array is repaired and the arguments parsed once more. A call the step rescues succeeds outright and produces no error envelope; a call it cannot rescue throws the rejection above verbatim, same code, message, `data.issues`, and `data.recovery.hint`. See the `add-tool` skill for the boundaries and the per-server switches.

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

> **`error.data` reaches the client.** It is forwarded to the MCP client as `structuredContent.error.data` (tool errors) or JSON-RPC `error.data` (resource errors). Upstream 401/403/422 responses sometimes echo token claims, internal user IDs, or schema validation hints — that text becomes client-visible. For sensitive endpoints, pass `captureBody: false` (or `bodyLimit: 0`) so the body stays out of `data`. Defaults remain `captureBody: true` because most upstreams return useful diagnostic text and silent dropping helps no one debug. The upstream **URL** defaults the other way and is omitted, since a request URL routinely carries user input, internal identifiers, or an API key in its query string; `includeUrl: true` puts the full `response.url` on `data.url`. The message names the host either way. Response **headers** are opt-in the same way: `errorHeaders: ['x-request-id']` copies the named headers onto `data.headers` under lowercase keys, and everything selected is client-facing — never name a header that carries a credential, and note that a selected `Location` can itself carry a sensitive path, query, or token. `set-cookie` is never captured whatever the selector says.

Full status table:

| Status | Code |
|:-------|:-----|
| 3xx | `InvalidRequest` — reachable under `redirect: 'manual'`, and outside `withRetry`'s transient set since re-issuing returns the same redirect |
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
| `error-contract-severity-unknown` | error | `severity` is present but isn't one of `debug` / `info` / `notice` / `warning`. It selects a logger method at runtime; omit the field for the default `error` level |

### Conformance rules

| Rule | Severity | Catches |
|:-----|:---------|:--------|
| `error-contract-conformance` | warning | Handler throws a non-baseline code that isn't in the contract. Suggests adding it to `errors[]` so the contract is the canonical source of truth for declared failure modes. |
| `error-contract-prefer-fail` | warning | Handler throws a code that **is** in the contract directly (via factory or `new McpError`) instead of through `ctx.fail(reason, …)`. Encourages routing through the typed helper so observers see consistent `data.reason` values. |
| `error-contract-unthrown` | warning | A declared `reason` that no literal `ctx.fail('<reason>'` or `ctx.recoveryFor('<reason>'` in the handler names. Fires only when the handler already holds at least one literal `ctx.fail(`, and skips the definition entirely when either callee takes a non-literal first argument. Wire the throw, drop the entry, or mark it `thrownBy: 'service'`. |
| `error-contract-recovery-unforwarded` | warning | A literal `ctx.fail('<reason>', …)` site carrying neither `ctx.recoveryFor('<reason>')` nor its own `recovery` key, so the declared hint reaches neither client surface. One diagnostic per site; skips a site whose data argument the scan cannot read. |

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

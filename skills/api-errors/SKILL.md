---
name: api-errors
description: >
  McpError constructor, JsonRpcErrorCode reference, and error handling patterns for `@cyanheads/mcp-ts-core`. Use when looking up error codes, understanding where errors should be thrown vs. caught, or using ErrorHandler.tryCatch in services.
metadata:
  author: cyanheads
  version: "1.0"
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

## Error Factories (Preferred)

Shorter than `new McpError(...)` and self-documenting. All return `McpError` instances. All accept an optional `options` parameter for error chaining via `{ cause }`.

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

`options` is `{ cause?: unknown }` — the standard ES2022 `ErrorOptions` type.

---

## McpError Constructor

For codes not covered by factories (InternalError, DatabaseError, etc.):

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
| `TypeError` | `ValidationError` |
| `RangeError` | `ValidationError` |
| `URIError` | `ValidationError` |
| `ReferenceError` | `InternalError` |
| `EvalError` | `InternalError` |
| `AggregateError` | `InternalError` |

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
| Handler factory | Catches all errors, normalizes to `McpError`, sets `isError: true` |
| Services/setup code | `ErrorHandler.tryCatch` for graceful recovery |

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

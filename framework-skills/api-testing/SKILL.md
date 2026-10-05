---
name: api-testing
description: >
  Testing patterns for MCP tool/resource handlers using `createMockContext` and Vitest. Covers mock context options, handler testing, McpError assertions, format testing, Vitest config setup, and test isolation conventions.
metadata:
  author: cyanheads
  version: "1.14"
  audience: external
  type: reference
---

## Overview

Tests target handler behavior directly — call `handler(input, ctx)`, assert on the return value or thrown error. The framework's handler factory (try/catch, formatting, telemetry) is not involved. Use `createMockContext` from `@cyanheads/mcp-ts-core/testing` to construct the `ctx` argument.

**Additional exports from `/testing`:** `createMockSession()` binds a mock handler context to an HTTP session; `createFetchMock()` provides a strict upstream HTTP fake; `runToolContract()` executes a definition through schema, handler, formatting, enrichment/content, and production-shaped error-envelope checks. `createMockLogger()` returns a standalone `MockContextLogger`, `createInMemoryStorage(options?)` provides a real `StorageService` backed by `InMemoryProvider`, and `expectInputRequired(run)` returns the `input_required` result a multi-round-trip handler asked for (see [Mock inputs](#mock-inputs)).

**Other testing subpaths:** `/testing/vitest` (fixtures and conformance suites, below), `/testing/fuzz` (see [Fuzz testing](#fuzz-testing)), and `/testing/apps`, whose `renderAppTool` renders an app tool's `ui://` view against your server (a stdio command or an HTTP URL) in a headless MCP Apps host and reports initialization, errors, CSP violations, the view↔host messages, and screenshots. It needs the optional peers `@modelcontextprotocol/client` and `@modelcontextprotocol/ext-apps` plus a `chrome-headless-shell` build; the `field-test` skill covers installing one and reading the report.

**Philosophy:** Test behavior, not implementation. Refactors should not break tests. Match the repo's existing test layout: fresh scaffolds use `tests/`, while colocated `src/**/*.test.ts` files are also supported. Integration tests at I/O boundaries over unit tests of internals.

---

## `mcpTest` — fixture-based Vitest test

`mcpTest` is a `test.extend`-based Vitest test that provides `ctx`, `session`, `fetchMock`, and `storage` as **per-test fixtures** — fresh instances for every test, eliminating boilerplate and enforcing isolation automatically. `fetchMock` is installed as `globalThis.fetch` only when requested by a test and restored afterward.

```ts
import { mcpTest } from '@cyanheads/mcp-ts-core/testing/vitest';

mcpTest('echoes the message', async ({ ctx }) => {
  const result = await echoTool.handler(echoTool.input.parse({ message: 'hi' }), ctx);
  expect(result.message).toBe('hi');
});

mcpTest('uses storage fixture', async ({ ctx, storage }) => {
  const svc = new MyService(config, storage);
  const result = await svc.doWork(ctx);
  expect(result).toBeDefined();
});

mcpTest('stubs an upstream HTTP boundary', async ({ fetchMock }) => {
  fetchMock.route({
    match: 'https://api.example.test/items/42',
    respond: Response.json({ id: '42' }),
  });
  await expect(loadItem('42')).resolves.toMatchObject({ id: '42' });
});
```

### Fixtures

| Fixture | Type | Per-test? | Notes |
|:--------|:-----|:----------|:------|
| `ctx` | `Context` | Yes | Fresh `createMockContext()` each test |
| `session` | `MockSession` | Yes | Fresh `{ sessionId, tenantId, ctx }` from `createMockSession()` |
| `fetchMock` | `FetchMockHarness` | Yes | Strict fetch fake installed/restored around the requesting test |
| `storage` | `StorageService` | Yes | Fresh `createInMemoryStorage()` each test |

### Extending with the function form

Override fixtures using the **function form** (`async ({}, use) => { ... }`) to preserve per-test freshness. A bare-value override shares one mutable instance across the entire file — defeating the fixture's isolation guarantee.

```ts
import { createMockContext } from '@cyanheads/mcp-ts-core/testing/vitest';

// Correct — function form gives each test a fresh context:
const tenantTest = mcpTest.extend({
  ctx: async ({}, use) => { await use(createMockContext({ tenantId: 'test-tenant' })); },
});

// Wrong — bare value shares one ctx across every test in the file:
// const tenantTest = mcpTest.extend({ ctx: createMockContext({ tenantId: 'test-tenant' }) });
```

The portable `/testing` helpers are re-exported from `@cyanheads/mcp-ts-core/testing/vitest` so fixture overrides don't need a second import.

---

## Upstream HTTP testing with `createFetchMock`

Use the fetch harness at real outbound I/O boundaries. Stub the external service, not server-owned services or handlers.

```ts
import { createFetchMock } from '@cyanheads/mcp-ts-core/testing';

const http = createFetchMock([
  {
    method: 'GET',
    match: 'https://api.example.test/items/42',
    respond: Response.json({ id: '42', name: 'Example' }),
  },
]);

http.install();
try {
  await expect(loadItem('42')).resolves.toEqual({ id: '42', name: 'Example' });
  expect(http.calls[0]?.request.url).toBe('https://api.example.test/items/42');
} finally {
  http.restore();
}
```

Routes match in registration order. `match` accepts an exact URL, `RegExp`, or request predicate; `respond` accepts a static `Response` or a response factory. A static response's body is read once, on the route's first match, and every call is served a fresh `Response` over those bytes with the same `status`, `statusText`, and headers — so a consumer that cancels the body, or an error-body reader like `httpErrorFromResponse` that stops past its cap, settles on Node as on Bun. Set `once: true` for one-shot behavior. Unmatched requests throw unless `onUnhandled` is provided.

**A request predicate routes on the URL's origin, never a prefix.** `req.url.startsWith(BASE_URL)` also matches a lookalike host (`https://api.example.test.evil.com/...`), which CodeQL reports as high-severity incomplete URL substring sanitization — it scans test files as readily as `src/`, so a suite that is green locally still fails the security check on a pull request. Parse the URL and compare origins, matching the path separately:

```ts
match: (req) => {
  const url = new URL(req.url);
  return url.origin === new URL(BASE_URL).origin && url.pathname.startsWith('/items/');
},
```

---

## Tool conformance with `toolContractSuite`

Point the reusable suite at a definition plus representative success and failure inputs. It checks input/output schemas, invokes the real handler, applies formatting/enrichment/content, and validates both public error surfaces.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';

toolContractSuite(searchTool, {
  success: [{ name: 'returns matches', input: { query: 'mcp' } }],
  errors: [{
    name: 'reports an empty query',
    input: { query: '' },
    code: JsonRpcErrorCode.InvalidParams,
    reason: 'empty_query',
  }],
});
```

Use `runToolContract(definition, input, { context })` from `/testing` when a custom test runner or an imperative assertion is a better fit. It intentionally skips transport auth and telemetry; those belong in transport/integration tests.

A declared reason thrown without a hint — a bare `ctx.fail('reason')` or a service throw carrying `{ reason }` — comes back with the entry's `recovery` as `data.recovery.hint` and a `Recovery:` line in `content[]`, as in production. The one production field it leaves out is `data.requestId` (and the `request <id>` term closing `content[]`), since there is no real request; a test asserting the factory's envelope instead expects both. Calling `definition.handler(...)` directly returns the `McpError` exactly as the throw site built it — no fill, no request id.

Arguments that fail the `input` schema are rejected the way the production handler factory rejects them: `InvalidParams` (`-32602`), with a message naming the tool and every failing field. That is the code a client sees on the wire, so assert it — not `ValidationError` (`-32007`), which stays the classification for a `ZodError` a handler throws itself. A result that breaks the tool's own `output` or `enrichment` schema is the definition's bug, so it returns `InternalError` (`-32603`) with a message naming that contract, exactly as in production.

Cancellation settles as it does in production. Pass `context: { signal }` and abort it: once the signal has fired, whatever the handler — or the output validation, `format()`, and enrichment after it — throws comes back as `RequestCancelled` (`-32011`), whether that is the signal's `AbortError`, its reason string, a `withRetry` backoff that stopped, or an `McpError` of the handler's own. A throw while the signal is still live keeps its own classification, and argument parsing stays outside the settle, so schema-invalid arguments on an aborted signal still return `InvalidParams`. A `toolContractSuite` error case with an aborted `context.signal` asserts `code: JsonRpcErrorCode.RequestCancelled` the same way.

**Resources have no contract runner.** A resource definition's `handler(...)` called directly returns the throw site's `McpError` with no recovery fill, so asserting a resource's declared `errors[]` hints needs a path through the resource factory. Serve the definition from `createWorkerHandler({ name, title, resources: [def] })` (`/worker`) and `fetch` it a `resources/read` JSON-RPC request carrying the current protocol revision in both the `MCP-Protocol-Version` header and `params._meta`. The response is plain JSON or an SSE `data:` frame, and its `error` carries `code`, `data.reason`, and the filled `data.recovery.hint`.

---

## `createMockContext` options

```ts
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

createMockContext()                                           // working ctx.state on tenant 'default'
createMockContext({ tenantId: 'test-tenant' })               // explicit tenant scope for ctx.state
createMockContext({ errors: myTool.errors })                 // attaches typed ctx.fail keyed by the contract reasons
createMockContext({ inputResponses: { confirm: { action: 'accept', content: { ok: true } } } }) // second round of a multi-round-trip handler
createMockContext({ requestState: 'opaque-state' })          // seeds ctx.inputs.state()
createMockContext({ clientCapabilities: { roots: {} } })     // seeds ctx.clientCapabilities and filters inputResponses to declared kinds
createMockContext({ requestId: 'my-id' })                    // override request ID (default: 'test-request-id')
createMockContext({ notifyResourceListChanged: () => {} })   // with resource-list change notifier
createMockContext({ notifyResourceUpdated: (_uri) => {} })   // with resource update notifier
createMockContext({ signal: controller.signal })             // custom AbortSignal
createMockContext({ auth: { clientId: 'test', scopes: [], sub: 'test-user' } }) // with auth context
createMockContext({ uri: new URL('myscheme://item/123') })   // for resource handler testing
```

`MockContextOptions` interface:

```ts
interface MockContextOptions<TErrors extends readonly ErrorContract[] | undefined> {
  auth?: AuthContext;
  clientCapabilities?: ClientCapabilities;
  errors?: TErrors | undefined;
  inputResponses?: InputResponses | Record<string, unknown>;
  notifyPromptListChanged?: () => void;
  notifyResourceListChanged?: () => void;
  notifyResourceUpdated?: (uri: string) => void;
  notifyToolListChanged?: () => void;
  requestId?: string;
  requestState?: unknown;
  sessionId?: string;
  signal?: AbortSignal;
  tenantId?: string;
  uri?: URL;
}
```

| Option | Effect |
|:-------|:-------|
| _(none)_ | Working `ctx.state` on tenant `'default'`; `ctx.inputs` is empty (first round) |
| `auth` | Sets `ctx.auth` for scope-checking tests |
| `clientCapabilities` | Sets `ctx.clientCapabilities` (`undefined` when omitted) and applies the production filter to `inputResponses`: only the answers these capabilities cover reach `ctx.inputs` (elicit → `elicitation`, and `elicitation.form` when it carries `content`; sampling → `sampling`, and `sampling.tools` when it holds a `tool_use` / `tool_result` block; roots → `roots`). Omitted, every seeded response reaches `ctx.inputs`, so existing `{ inputResponses }` tests are unaffected. The mock's `ctx.requestInput` stays ungated either way |
| `errors` | Attaches a typed `ctx.fail` against the contract — same wiring the production handler factory uses. Pass `myTool.errors` directly; the return type narrows to `HandlerContext<ReasonOf<…>>`, so the context is assignable to that definition's handler parameter. |
| `inputResponses` | Seeds `ctx.inputs` with the responses a retried request would carry, keyed by the identifiers the handler's `ctx.requestInput(...)` assigned (see below) |
| `notifyPromptListChanged` | Assigns `ctx.notifyPromptListChanged` for prompt-list change notification tests |
| `notifyResourceListChanged` | Assigns `ctx.notifyResourceListChanged` for resource notification tests |
| `notifyResourceUpdated` | Assigns `ctx.notifyResourceUpdated` for resource update notification tests |
| `notifyToolListChanged` | Assigns `ctx.notifyToolListChanged` for tool-list change notification tests |
| `requestId` | Overrides `ctx.requestId` (default: `'test-request-id'`) |
| `requestState` | Seeds `ctx.inputs.state()` — the opaque state a prior round attached |
| `sessionId` | Sets `ctx.sessionId` for handlers that branch on session ID |
| `signal` | Overrides `ctx.signal` — useful for cancellation testing |
| `tenantId` | Scopes `ctx.state` to a specific tenant. Defaults to `'default'` — the value stdio (and HTTP with `MCP_AUTH_MODE=none`) resolves |
| `uri` | Sets `ctx.uri` for resource handler testing |

### Mock state

`ctx.state` is a real `StorageService` over an `InMemoryProvider` — the production storage path, not a `Map`. A test therefore sees the same rules a deployed server enforces:

- **Keys** match `^[a-zA-Z0-9_.\-/]+$` and may not contain `..`. Colons are rejected, so `cache:v1:abc` throws `McpError(ValidationError)` in the test exactly as it would in a deployment; use `cache/v1/abc`.
- **Values** round-trip as JSON, as on every persistent provider. A read returns a fresh object in its JSON form — a `Date` reads back as its ISO string — so a test cannot pass on identity or on a `Date`/`Map` surviving storage. A value JSON cannot encode (`bigint`, a cyclic reference, a top-level `undefined`, function, or symbol) rejects with `McpError(SerializationError)`.
- **TTL** is honored. An entry written with `{ ttl: 30 }` reads back as `null` once 30 seconds elapse — drive the clock with `vi.useFakeTimers()` to assert expiry.
- **`getMany` / `setMany` / `deleteMany` / `list`** validate every key and prefix, and `list` paginates with the same opaque cursors.
- **Cancellation** applies: once `ctx.signal` aborts, state operations reject.

```ts
const ctx = createMockContext();

await ctx.state.set('cache/v1/abc', { hits: 1 }, { ttl: 30 });
await expect(ctx.state.get('cache/v1/abc')).resolves.toEqual({ hits: 1 });
await expect(ctx.state.set('cache:v1:abc', {})).rejects.toThrow(McpError);

await ctx.state.set('seen/abc', { at: new Date('2026-01-01T00:00:00Z') });
await expect(ctx.state.get('seen/abc')).resolves.toEqual({ at: '2026-01-01T00:00:00.000Z' });
```

Reach for `createInMemoryStorage()` when a service takes a `StorageService` directly — it builds the same pair.

### Mock inputs

`ctx.requestInput` is the real implementation: it throws an `InputRequiredSignal` the production handler factories convert into an `input_required` result. In a unit test the handler is called directly, so that signal surfaces as a thrown value — which is exactly how you assert the first round. The examples below drive `export_report` from `api-context` § *The shape of a multi-round-trip handler*, which asks for a format the caller left out:

```ts
import { isInputRequiredSignal } from '@cyanheads/mcp-ts-core';

it('asks for the format on the first round', async () => {
  const ctx = createMockContext();
  await expect(exportReport.handler(exportReport.input.parse({ reportId: 'r1' }), ctx))
    .rejects.toSatisfy(isInputRequiredSignal);
});
```

To assert on *what* was requested, use `expectInputRequired` from `/testing`. It runs the handler and returns the `input_required` result the handler factory would have returned; it throws when the handler returns normally, and any other error propagates untouched:

```ts
import { createMockContext, expectInputRequired } from '@cyanheads/mcp-ts-core/testing';

const asked = await expectInputRequired(() => exportReport.handler(input, createMockContext()));
expect(asked.inputRequests?.format?.method).toBe('elicitation/create');
```

Pass `asked.requestState` back as `createMockContext({ requestState })` when the handler reads state from the prior round. `inputResponses` drives the second round. `ctx.inputs.accepted(key, schema)` and `.view(key)` read it with the same helpers production uses, so a wrong response shape fails in the test:

```ts
it('exports in the format the user picked', async () => {
  const ctx = createMockContext({
    inputResponses: { format: { action: 'accept', content: { format: 'csv' } } },
  });
  await expect(exportReport.handler(input, ctx)).resolves.toMatchObject({ url: expect.any(String) });
});

it('stops when the user declines', async () => {
  const ctx = createMockContext({
    inputResponses: { format: { action: 'decline' } },
  });
  await expect(exportReport.handler(input, ctx)).rejects.toThrow(McpError);
});
```

Seeding an answer this way is right for a handler that treats it as input. A consent gate does not: it acts only on a record it stored when it asked, so an answer seeded alone makes it ask again — see below.

`ctx.inputs.dropped` is always `[]` on a mock context — the drop only happens in the SDK's wire decoding, so cover it in an integration test rather than a unit one.

Seed `clientCapabilities` to test what a client without a capability gets: a pre-answered `inputResponses` the declared capabilities do not cover — a kind never declared, a form answer (one carrying `content`) from a client that declared only `elicitation.url`, a tool-use sampling answer without `sampling.tools` — never reaches `ctx.inputs`, so the handler asks again. A handler that falls through when a capability is missing (`if (ctx.clientCapabilities?.roots) … else …`) is tested by seeding both shapes.

A consent gate that redeems a `ctx.state` record (see `api-context` § *Consent gates*) needs the record in the second round's storage, and each mock context has its own. Copy what round one stored into the round-two context. The record carries the caller, so seed the same `auth` (or none) on both:

```ts
const accept = { confirm: { action: 'accept', content: { confirm: true } } };

const first = createMockContext();
const asked = await expectInputRequired(() => deletePath.handler(input, first));
const record = await first.state.get(`consent/${asked.requestState}`);

const second = createMockContext({ inputResponses: accept, requestState: asked.requestState });
await second.state.set(`consent/${asked.requestState}`, record);
await expect(deletePath.handler(input, second)).resolves.toEqual({ deleted: input.path });

// The record is spent: the same state again asks for a fresh confirmation.
await expect(deletePath.handler(input, second)).rejects.toSatisfy(isInputRequiredSignal);

// An answer with no record behind it asks as well — nothing was asked, so nothing was confirmed.
const unasked = createMockContext({ inputResponses: accept });
await expect(deletePath.handler(input, unasked)).rejects.toSatisfy(isInputRequiredSignal);
```

A record the round-two context holds under another `auth`, or one written by another tool (its `operation` differs), asks again the same way — cover whichever of those the handler's binding is meant to catch.

### Mock logger

`ctx.log` captures all log calls for inspection. Import `MockContextLogger` from `@cyanheads/mcp-ts-core/testing` and cast `ctx.log` to access the `.calls` array (the cast is necessary because `createMockContext` returns `Context`, which types `log` as `ContextLogger`):

```ts
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';

const ctx = createMockContext();
const log = ctx.log as MockContextLogger;

await myTool.handler(input, ctx);
expect(log.calls.some(c => c.level === 'info' && c.msg.includes('Processing'))).toBe(true);
```

---

## Full test example

```ts
// tests/tools/my-tool.tool.test.ts
import { describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { myTool } from '@/mcp-server/tools/definitions/my-tool.tool.js';

describe('myTool', () => {
  it('returns expected output', async () => {
    const ctx = createMockContext();
    const input = myTool.input.parse({ query: 'hello' });
    const result = await myTool.handler(input, ctx);
    expect(result.result).toBe('Found: hello');
  });

  it('throws on invalid state', async () => {
    const ctx = createMockContext();
    const input = myTool.input.parse({ query: 'TRIGGER_ERROR' });
    await expect(myTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats response completely', () => {
    const result = { result: 'test' };
    const blocks = myTool.format!(result);
    expect(blocks[0].type).toBe('text');
    expect((blocks[0] as { text?: string }).text).toContain('test');
  });
});
```

Parse input through `myTool.input.parse(...)` to validate against the Zod schema and produce the typed input the handler expects. Call `myTool.handler(input, ctx)` directly, not through the MCP SDK or any framework wrapper. Assert on the return value for happy paths; use `.rejects.toThrow()` for error paths. Test `format` separately if the tool defines one — it's a pure function and needs no `ctx`. Verify the rendered text includes the fields the LLM needs, and for projection-style tools, add a case with non-default field selections.

---

## Testing with form-based client payloads

LLM clients only send populated fields. **Form-based clients** (MCP Inspector, web UIs) submit the full schema shape — optional object fields arrive with empty-string inner values instead of `undefined`. Both are valid MCP usage. Test that handlers handle both gracefully.

```ts
describe('form-client payloads', () => {
  it('skips optional object when inner fields are empty strings', async () => {
    const ctx = createMockContext();
    // Form client sends the object with empty values instead of omitting it
    const input = myTool.input.parse({
      query: 'test',
      dateRange: { minDate: '', maxDate: '' },
    });
    const result = await myTool.handler(input, ctx);
    // Should succeed — empty dateRange is ignored, not passed downstream
    expect(result.items).toBeDefined();
  });

  it('uses optional object when inner fields have real values', async () => {
    const ctx = createMockContext();
    const input = myTool.input.parse({
      query: 'test',
      dateRange: { minDate: '2025-01-01', maxDate: '2025-12-31' },
    });
    const result = await myTool.handler(input, ctx);
    // Should apply the date filter
    expect(result.items).toBeDefined();
  });
});
```

The pattern: parse through the schema (confirms Zod accepts the payload), call the handler, assert the empty-value case produces correct results — no errors, no corrupted downstream queries. Same applies to optional arrays: test with `[]` to verify the handler skips rather than passes through.

---

## Testing with sparse upstream payloads

This is a different problem from form-client `''` payloads. Here the upstream API omits fields entirely. The risk is either a validation failure from an over-strict schema or a quiet lie where missing data turns into a concrete fact.

```ts
describe('sparse upstream payloads', () => {
  it('preserves missing upstream fields as unknown', async () => {
    const upstream = {
      id: 'repo-123',
      name: 'Widget Repo',
      // archived and star_count omitted entirely
    };

    const normalized = normalizeRepo(upstream);
    expect(normalized).toEqual({
      id: 'repo-123',
      name: 'Widget Repo',
    });

    const output = repoSearchTool.output.parse({
      repos: [normalized],
    });
    const blocks = repoSearchTool.format!(output);
    expect((blocks[0] as { text: string }).text).toContain('Archived:** Not available');
    expect((blocks[0] as { text: string }).text).not.toContain('Archived:** No');
  });
});
```

**What to verify:**

- Fixtures omit fields entirely, not just set them to `null` or `''`.
- Normalization/helpers tolerate missing fields without fabricating defaults.
- Handler output still validates against the declared output schema.
- `format()` uses explicit unknown-state fallbacks instead of inventing facts.
- Tool-semantic defaults are tested separately from upstream absence so the distinction stays clear.

---

## Vitest config

Extend the framework's base config using `mergeConfig`. The base provides `globals: true`, `pool: 'forks'`, `isolate: true`, `tsconfigPaths`, and a Zod SSR compatibility fix. Add only the `@/` alias for your server's source:

```ts
// vitest.config.ts
import { defineConfig, mergeConfig } from 'vitest/config';
import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';

export default mergeConfig(coreConfig, defineConfig({
  resolve: {
    alias: { '@/': new URL('./src/', import.meta.url).pathname },
  },
}));
```

`mergeConfig` deep-merges the framework base with your overrides. The base sets `globals: true` (`describe`, `it`, `expect`, etc. available without imports), `pool: 'forks'` and `isolate: true` (test files run in separate worker processes), and `ssr: { noExternal: ['zod'] }` for Zod 4 compatibility. The `resolve.alias` entry maps `@/` to `src/`, matching the `paths` alias in `tsconfig.json` so imports like `@/services/...` resolve correctly in tests.

---

## Test isolation

**Construct dependencies fresh in `beforeEach`.** Never share mutable state across tests.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { initMyService } from '@/services/my-domain/my-service.js';

describe('myTool with service', () => {
  beforeEach(() => {
    // Re-initialize with a fresh instance before each test
    initMyService(mockConfig, mockStorage);
  });

  it('calls service correctly', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    // ...
  });
});
```

- Re-init services with `initMyService()` (or equivalent) in `beforeEach` when tests share a module-level singleton.
- Vitest runs test files in separate workers — parallel file execution is safe by default.
- Pass `createMockContext({ tenantId })` when a test needs a specific tenant; omitting it scopes state to `'default'`, not to a broken state surface.

---

## McpError assertions

```ts
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

it('throws NotFound for missing resource', async () => {
  const ctx = createMockContext();
  const input = myTool.input.parse({ id: 'nonexistent' });
  await expect(myTool.handler(input, ctx)).rejects.toMatchObject({
    code: JsonRpcErrorCode.NotFound,
  });
});
```

Use `.rejects.toThrow(McpError)` to assert type only. Use `.rejects.toMatchObject({ code: ... })` when the specific error code matters.

---

## Output schema assertions

`expect.schemaMatching` (Vitest 4, Standard Schema) validates a value against any Zod schema — including the definition's own `output`. Use it to assert schema conformance without duplicating the shape in the test:

```ts
it('output conforms to the declared output schema', async () => {
  const ctx = createMockContext();
  const result = await myTool.handler(myTool.input.parse({ query: 'x' }), ctx);
  expect(result).toEqual(expect.schemaMatching(myTool.output));
});
```

It composes as an asymmetric matcher anywhere a value is expected — e.g. `toHaveBeenCalledWith(expect.schemaMatching(schema))`. Prefer exact-value assertions when the expected output is fully known; reach for `schemaMatching` when the output is dynamic (timestamps, generated IDs) or the schema itself is the contract under test.

---

## Testing handlers with `errors[]` (typed contract)

Tools and resources that declare an `errors[]` contract receive a typed `ctx.fail` helper at runtime. Pass the definition's own `errors` to `createMockContext` and the mock wires `fail` the same way the production handler factory does:

```ts
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { fetchItems } from '@/mcp-server/tools/definitions/fetch-items.tool.js';

it('throws ctx.fail("no_match") when no items resolve', async () => {
  const ctx = createMockContext({ errors: fetchItems.errors });

  const input = fetchItems.input.parse({ ids: ['missing'] });
  await expect(fetchItems.handler(input, ctx)).rejects.toMatchObject({
    code: JsonRpcErrorCode.NotFound,
    data: { reason: 'no_match' },
  });
});
```

For lower-level tests that need the raw `fail` helper without a full mock context (e.g. asserting the reason → code mapping), use `createFail` directly — see [Testing the handler-side `fail` plumbing](#testing-the-handler-side-fail-plumbing) below.

### Why test `data.reason` and not just `code`?

The contract reason is the stable machine-readable identifier — clients switch on it the same way they would on an HTTP status. A code alone (`NotFound`) doesn't disambiguate between contract entries that share a code (`'no_match'` vs `'withdrawn'` both mapping to `NotFound`). Asserting on `data.reason` locks the test to the specific contract entry.

### `data.reason` is overridable-proof

The framework spreads caller-supplied data first and writes `reason` last, so a handler that passes `data: { reason: 'something_else' }` cannot override the contract reason. Tests can rely on `data.reason` always equaling the contract entry's reason — write assertions that depend on it without paranoia.

### Testing the handler-side `fail` plumbing

To verify the definition wires `ctx.fail` correctly without exercising the full handler factory, use the `errors` array directly:

```ts
import { createFail } from '@cyanheads/mcp-ts-core';

it('builds an error with the contract code and reason', () => {
  const fail = createFail(myTool.errors!);
  const err = fail('no_match', 'not found', { itemId: '123' });
  expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  expect(err.data).toEqual({ reason: 'no_match', itemId: '123' });
});
```

---

## Fuzz testing

For schema-heavy or input-validation-critical handlers, the framework ships fuzz helpers under `@cyanheads/mcp-ts-core/testing/fuzz`. They generate valid + adversarial inputs from your Zod schemas via `fast-check` and assert handler invariants (no crashes, no prototype pollution, no stack-trace leaks).

```ts
import { fuzzTool, fuzzResource, fuzzPrompt } from '@cyanheads/mcp-ts-core/testing/fuzz';

it('survives fuzz testing', async () => {
  const report = await fuzzTool(myTool, { numRuns: 100, numAdversarial: 30 });
  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});
```

| Helper | Purpose |
|:-------|:--------|
| `fuzzTool(def, opts)` / `fuzzResource(def, opts)` / `fuzzPrompt(def, opts)` | Drive valid + adversarial inputs through the handler. Returns a `FuzzReport`. |
| `zodToArbitrary(schema)` | Convert a Zod schema to a `fast-check` `Arbitrary` for custom property-based tests. |
| `adversarialArbitrary()` / `ADVERSARIAL_STRINGS` | Targeted injection sets (prototype pollution probes, control characters, oversized payloads). |

`FuzzOptions`: `numRuns` (default 50), `numAdversarial` (default 30), `seed` (reproducibility), `timeout` (per-call ms, default 5000), `ctx` (`MockContextOptions` for stateful handlers).

`report.leaks` looks for a stack frame or a server-side path in what a client can observe — the `code`, `message`, and `data` of the thrown `McpError`. Strings the input itself supplied are removed before that check, so naming the offending value in error data (`throw validationError(msg, { key })`) never registers as a leak: the client sent those bytes and learns nothing from seeing them again.

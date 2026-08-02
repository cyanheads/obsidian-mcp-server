---
name: api-testing
description: >
  Testing patterns for MCP tool/resource handlers using `createMockContext` and Vitest. Covers mock context options, handler testing, McpError assertions, format testing, Vitest config setup, and test isolation conventions.
metadata:
  author: cyanheads
  version: "1.6"
  audience: external
  type: reference
---

## Overview

Tests target handler behavior directly — call `handler(input, ctx)`, assert on the return value or thrown error. The framework's handler factory (try/catch, formatting, telemetry) is not involved. Use `createMockContext` from `@cyanheads/mcp-ts-core/testing` to construct the `ctx` argument.

**Additional exports from `/testing`:** `createMockSession()` binds a mock handler context to an HTTP session; `createFetchMock()` provides a strict upstream HTTP fake; `runToolContract()` executes a definition through schema, handler, formatting, enrichment/content, and production-shaped error-envelope checks. `createMockLogger()` returns a standalone `MockContextLogger`, and `createInMemoryStorage(options?)` provides a real `StorageService` backed by `InMemoryProvider`.

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
| `session` | `MockSession` | Yes | Fresh `{ sessionId, tenantId?, ctx }` from `createMockSession()` |
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

Routes match in registration order. `match` accepts an exact URL, `RegExp`, or request predicate; `respond` accepts a clonable `Response` or response factory. Set `once: true` for one-shot behavior. Unmatched requests throw unless `onUnhandled` is provided.

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

---

## `createMockContext` options

```ts
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

createMockContext()                                           // minimal — ctx.state operations throw without tenantId
createMockContext({ tenantId: 'test-tenant' })               // enables ctx.state (tenant-scoped in-memory storage)
createMockContext({ errors: myTool.errors })                 // attaches typed ctx.fail keyed by the contract reasons
createMockContext({ elicit: vi.fn().mockResolvedValue(...) }) // with elicitation
createMockContext({ progress: true })                        // with task progress (ctx.progress populated)
createMockContext({ requestId: 'my-id' })                    // override request ID (default: 'test-request-id')
createMockContext({ notifyResourceListChanged: () => {} })   // with resource-list change notifier
createMockContext({ notifyResourceUpdated: (_uri) => {} })   // with resource update notifier
createMockContext({ signal: controller.signal })             // custom AbortSignal
createMockContext({ auth: { clientId: 'test', scopes: [], sub: 'test-user' } }) // with auth context
createMockContext({ uri: new URL('myscheme://item/123') })   // for resource handler testing
```

`MockContextOptions` interface:

```ts
interface MockContextOptions {
  auth?: AuthContext;
  elicit?: (message: string, schema: z.ZodObject<z.ZodRawShape>) => Promise<ElicitResult>;
  errors?: readonly ErrorContract[];
  notifyPromptListChanged?: () => void;
  notifyResourceListChanged?: () => void;
  notifyResourceUpdated?: (uri: string) => void;
  notifyToolListChanged?: () => void;
  progress?: boolean;
  sessionId?: string;
  requestId?: string;
  signal?: AbortSignal;
  tenantId?: string;
  uri?: URL;
}
```

| Option | Effect |
|:-------|:-------|
| _(none)_ | Minimal context — `ctx.state` operations throw without `tenantId`; `ctx.elicit`/`ctx.progress` are `undefined` |
| `auth` | Sets `ctx.auth` for scope-checking tests |
| `elicit` | Assigns a function to `ctx.elicit` for testing elicitation calls |
| `errors` | Attaches a typed `ctx.fail` against the contract — same wiring the production handler factory uses. Pass `myTool.errors` directly. |
| `notifyPromptListChanged` | Assigns `ctx.notifyPromptListChanged` for prompt-list change notification tests |
| `notifyResourceListChanged` | Assigns `ctx.notifyResourceListChanged` for resource notification tests |
| `notifyResourceUpdated` | Assigns `ctx.notifyResourceUpdated` for resource update notification tests |
| `notifyToolListChanged` | Assigns `ctx.notifyToolListChanged` for tool-list change notification tests |
| `sessionId` | Sets `ctx.sessionId` for handlers that branch on session ID |
| `progress` | Populates `ctx.progress` with real state-tracking implementation (see below) |
| `requestId` | Overrides `ctx.requestId` (default: `'test-request-id'`) |
| `signal` | Overrides `ctx.signal` — useful for cancellation testing |
| `tenantId` | Sets `ctx.tenantId` and enables `ctx.state` operations with in-memory storage |
| `uri` | Sets `ctx.uri` for resource handler testing |

### Mock progress

When `progress: true`, `ctx.progress` is a real state-tracking object — not `vi.fn()` spies. It maintains internal state accessible via inspection properties:

```ts
const ctx = createMockContext({ progress: true });
// ctx.progress is typed as ContextProgress, but the mock exposes internal state:
const progress = ctx.progress as ContextProgress & {
  _total: number;
  _completed: number;
  _messages: string[];
};

await ctx.progress!.setTotal(10);
await ctx.progress!.increment(3);
await ctx.progress!.update('step message');

expect(progress._total).toBe(10);
expect(progress._completed).toBe(3);
expect(progress._messages).toContain('step message');
```

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

## Testing with optional capabilities

```ts
it('uses elicitation when available', async () => {
  const elicit = vi.fn().mockResolvedValue({
    action: 'accept',
    content: { format: 'json' },
  });
  const ctx = createMockContext({ elicit });
  const input = myTool.input.parse({ query: 'hello' });
  await myTool.handler(input, ctx);
  expect(elicit).toHaveBeenCalledOnce();
});

it('handles missing elicitation gracefully', async () => {
  // ctx.elicit is undefined — handler must check before calling
  const ctx = createMockContext();
  const input = myTool.input.parse({ query: 'hello' });
  // Should not throw even when ctx.elicit is absent
  await expect(myTool.handler(input, ctx)).resolves.toBeDefined();
});
```

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
- Use `createMockContext({ tenantId })` whenever the handler accesses `ctx.state` — omitting `tenantId` causes `ctx.state` to throw.

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

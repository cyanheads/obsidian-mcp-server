---
name: api-testing
description: >
  Testing patterns for MCP tool/resource handlers using `createMockContext` and Vitest. Covers mock context options, handler testing, McpError assertions, format testing, Vitest config setup, and test isolation conventions.
metadata:
  author: cyanheads
  version: "1.2"
  audience: external
  type: reference
---

## Overview

Tests target handler behavior directly — call `handler(input, ctx)`, assert on the return value or thrown error. The framework's handler factory (try/catch, formatting, telemetry) is not involved. Use `createMockContext` from `@cyanheads/mcp-ts-core/testing` to construct the `ctx` argument.

**Philosophy:** Test behavior, not implementation. Refactors should not break tests. Match the repo's existing test layout: fresh scaffolds use `tests/`, while colocated `src/**/*.test.ts` files are also supported. Integration tests at I/O boundaries over unit tests of internals.

---

## `createMockContext` options

```ts
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

createMockContext()                                           // minimal — ctx.state operations throw without tenantId
createMockContext({ tenantId: 'test-tenant' })               // enables ctx.state (tenant-scoped in-memory storage)
createMockContext({ sample: vi.fn().mockResolvedValue(...) }) // with MCP sampling
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
  notifyResourceListChanged?: () => void;
  notifyResourceUpdated?: (uri: string) => void;
  progress?: boolean;
  requestId?: string;
  sample?: (messages: SamplingMessage[], opts?: SamplingOpts) => Promise<CreateMessageResult>;
  signal?: AbortSignal;
  tenantId?: string;
  uri?: URL;
}
```

| Option | Effect |
|:-------|:-------|
| _(none)_ | Minimal context — `ctx.state` operations throw without `tenantId`; `ctx.elicit`/`ctx.sample`/`ctx.progress` are `undefined` |
| `auth` | Sets `ctx.auth` for scope-checking tests |
| `elicit` | Assigns a function to `ctx.elicit` for testing elicitation calls |
| `notifyResourceListChanged` | Assigns `ctx.notifyResourceListChanged` for resource notification tests |
| `notifyResourceUpdated` | Assigns `ctx.notifyResourceUpdated` for resource update notification tests |
| `progress` | Populates `ctx.progress` with real state-tracking implementation (see below) |
| `requestId` | Overrides `ctx.requestId` (default: `'test-request-id'`) |
| `sample` | Assigns a function to `ctx.sample` for testing sampling calls |
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

`ctx.log` captures all log calls for inspection:

```ts
const ctx = createMockContext();
const log = ctx.log as ContextLogger & {
  calls: Array<{ level: string; msg: string; data?: unknown }>;
};

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

it('uses sampling when available', async () => {
  const sample = vi.fn().mockResolvedValue({
    role: 'assistant',
    content: { type: 'text', text: 'Summary text' },
  });
  const ctx = createMockContext({ sample });
  const input = myTool.input.parse({ query: 'summarize this' });
  const result = await myTool.handler(input, ctx);
  expect(result.summary).toBeDefined();
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

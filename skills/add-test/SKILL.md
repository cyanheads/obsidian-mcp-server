---
name: add-test
description: >
  Scaffold a test file for an existing tool, resource, or service. Use when the user asks to add tests, improve coverage, or when a definition exists without a matching test file.
metadata:
  author: cyanheads
  version: "1.6"
  audience: external
  type: reference
---

## Context

Tests use Vitest and `createMockContext` from `@cyanheads/mcp-ts-core/testing`. If the repo already has tests, match the existing layout. If the repo has no existing tests, create a root `tests/` directory that mirrors the `src/` structure (e.g. `tests/mcp-server/tools/definitions/echo.tool.test.ts` for `src/mcp-server/tools/definitions/echo.tool.ts`).

For the full `createMockContext` API and testing patterns, read:

    skills/api-testing/SKILL.md

## Steps

1. **Identify the target** — which tool, resource, or service needs tests
2. **Read the source file** — understand the handler's logic, input/output schemas, error paths, and which `ctx` features it uses
3. **Create the test file** in the repo's existing test layout — search for existing `*.test.ts` files to confirm whether tests are colocated with source or under a root `tests/` directory
4. **Write test cases** covering happy path, error paths, and edge cases
5. **Run `bun run test`** to verify
6. **Run `bun run devcheck`** to verify lint, types, and MCP definitions

## Determining What to Test

Read the handler and identify:

| Aspect | Test Strategy |
|:-------|:-------------|
| **Happy path** | Valid input → expected output. Include at least one. |
| **Input variations** | Optional fields omitted, defaults applied, boundary values |
| **Error paths** | Invalid state, missing resources, service failures → correct error thrown |
| **`ctx.state` usage** | Available on any mock context (tenant `'default'` unless `{ tenantId }` says otherwise). It runs the production storage path, so use storage-legal keys (`cache/v1/abc`, never `cache:v1:abc`) and assert TTL expiry with fake timers. |
| **`ctx.requestInput` / `ctx.inputs`** | Two rounds. First round: assert the handler throws the input-required signal (`.rejects.toSatisfy(isInputRequiredSignal)`), or catch it and assert on `error.result.inputRequests`. Second round: seed `createMockContext({ inputResponses })` and assert the handler completes. Cover the decline/cancel branch too. |
| **`ctx.signal`** | Pass `createMockContext({ signal: controller.signal })` and assert a long loop stops early rather than running to completion. |
| **`ctx.fail` (typed contract)** | Definitions with `errors[]` need `fail` attached to the mock ctx — `createMockContext({ errors: myTool.errors })` does it for you. Assert on `data.reason` (stable per-contract entry), not just `code`. |
| **`format` function** | Test separately if defined — it's pure, no ctx needed. Verify it renders the IDs and fields the model needs, not just a count or title. For projection-style tools, test non-default field selections. |
| **Sparse upstream payloads** | For third-party API integrations, build a fixture with omitted fields. Assert normalized output still validates and `format()` preserves unknown values instead of inventing facts. |
| **Form-client payloads** | If handler has optional fields: test with empty-string inner values (form clients send `""` instead of `undefined`). Assert handler doesn't break or produce invalid output. |
| **Auth scopes** | Not tested at handler level (framework enforces) — skip |

## Templates

### Tool test

```typescript
/**
 * @fileoverview Tests for {{TOOL_NAME}} tool.
 * @module tests/tools/{{TOOL_NAME}}.tool.test
 */

import { describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { {{TOOL_EXPORT}} } from '@/mcp-server/tools/definitions/{{tool-name}}.tool.js';

describe('{{TOOL_EXPORT}}', () => {
  it('returns expected output for valid input', async () => {
    const ctx = createMockContext();
    const input = {{TOOL_EXPORT}}.input.parse({
      // valid input matching the Zod schema
    });
    const result = await {{TOOL_EXPORT}}.handler(input, ctx);
    expect(result).toMatchObject({
      // expected output shape
    });
  });

  it('throws on invalid state', async () => {
    const ctx = createMockContext();
    const input = {{TOOL_EXPORT}}.input.parse({
      // input that triggers an error path
    });
    await expect({{TOOL_EXPORT}}.handler(input, ctx)).rejects.toThrow();
  });

  // Only when the tool declares `errors: [...]`. Drop this block otherwise.
  it('throws ctx.fail("{{REASON}}") for the declared failure mode', async () => {
    const ctx = createMockContext({ errors: {{TOOL_EXPORT}}.errors });
    const input = {{TOOL_EXPORT}}.input.parse({
      // input that triggers the declared failure mode
    });
    await expect({{TOOL_EXPORT}}.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: '{{REASON}}' },
    });
  });

  it('formats output completely', () => {
    const output = { /* mock output matching the output schema */ };
    const blocks = {{TOOL_EXPORT}}.format!(output);
    expect(blocks.some((block) => block.type === 'text')).toBe(true);
    // Assert the rendered text includes the IDs/fields the LLM needs to act on.
  });
});
```

### Resource test

```typescript
/**
 * @fileoverview Tests for {{RESOURCE_NAME}} resource.
 * @module tests/resources/{{RESOURCE_NAME}}.resource.test
 */

import { describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { {{RESOURCE_EXPORT}} } from '@/mcp-server/resources/definitions/{{resource-name}}.resource.js';

describe('{{RESOURCE_EXPORT}}', () => {
  it('returns data for valid params', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = {{RESOURCE_EXPORT}}.params.parse({
      // valid params matching the Zod schema
    });
    const result = await {{RESOURCE_EXPORT}}.handler(params, ctx);
    expect(result).toBeDefined();
  });

  it('throws when resource not found', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = {{RESOURCE_EXPORT}}.params.parse({
      // params for a non-existent resource
    });
    await expect({{RESOURCE_EXPORT}}.handler(params, ctx)).rejects.toThrow();
  });

  // For resources that declare an `errors: [...]` contract, pass the contract via
  // `createMockContext` so the typed `ctx.fail` is wired automatically:
  //   const ctx = createMockContext({ errors: {{RESOURCE_EXPORT}}.errors });
  //   const err = await {{RESOURCE_EXPORT}}.handler(params, ctx).catch((e) => e);
  //   expect(err.code).toBe(JsonRpcErrorCode.NotFound);
  //   expect(err.data.reason).toBe('no_match');

  // Include this block only when the resource definition exports a `list` function.
  // Check the source — `list` is optional on resource definitions.
  it('lists available resources', async () => {
    const listing = await {{RESOURCE_EXPORT}}.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
    }
  });
});
```

### Service test

```typescript
/**
 * @fileoverview Tests for {{SERVICE_NAME}} service.
 * @module tests/services/{{domain}}/{{domain}}-service.test
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { get{{ServiceClass}}, init{{ServiceClass}} } from '@/services/{{domain}}/{{domain}}-service.js';

// Derive the minimal mock config from src/config/server-config.ts — read
// the server's Zod schema to see which fields init{{ServiceClass}}() needs.
const mockConfig = { /* fields from server config schema */ } as AppConfig;

describe('{{ServiceClass}}', () => {
  beforeEach(async () => {
    const mockStorage = await StorageService.create({ type: 'in-memory' });
    init{{ServiceClass}}(mockConfig, mockStorage);
  });

  it('performs the expected operation', async () => {
    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const service = get{{ServiceClass}}();
    const result = await service.doWork('input', ctx);
    expect(result).toBeDefined();
  });
});
```

If you need to test the accessor's "not initialized" guard, do it in a separate isolated-module test (`vi.resetModules()` before importing the service module). Don't mix that assertion into a suite that already calls `init{{ServiceClass}}()` in `beforeEach()`.

### Multi-round-trip tool test

A handler that calls `ctx.requestInput(...)` throws an `InputRequiredSignal` — in production the handler factory converts it to an `input_required` result; in a unit test it surfaces as a thrown value. Test both rounds.

```typescript
import { isInputRequiredSignal } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

it('requests the missing input on the first round', async () => {
  const ctx = createMockContext();
  const input = {{TOOL_EXPORT}}.input.parse({ path: '/tmp/x' });

  try {
    await {{TOOL_EXPORT}}.handler(input, ctx);
    throw new Error('Expected the handler to request input.');
  } catch (error) {
    if (!isInputRequiredSignal(error)) throw error;
    expect(Object.keys(error.result.inputRequests ?? {})).toEqual(['confirm']);
  }
});

it('completes once the response is supplied', async () => {
  const ctx = createMockContext({
    inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
  });
  const input = {{TOOL_EXPORT}}.input.parse({ path: '/tmp/x' });

  await expect({{TOOL_EXPORT}}.handler(input, ctx)).resolves.toMatchObject({ deleted: '/tmp/x' });
});

it('does not re-ask after a decline', async () => {
  const ctx = createMockContext({ inputResponses: { confirm: { action: 'decline' } } });
  const input = {{TOOL_EXPORT}}.input.parse({ path: '/tmp/x' });

  // Terminal, not another round — re-asking would burn the round budget.
  await expect({{TOOL_EXPORT}}.handler(input, ctx)).rejects.toThrow(McpError);
});
```

### Cancellation test

```typescript
it('respects cancellation', async () => {
  const controller = new AbortController();
  const ctx = createMockContext({ signal: controller.signal });
  const input = {{TOOL_EXPORT}}.input.parse({ count: 100, delayMs: 10 });

  setTimeout(() => controller.abort(), 50);
  const result = await {{TOOL_EXPORT}}.handler(input, ctx);

  // Should have returned a partial result rather than throwing on cancellation.
  // Assert on a field from the tool's actual output schema.
  expect(result).toBeDefined();
});
```

### Prompt test

```typescript
/**
 * @fileoverview Tests for {{PROMPT_NAME}} prompt.
 * @module tests/prompts/{{PROMPT_NAME}}.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { {{PROMPT_EXPORT}} } from '@/mcp-server/prompts/definitions/{{prompt-name}}.prompt.js';

describe('{{PROMPT_EXPORT}}', () => {
  it('generates valid messages for valid args', () => {
    const args = {{PROMPT_EXPORT}}.args!.parse({
      // valid args matching the Zod schema
    });
    const messages = {{PROMPT_EXPORT}}.generate(args);
    expect(messages).toBeInstanceOf(Array);
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
    }
  });

  // Include only when the prompt has no required args (args is optional or all fields optional).
  it('generates messages with no args', () => {
    const messages = {{PROMPT_EXPORT}}.generate({});
    expect(messages.length).toBeGreaterThan(0);
  });
});
```

## Fuzz Testing

For schema-heavy or input-validation-critical handlers, the framework ships fuzz helpers that generate valid + adversarial inputs from your Zod schemas via `fast-check` and assert handler invariants (no crashes, no prototype pollution, no stack-trace leaks):

```typescript
import { fuzzTool } from '@cyanheads/mcp-ts-core/testing/fuzz';

it('survives fuzz testing', async () => {
  const report = await fuzzTool({{TOOL_EXPORT}}, { numRuns: 100 });
  expect(report.crashes).toHaveLength(0);
  expect(report.leaks).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
});
```

Available helpers from `@cyanheads/mcp-ts-core/testing/fuzz`: `fuzzTool`, `fuzzResource`, `fuzzPrompt`, `zodToArbitrary` (custom property-based tests), `adversarialArbitrary` and `ADVERSARIAL_STRINGS` (targeted injection sets). Returns a `FuzzReport` you can assert against. Options: `numRuns`, `numAdversarial`, `seed` (reproducibility), `timeout`, `ctx` (`MockContextOptions` for stateful handlers).

## Generating Tests from Schemas

When scaffolding tests for an existing handler, use the Zod schemas to generate meaningful test cases:

1. **Read `input` schema** — identify required fields, optional fields with defaults, constrained types (enums, min/max, patterns)
2. **Read `output` schema** — know what shape to assert against
3. **Happy path** — construct the simplest valid input, assert output matches schema
4. **Defaults** — omit optional fields, verify defaults are applied in the output
5. **Boundaries** — if the schema has `.min()`, `.max()`, `.length()`, test at the boundaries
6. **Error paths** — trace the handler logic for throw conditions, construct inputs that trigger each
7. **Sparse upstream fixtures** — if the handler/service wraps a third-party API, add at least one fixture where upstream omits optional fields entirely. Assert that the output still validates and that `format()` renders uncertainty honestly (`Not available`, omitted badge, etc.) instead of fabricating values.

## Checklist

- [ ] Test file created in the repo's existing layout (`tests/...` or colocated with source)
- [ ] JSDoc `@fileoverview` and `@module` header present
- [ ] Happy path tested with valid input → expected output
- [ ] Error paths tested (at least one `.rejects.toThrow()`)
- [ ] `format` function tested if defined
- [ ] `createMockContext` options match handler's ctx usage (`tenantId`, `inputResponses`, `requestState`, `errors`, `signal`)
- [ ] Service re-initialized in `beforeEach` if handler depends on a service singleton
- [ ] If handler has optional fields: tested with empty-string inner values (form-client simulation)
- [ ] If wrapping external API: sparse-payload case tested — fixture omits at least one optional upstream field; output still validates and `format()` renders uncertainty honestly instead of inventing values
- [ ] If target is a prompt: `generate()` tested with valid args and (when applicable) no args
- [ ] `bun run test` passes
- [ ] `bun run devcheck` passes

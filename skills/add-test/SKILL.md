---
name: add-test
description: >
  Scaffold a test file for an existing tool, resource, or service. Use when the user asks to add tests, improve coverage, or when a definition exists without a matching test file.
metadata:
  author: cyanheads
  version: "1.3"
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
3. **Create the test file** in the repo's existing test layout
4. **Write test cases** covering happy path, error paths, and edge cases
5. **Run `bun run test`** to verify
6. **Run `bun run devcheck`** to verify types

## Determining What to Test

Read the handler and identify:

| Aspect | Test Strategy |
|:-------|:-------------|
| **Happy path** | Valid input → expected output. Include at least one. |
| **Input variations** | Optional fields omitted, defaults applied, boundary values |
| **Error paths** | Invalid state, missing resources, service failures → correct error thrown |
| **`ctx.state` usage** | Use `createMockContext({ tenantId: 'test' })` to enable storage |
| **`ctx.elicit` / `ctx.sample`** | Mock with `vi.fn()`, also test the absent case (undefined) |
| **`ctx.progress`** | Use `createMockContext({ progress: true })` for task tools |
| **`format` function** | Test separately if defined — it's pure, no ctx needed. Verify it renders the IDs and fields the model needs, not just a count or title. For projection-style tools, test non-default field selections. |
| **Sparse upstream payloads** | For third-party API integrations, build a fixture with omitted fields. Assert normalized output still validates and `format()` preserves unknown values instead of inventing facts. |
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
import { get{{ServiceClass}}, init{{ServiceClass}} } from '@/services/{{domain}}/{{domain}}-service.js';

describe('{{ServiceClass}}', () => {
  beforeEach(() => {
    // Re-initialize with fresh config/storage for each test
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

### Task tool test

For tools with `task: true`, use `createMockContext({ progress: true })`:

```typescript
it('reports progress during execution', async () => {
  const ctx = createMockContext({ progress: true });
  const input = {{TOOL_EXPORT}}.input.parse({ count: 3, delayMs: 10 });
  await {{TOOL_EXPORT}}.handler(input, ctx);

  const progress = ctx.progress as ContextProgress & {
    _total: number;
    _completed: number;
    _messages: string[];
  };
  expect(progress._total).toBe(3);
  expect(progress._completed).toBe(3);
});

it('respects cancellation', async () => {
  const controller = new AbortController();
  const ctx = createMockContext({ progress: true, signal: controller.signal });
  const input = {{TOOL_EXPORT}}.input.parse({ count: 100, delayMs: 10 });

  // Abort after a short delay
  setTimeout(() => controller.abort(), 50);
  const result = await {{TOOL_EXPORT}}.handler(input, ctx);

  // Should have stopped early
  expect(result.finalCount).toBeGreaterThan(0);
});
```

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
- [ ] `createMockContext` options match handler's ctx usage (`tenantId`, `progress`, `elicit`, `sample`)
- [ ] Service re-initialized in `beforeEach` if handler depends on a service singleton
- [ ] If wrapping external API: sparse-payload case tested (omitted upstream fields still validate; `format()` does not invent facts)
- [ ] `bun run test` passes
- [ ] `bun run devcheck` passes

---
name: code-simplifier
description: >
  Post-session code review and cleanup against a working tree of changes. Analyzes `git diff` to simplify, consolidate, and align changed code with the existing codebase — modernize syntax, remove unnecessary complexity, consolidate duplicated logic, catch efficiency issues. Use after a substantive working session, or when asked to clean up, simplify, reduce slop, consolidate, modernize, tighten up, or de-slop code. For `@cyanheads/mcp-ts-core` projects, includes specific transformations for tool/resource/prompt definitions, the ctx pattern, error factories, and framework idioms.
metadata:
  author: cyanheads
  version: "1.2"
  audience: external
  type: workflow
---

# Code Simplifier

Post-session cleanup pass. Reviews what changed, understands how it fits the existing codebase, and makes targeted improvements — modernizing syntax, removing unnecessary complexity, consolidating duplicated logic, catching efficiency issues. Prioritizes codebase cohesion over local perfection.

## Core philosophy

**Every change must earn its keep.** A simplification that doesn't meaningfully improve clarity, correctness, or cohesion is noise. Don't refactor for refactoring's sake. Don't create new files, abstractions, or utilities unless they solve a demonstrated problem. If the existing code works and is readable, leave it alone. The goal is a cohesive codebase, not a pristine one.

## Procedure

### Phase 1: Identify changes

Run `git status` to see the shape of the working tree, then `git diff HEAD` for all uncommitted changes (staged and unstaged). Untracked files never appear in the diff — read new files directly. If the tree is clean, review the most recently modified files from the current session.

### Phase 2: Understand the surrounding codebase

Don't review changes in isolation. Before any modifications:

1. **Read the full files** containing changes — not just the diff hunks. Understand imports, surrounding logic, module structure.
2. **Identify the project language(s)** and select the relevant transformation rules. Discard inapplicable rules.
3. **Survey adjacent code** — shared utilities, sibling modules, common patterns. You need to know what already exists before deciding something is missing. For mcp-ts-core projects, check `src/utils/` for project utilities, `src/errors/` for error handling, and `node_modules/@cyanheads/mcp-ts-core/` for framework exports.

### Phase 3: Review

Evaluate the changes across these dimensions. Not every dimension applies to every diff — skip what's irrelevant.

#### Codebase cohesion

- **Reuse** — Search for existing utilities, helpers, and patterns that could replace newly-written code. For mcp-ts-core projects, prefer `import from '@cyanheads/mcp-ts-core/utils'` over hand-rolled equivalents — pagination helpers, schema builders, retry primitives, and OTel attribute constants are framework-provided.
- **Consolidation** — Flag copy-paste-with-variation: near-duplicate code blocks that should be unified. Only unify if the shared abstraction is genuinely simpler than the duplicated code.
- **Consistency** — Check that new code follows the same patterns as the rest of the codebase: naming conventions, error handling style, import patterns, type annotation style. Normalize toward the better variant when the project is inconsistent.
- **Stringly-typed code** — Flag raw strings where constants, string-union types, branded types, or framework attribute constants already exist. For mcp-ts-core projects, the `ATTR_*` constants in `@cyanheads/mcp-ts-core/utils` should replace raw OTel attribute keys.

#### Code quality

- **Redundant state** — State that duplicates existing state, cached values that could be derived.
- **Unnecessary complexity** — Deep nesting that could be guard clauses, premature abstractions, over-engineered solutions to simple problems.
- **Dead code** — Unreachable branches, unused variables, commented-out code, exports that nothing imports.
- **Defensive code for impossible states** — Guards for cases the type system or framework already prevents. Drop them.
- **Outdated patterns** — Verbose or legacy syntax where modern equivalents exist. See the transformation tables below.

#### Efficiency

- **Redundant work** — Repeated computations, duplicate file reads, duplicate network/API calls, N+1 query patterns.
- **Missed concurrency** — Independent async operations run sequentially that could run in parallel with `Promise.all` / `Promise.allSettled`.
- **No-op updates** — State/store updates inside loops or event handlers that fire unconditionally. Add change-detection so downstream consumers aren't notified when nothing changed.
- **TOCTOU** — Pre-checking file/resource existence before operating on it. Operate directly and handle the error instead.
- **Overly broad operations** — Reading entire files when only a portion is needed, loading all items when filtering for one.

#### mcp-ts-core-specific

- **Error throwing patterns** — Prefer framework error factories (`McpError`, `validationError`, `notFound`, `httpErrorFromResponse`) over raw `throw new Error()`. Tool handlers should throw — the framework catches, classifies, and instruments.
- **Error codes** — `InvalidParams` only for malformed JSON-RPC params shape. `ValidationError` for domain validation. `NotFound` for missing entities. Don't conflate them.
- **Ctx usage** — Use `ctx.log`, `ctx.state`, `ctx.elicit` — don't reach for global loggers or request-scoped storage directly. The `ctx` pattern carries tenant scope and OTel context.
- **Zod schemas** — Every tool input/output field needs `.describe()`. Zod 4 requires `z.record(z.string(), z.string())` not `z.record(z.string())`. Use `.optional()` rather than `.nullish()` unless null is semantically distinct from absent.
- **Tool annotations** — `readOnlyHint`, `idempotentHint`, `openWorldHint` should reflect reality. A read-only tool with `readOnlyHint: false` gives clients the wrong picture.
- **`exactOptionalPropertyTypes` boundaries** — If a downstream type insists on the field being present-or-not-present (not present-as-undefined), use a mapped widening type at the boundary. The pattern is documented in the framework.
- **`format()` ↔ `structuredContent` parity** — Different MCP clients forward different surfaces. Tests should assert both surfaces carry equivalent data.

### Phase 4: Apply transformations

1. **Filter findings ruthlessly.** If a finding is a false positive or not worth the churn, skip it. Don't argue with yourself about borderline cases — move on.
2. **Transform incrementally** — one category of change at a time (modernize syntax, then reduce nesting, then consolidate).
3. **Verify equivalence** — all functionality, types, and public interfaces must remain unchanged. Run the project's gates after transforming (`bun run devcheck` and the test suite in mcp-ts-core projects; typecheck/lint/tests elsewhere); a simplification that breaks the build is worse than the verbosity it removed.
4. **Keep the diff minimal.** Only touch lines that have a real reason to change. Don't reformat untouched code, add comments to code you didn't modify, or "improve" things that are already fine.

When done, briefly summarize what was fixed or confirm the code was already clean.

## Common transformations

The tables below cover TypeScript and Python. For other languages, apply analogous principles: prefer modern idioms, reduce nesting, eliminate dead code, follow project conventions.

### TypeScript (modern ESM, TS 5.x+)

| Before | After | Why |
| --- | --- | --- |
| `const x: Foo = { ... } as Foo` | `const x = { ... } satisfies Foo` | Type-checked without assertion |
| `let resource = acquire(); try { ... } finally { release(resource) }` | `using resource = acquire()` | Explicit resource disposal (TS 5.2+) |
| `if (x !== null && x !== undefined)` | `if (x != null)` | Idiomatic null/undefined check |
| `arr.filter(x => x !== null) as T[]` | `arr.filter(x => x != null)` | TS 5.5+ infers the type predicate — no cast; on older TS use an explicit `(x): x is T` predicate |
| `export { foo } from './foo/index.js'` | Direct imports at call sites | Avoid barrel re-exports inside the package; barrel exports are for public APIs only |
| `async function f() { const a = await x(); const b = await y(); }` | `const [a, b] = await Promise.all([x(), y()])` | Parallel when independent |
| `obj.x !== undefined ? obj.x : fallback` | `obj.x ?? fallback` | Nullish coalescing |
| `if (a) { if (b) { if (c) { ... } } }` | Guard clauses with early returns | Reduce nesting |
| `try { risky() } catch (e: any) { ... }` | `try { risky() } catch (e: unknown) { ... }` | Type-safe error handling |
| `enum Status { A, B, C }` | `const Status = { A: 'A', B: 'B', C: 'C' } as const` | Prefer const objects over enums — but switching numeric values to strings changes serialized output; keep values stable if they're persisted (string enums are acceptable) |
| `function f(a: string, b: string, c: string, d?: string)` | `function f(opts: FnOptions)` | Options object when >3 params |
| `throw new Error('Bad input')` (in a tool handler) | `throw validationError('Bad input', { field: 'x' })` | Use framework error factories so the framework can classify and instrument |
| `const ATTR_KEY = 'mcp.tool.name'` | `import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils'` | Use framework attribute constants |

### Python (3.12+)

| Before | After | Why |
| --- | --- | --- |
| `Optional[str]` | `str \| None` | Modern union syntax (3.10+) |
| `List[str]`, `Dict[str, int]` | `list[str]`, `dict[str, int]` | Built-in generics (3.9+) |
| `if x == 0: ... elif x == 1: ... elif x == 2: ...` | `match x: case 0: ... case 1: ...` | Structural pattern matching (3.10+) |
| `class Config: def __init__(self, a, b, c): self.a = a ...` | `@dataclass class Config: a: str; b: int; c: float` | Less boilerplate, built-in eq/repr |
| `results = []; for item in items: results.append(transform(item))` | `results = [transform(item) for item in items]` | Idiomatic comprehension |
| `f = open('x'); try: ... finally: f.close()` | `with open('x') as f: ...` | Context manager for resources |
| `m = pattern.match(s)` then `if m: use(m)` | `if (m := pattern.match(s)): use(m)` | Walrus operator where it removes a throwaway assignment |
| `"Hello " + name + "!"` | `f"Hello {name}!"` | f-string over concatenation |
| `except Exception as e: pass` | `except SpecificError as e: log(e)` | Catch specific, never bare except/pass |
| `from module import *` | `from module import specific_name` | Explicit imports only |
| `TypeAlias = Union[A, B, C]` | `type ABC = A \| B \| C` | `type` statement (3.12+) |
| Sequential `await` for independent I/O | `await asyncio.gather(a(), b())` | Parallel when independent |

## When NOT to simplify

Leave code alone when:

- **It works and is readable.** "I would have written it differently" is not a reason to change it.
- **The change is cosmetic.** Renaming a variable from `data` to `result` isn't worth the churn.
- **Intentional verbosity for debugging.** Verbose code may exist to make stack traces or logging clearer.
- **Performance-critical paths.** A less readable version may exist for measured performance reasons — check before simplifying.
- **API compatibility.** Don't change public function signatures, export shapes, or return types that callers depend on. For mcp-ts-core projects, the public surface includes tool input/output schemas exposed via MCP — changing them is a breaking change to the server's MCP surface.
- **Tests.** Don't DRY up test code aggressively — test readability and isolation matter more than deduplication.
- **Type workarounds.** Sometimes an `as` cast or `# type: ignore` exists because of a genuine type system limitation — verify before removing.
- **The abstraction isn't proven.** Don't create a shared utility for two similar blocks of code. Wait until there are three, and even then only if the abstraction is genuinely simpler than the duplication.

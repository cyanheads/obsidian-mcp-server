---
name: code-simplifier
description: >
  Post-session code review and cleanup against a working tree of changes. Analyzes `git diff` to simplify, consolidate, and align changed code with the existing codebase — modernize syntax, remove unnecessary complexity, consolidate duplicated logic, catch efficiency issues. Use after a substantive working session, or when asked to clean up, simplify, reduce slop, consolidate, modernize, tighten up, or de-slop code. For `@cyanheads/mcp-ts-core` projects, includes specific transformations for tool/resource/prompt definitions, the ctx pattern, error factories, and framework idioms.
metadata:
  author: cyanheads
  version: "1.4"
  audience: external
  type: workflow
---

# Code Simplifier

Post-session cleanup pass. Reviews what changed, understands how it fits the existing codebase, and makes targeted improvements — modernizing syntax, removing unnecessary complexity, consolidating duplicated logic, catching efficiency issues. Prioritizes codebase cohesion over local perfection.

## Core philosophy

**Every change must earn its keep.** A simplification that doesn't meaningfully improve clarity, correctness, or cohesion is noise. Don't refactor for refactoring's sake. Don't create new files, abstractions, or utilities unless they solve a demonstrated problem. If the existing code works and is readable, leave it alone. The goal is a cohesive codebase, not a pristine one.

## Procedure

### Phase 1: Identify changes

Run `git status` to see the shape of the working tree, then `git diff HEAD` for all uncommitted changes (staged and unstaged). Untracked files never appear in the diff — read new files directly. If the diff is empty and there are no untracked files, review the last commit (`git diff HEAD~1 HEAD`); if that is also empty, say the tree is clean and stop. Don't go hunting through the codebase for files to improve.

### Phase 2: Understand the surrounding codebase

Don't review changes in isolation. Before any modifications:

1. **Read the full files** containing changes — not just the diff hunks. Understand imports, surrounding logic, module structure.
2. **Identify the project language(s)** and select the relevant transformation rules. Discard inapplicable rules.
3. **Survey adjacent code** — shared utilities, sibling modules, common patterns. You need to know what already exists before deciding something is missing.
4. **Run the project's gate once before editing** to establish a baseline. Find it in `package.json` scripts — `devcheck` if present, else `check`, else the separate `typecheck` / `lint` / `test` scripts; Python projects gate on `uv run ruff check`, `uv run ruff format --check`, and the configured type checker and test runner. In a Bun project that tests with Vitest, run `bun run test` — bare `bun test` bypasses the script and runs Bun's own runner. If the gate is already red, say so in the summary and don't attribute the failure to your changes.

### Phase 3: Review

Evaluate the changes across these dimensions. Not every dimension applies to every diff — skip what's irrelevant.

#### Codebase cohesion

- **Reuse** — Search for existing utilities, helpers, and patterns that could replace newly-written code. Check utility directories, shared modules, and files adjacent to the changed ones. If a function already exists that does what the new code does, use it.
- **Consolidation** — Flag copy-paste-with-variation: near-duplicate code blocks that should be unified. Only unify if the shared abstraction is genuinely simpler than the duplicated code.
- **Consistency** — Check that new code follows the same patterns as the rest of the codebase: naming conventions, error handling style, import patterns, type annotation style. Normalize toward the better variant when the project is inconsistent.
- **Stringly-typed code** — Flag raw strings where constants, string-union types, or branded types already exist in the codebase.

#### Code quality

- **Redundant state** — State that duplicates existing state, cached values that could be derived.
- **Unnecessary complexity** — Deep nesting that could be guard clauses, premature abstractions, over-engineered solutions to simple problems.
- **Dead code** — Unreachable branches, unused variables, commented-out code. An export nothing imports is dead in an application or a package-internal module; on a published package's public surface it is API — leave it and note it in the summary.
- **Defensive code for impossible states** — Guards for cases the type system or upstream validation already prevents. Drop them.
- **Type escapes** — `any`, `as` casts that paper over a mismatch, non-null `!`, and `@ts-ignore`. Each is a claim the compiler couldn't check: replace with a narrowed type, a type guard, or a parse at the boundary. Keep the ones documenting a genuine type-system or third-party-types limitation, and prefer `@ts-expect-error` with a one-line reason over `@ts-ignore`.
- **Swallowed errors** — Empty `catch {}`, `catch { return null }`, and `try` blocks that log and continue. A fallback that hides a failure is worse than the crash it prevents: rethrow or let it propagate. When wrapping, preserve the chain (`new Error(msg, { cause })`, `raise X from err`).
- **Comment noise** — Strip comments that restate the code, commented-out code, and comments describing behavior the diff removed. Keep file headers, export JSDoc, and any comment carrying a *why* — a constraint, a workaround, an upstream bug reference.
- **Outdated patterns** — Verbose or legacy syntax where modern equivalents exist. See the transformation tables below.

#### Efficiency

- **Redundant work** — Repeated computations, duplicate file reads, duplicate network/API calls, N+1 query patterns.
- **Missed concurrency** — Independent async operations run sequentially that could run in parallel with `Promise.all` / `Promise.allSettled`.
- **Unbounded fan-out** — `Promise.all` / `asyncio.gather` over a caller-sized or otherwise unbounded array fires everything at once. Cap it with the project's existing concurrency helper or a batched loop. A fixed handful of independent calls needs no limit.
- **No-op updates** — State/store updates inside loops or event handlers that fire unconditionally. Add change-detection so downstream consumers aren't notified when nothing changed.
- **TOCTOU** — Pre-checking file/resource existence before operating on it. Operate directly and handle the error instead.
- **Overly broad operations** — Reading entire files when only a portion is needed, loading all items when filtering for one.

#### mcp-ts-core-specific

- **Gate** — `bun run devcheck` plus the test suite (`bun run test`) is the project gate in Phase 2 step 4 and Phase 4 step 5.
- **Framework-provided utilities** — Before hand-rolling, check `src/utils/` and `src/errors/` in the project and `node_modules/@cyanheads/mcp-ts-core/` for framework exports: pagination helpers, schema builders, retry primitives, and the `ATTR_*` OTel attribute constants are framework-provided. Raw OTel attribute keys should be `ATTR_*` imports from `@cyanheads/mcp-ts-core/utils`.
- **Error throwing patterns** — Prefer framework error factories (`McpError`, `validationError`, `notFound`, `httpErrorFromResponse`) over raw `throw new Error()`. Tool handlers should throw — the framework catches, classifies, and instruments.
- **Error codes** — `InvalidParams` only for malformed JSON-RPC params shape. `ValidationError` for domain validation. `NotFound` for missing entities. Don't conflate them.
- **Ctx usage** — Use `ctx.log`, `ctx.state`, `ctx.enrich` — don't reach for global loggers or request-scoped storage directly. The `ctx` pattern carries tenant scope and OTel context.
- **Zod schemas** — Every tool input/output field needs `.describe()`. Zod 4 requires `z.record(z.string(), z.string())` not `z.record(z.string())`. Use `.optional()` rather than `.nullish()` unless null is semantically distinct from absent.
- **Tool annotations** — `readOnlyHint`, `idempotentHint`, `openWorldHint` should reflect reality. A read-only tool with `readOnlyHint: false` gives clients the wrong picture.
- **`exactOptionalPropertyTypes` boundaries** — If a downstream type insists on the field being present-or-not-present (not present-as-undefined), use a mapped widening type at the boundary. The pattern is documented in the framework.
- **`format()` ↔ `structuredContent` parity** — Different MCP clients forward different surfaces. Tests should assert both surfaces carry equivalent data.
- **Defensive code** — the "impossible states" the framework already prevents include malformed params (Zod-validated before the handler runs) and unclassified errors (caught and classified after it throws). Guards for either are dead.
- **Public surface** — the MCP surface (every tool input/output schema advertised to clients) is public API for the "API compatibility" rule; changing one is a breaking change, not a refactor.

### Phase 4: Apply transformations

1. **Filter findings ruthlessly.** If a finding is a false positive or not worth the churn, skip it. Don't argue with yourself about borderline cases — move on.
2. **Stay in scope.** Edit only files in the diff or new this session. Touch a file outside that set only when a finding requires it — importing an existing helper, deleting a private export the diff just orphaned — and only on the lines that finding names. Anything broader goes in the summary as a recommendation, not into the tree.
3. **Correctness bugs are not this pass's job.** A real defect doesn't get folded into a cleanup diff — name it in the summary with file and line so it can be handled as its own change.
4. **Transform incrementally** — one category of change at a time (modernize syntax, then reduce nesting, then consolidate).
5. **Verify equivalence** — all functionality, types, and public interfaces must remain unchanged. Re-run the gate from Phase 2 after transforming; a simplification that breaks the build is worse than the verbosity it removed.
6. **Keep the diff minimal.** Only touch lines that have a real reason to change. Don't reformat untouched code, add comments to code you didn't modify, or "improve" things that are already fine. Formatting belongs to the formatter (Biome, ruff): never hand-adjust whitespace, quotes, or import order, and never let a formatting-only hunk into the diff.
7. **Never stage, commit, tag, or push.** This pass ends with a dirty working tree and a summary; landing the changes is the caller's call.

When done, briefly summarize what was fixed, what was deliberately skipped, and any defects or out-of-scope recommendations — or confirm the code was already clean.

## Common transformations

The tables below cover TypeScript and Python. For other languages, apply analogous principles: prefer modern idioms, reduce nesting, eliminate dead code, follow project conventions. Check the project's language floor (`tsconfig` target/lib, `pyproject` `requires-python`) before applying a version-gated row.

### TypeScript (modern ESM, TS 5.x+)

| Before | After | Why |
| --- | --- | --- |
| `const x: Foo = { ... } as Foo` | `const x = { ... } satisfies Foo` | Type-checked without assertion |
| `let resource = acquire(); try { ... } finally { release(resource) }` | `using resource = acquire()` | Explicit resource disposal (TS 5.2+) |
| `if (x !== null && x !== undefined)` | `if (x != null)` | Idiomatic null/undefined check |
| `arr.filter(x => x !== null) as T[]` | `arr.filter(x => x != null)` | TS 5.5+ infers the type predicate — no cast; on older TS use an explicit `(x): x is T` predicate |
| `export { foo } from './foo/index.js'` | Direct imports at call sites | Avoid barrel re-exports inside the package; barrel exports are for public APIs only |
| `import { readFile } from 'fs/promises'` | `import { readFile } from 'node:fs/promises'` | `node:` protocol — unambiguous, lint-enforced in Biome |
| `async function f() { const a = await x(); const b = await y(); }` | `const [a, b] = await Promise.all([x(), y()])` | Parallel when independent |
| `value \|\| fallback` | `value ?? fallback` | `\|\|` also swallows `0`, `''`, and `false` — use `??` unless every falsy value really should take the fallback |
| `obj.x !== undefined ? obj.x : fallback` | `obj.x ?? fallback` | Nullish coalescing — equivalent only when `null` should take the fallback too |
| `if (a) { if (b) { if (c) { ... } } }` | Guard clauses with early returns | Reduce nesting |
| `try { risky() } catch (e: any) { ... }` | `try { risky() } catch (e) { ... }` | Under `strict` the catch binding is already `unknown`; narrow with a type guard before use |
| `catch (err) { throw new Error('load failed') }` | `throw new Error('load failed', { cause: err })` | Preserve the cause chain |
| `[...arr].sort(cmp)` / `arr.slice().sort(cmp)` | `arr.toSorted(cmp)` | Non-mutating array methods (ES2023) — also `toReversed`, `toSpliced`, `with` |
| `const c = new AbortController(); setTimeout(() => c.abort(), ms)` | `AbortSignal.timeout(ms)` | Built-in timeout signal; combine with a caller's signal via `AbortSignal.any([...])` |
| `JSON.parse(JSON.stringify(x))` | `structuredClone(x)` | Deep clone that preserves Date, Map, Set, and cycles |
| `enum Status { A, B, C }` | `const Status = { A: 'A', B: 'B', C: 'C' } as const` | `enum`, `namespace`, and constructor parameter properties are non-erasable syntax rejected by TS 5.8 `erasableSyntaxOnly` and Node type-stripping — but switching numeric values to strings changes serialized output; keep values stable if they're persisted |
| `function f(a: string, b: string, c: string, d?: string)` | `function f(opts: FnOptions)` | Options object when >3 params |
| `throw new Error('Bad input')` (in a tool handler) | `throw validationError('Bad input', { field: 'x' })` | Use framework error factories so the framework can classify and instrument |
| `const ATTR_KEY = 'mcp.tool.name'` | `import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils'` | Use framework attribute constants |

### Python (3.12+)

| Before | After | Why |
| --- | --- | --- |
| `Optional[str]` | `str \| None` | Modern union syntax (3.10+) |
| `List[str]`, `Dict[str, int]` | `list[str]`, `dict[str, int]` | Built-in generics (3.9+) |
| `T = TypeVar("T")` + `def f(x: T) -> T` | `def f[T](x: T) -> T` | PEP 695 generics (3.12+) — also `class C[T]:` |
| `TypeAlias = Union[A, B, C]` | `type ABC = A \| B \| C` | `type` statement (3.12+) |
| `if isinstance(x, Foo): a = x.a; b = x.b` | `match x: case Foo(a=a, b=b): ...` | Structural pattern matching (3.10+) where it destructures — not as a replacement for a flat equality `if/elif` chain |
| `class Config: def __init__(self, a, b, c): self.a = a ...` | `@dataclass(slots=True) class Config: a: str; b: int; c: float` | Less boilerplate, built-in eq/repr; `frozen=True` when instances shouldn't mutate |
| `results = []; for item in items: results.append(transform(item))` | `results = [transform(item) for item in items]` | Idiomatic comprehension |
| `f = open('x'); try: ... finally: f.close()` | `with open('x') as f: ...` | Context manager for resources |
| `os.path.join(d, n)`, `os.path.exists(p)`, `open(p).read()` | `Path(d) / n`, `p.exists()`, `p.read_text()` | `pathlib` over `os.path` string juggling |
| `datetime.utcnow()` / `datetime.utcfromtimestamp(t)` | `datetime.now(UTC)` / `datetime.fromtimestamp(t, UTC)` | Deprecated in 3.12 — the old calls return naive datetimes that compare wrong against aware ones |
| `zip(a, b)` | `zip(a, b, strict=True)` | 3.10+ — silently truncating to the shorter input hides bugs |
| `m = pattern.match(s)` then `if m: use(m)` | `if (m := pattern.match(s)): use(m)` | Walrus operator where it removes a throwaway assignment |
| `"Hello " + name + "!"` | `f"Hello {name}!"` | f-string over concatenation |
| `except Exception as e: pass` | `except SpecificError as e: log(e)` | Catch specific, never bare except/pass |
| `from module import *` | `from module import specific_name` | Explicit imports only |
| Sequential `await` for independent I/O | `async with asyncio.TaskGroup() as tg: tg.create_task(a()); tg.create_task(b())` | Structured concurrency (3.11+) — cancels siblings on failure and raises an `ExceptionGroup`; `asyncio.gather(..., return_exceptions=True)` stays correct when every result is wanted regardless of failures |

## When NOT to simplify

Leave code alone when:

- **It works and is readable.** "I would have written it differently" is not a reason to change it.
- **The change is cosmetic.** Renaming a variable from `data` to `result` isn't worth the churn.
- **Intentional verbosity for debugging.** Verbose code may exist to make stack traces or logging clearer.
- **Performance-critical paths.** A less readable version may exist for measured performance reasons — check before simplifying.
- **API compatibility.** Don't change public function signatures, export shapes, or return types that callers depend on.
- **Tests.** Don't DRY up test code aggressively — test readability and isolation matter more than deduplication.
- **Type workarounds.** Sometimes an `as` cast or `# type: ignore` exists because of a genuine type system limitation — verify before removing.
- **The abstraction isn't proven.** Don't create a shared utility for two similar blocks of code. Wait until there are three, and even then only if the abstraction is genuinely simpler than the duplication.
- **`return await` inside `try` / `finally`.** Collapsing it to `return` is not equivalent — the promise settles outside the block, so `catch` never fires and `finally` runs early. Only strip `await` from a `return` in plain function-body position.
- **Lazy logging arguments.** `logger.info("loaded %s in %sms", name, ms)` defers formatting until the record is emitted — don't turn it into an f-string.
- **Awaits that only look independent.** Sequential I/O may be sequential on purpose: rate limits, upstream ordering, a write that must land before the next read. Confirm independence from the code, not from the shape of the calls, before reaching for `Promise.all`.
- **Generated and vendored files.** Lockfiles, generated clients and schemas, migrations, snapshots, and anything under `dist/` are regenerated, not edited — skip them even when they appear in the diff.
- **Tool descriptions and `.describe()` prose.** They are the contract an LLM client reads — tightening them for brevity degrades the surface. Treat them as API text, not as comments.

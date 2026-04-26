---
name: api-linter
description: >
  MCP definition linter rules reference. Use when `bun run lint:mcp`, `bun run devcheck`, or `createApp()` startup reports a lint error or warning (`format-parity`, `schema-is-object`, `name-format`, `server-json-*`, etc.) and you need to understand the rule, its severity, and how to fix it. Every rule ID the linter emits has an entry in this doc.
metadata:
  author: cyanheads
  version: "1.2"
  audience: external
  type: reference
---

## Overview

The linter validates tool, resource, and prompt definitions against the MCP spec and framework conventions. It runs in three places:

| Entry point | When | On failure |
|:------------|:-----|:-----------|
| `createApp()` / `createWorkerHandler()` | Every startup | Throws `ConfigurationError`; process exits with a formatted banner. Warnings are logged and startup continues. |
| `bun run lint:mcp` | Manual or CI | Prints errors + warnings, exits non-zero on errors. |
| `bun run devcheck` | Pre-commit workflow | Wraps `lint:mcp` alongside typecheck, format, `bun audit`, `bun outdated`. |

All three surface the same `LintReport` from `validateDefinitions()` (exported from `@cyanheads/mcp-ts-core/linter`). Each diagnostic has a stable `rule` ID — that's the anchor you land on via the `See: skills/api-linter/SKILL.md#<rule>` breadcrumb appended to every message.

**Severity:**
- **error** — MUST-level spec violation; blocks startup.
- **warning** — SHOULD-level or quality issue; logged but startup continues.

**Imports (if you need to run the linter programmatically):**

```ts
import { validateDefinitions } from '@cyanheads/mcp-ts-core/linter';
import type { LintReport, LintDiagnostic } from '@cyanheads/mcp-ts-core/linter';

const report = validateDefinitions({ tools, resources, prompts, serverJson, packageJson });
if (!report.passed) process.exit(1);
```

---

## Rule index

Grouped by family. Jump to any rule ID via its anchor.

| Family | Rules | Section |
|:-------|:------|:--------|
| Format parity | `format-parity`, `format-parity-threw`, `format-parity-walk-failed` | [Format parity](#format-parity) |
| Schema | `schema-is-object`, `describe-on-fields`, `schema-serializable` | [Schema rules](#schema-rules) |
| Names | `name-required`, `name-format`, `name-unique` | [Name rules](#name-rules) |
| Tools | `description-required`, `handler-required`, `auth-type`, `auth-scope-format`, `annotation-type`, `annotation-coherence`, `meta-ui-type`, `meta-ui-resource-uri-required`, `meta-ui-resource-uri-scheme`, `app-tool-resource-pairing` | [Tool rules](#tool-rules) |
| Resources | `uri-template-required`, `uri-template-valid`, `resource-name-not-uri`, `template-params-align` | [Resource rules](#resource-rules) |
| Prompts | `generate-required` | [Prompt rules](#prompt-rules) |
| server.json | ~40 rules prefixed `server-json-*` | [server.json rules](#server-json-rules) |

---

## Format parity

Why this family exists: different MCP clients forward different surfaces of a tool response to the model. Claude Code reads `structuredContent` (from your handler's return value, typed by `output`). Claude Desktop reads `content[]` (from your `format()` function). Every field must be visible on both surfaces or one class of client sees less than another. The linter enforces this by synthesizing a sample value where every leaf is a uniquely identifiable sentinel, calling `format()` once, then verifying each sentinel (or its key name, for permissive types like booleans) appears in the rendered text.

### format-parity

**Severity:** error

Fires when `format()` does not render a field present in `output`. Emitted once per missing field; large schemas can produce many `format-parity` diagnostics from a single tool.

**Primary fix:** render the missing field in `format()`. For tools that return either a summary list or a detail view, use `z.discriminatedUnion` so each branch is walked separately:

```ts
output: z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('list'), items: z.array(ItemSchema) }),
  z.object({ mode: z.literal('detail'), item: ItemSchema, history: z.array(HistoryEntry) }),
]),

format: (result) => {
  if (result.mode === 'list') return renderList(result.items);
  return renderDetail(result.item, result.history);
}
```

**Escape hatch:** if the output schema was over-typed for a genuinely dynamic upstream API (e.g., a third-party JSON blob whose shape you can't nail down), relax it:

```ts
output: z.object({}).passthrough()
```

`passthrough()` still flows the full payload to `structuredContent` without declaring each field, so the linter has nothing to check against and you're not maintaining aspirational typing.

**Anti-pattern:** summary-only `format()` like `return [{ type: 'text', text: \`Found ${n} items\` }]`. The sentinel walk will flag every field in the items array. Don't "fix" this by removing fields from `output` — that makes `structuredContent` clients blind too.

### format-parity-threw

**Severity:** warning

Fires when `format()` throws while being called with a synthetic sample. The linter cannot verify parity because your formatter crashed before producing output.

**Fix:** `format()` must be **total** — render any valid value of the output schema without throwing. Common causes:

- Assuming an optional array is always present (`result.items.map(...)` when `items` could be `undefined`)
- Dereferencing a discriminated-union branch without checking the discriminator
- Calling `toFixed()` or `toISOString()` on a value that could legitimately be any number/string

Add narrow guards. The linter feeds a synthetic but schema-valid value; if your formatter can't handle it, real inputs will eventually hit the same path.

### format-parity-walk-failed

**Severity:** warning

Fires when the linter cannot walk the output schema to build a synthetic sample (usually because the schema uses an unusual composition the walker doesn't recognize). Parity is not verified for that tool — nothing is broken at runtime, but the check is silently disabled.

**Fix:** inspect the walker error message in the diagnostic. Usually caused by very deep recursion, custom Zod extensions, or mixing Zod 3 and 4 schema internals. File an issue against `@cyanheads/mcp-ts-core` with the schema shape — this is a linter gap, not user error.

---

## Schema rules

### schema-is-object

**Severity:** error

Tool `input`/`output` and prompt `args` must be `z.object({...})` at the top level (not `z.string()`, `z.array(...)`, etc.). The MCP spec requires a keyed structure at the schema root.

**Fix:** wrap whatever you had in a single-key object:

```ts
// Wrong
input: z.array(z.string())
// Right
input: z.object({ items: z.array(z.string()).describe('List of items') })
```

### describe-on-fields

**Severity:** warning

Every field in `input`, `output`, `params`, or `args` needs a `.describe('...')` call. Descriptions ship to the client and the LLM — missing ones make tools harder to use correctly.

**Fix:** add `.describe('...')` to the paths the linter flags. The diagnostic names which path is missing a description (e.g., `input.filters.status`).

**Recursion rules** — the linter walks selectively; primitive array elements are intentionally skipped. Knowing what's walked prevents over-application of describes that end up as noise in the generated JSON Schema.

| Schema position | Walked? | Describe required on inner? |
|:---|:---|:---|
| `z.object({ ... })` field | Yes | Yes, on each field |
| `z.array(compound)` element — object, array, or union | Yes | Yes, on the element |
| `z.array(primitive)` element — string, number, enum, regex-branded primitive, etc. | **No** | No — outer array describe is sufficient |
| `z.union([a, b, ...])` non-literal option | Yes | Yes, on each option |
| `z.union([..., z.literal(X), ...])` literal option | **No** | No — outer union describe is sufficient |

The asymmetry that catches agents: inside `z.union([z.string(), z.array(z.string())])`, the outer `z.string()` option **does** need a describe (unions walk non-literal options), but the `z.string()` inside the inner array does **not** (arrays don't walk primitive elements). If the linter didn't flag a path, don't add a describe there — the redundant describe ships to the JSON Schema as clutter.

**Literal variants are exempt** because they carry no independent semantic content — they're structural markers. The canonical case is form-client blank tolerance, where a `z.literal('')` variant is threaded into a union alongside a validated string so empty submissions from MCP Inspector / web UIs round-trip without breaking schema-level validation:

```ts
variable: z
  .union([
    z.literal(''),                                    // form-client sentinel — no describe needed
    z.string().max(50).regex(/^[a-z_][a-z0-9_]*$/i)
      .describe('Identifier matching [a-zA-Z_][a-zA-Z0-9_]*, max 50 chars'),
  ])
  .optional()
  .describe('Variable name. Blank values from form-based clients are treated as omitted.'),
```

The outer describe on the union carries the semantic load; the non-literal variant still gets its own describe so the LLM sees the regex/length constraints in JSON Schema. Only the `z.literal` is skipped.

### schema-serializable

**Severity:** error

Input/output schemas must use JSON-Schema-serializable Zod types only. The MCP SDK converts schemas to JSON Schema for `tools/list`; non-serializable types cause a hard runtime failure.

**Disallowed:** `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`.

**Fix:** use structural equivalents. Most common swap:

```ts
// Wrong
z.date()
// Right
z.string().describe('ISO 8601 timestamp, e.g., 2026-04-20T12:00:00Z')
```

Parse the string to a `Date` inside the handler if you need one.

---

## Name rules

### name-required

**Severity:** error

Every tool, resource, and prompt definition needs a non-empty `name` string. For resources, an empty `name` also falls back to the URI template (see `resource-name-not-uri`).

### name-format

**Severity:** error

Names must match `^[a-zA-Z0-9._-]+$` (alphanumerics, dots, hyphens, underscores). Tools conventionally use `snake_case`, resources and prompts use `kebab-case` or `snake_case`.

**Fix:** rename to a valid identifier. If the legacy name is user-facing, keep `title` as the display string and use a valid `name` internally.

### name-unique

**Severity:** error

Tool names, resource names, and prompt names must each be unique within their type. Duplicates would cause the client to see only one.

**Fix:** rename one, or consolidate into a single definition if they're actually the same tool.

---

## Tool rules

### description-required

**Severity:** warning

Every tool, resource, and prompt needs a non-empty `description`. This is what the client shows the LLM to decide whether to call the definition. A missing description dramatically hurts selection accuracy.

Also applies to resources and prompts (same rule ID, different `definitionType`).

**Fix:** write a single cohesive paragraph. Prose, not bullet lists. Descriptions render inline in most clients.

### handler-required

**Severity:** error

Every tool must have a `handler` function (or `taskHandlers` object for task tools). Every resource must have a `handler`. Definitions without handlers can't do anything at runtime.

Also applies to resources (same rule ID, different `definitionType`).

### auth-type

**Severity:** error

`auth` must be an array of strings. A single string or other shape is rejected.

```ts
// Wrong
auth: 'tool:my_tool:read'
// Right
auth: ['tool:my_tool:read']
```

### auth-scope-format

**Severity:** error

Every element in `auth` must be a non-empty string. Empty strings in the array are rejected — they'd match anything.

### annotation-type

**Severity:** warning

`annotations` hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) must be booleans. Strings like `'yes'` or numbers are rejected — the MCP spec defines these as booleans and clients may type-check.

### annotation-coherence

**Severity:** warning

Contradictory annotation combinations. The canonical case: `readOnlyHint: true` with `destructiveHint: true` — a read-only tool cannot be destructive. `idempotentHint: true` alongside `readOnlyHint: true` is fine (explicit redundancy is allowed).

### meta-ui-type

**Severity:** error (MCP Apps tools only)

When a tool declares `_meta.ui`, that field must be an object. `null`, arrays, or primitives are rejected.

### meta-ui-resource-uri-required

**Severity:** error (MCP Apps tools only)

`_meta.ui.resourceUri` must be a non-empty string. This is the URI the client resolves to load the app UI.

### meta-ui-resource-uri-scheme

**Severity:** warning (MCP Apps tools only)

`_meta.ui.resourceUri` should use the `ui://` scheme. Other schemes (like `https://`) work but are discouraged — the `ui://` convention signals the resource is meant to be hosted by the MCP server, not fetched externally.

### app-tool-resource-pairing

**Severity:** warning (MCP Apps tools only)

An app tool's `_meta.ui.resourceUri` must match the `uriTemplate` of a registered resource. This catches the common mistake of renaming one side of the pair and forgetting the other.

**Fix:** either correct the `resourceUri` to match an existing resource, or register the resource it references. Use the `add-app-tool` skill's paired scaffold to avoid this.

---

## Resource rules

### uri-template-required

**Severity:** error

Every resource needs a non-empty `uriTemplate` string. The URI template is the resource's primary identifier.

### uri-template-valid

**Severity:** error

`uriTemplate` must be syntactically valid per RFC 6570: balanced braces, non-empty variable names. `test://{id/data` (unbalanced) and `test://{}/data` (empty variable) are rejected.

### resource-name-not-uri

**Severity:** warning

Warns when the resource's `name` defaults to the URI template because no explicit name was provided. URIs make poor display names — clients often show them verbatim.

**Fix:** add a short `name` field:

```ts
resource('myscheme://{id}/data', {
  name: 'Item data',  // <-- add this
  // ...
})
```

### template-params-align

**Severity:** error

Every variable in the URI template must appear as a key in the `params` schema, and vice versa. `test://{itemId}/data` with `params: z.object({ item_id: ... })` is rejected — casing mismatches count.

**Fix:** rename one side so they match exactly. The error message names which variables are on which side.

---

## Prompt rules

### generate-required

**Severity:** error

Every prompt needs a `generate` function that returns the message array. Prompts without `generate` have nothing to produce.

(Prompts also share `name-*` and `description-required` rules from their respective families.)

---

## server.json rules

Validates the `server.json` manifest at project root against the [MCP server manifest spec](https://modelcontextprotocol.io/specification). Every rule below fires only when a `server.json` is present.

| Rule ID | Severity | What it checks |
|:--------|:---------|:---------------|
| `server-json-type` | error | `server.json` must be a JSON object, not an array or primitive |
| `server-json-name-required` | error | `name` must be present and non-empty |
| `server-json-name-length` | error | `name` length 3–200 characters |
| `server-json-name-format` | error | `name` must match reverse-DNS pattern `owner/project` |
| `server-json-description-required` | error | `description` must be present and non-empty |
| `server-json-description-length` | warning | `description` > 100 chars — some registries truncate |
| `server-json-version-required` | error | `version` must be present |
| `server-json-version-length` | error | `version` length ≤ 255 |
| `server-json-version-no-range` | error | `version` must be a specific version, not a range (`^`, `~`, `>=`, etc.) |
| `server-json-version-semver` | warning | `version` should be valid semver (`major.minor.patch`) |
| `server-json-version-sync` | warning | `server.json` `version` should match `package.json` `version` |
| `server-json-repository-type` | error | `repository` must be an object |
| `server-json-repository-url` | error | `repository.url` is required when `repository` is present |
| `server-json-repository-source` | error | `repository.source` is required when `repository` is present |
| `server-json-packages-type` | error | `packages` must be an array |
| `server-json-package-type` | error | Each `packages[i]` must be an object |
| `server-json-package-registry` | error | `packages[i].registryType` is required |
| `server-json-package-identifier` | error | `packages[i].identifier` is required |
| `server-json-package-transport` | error | `packages[i].transport` is required |
| `server-json-package-no-latest` | error | `packages[i].version` must not be `"latest"` — pin a specific version |
| `server-json-package-version-sync` | warning | `packages[i].version` should match root `version` |
| `server-json-package-args-type` | error | `packages[i].packageArguments` must be an array |
| `server-json-runtime-args-type` | error | `packages[i].runtimeArguments` must be an array |
| `server-json-env-vars-type` | error | `packages[i].environmentVariables` must be an array |
| `server-json-remotes-type` | error | `remotes` must be an array |
| `server-json-remote-type` | error | Each `remotes[i]` must be an object |
| `server-json-remote-transport-type` | error | `remotes[i].type` is required |
| `server-json-remote-no-stdio` | error | `remotes[i].type` must be `streamable-http` or `sse` — `stdio` is not valid for remotes |
| `server-json-transport-type` | error | `transport` must be an object |
| `server-json-transport-type-value` | error | `transport.type` must be one of `stdio`, `streamable-http`, `sse` |
| `server-json-transport-url-required` | error | `transport.url` required for `streamable-http` and `sse` |
| `server-json-transport-url-format` | warning | `transport.url` should be `http://` or `https://` |
| `server-json-argument-type` | error | Each argument must be an object |
| `server-json-argument-type-value` | error | `argument.type` must be `positional` or `named` |
| `server-json-argument-name` | error | Named arguments require `name` |
| `server-json-argument-value` | error | Positional arguments require `value` or `valueHint` |
| `server-json-input-format` | warning | `format` should be `string`, `number`, `boolean`, or `filepath` |
| `server-json-env-var-type` | error | Each environment variable must be an object |
| `server-json-env-var-name` | error | Environment variable `name` is required |
| `server-json-env-var-description` | warning | Environment variables should have a `description` |

Most of these are mechanical — fix the manifest field named in the diagnostic's `message`. The registry spec is the source of truth; this linter just surfaces violations before you submit.

---

## Escape hatches

### Dynamic upstream data

If `output` wraps a third-party API whose shape you can't pin down, prefer `z.object({}).passthrough()` over aspirational typing. The linter skips `format-parity` for passthrough schemas, and `structuredContent` still receives the full payload.

### Temporarily suppress a warning

Warnings don't block startup, so you can ship with them logged. If one is genuinely wrong (rather than the rule being wrong for your case), file an issue against `@cyanheads/mcp-ts-core` with the repro — the linter rules are still maturing.

### Escape isn't "make it pass"

Don't remove fields from `output` to silence `format-parity` — that makes the data invisible to `structuredContent` clients too. Don't rename `description` to something else to silence `describe-on-fields`. The right fix is either to render the field (format-parity) or accept the warning (description-required).

---

## Adding a new rule

If you're extending `@cyanheads/mcp-ts-core` with a new lint rule:

1. Add the rule to `src/linter/rules/<family>-rules.ts`. Return `LintDiagnostic` objects with a stable `rule` ID.
2. Wire it into `validateDefinitions()` in `src/linter/validate.ts` if it's a new family.
3. Add tests in `tests/unit/linter/`.
4. **Document the rule in this file.** Add it to the rule index, write a section under the matching family, and bump `metadata.version` in the frontmatter.
5. The breadcrumb mapping in `validateDefinitions()` is family-prefix-based (`server-json-*` → `#server-json-rules`, etc.), so rules in existing families pick up the right anchor automatically.

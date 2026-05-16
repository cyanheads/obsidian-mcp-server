---
name: api-linter
description: >
  MCP definition linter rules reference. Use when `bun run lint:mcp`, `bun run devcheck`, or `createApp()` startup reports a lint error or warning (`format-parity`, `schema-is-object`, `name-format`, `server-json-*`, etc.) and you need to understand the rule, its severity, and how to fix it. Every rule ID the linter emits has an entry in this doc.
metadata:
  author: cyanheads
  version: "1.3"
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
| Portability | `schema-format-portability`, `schema-anyof-needs-type`, `schema-no-discriminator-keyword`, `schema-no-defs`, `schema-dialect-tag` | [Portability rules](#portability-rules) |
| Names | `name-required`, `name-format`, `name-unique` | [Name rules](#name-rules) |
| Tools | `description-required`, `handler-required`, `auth-type`, `auth-scope-format`, `annotation-type`, `annotation-coherence`, `meta-ui-type`, `meta-ui-resource-uri-required`, `meta-ui-resource-uri-scheme`, `app-tool-resource-pairing` | [Tool rules](#tool-rules) |
| Resources | `uri-template-required`, `uri-template-valid`, `resource-name-not-uri`, `template-params-align` | [Resource rules](#resource-rules) |
| Landing | `landing-*` (23 rules — shape, tagline, logo, links, repo, envExample, connectSnippets, theme) | [Landing config rules](#landing-config-rules) |
| Prompts | `generate-required` | [Prompt rules](#prompt-rules) |
| Handler body | `prefer-mcp-error-in-handler`, `prefer-error-factory`, `preserve-cause-on-rethrow`, `no-stringify-upstream-error` | [Handler body rules](#handler-body-rules) |
| Error contract (structural) | `error-contract-type`, `error-contract-empty`, `error-contract-entry-type`, `error-contract-code-type`, `error-contract-code-unknown`, `error-contract-code-unknown-error`, `error-contract-reason-required`, `error-contract-reason-format`, `error-contract-reason-unique`, `error-contract-when-required`, `error-contract-retryable-type` | [Error contract rules](#error-contract-rules) |
| Error contract (conformance) | `error-contract-conformance`, `error-contract-prefer-fail` | [Error contract rules](#error-contract-rules) |
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

## Portability rules

MCP pins JSON Schema 2020-12 as the default dialect (SEP-1613), but LLM vendors accept different *subsets*. A schema that passes `schema-serializable` can still hard-fail at OpenAI's tool validator or silently lose fields at Gemini's API surface. These rules walk the emitted JSON Schema for patterns that break cross-vendor.

Three default-on, two opt-in. Promote opt-ins via `MCP_LINT_PORTABILITY=strict` (env) or `validateDefinitions({ portability: 'strict' })` when targeting multi-vendor deployments.

| Rule | Severity | Default-on? |
|:-----|:---------|:------------|
| `schema-format-portability` | error | yes |
| `schema-anyof-needs-type` | warning | yes |
| `schema-no-discriminator-keyword` | warning | yes |
| `schema-no-defs` | warning | only when `portability: 'strict'` |
| `schema-dialect-tag` | warning | only when `portability: 'strict'` |

### schema-format-portability

**Severity:** error

Fires when the emitted schema contains a `format` value outside the allowlist. Default = OpenAI's nine: `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uuid` — the strictest commonly-used target. OpenAI's tool validator **hard-rejects** unknown formats: the tool never registers and the model never sees it. Field report: [cyanheads/git-mcp-server#47](https://github.com/cyanheads/git-mcp-server/issues/47) (`gpt-5-codex` rejecting `format: "uri"` from `z.url()`).

Zod methods vs. the default allowlist:

| Zod call | Emitted format | Allowed? |
|:---------|:---------------|:---------|
| `z.email()`, `z.uuid()`, `z.iso.datetime()`, `z.iso.date()` | `email` / `uuid` / `date-time` / `date` | yes |
| `z.url()` | `uri` | **no — fires** |
| `z.cuid()`, `z.cuid2()`, `z.ulid()`, `z.nanoid()`, `z.base64()`, `z.jwt()` | various | **no — fires** |

**Fix:** drop the format method, move the constraint into `.describe()` text where the model reads it:

```ts
// Wrong                                  // Right
homepage: z.url().describe('Homepage')    homepage: z.string().describe('Homepage (absolute URL)')
```

**Override:** widen the allowlist when targeting only vendors that accept the format:

```ts
validateDefinitions({ formatAllowlist: ['email', 'uuid', 'date-time', 'uri'], tools, resources, prompts });
```

### schema-anyof-needs-type

**Severity:** warning

Fires when an `anyOf`/`oneOf` branch lacks a top-level `type`. Gemini rejects with `400: reference to undefined schema`. Triggered by patterns like `z.union([z.object({...}).nullable(), z.object({...})])` — the inner nullable emits a typeless `anyOf`.

**Fix:** prefer optionality via required-omission, or use `z.discriminatedUnion` for tagged unions — both emit branches with explicit `type: "object"`.

### schema-no-discriminator-keyword

**Severity:** warning

Fires when a schema carries the OpenAPI `discriminator` keyword. OpenAI silently ignores it; Gemini doesn't recognize it. Zod 4's `z.discriminatedUnion` emits the portable shape (`oneOf` of typed branches with `const`-tagged literals), so this rule mainly catches hand-built schemas attached via `.meta({...})` or third-party-generated JSON Schema.

**Fix:** drop the `discriminator` meta — the `const` literals on each branch are how clients tell variants apart.

### schema-no-defs

**Severity:** warning (only when `portability: 'strict'`)

Fires when emitted output contains `$defs` or `$ref`. Gemini rejects these (`400: reference to undefined schema`). Typically caused by reused or recursive types built with `z.lazy(...)`. Opt-in because [SEP-1576](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1576) (token-bloat mitigation) is moving the community toward more `$defs`.

**Fix:** inline the recursive type with bounded depth, or accept the Gemini limitation if you target only Anthropic clients.

### schema-dialect-tag

**Severity:** warning (only when `portability: 'strict'`)

Fires when the top-level schema is missing `$schema`. SEP-1613 makes JSON Schema 2020-12 the default dialect, but explicit tagging (`"$schema": "https://json-schema.org/draft/2020-12/schema"`) is forward-compatible — older SDK clients default to draft-07. Zod 4's `toJSONSchema` always emits `$schema`, so this rule is a no-op for Zod-only servers; it exists as forward-compat for hand-built schemas (see SEP-834).

---

## Name rules

### name-required

**Severity:** error

Every tool, resource, and prompt definition needs a non-empty `name` string. For resources, an empty `name` also falls back to the URI template (see `resource-name-not-uri`).

### name-format

**Severity:** error

**Scope:** tools only — resources and prompts are checked by `name-required` only.

Tool names must match `^[A-Za-z0-9._-]{1,128}$` (alphanumerics, dots, hyphens, underscores; 1–128 chars). Tools conventionally use `snake_case`.

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

Catches `readOnlyHint: true` with **any** explicit `destructiveHint` value (even `false`) — the destructive hint is meaningless on a read-only tool, so its presence signals authoring confusion. Drop `destructiveHint` entirely when the tool is read-only.

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

Every variable in the URI template must appear as a key in the `params` schema. `test://{itemId}/data` with `params: z.object({ item_id: ... })` is rejected — casing mismatches count. The check is template → schema only; extra schema keys not referenced by the template are not flagged.

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

## Landing config rules

Validate the `landing` config passed to `createApp()` (the config object that drives the framework's landing page). Run only when `input.landing` is provided to `validateDefinitions`. All errors — landing config that's structurally broken would render incorrectly on the public page.

| Rule | Severity | Catches |
|:-----|:---------|:--------|
| `landing-shape` | error | `landing` is not a plain object |
| `landing-tagline-type` | error | `tagline` is present but not a string |
| `landing-tagline-length` | error | `tagline` exceeds the max length |
| `landing-logo-type` | error | `logo` is present but not a string |
| `landing-logo-size` | error | `logo` is too long for inline rendering |
| `landing-links-type` | error | `links` is present but not an array |
| `landing-links-count` | error | `links` exceeds the max count |
| `landing-link-shape` | error | A `links[]` entry is not a plain object |
| `landing-link-href` | error | A link entry's `href` is missing or not a non-empty string |
| `landing-link-label` | error | A link entry's `label` is missing or not a non-empty string |
| `landing-repo-root-type` | error | `repoRoot` is present but not a string |
| `landing-repo-root-shape` | error | `repoRoot` is not a recognized GitHub URL shape |
| `landing-env-example-type` | error | `envExample` is present but not a plain object |
| `landing-env-example-count` | error | `envExample` has too many entries |
| `landing-env-example-key` | error | An `envExample` key is empty or invalid |
| `landing-env-example-value` | error | An `envExample` value is not a string |
| `landing-connect-snippets-type` | error | `connectSnippets` is present but not a plain object |
| `landing-connect-snippets-key` | error | A `connectSnippets` key is empty |
| `landing-connect-snippets-value` | error | A `connectSnippets` value is not a string |
| `landing-connect-snippets-empty` | error | A `connectSnippets` value is an empty string |
| `landing-theme-type` | error | `theme` is present but not a plain object |
| `landing-theme-accent` | error | `theme.accent` is present but not a string |
| `landing-theme-accent-format` | error | `theme.accent` doesn't match the expected color format |

Diagnostic anchors for these rules are the rule ID — e.g. `skills/api-linter/SKILL.md#landing-shape`. Pass `landing` to `validateDefinitions({ landing, tools, resources, prompts })` to opt in.

---

## Handler body rules

Heuristic source-text checks that scan `handler.toString()` for common error-handling anti-patterns. All warnings — false positives are possible because the rules can't see code reached through wrappers, factories assigned to variables, or service-layer throws. Each rule fires at most once per handler to keep reports quiet.

### prefer-mcp-error-in-handler

**Severity:** warning

Fires when a handler contains `throw new Error(...)`. Plain `Error` doesn't carry a JSON-RPC code — the framework's auto-classifier degrades to `InternalError`, hiding the actual failure mode.

**Fix:** use `McpError` or a factory:

```ts
// instead of:
throw new Error('Item not found');
// use:
throw notFound('Item not found', { itemId });
```

### prefer-error-factory

**Severity:** warning

Fires when a handler builds an error via `new McpError(JsonRpcErrorCode.X, ...)` and a matching factory exists (`notFound`, `rateLimited`, `serviceUnavailable`, …). The factory form is shorter, self-documenting, and consistent with the rest of the codebase.

**Fix:** swap the constructor for the factory the diagnostic names:

```ts
// instead of:
throw new McpError(JsonRpcErrorCode.NotFound, 'Item missing');
// use:
throw notFound('Item missing');
```

### preserve-cause-on-rethrow

**Severity:** warning

Fires when a `catch (e)` block throws a structured `McpError` (or factory) without passing `{ cause: e }`. Dropping the cause loses the original stack trace — observability platforms and `pino-pretty` rely on it to render error chains.

**Fix:** thread the cause through the 4th `McpError` argument or factory options:

```ts
try {
  await fetchUpstream();
} catch (e) {
  throw serviceUnavailable('Upstream failed', { service: 'pubmed' }, { cause: e });
}
```

### no-stringify-upstream-error

**Severity:** warning

Fires when a handler throws an error message containing `JSON.stringify(...)`. Stringifying caught or upstream errors into the message risks leaking internal stack traces, AWS internal ARNs, or third-party trace IDs to clients.

**Fix:** sanitize first, or attach the raw blob to the error's `data` payload — never the message.

```ts
// instead of:
throw new Error(`Upstream failed: ${JSON.stringify(e)}`);
// use:
throw serviceUnavailable('Upstream failed', { upstreamError: e }, { cause: e });
```

---

## Error contract rules

Validate the optional `errors[]` declarative contract on tool/resource definitions. Structural rules check the shape of contract entries; conformance rules cross-check the handler body against the declared codes.

When a contract is declared, the handler receives a typed `ctx.fail(reason, …)` keyed by the declared reason union. See `skills/api-errors/SKILL.md` for runtime semantics.

### error-contract-type

**Severity:** error

Fires when `errors` is present but not an array. The contract must be a tuple of `ErrorContract` entries.

### error-contract-empty

**Severity:** warning

Fires when `errors: []` is declared. An empty contract is a no-op — nothing to surface in `tools/list`, no reason union for `ctx.fail`, no conformance to check.

**Fix:** drop the field, or declare actual failure modes.

### error-contract-entry-type

**Severity:** error

Fires when an entry in `errors[]` isn't an object. Each entry must be `{ code, reason, when }` (and optionally `retryable`).

### error-contract-code-type

**Severity:** error

Fires when an entry's `code` is missing or not a number. Use the `JsonRpcErrorCode` enum:

```ts
errors: [{ code: JsonRpcErrorCode.NotFound, reason: 'no_match', when: 'No items matched' }]
```

### error-contract-code-unknown

**Severity:** error

Fires when an entry's `code` is a number but not a known `JsonRpcErrorCode` value. Likely a typo or stale magic number — import the enum and use a member.

### error-contract-code-unknown-error

**Severity:** warning

Fires when an entry uses `JsonRpcErrorCode.UnknownError` (-32099). That code is the auto-classifier's giveup-fallback; declaring it in a contract conveys nothing useful to clients.

**Fix:** pick a more specific code (`InternalError`, `ServiceUnavailable`, etc.) or drop the entry.

### error-contract-reason-required

**Severity:** error

Fires when an entry's `reason` is missing or empty. `reason` is the stable machine-readable identifier clients switch on; it must always be present.

### error-contract-reason-format

**Severity:** warning

Fires when `reason` isn't snake_case (matched against `^[a-z][a-z0-9_]*$`). Reasons are part of the public API — treat them like API constants. `'NotFound'`, `'no-match'`, `'1bad'` all warn.

**Fix:** rename to snake_case (`'no_match'`, `'rate_limited'`, …).

### error-contract-reason-unique

**Severity:** error

Fires when two entries in the same contract share a `reason`. Reasons must be unique within a contract — they're how `ctx.fail(reason, …)` selects the entry.

### error-contract-when-required

**Severity:** error

Fires when an entry's `when` field is missing or empty. `when` is the human-readable explanation surfaced to LLMs and UI clients; without it, the contract is opaque.

### error-contract-retryable-type

**Severity:** warning

Fires when an entry's optional `retryable` field is present but isn't a boolean. Only `true` or `false` is meaningful — drop the field if you can't commit to either.

### error-contract-conformance

**Severity:** warning

Cross-check rule. Fires when a handler throws a non-baseline code (via `JsonRpcErrorCode.X` or a factory like `notFound()`) that isn't declared in `errors[]`.

Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) are auto-allowed because they bubble from anywhere — services, framework utilities, the auto-classifier — and are implicitly always-possible on any tool. Only domain-specific codes need declaring.

**Fix:** add the missing code to `errors[]` with a stable reason, or route through `ctx.fail(reason, …)` if it maps to an existing entry.

**Heuristic limitations:** the scan reads `handler.toString()` and only catches direct `throw new McpError(JsonRpcErrorCode.X, …)` and `throw factory(…)` patterns. Indirect throws (`const e = notFound(); throw e;`), throws from called services, and throws via runtime helpers like `httpErrorFromResponse(...)` are invisible.

### error-contract-prefer-fail

**Severity:** warning

Fires when a handler throws a code that **is** declared in the contract directly (via factory or `new McpError`) instead of routing through `ctx.fail(reason, …)`. Direct throws bypass the typed helper, leaving observers without a stable `data.reason` and disconnecting the throw site from the contract entry.

**Fix:** swap the direct throw for `ctx.fail` using the reason the diagnostic suggests:

```ts
// instead of:
throw notFound('No items match');
// use:
throw ctx.fail('no_match', 'No items match');
```

The diagnostic message includes the declared reason(s) for the code so you can copy-paste.

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

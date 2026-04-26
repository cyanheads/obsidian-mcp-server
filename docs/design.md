# Obsidian MCP Server — Design

## MCP Surface

### Tools

| # | Name | Description | Key Inputs | Annotations |
|:--|:-----|:------------|:-----------|:------------|
| 1 | `obsidian_get_note` | Read a note's content, structured metadata (frontmatter/tags/stat — parsed by the upstream plugin), section structure (document map), or a single section. Works against any vault path, the active file, or a periodic note. | `target`, `format` (`content`/`full`/`document-map`/`section`); `section` required when `format: 'section'` | `readOnlyHint`, `idempotentHint` |
| 2 | `obsidian_write_note` | Create or overwrite a note (whole file) or replace a single section in place. Idempotent. | `target`, `content`, `section?`, `contentType?` | `idempotentHint`, `destructiveHint` |
| 3 | `obsidian_append_to_note` | Append content to the end of a note, or to the end of a heading/block/frontmatter section. | `target`, `content`, `section?`, `contentType?`, `createTargetIfMissing?` | (none — additive) |
| 4 | `obsidian_patch_note` | Surgical edit of a heading, block reference, or frontmatter field. Supports `append`/`prepend`/`replace`. The right tool when you need precise placement inside an existing document. | `target`, `section`, `operation`, `content`, `contentType?`, `patchOptions?` | `destructiveHint` (always — worst-case across operations) |
| 5 | `obsidian_delete_note` | Permanently delete a note. Elicits human confirmation when the client supports it. | `target` | `destructiveHint` |
| 6 | `obsidian_replace_in_note` | String or regex search-replace inside a single note. Composed read → mutate → write at the service layer (no native upstream endpoint). Per-replacement `useRegex`/`caseSensitive`/`replaceAll` flags. | `target`, `replacements: [{ search, replace, useRegex?, caseSensitive?, replaceAll? }]` | `destructiveHint` |
| 7 | `obsidian_manage_frontmatter` | Atomic `get` / `set` / `delete` on a single frontmatter key. `set` uses PATCH; `delete` uses read-modify-write because PATCH has no delete operation. Avoids rewriting the whole file for `get` and `set`. | discriminated on `operation`: `{ operation: 'get'\|'delete', target, key }` or `{ operation: 'set', target, key, value }` | `destructiveHint` (set/delete) |
| 8 | `obsidian_manage_tags` | Add, remove, or list a note's tags across both frontmatter (`tags:` array) and inline (`#tag`) syntax. Service layer reconciles both locations. | `target`, `operation`, `tags?: string[]`, `location?: 'frontmatter'\|'inline'\|'both'` (default `both`) | `destructiveHint` (add/remove) |
| 9 | `obsidian_list_files` | List files and subdirectories at a vault path. Defaults to vault root. Optional client-side filters by extension and name. | `path?`, `extension?`, `nameRegex?` | `readOnlyHint`, `idempotentHint` |
| 10 | `obsidian_search_notes` | Search the vault. Modes: `text` (substring + context, with optional `pathPrefix` filter), `dataview` (DQL `TABLE` query — use this for path/date/metadata filters), `jsonlogic` (structured filter on `NoteJson`). | `mode`, `query`, `contextLength?`, `pathPrefix?` (text mode) | `readOnlyHint` |
| 11 | `obsidian_list_tags` | All tags found across the vault, with usage counts. Includes hierarchical parents (e.g. `work` for `work/tasks`). | (none) | `readOnlyHint`, `idempotentHint` |
| 12 | `obsidian_list_commands` | List Obsidian command-palette commands available for execution. | (none) | `readOnlyHint`, `idempotentHint` |
| 13 | `obsidian_execute_command` | Execute an Obsidian command by ID (from `obsidian_list_commands`). Behavior is opaque — some commands are destructive (e.g. delete file), some open UI. **Registered only when `OBSIDIAN_ENABLE_COMMANDS=true`.** | `commandId` | `openWorldHint`, `destructiveHint` |
| 14 | `obsidian_open_in_ui` | Open a file in the Obsidian app UI. By default fails with `NotFound` if the path doesn't exist. Pass `failIfMissing: false` to allow the upstream's create-on-open side effect (useful for "open or create" UX). Useful for surfacing a note to the human after agent edits. | `path`, `failIfMissing?` (default `true`), `newLeaf?` | `openWorldHint`, `destructiveHint` |

### Common Input Shapes

Three reusable Zod shapes are referenced across multiple tools.

```ts
// `target` — where the note lives. Used by get/write/append/patch/delete.
const Target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('path'),
    path: z.string().min(1).describe('Vault-relative path, e.g. "Projects/foo.md".') }),
  z.object({ type: z.literal('active') }),
  z.object({ type: z.literal('periodic'),
    period: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('ISO date YYYY-MM-DD. Omit for the current period.') }),
]);

// `section` — sub-document target inside a note. Optional on get/write/append; required on patch.
const Section = z.object({
  type: z.enum(['heading', 'block', 'frontmatter']),
  target: z.string().min(1)
    .describe('Heading name (use "::" for nesting), block reference (e.g. "2d9b4a"), or frontmatter field name.'),
});

// `patchOptions` — flags for obsidian_patch_note. All default false.
const PatchOptions = z.object({
  createTargetIfMissing: z.boolean().default(false),
  applyIfContentPreexists: z.boolean().default(false)
    .describe('Apply the patch even if matching content already exists in the target. Guards against double-applying.'),
  trimTargetWhitespace: z.boolean().default(false),
}).optional();

// `contentType` on write/append/patch — defaults to 'markdown'.
// 'json' is for typed frontmatter values and table-row inserts on block targets.
const ContentType = z.enum(['markdown', 'json']).default('markdown');
```

### Output Shapes

Sketches of the `structuredContent` payload each tool returns. `format()` renders the same data as markdown.

| Tool | Output |
|:-----|:-------|
| `obsidian_get_note` (`format: 'content'`) | `{ path, content }` |
| `obsidian_get_note` (`format: 'full'`) | `{ path, content, frontmatter, tags, stat: { ctime, mtime, size } }` |
| `obsidian_get_note` (`format: 'document-map'`) | `{ path, headings, blocks, frontmatterFields }` |
| `obsidian_get_note` (`format: 'section'`) | `{ path, section: { type, target }, value }` — `value` is the section's raw markdown, or the JSON value when `section.type === 'frontmatter'`. |
| `obsidian_write_note`, `obsidian_append_to_note` | `{ path, sectionTargeted: boolean, updatedContent?: string }` — the API returns the full updated file when section was targeted; we forward it. |
| `obsidian_patch_note` | `{ path, section, operation }` — upstream returns 200 with no body. |
| `obsidian_delete_note` | `{ path, deleted: true }` |
| `obsidian_replace_in_note` | `{ path, totalReplacements, perReplacement: [{ search, count }] }` |
| `obsidian_manage_frontmatter` (`get`) | `{ path, key, value, exists: boolean }` |
| `obsidian_manage_frontmatter` (`set`/`delete`) | `{ path, key, operation, frontmatter }` — full post-state frontmatter included for chaining |
| `obsidian_manage_tags` (`list`) | `{ path, tags: { frontmatter: string[], inline: string[], all: string[] } }` |
| `obsidian_manage_tags` (`add`/`remove`) | `{ path, operation, applied: string[], skipped: string[], tags: string[] }` — `applied` = tags actually changed; `skipped` = tags already in/not in the target location |
| `obsidian_list_files` | `{ path, files: string[], directories: string[] }` — split from the upstream's mixed `files[]` (entries ending in `/` are directories). Filters applied client-side after fetch. |
| `obsidian_search_notes` | `{ mode, results: SearchHit[], excluded?: { count, hint } }` — `SearchHit` is mode-discriminated (see Design Decisions § Search output shape). |
| `obsidian_list_tags` | `{ tags: [{ name, count }] }` |
| `obsidian_list_commands` | `{ commands: [{ id, name }] }` |
| `obsidian_execute_command` | `{ commandId, executed: true }` |
| `obsidian_open_in_ui` | `{ path, opened: true, createdIfMissing: boolean }` — `createdIfMissing` reflects whether the file existed before the open call. Always `false` when `failIfMissing: true` (default), since the handler throws `NotFound` instead of letting upstream create. |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `obsidian://vault/{path}` | Note content as a stable, addressable URI. Mirrors `obsidian_get_note` with `format: 'full'`. | N/A (single note) |
| `obsidian://tags` | Vault tag listing with counts. Mirrors `obsidian_list_tags`. | None (single payload) |
| `obsidian://status` | Server reachability, plugin version, auth status. Reads `GET /` directly. | N/A |

### Prompts

None. The server exposes a CRUD/search surface — there is no recurring multi-turn pattern that benefits from a structured template.

---

## Overview

`obsidian-mcp-server` is an MCP server that exposes an Obsidian vault to LLM agents through the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. It targets agent workflows over personal knowledge bases: reading and editing notes, browsing structure, searching content, working with daily/periodic notes, and triggering vault commands.

The server is a thin, opinionated wrapper around the plugin's HTTP API — one upstream service, well-defined endpoints, mostly 1:1 method semantics. Design effort goes into **collapsing the API's parallel "where does the note live" axes** (vault path, currently-active file, current periodic note, dated periodic note) into a single `target` discriminator so the agent doesn't navigate four separate tool families to do the same thing in different scopes.

**Target user:** an agent acting on behalf of a human who runs Obsidian locally with the Local REST API plugin enabled. Not multi-tenant; not a hosted service. Sessions are stdio or local HTTP.

---

## Requirements

- Wrap the Obsidian Local REST API (v3 PATCH semantics)
- Authenticate via API key (Bearer token) sourced from env var
- Support HTTPS to `127.0.0.1:27124` with self-signed cert (default) or HTTP to `:27123`
- Tolerate connection failures gracefully (Obsidian app may not be running)
- Surface clear recovery instructions when reachability or auth fails
- Expose every meaningful CRUD/search operation as a tool — no agent-visible capability locked behind resources
- Consolidate the four note-target axes (path/active/periodic-current/periodic-dated) into one `target` parameter on file tools
- Confirm destructive operations (delete) with `ctx.elicit` when available; fall back to `destructiveHint` annotation otherwise
- Single-tenant, local-first — no JWT/OAuth, no shared storage requirements

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ObsidianService` | Obsidian Local REST API HTTP endpoints. Holds API key + base URL config, builds requests with the appropriate `Accept`/`Content-Type`/`Target-*` headers, translates the `target` discriminator into URL paths, parses JSON/markdown responses, classifies errors. When `OBSIDIAN_VERIFY_SSL=false`, constructs a custom `undici.Agent` with `connect: { rejectUnauthorized: false }` and passes it as `dispatcher` on every fetch (Bun + Node 20+ both honor this — `fetch` itself has no `rejectUnauthorized` option). | Every tool and resource. |

**Resilience:** wrap each REST call with `withRetry` from `@cyanheads/mcp-ts-core/utils`. Backoff: 200ms base, 3 attempts. Distinguish:

- **Connection refused** → `ServiceUnavailable` with message "Obsidian Local REST API is not reachable at {url}. Make sure Obsidian is running and the Local REST API plugin is enabled." Do not retry — Obsidian isn't going to restart between attempts.
- **401/403** → `Unauthorized`/`Forbidden` with "Verify `OBSIDIAN_API_KEY` matches the value shown in Obsidian → Settings → Local REST API." Do not retry.
- **404** → `NotFound` with the path/section that was missing.
  - When `target.type === 'active'`, surface "No file is currently active in Obsidian — open a file in the app first" instead of a generic not-found message.
  - When `target.type === 'path'`, the service does a single best-effort case-insensitive lookup against the parent directory's listing. If a match exists, append a hint to the error: `'File not found at "Projects/Foo.md". Did you mean "projects/foo.md"?'`. We do not silently retry — auto-correcting case hides bugs on case-sensitive filesystems. The hint gives the agent the recovery signal explicitly.
- **405** (path is a directory) → `InvalidParams` — the agent passed a directory path to a file operation.
- **5xx, network timeouts** → transient, retry with backoff.
- **400** → `InvalidParams` with the upstream error message preserved.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `OBSIDIAN_API_KEY` | yes | — | API key from Obsidian → Settings → Community Plugins → Local REST API. Bearer token sent on every request. |
| `OBSIDIAN_BASE_URL` | no | `https://127.0.0.1:27124` | Base URL of the Obsidian Local REST API. Use `http://127.0.0.1:27123` for the insecure HTTP port. |
| `OBSIDIAN_VERIFY_SSL` | no | `false` | Whether to verify the TLS certificate. Default `false` because the plugin uses a self-signed cert. Set `true` if you've imported the cert into a trust store. |
| `OBSIDIAN_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout. Searches against very large vaults can be slow; bump if you see timeouts. |
| `OBSIDIAN_ENABLE_COMMANDS` | no | `false` | Opt-in flag for `obsidian_execute_command`. The tool isn't registered unless this is `true`. Off by default because Obsidian commands are opaque and can be destructive (delete file, close vault, etc.) — running one with the wrong ID can cause data loss the agent has no way to anticipate. |

Loaded via `parseEnvConfig` in `src/config/server-config.ts`.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with the env vars above
2. **Service** — `src/services/obsidian/obsidian-service.ts` with init/accessor pattern, the target → URL translator, the headers builder for PATCH/section targeting, and `withRetry` resilience
3. **Read-only tools** — `obsidian_get_note`, `obsidian_list_files`, `obsidian_list_tags`, `obsidian_list_commands`, `obsidian_search_notes`
4. **Resources** — `obsidian://vault/{path}`, `obsidian://tags`, `obsidian://status` (thin shims over the read tools' service methods)
5. **Write tools (single-call)** — `obsidian_write_note`, `obsidian_append_to_note`, `obsidian_patch_note`
6. **Composed tools (read-modify-write)** — `obsidian_replace_in_note`, `obsidian_manage_frontmatter`, `obsidian_manage_tags` (these stack on the single-call write tools)
7. **Side-effecting/destructive tools** — `obsidian_open_in_ui`, `obsidian_execute_command`, `obsidian_delete_note` (last because of elicit complexity)
8. **Tests** — `createMockContext` for handlers, `nock` or fetch mock for the service layer

Each step is independently runnable. After step 3 the server is already useful for read-only inspection.

---

## Domain Mapping

The Obsidian Local REST API exposes operations across four "targets" (where a note lives) and one common verb set. The design collapses the parallel axes.

### Target axes

| Target | URL pattern | Tool reaches it via |
|:-------|:------------|:--------------------|
| Vault path | `/vault/{path}` | `target: { type: 'path', path }` |
| Active file (currently open) | `/active/` | `target: { type: 'active' }` |
| Periodic note (current) | `/periodic/{period}/` | `target: { type: 'periodic', period }` |
| Periodic note (dated) | `/periodic/{period}/{year}/{month}/{day}/` | `target: { type: 'periodic', period, date }` |

### Verbs × targets (every cell maps to one consolidated tool)

| Verb | Vault path | Active | Periodic (cur) | Periodic (date) | Consolidated tool |
|:-----|:-----------|:-------|:---------------|:----------------|:------------------|
| GET | ✓ | ✓ | ✓ | ✓ | `obsidian_get_note` |
| PUT (replace) | ✓ | ✓ | ✓ | ✓ | `obsidian_write_note` |
| POST (append) | ✓ | ✓ | ✓ | ✓ | `obsidian_append_to_note` |
| PATCH (insert) | ✓ | ✓ | ✓ | ✓ | `obsidian_patch_note` |
| DELETE | ✓ | ✓ | ✓ | ✓ | `obsidian_delete_note` |

That collapse is the central design move: 5 verbs × 4 targets = 20 endpoints, but only 5 tools.

### Other endpoints

| Endpoint | Tool |
|:---------|:-----|
| `GET /` | `obsidian://status` resource only — no tool (connection failures already surface clear errors via the resilience layer) |
| `GET /vault/`, `GET /vault/{dir}/` | `obsidian_list_files` |
| `POST /search/`, `POST /search/simple/` | `obsidian_search_notes` (mode-discriminated) |
| `GET /tags/` | `obsidian_list_tags` |
| `GET /commands/` | `obsidian_list_commands` |
| `POST /commands/{id}/` | `obsidian_execute_command` |
| `POST /open/{filename}` | `obsidian_open_in_ui` |
| `GET /openapi.yaml`, `GET /obsidian-local-rest-api.crt` | (skipped — utility endpoints with no agent value) |

### Composed tools (no single upstream endpoint)

These tools compose existing endpoints in the service layer rather than mapping 1:1.

| Tool | Composition |
|:-----|:------------|
| `obsidian_replace_in_note` | `GET /vault/{path}` (NoteJson) → apply replacements in memory → `PUT /vault/{path}` |
| `obsidian_manage_frontmatter` `get` | `GET /vault/{path}/frontmatter/{key}` (or NoteJson + lookup) |
| `obsidian_manage_frontmatter` `set` | `PATCH /vault/{path}` with `Operation: replace`, `Target-Type: frontmatter`, `Target: {key}`, JSON body |
| `obsidian_manage_frontmatter` `delete` | `GET /vault/{path}` (NoteJson) → strip key → `PUT /vault/{path}` (PATCH has no `delete` operation) |
| `obsidian_manage_tags` `list` | `GET /vault/{path}` (NoteJson) → return parsed `tags`, separated by location (frontmatter vs inline) |
| `obsidian_manage_tags` `add`/`remove` | `GET /vault/{path}` (NoteJson) → reconcile tags in frontmatter `tags:` array and inline `#tag` syntax per `location` → `PUT /vault/{path}` |

---

## Workflow Analysis

The most complex tool is `obsidian_patch_note` because it composes section targeting + operation mode + content type + four boolean flags. The handler call sequence is single-shot — no parallel fan-out, no elicit — but the parameter design is what matters:

`obsidian_patch_note` (single upstream call):

| # | Step | Notes |
|:--|:-----|:------|
| 1 | Resolve `target` to URL path | `path` → `/vault/{encodedPath}`, `active` → `/active/`, `periodic` → `/periodic/{period}/[{year}/{month}/{day}/]` |
| 2 | Build PATCH headers | `Operation`, `Target-Type`, `Target` (URL-encoded), `Target-Delimiter`, optional `Create-Target-If-Missing`, `Apply-If-Content-Preexists`, `Trim-Target-Whitespace` |
| 3 | Set `Content-Type` | `text/markdown` (default) or `application/json` (for tables and frontmatter values) |
| 4 | PATCH upstream | Single HTTP call |
| 5 | Classify response | 200 → success, 400 → `InvalidParams`, 404 → `NotFound`, 405 → `InvalidParams` (path is a directory) |

The other workflow that benefits from explicit thought is the **read → patch chain** an agent will commonly run:

```
obsidian_get_note(target, format: 'document-map')
  → tells agent which headings/blocks/frontmatter exist
obsidian_patch_note(target, section, operation, content)
  → modifies the right one
```

This is *not* a workflow tool (we don't merge it into one super-tool) — it's a deliberate two-step pattern. Document-map output is small and the agent often wants to choose the section based on its content. Forcing them to declare both upfront would be worse.

---

## Design Decisions

### Target discriminator instead of separate tool families

Every file operation in the OpenAPI exists in four flavors (vault path, active, periodic current, periodic dated). A naive 1:1 mapping would expose 20 tools (5 verbs × 4 targets). This is wasteful — the underlying semantics are identical, only the URL changes. A discriminated `target` parameter:

```ts
target: z.discriminatedUnion('type', [
  z.object({ type: z.literal('path'), path: z.string() }),
  z.object({ type: z.literal('active') }),
  z.object({ type: z.literal('periodic'),
    period: z.enum(['daily','weekly','monthly','quarterly','yearly']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
])
```

This collapses to 5 tools, with the correct URL chosen by a single switch in the service layer. The cost is one extra parameter on each tool; the benefit is a 4× smaller surface and one consistent mental model.

### Three write tools instead of one super-tool

`obsidian_write_note` (PUT), `obsidian_append_to_note` (POST), `obsidian_patch_note` (PATCH) overlap somewhat — PATCH-with-replace is similar to PUT-with-section, POST-with-section is similar to PATCH-with-append. Collapsing into one `obsidian_modify_note(operation: 'write'|'append'|'patch', ...)` was considered.

Kept separate because:
- Each has distinct annotations (`destructiveHint` differs)
- PATCH has 4 boolean flags none of the others use
- Required-vs-optional `section` differs (always required on PATCH, optional on the others)
- LLM tool selection is easier picking among three named tools than one tool with three modes

### Search modes consolidated under one tool

`POST /search/` and `POST /search/simple/` are different endpoints with different request bodies. Folded into one `obsidian_search_notes` tool with `mode: 'text'|'dataview'|'jsonlogic'`. The 80% case is `mode: 'text'`; the structured modes are escape hatches for power users.

### Search output shape (mode-discriminated)

The three search modes return different per-hit shapes upstream — `simple` returns match positions and context; `dataview` and `jsonlogic` return arbitrary `result` values that depend on the query. We surface that natively rather than forcing a normalized shape:

```ts
results: z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('text'),
    hits: z.array(z.object({
      filename: z.string(),
      score: z.number().optional(),
      matches: z.array(z.object({
        context: z.string(),
        match: z.object({ start: z.number(), end: z.number() }),
      })),
    })) }),
  z.object({ mode: z.literal('dataview'),
    hits: z.array(z.object({ filename: z.string(), result: z.unknown() })) }),
  z.object({ mode: z.literal('jsonlogic'),
    hits: z.array(z.object({ filename: z.string(), result: z.unknown() })) }),
])
```

The alternative (one normalized hit shape with optional fields everywhere) loses the structural guarantee that `text` results always have `matches` while `dataview`/`jsonlogic` results always have `result`. Better to let the LLM see the right shape per mode.

### Search result truncation

`obsidian_search_notes` caps `hits` at **100 results**. When the upstream returns more, we keep the first 100 and add `excluded: { count: N, hint: 'Narrow your query (add filters, more specific terms) to surface the rest.' }` to the output. 100 is a pragmatic ceiling — large enough to cover normal exploratory queries against a personal vault, small enough that one tool call doesn't blow the context window. If this proves wrong in practice, easy to bump.

### `format()` is content-complete for every tool

Every tool's `format()` renders the same data as `structuredContent` — full content for `obsidian_get_note`, the per-mode hit list for `obsidian_search_notes`, the file/directory split for `obsidian_list_files`, etc. We do not return a thin "12 KB note loaded" stub from `format()` and rely on `structuredContent` for the actual data. Different MCP clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same picture.

### Default `format: 'full'` on `obsidian_get_note`

The Obsidian API defaults to `text/markdown` (just content). We default to `'full'` (NoteJson — content + frontmatter + tags + stat). The size delta is small; structured metadata is meaningfully more useful to an LLM than raw YAML embedded in the markdown body. `'content'` and `'document-map'` remain available for size-sensitive or section-discovery cases.

We do **not** parse frontmatter ourselves. Setting `Accept: application/vnd.olrapi.note+json` tells the Obsidian Local REST API plugin to do the parsing and return the result as a `frontmatter` object inside NoteJson. That's the right boundary: no YAML parser dependency, no risk of diverging from how Obsidian itself interprets edge cases (date coercion, multi-line strings, tag syntax), and the plugin already merges inline `#tag` syntax with the frontmatter `tags:` field into the unified `tags` array.

### Discriminated inputs where parameters are conditionally required

Two tools have parameters that are required in some modes and forbidden in others. Encode that in the schema rather than checking at handler runtime:

```ts
// obsidian_get_note — `section` is only meaningful when format === 'section'
input: z.discriminatedUnion('format', [
  z.object({ format: z.literal('content'),       target: Target }),
  z.object({ format: z.literal('full'),          target: Target }),
  z.object({ format: z.literal('document-map'),  target: Target }),
  z.object({ format: z.literal('section'),       target: Target, section: Section }),
])

// obsidian_manage_frontmatter — `value` is required on set, forbidden on get/delete
input: z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('get'),    target: Target, key: z.string() }),
  z.object({ operation: z.literal('delete'), target: Target, key: z.string() }),
  z.object({ operation: z.literal('set'),    target: Target, key: z.string(), value: z.unknown() }),
])
```

The alternative — flat schemas with `z.any().optional()` and runtime checks — accepts contradictory inputs and surfaces the failure as a generic validation error mid-handler. The discriminator gives the LLM and the linter a clear signal about what each mode actually needs.

### `obsidian_replace_in_note` applies replacements sequentially

Multiple replacements are applied in array order over the evolving content — replacement[1] sees replacement[0]'s output. Sequential is more expressive than parallel-over-original: an agent can express either pattern (chain or independent) under sequential semantics, but parallel loses information when replacements would touch overlapping regions. `perReplacement[i].count` reflects matches found at the time replacement *i* was applied.

### `obsidian_manage_tags` reconciliation policy

When `location: 'both'`:
- **`add`**: ensures the tag exists in both representations. If present in only one, adds to the other; tags already in both are reported in `skipped`.
- **`remove`**: strips the tag from both representations. Inline `#tag` occurrences inside fenced code blocks are left alone — they're code, not tags.

When `location: 'frontmatter'` or `'inline'`, only that representation is touched. `applied` lists tags actually changed; `skipped` lists tags already present (for `add`) or absent (for `remove`) in the targeted location.

### Composed convenience tools where the upstream API forces multi-step dances

Three operations that agents need constantly in knowledge-base workflows have no single upstream endpoint: search-replace inside a note, deleting a frontmatter key, and adding/removing a tag (which lives in two places — frontmatter `tags:` and inline `#tag`). Without dedicated tools, agents have to compose them by hand: read the note, mutate the body or YAML, write it back, and (for tags) reconcile both representations correctly.

We expose `obsidian_replace_in_note`, `obsidian_manage_frontmatter`, and `obsidian_manage_tags` as composed tools that do that work in the service layer. These are the highest-leverage adds in the design — they're more cognitive savings per byte of tool surface than anything else, and they prevent a class of agent bugs (forgetting that tags live in two places, clobbering frontmatter on a key delete, regex escaping in PATCH content). The API-faithful primitives (`get`/`write`/`patch`) remain available for cases the composed tools don't cover.

### Search filters: `pathPrefix` only on text mode

Adding `pathPrefix` to the `text` search mode is a cheap client-side string filter on returned filenames — worth adding because text-mode search is the common case and scoping to a folder is a frequent need. We deliberately do **not** add `modifiedSince`: the upstream `/search/simple` returns no stat data, so filtering by mod-time would require an extra `GET /vault/{path}` per hit to read `stat.mtime` — N round-trips for a search call. Agents that need date filters should use `dataview` mode where `file.mtime` is queryable in one call.

### Resources are intentionally minimal

Only three resources, all redundant with tools. They exist solely as a convenience for clients (Claude Desktop) that let users attach resources to a conversation. Tool-only clients (Claude Code, Cursor) lose nothing by ignoring them. We do not expose tags-by-name or commands-by-id as resources because there's no useful "stable URI for a tag" use case.

### `obsidian_delete_note` uses elicit

Note deletion is destructive and irreversible from the agent's side (no undo via the API; the human would need Obsidian's local trash). The handler calls `ctx.elicit` when present to confirm. When elicit isn't available (headless stdio), `destructiveHint: true` ensures the host's approval flow surfaces the risk. We did *not* exclude delete from the tool surface entirely — Obsidian's UI surfaces a recoverable trash, and the operation is a normal part of vault hygiene.

### `obsidian_execute_command` is gated and annotated `openWorldHint`

Command IDs are opaque strings whose behavior depends on which plugins the user has installed. We can't enumerate side effects. Two layers of safety:

1. **Registration gate via `OBSIDIAN_ENABLE_COMMANDS`** (default `false`). The tool isn't even visible in `tools/list` unless the operator opts in. This ensures the default install can't trigger destructive Obsidian commands by accident — a sloppy agent invoking `obsidian_execute_command` with the wrong ID can't blow up a vault that never registered the tool. `obsidian_list_commands` stays available regardless so an agent can discover what would be possible if enabled.
2. **Annotations on the registered tool** — `openWorldHint: true` and `destructiveHint: true` route execution through host approval flows when the tool *is* enabled. The description warns explicitly.

---

## Known Limitations

- **Plugin must be running.** All operations fail if Obsidian isn't open with the Local REST API plugin enabled. The resilience layer surfaces this with a clear "Obsidian Local REST API is not reachable at {url} — make sure Obsidian is running and the Local REST API plugin is enabled" message; the `obsidian://status` resource provides the same check for clients that prefer to read it directly.
- **Self-signed certificate.** Default `OBSIDIAN_VERIFY_SSL=false` because the plugin generates a self-signed cert on first run. Users who want strict TLS need to import the cert into their trust store and set `OBSIDIAN_VERIFY_SSL=true`.
- **No batch operations.** The upstream API is single-target per request. Agents needing to fetch N notes will issue N parallel calls. Not a server limitation we can solve.
- **No move/rename.** The upstream API exposes no rename or move endpoint — only delete + create-at-new-path. Renaming a note in place loses block-reference and backlink integrity that Obsidian normally maintains during a UI-driven rename. We do **not** synthesize a move tool from delete+create for that reason. Agents that need this should ask the human to rename in Obsidian, or — when `OBSIDIAN_ENABLE_COMMANDS=true` — call `obsidian_execute_command` with the appropriate command ID and let Obsidian handle the rename properly.
- **No search pagination.** `POST /search/` returns all matches. We cap `hits` at 100 and surface `excluded.count` + a hint when there's more (see Design Decisions § Search result truncation).
- **PATCH v3 semantics only.** The plugin still supports the deprecated v2 PATCH protocol; we use v3 exclusively. If the user is on an old plugin version, PATCH calls will fail.
- **Single-tenant.** Auth is plugin API key, not per-user. The server is local-first and not designed for multi-tenant deployment. `tenantId` defaults to `'default'`.
- **No frontmatter typed access.** `obsidian_get_note` returns the upstream-parsed frontmatter as `Record<string, unknown>` because Obsidian frontmatter is freeform. Agents must validate values themselves.

---

## API Reference

### Auth

Bearer token via `Authorization: Bearer {OBSIDIAN_API_KEY}`. Every endpoint except `GET /` requires it.

### Servers

- `https://127.0.0.1:27124` — default, self-signed cert
- `http://127.0.0.1:27123` — insecure HTTP fallback

### Section targeting (PATCH/PUT/POST)

Headers:
- `Target-Type: heading | block | frontmatter`
- `Target: <name>` (URL-encoded if non-ASCII)
- `Target-Delimiter: ::` (for nested headings)

Headings nest with the delimiter: `Heading 1::Subheading 1:1::Subsubheading 1:1:1`.

### PATCH operation flags

- `Operation: append | prepend | replace` (required)
- `Create-Target-If-Missing: true | false` (default `false`)
- `Apply-If-Content-Preexists: true | false` (default `false`) — guards against double-applying the same patch
- `Trim-Target-Whitespace: true | false` (default `false`)

### Content types

- `text/markdown` — default, body is raw markdown
- `application/json` — body is JSON. Useful for:
  - Frontmatter values (preserves typing)
  - Table rows when patching a block-referenced table: `[["Chicago, IL", "16"]]`

### Document map

`Accept: application/vnd.olrapi.document-map+json` on any GET returns `{ headings, blocks, frontmatterFields }` — the catalog of valid PATCH targets in the document. Use before patching unfamiliar notes.

### Note JSON

`Accept: application/vnd.olrapi.note+json` instructs the plugin to parse YAML frontmatter and tags server-side, returning:

```json
{
  "content": "...",
  "frontmatter": { ... },
  "tags": ["..."],
  "path": "...",
  "stat": { "ctime": 0, "mtime": 0, "size": 0 }
}
```

### Search formats

- **Text** (`POST /search/simple?query=...&contextLength=100`) — substring match with surrounding context
- **Dataview DQL** (`Content-Type: application/vnd.olrapi.dataview.dql+txt`) — `TABLE` queries from the [Dataview](https://blacksmithgu.github.io/obsidian-dataview/) plugin (requires Dataview installed)
- **JsonLogic** (`Content-Type: application/vnd.olrapi.jsonlogic+json`) — structured filters over `NoteJson`. Custom operators: `glob` and `regexp`

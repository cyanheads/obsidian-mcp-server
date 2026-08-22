<div align="center">
  <h1>obsidian-mcp-server</h1>
  <p><b>Read, write, search, and surgically edit Obsidian vault notes, tags, and frontmatter via MCP. STDIO or Streamable HTTP.</b>
  <div>14 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-3.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/obsidian-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/obsidian-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/obsidian-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/obsidian-mcp-server/releases/latest/download/obsidian-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=obsidian-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9ic2lkaWFuLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik9CU0lESUFOX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22obsidian-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-mcp-server%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Fourteen tools grouped by shape — readers fetch notes and metadata, writers create or surgically edit content, managers reconcile tags and frontmatter, and a guarded escape hatch dispatches Obsidian command-palette commands.

| Tool Name | Description |
|:----------|:------------|
| `obsidian_get_note` | Read a note as raw content, full structured form (content + frontmatter + tags + stat, with optional outgoing links), structural document map, or a single section. |
| `obsidian_list_notes` | List notes and subdirectories under a vault path. Recursive walk (default depth 2, max depth 20; 1000-entry cap) with optional `extension` and `nameRegex` filters. |
| `obsidian_list_tags` | List vault tags with usage counts, including hierarchical parents. Ordered by count descending and capped at `limit` (default 200, max 10000), with the withheld remainder disclosed. Optional `nameRegex` and `minCount` narrow the set first. |
| `obsidian_list_commands` | List Obsidian command-palette commands, optionally filtered by `nameRegex` on display name. **Opt-in via `OBSIDIAN_ENABLE_COMMANDS=true`** (paired with `obsidian_execute_command`). |
| `obsidian_search_notes` | Search the vault by text, JSONLogic, or BM25-ranked Omnisearch (when the plugin is reachable). Results paginate via opaque cursors. |
| `obsidian_write_note` | Create a note, replace a single section in place, or — with `overwrite: true` — clobber an existing file. Refuses whole-file writes against an existing path by default. |
| `obsidian_append_to_note` | Append content to a note. Without `section`, creates the file if missing. With `section`, appends to a specific heading, block, or frontmatter field (file must exist). |
| `obsidian_patch_note` | Surgical `append` / `prepend` / `replace` against a heading, block reference, or frontmatter field. |
| `obsidian_replace_in_note` | Search-replace inside a single note, scoped to the body by default. Literal or regex matching with whole-word, whitespace-flexible, and case-sensitivity options; supports capture-group replacement. |
| `obsidian_manage_frontmatter` | Atomic `get` / `set` / `delete` on a single frontmatter key. |
| `obsidian_manage_tags` | Add, remove, or list tags. Defaults to the frontmatter `tags:` array; `location: 'inline'` or `'both'` opts into mutating the note body. |
| `obsidian_delete_note` | Permanently delete a note. Always asks the user to confirm first — the call is answered with a confirmation request and retried with the answer. |
| `obsidian_open_in_ui` | Open a file in the Obsidian app UI, with `failIfMissing` and `newLeaf` toggles. |
| `obsidian_execute_command` | Execute an Obsidian command-palette command by ID. **Opt-in via `OBSIDIAN_ENABLE_COMMANDS=true`.** |

### `obsidian_get_note`

Read a note in one of four projections, addressed by vault path, the active file, or a periodic note (`daily`, `weekly`, `monthly`, `quarterly`, `yearly`).

- `format: "content"` — raw markdown body
- `format: "full"` — content, frontmatter, tags, and file metadata; pass `includeLinks: true` to also parse outgoing wiki and markdown link references from the body (vault-internal only — external URLs are filtered)
- `format: "document-map"` — catalog of headings, block references, and frontmatter fields
- `format: "section"` — single heading/block/frontmatter section value (requires `section`); heading sections include the full subtree under that heading

Pair the document-map projection with `obsidian_patch_note` to discover edit targets before patching.

---

### `obsidian_search_notes`

Up to three search modes selected by `mode`:

- `text` — substring match with surrounding context windows. `contextLength` controls characters of context per side of each match (default 100; bump it for more context per hit). Optional `pathPrefix` filter (text mode only — passing `pathPrefix` in any other mode is rejected with `path_prefix_invalid_mode`).
- `jsonlogic` — JSONLogic tree evaluated against `path`, `content`, `frontmatter.<key>`, `tags`, and `stat.{ctime,mtime,size}`; custom `glob` and `regexp` operators, both taking `[PATTERN, VALUE]` — pattern first, then the field reference: `{"glob": ["Projects/*.md", {"var": "path"}]}`. The reverse order compiles the note's own field as the pattern: `glob` then matches nothing, and `regexp` fails outright on whatever the field parses as. This is also how backlinks are expressed, since there is no dedicated tool or upstream endpoint for them: `{"regexp": ["\\[\\[Target Note(\\||#|\\]\\])", {"var": "content"}]}` returns every note whose body wikilinks `Target Note`.
- `omnisearch` — BM25-ranked search via the community [Omnisearch](https://github.com/scambier/obsidian-omnisearch) plugin. Supports quoted phrases, `-exclusion`, `path:` / `ext:` filters, typo tolerance, and PDF + OCR coverage (via [Text Extractor](https://github.com/scambier/obsidian-text-extractor)). Only present in the mode enum when the plugin's HTTP server is reachable at startup; the upstream hard-caps results at 50 — narrow the query to surface more (the response carries `truncated: true` when the cap was likely hit).

Results paginate via opaque cursors per the [MCP 2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25/utils/pagination): omit `cursor` for the first page, then pass `nextCursor` from the prior response. Every result carries `totalCount` (post-path-policy, pre-pagination); `nextCursor` is omitted on the last page. Text-mode hits are additionally clipped per file at `maxMatchesPerHit` (default 10) so a single match-heavy note can't blow the response budget — clipped hits carry `truncated: true` and `totalMatches`.

---

### `obsidian_write_note`

Create or surgically replace, with a protective default against accidental whole-file overwrites.

- Without `section` — full-file `PUT`. **Refuses to clobber an existing file** unless `overwrite: true` is set. The `file_exists` (`Conflict`) error suggests `obsidian_patch_note` / `obsidian_append_to_note` / `obsidian_replace_in_note` for in-place edits.
- With `section` — `PATCH`-with-replace against the named heading/block/frontmatter field, leaving the rest of the file untouched. The `overwrite` flag is ignored in section mode.

The output reports `created: true` when the call brought a new file into existence; `false` when it replaced an existing one or targeted a section. Every mutating tool also returns `previousSizeInBytes` and `currentSizeInBytes` so an agent can spot accidental clobbers, unexpected upstream behavior, or a typo path that landed at the wrong file.

---

### `obsidian_append_to_note`

A combined upsert + section-append primitive that mirrors the upstream Local REST API behavior:

- Without `section` — `POST` to `/vault/{path}`. Appends when the file exists, **creates the file with your content as the entire body when it doesn't.** The output's `created: true` flags the second branch so the agent can notice when a typo path or a not-yet-created daily note silently turned into a brand-new file.
- With `section` — `PATCH`-with-append against the named heading, block reference, or frontmatter field. The file must exist (PATCH preflight throws `note_missing` otherwise). Pass `createTargetIfMissing: true` to bring the section itself into existence inside an existing file. Block-reference targets concatenate adjacent to the block line without a separator — include a leading newline in `content` if you want one.

`previousSizeInBytes` is `0` on the upsert-create branch and the actual file size otherwise; `currentSizeInBytes` is the post-write size read from the upstream after the operation. Compare deltas against `Buffer.byteLength(content)` to detect auto-newline injection or concurrent writers.

---

### `obsidian_patch_note`

Surgical edits at a single document target.

- `operation: "append"` adds after the section
- `operation: "prepend"` adds before the section
- `operation: "replace"` swaps it out
- Targets: heading path, block reference ID, or frontmatter field

Heading targets accept either the full `Parent::Child` path or a bare leaf name. A bare leaf that matches exactly one heading is expanded to its full path before the write, and the response echoes the locator the edit landed on; a leaf matching several headings is rejected with `ambiguous_section`, whose error data lists the candidate paths. The same resolution applies to `obsidian_write_note` and `obsidian_append_to_note` with `section`.

Use `obsidian_get_note` with `format: "document-map"` to discover what targets exist before patching.

---

### `obsidian_replace_in_note`

Search-replace for edits that don't fit `obsidian_patch_note`'s structural targets. The note is fetched, replacements are applied sequentially (each sees the previous output), and the result is written back in a single `PUT`.

`scope` selects what the replacements run over:

- `body` (default) — the text after the YAML frontmatter block. The block is re-attached from the original bytes, so it comes back byte-identical.
- `frontmatter` — only the YAML between the `---` fences. The fences themselves are never matched.
- `both` — each replacement runs over the frontmatter and then the body; `perReplacement[]` reports `bodyCount` and `frontmatterCount` separately.

With the frontmatter in scope, the rewritten YAML is re-parsed before anything is written: if it no longer parses as a mapping of properties, the call fails with `frontmatter_invalid` and the note keeps its original bytes. That check catches YAML that breaks — an unquoted `:` in a scalar, a list marker rewritten into an alias, a stray quote. It cannot catch an edit that stays well-formed while meaning something else, such as a substring collision that renames a key or a replacement that drops a scalar's quotes and changes its type. Prefer `obsidian_manage_frontmatter` for typed edits to a single property.

Per-replacement options:

- `useRegex` — treat `search` as an ECMAScript regex. With `useRegex: true`, the replacement honors `$1` / `$&` capture-group references.
- `caseSensitive` — when `false`, match case-insensitively
- `wholeWord` — wrap the pattern in `\b…\b`; works in both literal and regex modes
- `flexibleWhitespace` — substitute any run of whitespace in `search` with `\s+`. Literal mode only — has no effect when `useRegex: true` (express it directly).
- `replaceAll` — when `false`, only the first match is replaced. Under `scope: 'both'` that one substitution goes to the frontmatter when it matches there, and to the body otherwise.

Literal mode preserves `$1` / `$&` in the replacement verbatim — only `useRegex: true` expands capture-group references.

---

### `obsidian_manage_tags`

Add, remove, or list tags on a note. Operates on one of two representations, defaulting to the canonical Obsidian frontmatter location:

- `location: 'frontmatter'` (default) — only the frontmatter `tags:` array; the note body is left untouched
- `location: 'inline'` — only inline `#tag` syntax in the body; `add` appends `#tag` at end-of-file
- `location: 'both'` — opt-in reconciliation across both representations

`add` ensures the tag is present in the requested location(s); `remove` strips it; `list` ignores the input `tags` array. Inline `#tag` occurrences inside fenced code blocks are intentionally left alone.

Inline mode reads and writes the note body only — a `#` inside a YAML scalar is frontmatter, so it is neither listed as an inline tag nor rewritten by a removal. Removing an inline tag takes exactly one adjacent horizontal space with it — the one before the tag, or the one after when no space precedes it; every other byte survives, including nested list indentation, four-space indented code blocks, trailing two-space hard line breaks, and table cell padding.

---

### `obsidian_delete_note`

Permanently delete a note. The first call answers with a confirmation request rather than a deletion — the prompt includes the file's byte size, so the destructive blast radius is visible before the user confirms — and the tool is retried with the answer. Declining or cancelling fails the call with `cancelled` and issues no `DELETE`; the `destructiveHint` annotation also surfaces the operation in the host's approval flow. The output reports `previousSizeInBytes` (size at the moment of deletion) and `currentSizeInBytes: 0`.

The confirmation is not optional and has no fallback path: a client that cannot serve the input round-trip cannot complete a delete. Every other tool is unaffected.

---

### `obsidian_execute_command`

Dispatch an Obsidian command-palette command by ID (discoverable via `obsidian_list_commands`). Behavior is command-dependent — some commands open UI, others delete files or close the vault.

**Off by default.** When `OBSIDIAN_ENABLE_COMMANDS` is unset, both `obsidian_execute_command` and its discovery partner `obsidian_list_commands` are wrapped with `disabledTool()` — absent from `tools/list` (the LLM can't invoke them) but still visible in the operator-facing manifest with a hint to enable them.

---

## Path policy (folder-scoped permissions)

Three optional env vars gate which vault paths each tool can target. **Default unset = full vault** for both reads and writes — backwards compatible.

| Goal | Config |
|:---|:---|
| Default (current behavior) | all unset |
| Read everywhere, write only in `projects/` and `scratch/` | `OBSIDIAN_WRITE_PATHS=projects/,scratch/` |
| Read only `public/`, write only `public/inbox/` | `OBSIDIAN_READ_PATHS=public/`, `OBSIDIAN_WRITE_PATHS=public/inbox/` |
| Read-only deployment — no writes anywhere | `OBSIDIAN_READ_ONLY=true` |

**Matching is prefix-based with implicit recursion**, case-insensitive, with trailing slashes normalized. `projects/` matches `projects/a.md`, `projects/sub/b.md`, etc.

**Write paths are implicitly readable** — you can't sanely edit what you can't see. So a read passes when the target matches `READ_PATHS` *or* `WRITE_PATHS`.

**`OBSIDIAN_READ_ONLY=true` short-circuits before the path checks** — every write tool and the command-palette pair are wrapped with `disabledTool()` at startup (absent from `tools/list`), and any write that still reaches the service is denied at runtime regardless of `WRITE_PATHS`.

Denies are typed `path_forbidden` (JSON-RPC code `Forbidden`) with the active scope echoed back in `data.recovery.hint` and `data.activeScope`, so the LLM can self-correct without inspecting server logs. Search results from `obsidian_search_notes` are filtered against `READ_PATHS` silently — surfacing a "we hid N hits" indicator would defeat the gate.

**Tag listing is vault-wide.** `obsidian_list_tags` and the `obsidian://tags` resource aggregate tag names across the whole vault and are *not* narrowed by `OBSIDIAN_READ_PATHS` — they take no path to gate, so tag names (never note contents) from outside the read scope can surface.

The startup banner logs the active scope so operators can verify their config at boot.

---

## Resources

| Type | URI | Description |
|:---|:---|:---|
| Resource | `obsidian://vault/{+path}` | A note in the vault — content, frontmatter, tags, and file metadata. |
| Resource | `obsidian://tags` | All tags found across the vault, with usage counts. |
| Resource | `obsidian://status` | Server reachability, auth status, plugin/Obsidian version info, and the plugin manifest. |

All resource data is also reachable via tools — `obsidian_get_note` for `obsidian://vault/{+path}`, `obsidian_list_tags` for `obsidian://tags`. Resources exist for clients that prefer attaching a specific note or vault snapshot to a conversation. The tag pair is not a mirror: `obsidian://tags` keeps snapshot semantics and returns the upstream payload whole and unsorted, while `obsidian_list_tags` orders by count and caps.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats. Tools advertise their failure surface via typed `errors[]` contracts.
- Server-level `instructions` on `initialize` — surfaces deployment-specific orientation (active path policy, read-only mode, command-palette toggle) to spec-compliant clients alongside the static tool/resource catalog
- Pluggable auth on the HTTP transport: `none`, `jwt`, `oauth`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

The server itself is stateless — every tool call hits the Local REST API directly. The framework's storage backends, request-state KV, and progress streams aren't used here; Obsidian is single-vault and there's nothing to persist between calls.

Obsidian-specific:

- Wraps the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin — typed client, deterministic error mapping
- Section-aware editing across headings, block references, and frontmatter fields via `PATCH`-with-target operations
- Tag reconciliation across both representations: frontmatter `tags:` array and inline `#tag` syntax (skipping fenced code blocks)
- Search across up to three modes: text, JSONLogic, and (when the plugin is reachable) BM25-ranked Omnisearch — cursor-paginated per the MCP 2025-11-25 spec, with per-file match clipping in text mode
- Required human-in-the-loop confirmation for destructive deletes — a multi-round-trip `input_required` round served on both protocol revisions, with no unconfirmed path through the tool
- Folder-scoped read/write permissions via `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` and a global `OBSIDIAN_READ_ONLY` kill switch — denies are typed `path_forbidden` with the active scope echoed back in the error data
- Opt-in command-palette pair (`obsidian_list_commands` + `obsidian_execute_command`) — registered only when `OBSIDIAN_ENABLE_COMMANDS=true`
- Forgiving path resolution on `obsidian_get_note` and `obsidian_open_in_ui` — silently retries case-mismatched paths against the canonical filename, throws `Conflict` on ambiguous case matches, and enriches `NotFound` with `Did you mean: …?` suggestions when only near-matches exist. `obsidian_delete_note` is deliberately excluded — a destructive op shouldn't silently rewrite the target path.

## Getting started

Add the following to your MCP client configuration file. The Obsidian Local REST API plugin must be installed and enabled in your vault — see [Prerequisites](#prerequisites).

```json
{
  "mcpServers": {
    "obsidian-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["obsidian-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OBSIDIAN_API_KEY": "your-local-rest-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "obsidian-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "obsidian-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "OBSIDIAN_API_KEY": "your-local-rest-api-key"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server. Inline env vars work for one-off runs; for repeated use, copy values into `.env` (see [`.env.example`](./.env.example)) and run `bun run start:http`.

```sh
MCP_TRANSPORT_TYPE=http OBSIDIAN_API_KEY=... bun run start:http
# Server listens at http://127.0.0.1:3010/mcp by default
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- The [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin, **v4.0.0 through v5.x**, installed and enabled in your vault. Generate an API key in **Settings → Community Plugins → Local REST API** and copy it into `OBSIDIAN_API_KEY`. Plugin v6.0 removes the markdown-patch 1.x wire format this server pins for section-targeted writes and the document map.
- Periodic-note targets (`target: { "type": "periodic" }`) additionally need plugin **v5.0.1 or earlier** — v5.0.2 removed the built-in `/periodic/` routes. Every other target type is unaffected.
- An MCP client that can answer an input request (elicitation). `obsidian_delete_note` always asks for confirmation before deleting, so a client without that support can read and write notes but cannot delete one.
- This server defaults to `http://127.0.0.1:27123` for simplicity. Enable **"Non-encrypted (HTTP) Server"** in the plugin settings to use it. To use the always-on HTTPS port instead, set `OBSIDIAN_BASE_URL=https://127.0.0.1:27124`; the plugin's self-signed cert is handled by `OBSIDIAN_VERIFY_SSL=false` (the default).

### Installation

1. **Clone the repository:**

   ```sh
   git clone https://github.com/cyanheads/obsidian-mcp-server.git
   ```

2. **Navigate into the directory:**

   ```sh
   cd obsidian-mcp-server
   ```

3. **Install dependencies:**

   ```sh
   bun install
   ```

4. **Configure environment:**

   ```sh
   cp .env.example .env
   # edit .env and set OBSIDIAN_API_KEY
   ```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `OBSIDIAN_API_KEY` | **Required.** Bearer token for the Obsidian Local REST API plugin. | — |
| `OBSIDIAN_BASE_URL` | Base URL of the Local REST API plugin. Use `https://127.0.0.1:27124` for the always-on HTTPS port (self-signed cert). | `http://127.0.0.1:27123` |
| `OBSIDIAN_VERIFY_SSL` | Verify the TLS certificate. Default `false` because the plugin uses a self-signed cert. On Node, the dispatcher's `rejectUnauthorized` option handles this without any process-wide change. On Bun, the runtime ignores that option, so the service additionally sets `NODE_TLS_REJECT_UNAUTHORIZED=0` — that fallback is scoped to Bun only. | `false` |
| `OBSIDIAN_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds. | `30000` |
| `OBSIDIAN_ENABLE_COMMANDS` | Opt-in flag for the command-palette pair (`obsidian_list_commands` + `obsidian_execute_command`). Off by default — Obsidian commands are opaque and can be destructive. | `false` |
| `OBSIDIAN_READ_PATHS` | Comma-separated vault-relative folder allowlist for read operations. Prefix-based with implicit recursion; case-insensitive; trailing slashes normalized. Unset = full vault. Write paths are implicitly readable. | unset |
| `OBSIDIAN_WRITE_PATHS` | Comma-separated vault-relative folder allowlist for write operations. Same syntax as `OBSIDIAN_READ_PATHS`. Unset = full vault. | unset |
| `OBSIDIAN_READ_ONLY` | Global kill switch. When `true`, denies every write regardless of `OBSIDIAN_WRITE_PATHS`, and suppresses the `OBSIDIAN_ENABLE_COMMANDS` pair (commands can mutate). | `false` |
| `OBSIDIAN_OMNISEARCH_URL` | Override URL for the [Omnisearch](https://github.com/scambier/obsidian-omnisearch) plugin's HTTP server. When unset, derives from `OBSIDIAN_BASE_URL` host with port `51361` (falling back to `http://localhost:51361`). Probed once at startup — if reachable, the `omnisearch` mode is added to `obsidian_search_notes`; otherwise it's omitted from the tool schema. Restart the server to re-probe. | derived |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | Host for the HTTP server. | `127.0.0.1` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | Endpoint path for the JSON-RPC handler. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments (landing page, Server Card, RFC 9728 metadata). | unset |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_AUTH_SECRET_KEY` | **Required when `MCP_AUTH_MODE=jwt`.** ≥32-char shared secret used to verify incoming JWTs. | — |
| `MCP_AUTH_DISABLE_SCOPE_CHECKS` | When `true`, bypasses per-tool scope enforcement after the auth-context presence check. Token signature, audience, issuer, and expiry validation remain intact. Use only when a custom claim can't be injected and combine with `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` / `OBSIDIAN_READ_ONLY` for access control. A `WARNING` is logged at startup whenever the bypass is active. | `false` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t obsidian-mcp-server .
docker run --rm -e OBSIDIAN_API_KEY=your-key -p 3010:3010 obsidian-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/obsidian-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

The image binds to `0.0.0.0` inside the container (required for Docker port mapping). For any deployment reachable beyond your own machine, set `MCP_AUTH_MODE=jwt` (with `MCP_AUTH_SECRET_KEY`) or `oauth` — otherwise the listener forwards your `OBSIDIAN_API_KEY` to the vault on behalf of every caller.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits the Obsidian service. |
| `src/config` | Server-specific environment variable parsing (`OBSIDIAN_*`) with Zod. |
| `src/services/obsidian` | Local REST API client, frontmatter operations, section extractor, domain types. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared input schemas. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (currently empty — CRUD/search shape doesn't benefit from a structured template). |
| `tests/` | Vitest tests mirroring `src/`. |
| `docs/` | Upstream OpenAPI spec for the Local REST API plugin and the generated `tree.md`. |
| `changelog/` | Per-version release notes; `CHANGELOG.md` is the regenerated rollup. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Bugs, feature requests, and documentation gaps belong in an issue — see [CONTRIBUTING.md](.github/CONTRIBUTING.md) for what makes one actionable, and [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) for how we work together. Security reports go through [SECURITY.md](.github/SECURITY.md), never a public issue.

Pull requests are welcome for small, self-contained fixes. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

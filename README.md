<div align="center">
  <h1>obsidian-mcp-server</h1>
  <p><b>MCP server for Obsidian vaults — read, write, search, and surgically edit notes, tags, and frontmatter via the Local REST API plugin. STDIO or Streamable HTTP.</b>
  <div>14 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/obsidian-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/obsidian-mcp-server) [![Version](https://img.shields.io/badge/Version-3.0.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Tools

Fourteen tools grouped by shape — readers fetch notes and metadata, writers create or surgically edit content, managers reconcile tags and frontmatter, and a guarded escape hatch dispatches Obsidian command-palette commands.

| Tool Name | Description |
|:----------|:------------|
| `obsidian_get_note` | Read a note as raw content, full structured form (content + frontmatter + tags + stat), structural document map, or a single section. |
| `obsidian_list_notes` | List notes and subdirectories at a vault path with optional extension and name-regex filters. Returns all entries the upstream lists (markdown, attachments, canvas, excalidraw) split into `files[]` and `directories[]`. |
| `obsidian_list_tags` | List every tag found across the vault with usage counts, including hierarchical parents. |
| `obsidian_list_commands` | List Obsidian command-palette commands available for execution. |
| `obsidian_search_notes` | Search the vault by text, Dataview DQL, or JSONLogic — capped at 100 hits with overflow indicator. |
| `obsidian_write_note` | Create or overwrite a note, or replace a single heading/block/frontmatter section in place. |
| `obsidian_append_to_note` | Append content to a note, or to a specific heading/block/frontmatter section. |
| `obsidian_patch_note` | Surgical `append` / `prepend` / `replace` against a heading, block reference, or frontmatter field. |
| `obsidian_replace_in_note` | Body-wide search-replace inside a single note. Literal or regex matching, with `wholeWord`, `flexibleWhitespace`, `caseSensitive`, `replaceAll`, and `$1`/`$&` capture groups. |
| `obsidian_manage_frontmatter` | Atomic `get` / `set` / `delete` on a single frontmatter key. |
| `obsidian_manage_tags` | Add, remove, or list tags — reconciles frontmatter `tags:` and inline `#tag` syntax. |
| `obsidian_delete_note` | Permanently delete a note. Elicits human confirmation when the client supports it. |
| `obsidian_open_in_ui` | Open a file in the Obsidian app UI, with `failIfMissing` and `newLeaf` toggles. |
| `obsidian_execute_command` | Execute an Obsidian command-palette command by ID. **Opt-in via `OBSIDIAN_ENABLE_COMMANDS=true`.** |

### `obsidian_get_note`

Read a note in one of four projections, addressed by vault path, the active file, or a periodic note (`daily`, `weekly`, `monthly`, `quarterly`, `yearly`).

- `format: "content"` — raw markdown body
- `format: "full"` — content, frontmatter, tags, and file metadata
- `format: "document-map"` — catalog of headings, block references, and frontmatter fields
- `format: "section"` — single heading/block/frontmatter section value (requires `section`); heading sections include the full subtree under that heading

Pair the document-map projection with `obsidian_patch_note` to discover edit targets before patching.

---

### `obsidian_search_notes`

Three search modes selected by `mode`:

- `text` — substring match with surrounding context windows; optional `pathPrefix` filter (text mode only — passing `pathPrefix` in `dataview` or `jsonlogic` mode is rejected with `path_prefix_invalid_mode`)
- `dataview` — Dataview DQL (`TABLE …`) for path/date/metadata queries; `file.mtime`, `file.path`, etc. are queryable
- `jsonlogic` — JSONLogic tree evaluated against `path`, `content`, `frontmatter.<key>`, `tags`, and `stat.{ctime,mtime,size}`; custom `glob` and `regexp` operators

Results are capped at 100 hits. When the upstream returns more, an `excluded` indicator surfaces the overflow count and a hint to narrow the query. Text-mode hits are additionally clipped per file at `maxMatchesPerHit` (default 10) so a single match-heavy note can't blow the response budget — clipped hits carry `truncated: true` and `totalMatches`.

---

### `obsidian_write_note`

Idempotent create/overwrite with optional in-place section replacement.

- Without `section` — full-file `PUT`, creates the file if missing
- With `section` — `PATCH`-with-replace against the named heading/block/frontmatter field, leaving the rest of the file untouched

Repeated calls with the same input converge on the same result.

---

### `obsidian_patch_note`

Surgical edits at a single document target.

- `operation: "append"` adds after the section
- `operation: "prepend"` adds before the section
- `operation: "replace"` swaps it out
- Targets: heading path, block reference ID, or frontmatter field

Use `obsidian_get_note` with `format: "document-map"` to discover what targets exist before patching.

---

### `obsidian_replace_in_note`

Body-wide search-replace for edits that don't fit `obsidian_patch_note`'s structural targets. The note is fetched, replacements are applied sequentially (each sees the previous output), and the result is written back in a single `PUT`.

Per-replacement options:

- `useRegex` — treat `search` as an ECMAScript regex. With `useRegex: true`, the replacement honors `$1` / `$&` capture-group references.
- `caseSensitive` — when `false`, match case-insensitively
- `wholeWord` — wrap the pattern in `\b…\b`; works in both literal and regex modes
- `flexibleWhitespace` — substitute any run of whitespace in `search` with `\s+`. Literal mode only — has no effect when `useRegex: true` (express it directly).
- `replaceAll` — when `false`, only the first match is replaced

Literal mode preserves `$1` / `$&` in the replacement verbatim — only `useRegex: true` expands capture-group references.

---

### `obsidian_manage_tags`

Add, remove, or list tags on a note. Reconciles both representations:

- Frontmatter `tags:` array
- Inline `#tag` syntax in the body

`add` ensures the tag is present in the requested location(s); `remove` strips it. Inline `#tag` occurrences inside fenced code blocks are intentionally left alone.

---

### `obsidian_delete_note`

Permanently delete a note. When the client supports `elicit`, the server requests human confirmation before issuing the `DELETE`. Without elicitation, the `destructiveHint` annotation surfaces the operation in the host's approval flow.

---

### `obsidian_execute_command`

Dispatch an Obsidian command-palette command by ID (discoverable via `obsidian_list_commands`). Behavior is command-dependent — some commands open UI, others delete files or close the vault.

**Off by default.** Register only when the operator sets `OBSIDIAN_ENABLE_COMMANDS=true`; the tool is omitted from the surface otherwise.

---

## Resources

| Type | URI | Description |
|:---|:---|:---|
| Resource | `obsidian://vault/{+path}` | A note in the vault — content, frontmatter, tags, and file metadata. |
| Resource | `obsidian://tags` | All tags found across the vault, with usage counts. |
| Resource | `obsidian://status` | Server reachability, plugin version, and auth status of the Obsidian Local REST API. |

All resource data is also reachable via tools — `obsidian_get_note` for `obsidian://vault/{+path}`, `obsidian_list_tags` for `obsidian://tags`. Resources exist for clients that prefer attaching a specific note or vault snapshot to a conversation.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats. Tools advertise their failure surface via typed `errors[]` contracts.
- Pluggable auth on the HTTP transport: `none`, `jwt`, `oauth`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

The server itself is stateless — every tool call hits the Local REST API directly. The framework's storage backends, request-state KV, and progress streams aren't used here; Obsidian is single-vault and there's nothing to persist between calls.

Obsidian-specific:

- Wraps the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin — typed client, deterministic error mapping
- Section-aware editing across headings, block references, and frontmatter fields via `PATCH`-with-target operations
- Tag reconciliation across both representations: frontmatter `tags:` array and inline `#tag` syntax (skipping fenced code blocks)
- Search across three modes: text, Dataview DQL, JSONLogic — with overflow indicator when results exceed the 100-hit cap
- Optional human-in-the-loop confirmation for destructive deletes via `ctx.elicit`
- Opt-in `obsidian_execute_command` for the command palette — registered only when explicitly enabled
- Forgiving path resolution on `obsidian_get_note` and `obsidian_open_in_ui` — silently retries case-mismatched paths against the canonical filename, throws `Conflict` on ambiguous case matches, and enriches `NotFound` with `Did you mean: …?` suggestions when only near-matches exist. `obsidian_delete_note` is deliberately excluded — a destructive op shouldn't silently rewrite the target path.

## Getting started

Add the following to your MCP client configuration file. The Obsidian Local REST API plugin must be installed and enabled in your vault — see [Prerequisites](#prerequisites).

```json
{
  "mcpServers": {
    "obsidian": {
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
    "obsidian": {
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

- [Bun v1.3.11](https://bun.sh/) or higher (or Node.js v22+).
- The [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin installed and enabled in your vault. Generate an API key in **Settings → Community Plugins → Local REST API** and copy it into `OBSIDIAN_API_KEY`.
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
| `OBSIDIAN_ENABLE_COMMANDS` | Opt-in flag for `obsidian_execute_command`. Off by default — Obsidian commands are opaque and can be destructive. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | Host for the HTTP server. | `127.0.0.1` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | Endpoint path for the JSON-RPC handler. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_AUTH_SECRET_KEY` | **Required when `MCP_AUTH_MODE=jwt`.** ≥32-char shared secret used to verify incoming JWTs. | — |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Hot-reload dev mode:**

  ```sh
  bun run dev:stdio
  bun run dev:http
  ```

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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

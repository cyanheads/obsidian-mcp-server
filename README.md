<div align="center">
  <h1>obsidian-mcp-server</h1>
  <p><b>Read, write, search, and surgically edit Obsidian vault notes, tags, and frontmatter via MCP. STDIO or Streamable HTTP.</b>
  <div>14 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-3.6.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/obsidian-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/obsidian-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/obsidian-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/obsidian-mcp-server/releases/latest/download/obsidian-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=obsidian-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9ic2lkaWFuLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik9CU0lESUFOX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22obsidian-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-mcp-server%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Obsidian vault notes over the Local REST API plugin. Read, search, and write notes, edit single headings, blocks, and frontmatter fields in place, and manage tags, with folder-scoped read/write permissions built in. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `obsidian_get_note` | Read a note as raw content, full structured form, document map, or a single section |
| `obsidian_list_notes` | List notes and folders under a vault path, recursively, with extension and name filters |
| `obsidian_list_tags` | List vault tags with usage counts, most-used first |
| `obsidian_search_notes` | Search by text, JSONLogic, or BM25-ranked Omnisearch when that plugin is reachable |
| `obsidian_write_note` | Create a note, replace one section, or overwrite a whole file with `overwrite: true` |
| `obsidian_append_to_note` | Append to a note (creating it if missing) or to one heading, block, or frontmatter field |
| `obsidian_patch_note` | Append, prepend, or replace against one heading, block reference, or frontmatter field |
| `obsidian_replace_in_note` | Literal or regex search-replace inside one note, body-only by default |
| `obsidian_manage_frontmatter` | Get, set, or delete one frontmatter key |
| `obsidian_manage_tags` | Add, remove, or list a note's tags in frontmatter, inline, or both |
| `obsidian_delete_note` | Permanently delete a note after the user confirms |
| `obsidian_open_in_ui` | Open a file in the Obsidian app, optionally in a new pane |
| `obsidian_list_commands` | List command-palette commands (opt-in via `OBSIDIAN_ENABLE_COMMANDS`) |
| `obsidian_execute_command` | Run a command-palette command by ID (opt-in via `OBSIDIAN_ENABLE_COMMANDS`) |

### Resources

| Resource | Description |
|:---|:---|
| `obsidian://vault/{+path}` | A note's content, frontmatter, tags, and file metadata |
| `obsidian://tags` | Every vault tag with its usage count, as an uncapped snapshot |
| `obsidian://status` | Plugin reachability, auth status, versions, and registered API extensions |

Note and tag data are also reachable through tools (`obsidian_get_note`, `obsidian_list_tags`); `obsidian://status` has no tool equivalent.

## Capability reference

### `obsidian_get_note` <sub>tool</sub>

- `target` is a vault `path`, the `active` file, or a `periodic` note (`daily` through `yearly`, optional `date`); `format` is `content`, `full`, `document-map`, or `section`, and `full` takes `includeLinks: true` for vault-internal outgoing links
- `result.format` discriminates the payload; a `section` read that matches several headings returns the first and lists every full path in `candidates`

---

### `obsidian_list_notes` <sub>tool</sub>

- Walks from `path` (default vault root) to `depth` 1–20 (default 2), filtered by `extension` and `nameRegex` (≤256 chars); a folder that fails `nameRegex` is not walked
- Returns `entries[]` (`file` / `directory`), `totals`, and `appliedFilters`; the walk stops at 1,000 entries with `excluded.reason: "entry_cap"`, and a folder the depth limit or path policy kept out carries `truncated: true`

---

### `obsidian_list_tags` <sub>tool</sub>

- `nameRegex` (≤256 chars) and `minCount` narrow the set, then tags are ranked by count and capped at `limit` (default 200, max 10000); hierarchical parents count (`work/tasks` adds to `work`)
- When the cap withholds tags, the response carries `truncated`, `shown`, and `cap`

---

### `obsidian_search_notes` <sub>tool</sub>

- `mode: "text"` requires every whitespace-split token of `query` as a case-insensitive substring of the filename or body (quotes are literal), shaped by `contextLength` (default 100), `pathPrefix`, and `maxMatchesPerHit` (default 10); `mode: "jsonlogic"` evaluates a `logic` tree over `path`, `content`, `frontmatter.<key>`, `tags`, and `stat`, with `glob` / `regexp` taking `[PATTERN, VALUE]`
- `result.mode` discriminates the payload; every mode reports `totalCount` and pages via `nextCursor`, and a text hit clipped to `maxMatchesPerHit` carries `truncated` and `totalMatches`
- `mode: "omnisearch"` (BM25 ranking, quoted phrases, `-exclusion`, `path:` / `ext:` filters) is offered only when the Omnisearch plugin answered at startup; its 50-hit upstream cap sets `truncated: true`

---

### `obsidian_write_note` <sub>tool</sub>

- `target` and `content`, with optional `section` and `contentType` (`markdown` / `json`); a whole-file write to an existing note fails with `file_exists` unless `overwrite: true`
- With `section`, replaces only that heading, block, or frontmatter field and keeps the heading line; output reports `created`, `sectionTargeted`, and the resolved `sectionTarget`

---

### `obsidian_append_to_note` <sub>tool</sub>

- Without `section`, appends to the file or creates it (`created: true`); with `section`, appends to that heading, block, or frontmatter field of an existing note, and `createTargetIfMissing: true` creates the section
- A section append whose content is already at the target fails with `content_preexists`; block targets add no separator, so start `content` with a newline if you want one

---

### `obsidian_patch_note` <sub>tool</sub>

- `operation: "append" | "prepend" | "replace"` against one `section` of an existing note; `patchOptions` takes `createTargetIfMissing`, `applyIfContentPreexists`, and `trimTargetWhitespace` (plugin v4.x only)
- Echoes the resolved `section` and `operation`; a repeat of content already at the target fails with `content_preexists` unless `applyIfContentPreexists: true`

---

### `obsidian_replace_in_note` <sub>tool</sub>

- `replacements[]` run in order, each over the previous one's output; each takes `useRegex` (≤1024 chars), `caseSensitive` (default `true`), `wholeWord`, `flexibleWhitespace` (literal mode only), and `replaceAll` (default `true`)
- Returns `totalReplacements` and `perReplacement[]` with `bodyCount` / `frontmatterCount`
- `scope: "body"` (default) leaves frontmatter byte-identical; `"frontmatter"` and `"both"` re-parse the YAML afterward and write nothing if it breaks (`frontmatter_invalid`)

---

### `obsidian_manage_frontmatter` <sub>tool</sub>

- `operation: "get" | "set" | "delete"` on one `key`; `set` requires a JSON-typed `value`
- `get` returns `exists` and `value` (`null` when absent); `set` and `delete` return the full `frontmatter` after the change, and a `delete` against unparseable YAML fails with `frontmatter_invalid` without writing

---

### `obsidian_manage_tags` <sub>tool</sub>

- `operation: "add" | "remove" | "list"` with `tags`; `location: "frontmatter"` (default, the `tags:` array), `"inline"` (body `#tag`; `add` appends at end of file), or `"both"`
- `add` / `remove` report `applied`, `skipped`, and the resulting `tags`; `list` returns `frontmatter`, `inline`, and `all`
- Inline detection follows Obsidian's tag grammar: code, wikilinks, images, link destinations, HTML, and math are skipped, and `%% … %%` comments are read

---

### `obsidian_delete_note` <sub>tool</sub>

- Takes a `target`; the first call answers with a confirmation request naming the path and byte size, and the note is deleted only after the user accepts
- Declining fails with `cancelled`, and a client without elicitation support cannot delete; there is no API-level undo, only Obsidian's local trash
- An answer counts only against the single-use consent record stored when the prompt was shown, bound to the caller, the path, and the note's content then. A pre-supplied or replayed answer, or one given after the note changed, gets a fresh prompt instead
- Consent records live in the server's storage provider (`STORAGE_PROVIDER_TYPE`, default `in-memory`, process-local). That works for stdio or a single HTTP instance; several instances behind one endpoint need a shared provider (`filesystem`, `supabase`, or `cloudflare-d1`, never `cloudflare-kv`)

---

### `obsidian_open_in_ui` <sub>tool</sub>

- `path`, `failIfMissing` (default `true`), and `newLeaf` (open in a split pane); with `failIfMissing: false` a missing file is created, which needs write access
- `createdIfMissing` reports which branch ran

---

### `obsidian_list_commands` <sub>tool</sub>

- Optional `nameRegex` (≤256 chars) matched against each command's display name
- Returns `commands[]` of `id` and `name`, where `id` feeds `obsidian_execute_command`
- Listed only when `OBSIDIAN_ENABLE_COMMANDS=true` and `OBSIDIAN_READ_ONLY` is off

---

### `obsidian_execute_command` <sub>tool</sub>

- `commandId` from `obsidian_list_commands`; returns `executed: true`, or fails with `command_unknown` for an unregistered ID
- Runs with the authority of a keyboard shortcut, so some commands are destructive (delete file, close vault); gated like `obsidian_list_commands`

---

### `obsidian://vault/{+path}` <sub>resource</sub>

- `{+path}` captures everything after `/vault/`, slashes included; literal and percent-encoded paths resolve to the same note
- Returns `path`, `content`, `frontmatter`, `tags`, and `stat`, the same shape as `obsidian_get_note` with `format: "full"`; failures are `path_forbidden`, `note_missing`, or `path_is_directory`

---

### `obsidian://tags` <sub>resource</sub>

- Every tag with its `count`, uncapped and in upstream order, hierarchical parents included
- No ranking or filters; `obsidian_list_tags` gives the count-ranked, capped view

---

### `obsidian://status` <sub>resource</sub>

- `status`, `service`, `authenticated`, `versions`, `manifest`, and `apiExtensions[]`; still answers with a wrong API key, reporting `authenticated: false`
- On plugin v5.0.2 and later, check `apiExtensions` for `local-rest-api-periodic-notes` before using `periodic` targets

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Obsidian-specific:

- Typed client for the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin; section writes speak markdown-patch 2.0 to plugin v5.0 and later and 1.x to v4.x, chosen from the reported plugin version
- Heading targets take a full `Parent::Child` path or a bare leaf name; writes reject an ambiguous one with `ambiguous_section` and its `candidates`, unless exactly one match is a top-level heading. On plugin v5.0 and later, content added to a heading is set off by a blank line (a list item continues an adjacent list), and a heading inside it must sit below the section's level (`heading_outside_section`)
- Folder-scoped read/write permissions, a read-only switch, and an opt-in command-palette pair (see [Path policy](#path-policy)); server-level `instructions` on `initialize` report the active policy
- `obsidian_get_note` and `obsidian_open_in_ui` retry a case-mismatched path against the real filename and add `Did you mean` suggestions to a miss; writes and deletes match the exact path
- Regex inputs are capped (`nameRegex` at 256 chars, `useRegex` at 1024) and rejected with `regex_unsafe` when they nest quantifiers
- Backlinks have no dedicated tool; `obsidian_search_notes` in `jsonlogic` mode finds them with `{"regexp": ["\\[\\[Target Note(\\||#|\\]\\])", {"var": "content"}]}`

Agent-friendly output:

- Recovery-guided errors: every declared failure carries a `reason`, a JSON-RPC code, and a `recovery.hint` written for that case
- Size deltas: every mutating tool returns `previousSizeInBytes` / `currentSizeInBytes`, so a caller can spot an accidental clobber without a follow-up read
- Ambiguity surfaced as data: shared heading names return `candidates`, and tag operations report `applied` vs. `skipped`
- Discriminated output contracts: `format` on `obsidian_get_note`, `mode` on `obsidian_search_notes`, `operation` on `obsidian_manage_frontmatter` and `obsidian_manage_tags`

## Getting started

Add the following to your MCP client configuration file. The Obsidian Local REST API plugin must be installed and enabled in your vault; see [Prerequisites](#prerequisites).

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

Or with Docker:

```json
{
  "mcpServers": {
    "obsidian-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "MCP_LOG_LEVEL=info",
        "-e", "OBSIDIAN_API_KEY=your-local-rest-api-key",
        "ghcr.io/cyanheads/obsidian-mcp-server:latest"
      ]
    }
  }
}
```

Inside a container, the default `OBSIDIAN_BASE_URL` (`http://127.0.0.1:27123`) is the container's own loopback. Add `-e OBSIDIAN_BASE_URL=http://host.docker.internal:27123` (Docker Desktop) or run with `--network host` (Linux) to reach the plugin on your host.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http OBSIDIAN_API_KEY=... bun run start:http
# Server listens at http://127.0.0.1:3010/mcp by default
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- The [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin, v4.0.0 or later, enabled in your vault. Generate an API key under **Settings → Community Plugins → Local REST API** and set it as `OBSIDIAN_API_KEY`.
- The server defaults to `http://127.0.0.1:27123`, so enable **"Non-encrypted (HTTP) Server"** in the plugin settings, or set `OBSIDIAN_BASE_URL=https://127.0.0.1:27124` for the always-on HTTPS port (its self-signed cert is accepted while `OBSIDIAN_VERIFY_SSL=false`, the default).
- Periodic-note targets work natively on plugin v5.0.1 and earlier. From v5.0.2 they need the [periodic-notes API extension](https://github.com/coddingtonbear/obsidian-local-rest-api-periodic-notes); without it they fail with `periodic_unsupported`.
- Plugin v6.0 drops markdown-patch 1.x, which two table-row writes (`contentType: "json"`) still use: rows under a heading, and rows through a block ID on its own line below the table. On v6.0, target the table by an ID on its last row.
- An MCP client that supports elicitation, to use `obsidian_delete_note`. Every other tool works without it.

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
| `OBSIDIAN_API_KEY` | **Required.** Bearer token for the Local REST API plugin. | — |
| `OBSIDIAN_BASE_URL` | Local REST API base URL; `https://127.0.0.1:27124` is the always-on HTTPS port. A trailing slash is stripped. When nothing answers, calls fail with `obsidian_unreachable`. | `http://127.0.0.1:27123` |
| `OBSIDIAN_VERIFY_SSL` | Verify the plugin's TLS certificate. Off by default for its self-signed cert; the relaxation applies only to an `https:` `OBSIDIAN_BASE_URL`. With `true`, an untrusted cert fails calls with `certificate_rejected`. | `false` |
| `OBSIDIAN_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds. | `30000` |
| `OBSIDIAN_ENABLE_COMMANDS` | Enable `obsidian_list_commands` and `obsidian_execute_command`. Commands are opaque and can be destructive. | `false` |
| `OBSIDIAN_READ_PATHS` | Comma-separated folder allowlist for reads. See [Path policy](#path-policy). | unset (full vault) |
| `OBSIDIAN_WRITE_PATHS` | Comma-separated folder allowlist for writes. See [Path policy](#path-policy). | unset (full vault) |
| `OBSIDIAN_READ_ONLY` | Deny every write and disable the command-palette pair. | `false` |
| `OBSIDIAN_OMNISEARCH_URL` | [Omnisearch](https://github.com/scambier/obsidian-omnisearch) HTTP server URL. Unset derives from the `OBSIDIAN_BASE_URL` host on port `51361`. Probed once at startup; the `omnisearch` search mode appears only if it answers. | derived |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful` or `auto`. The server requires a stateful session because the `obsidian_delete_note` confirmation needs one on 2025-era clients, so `stateless` fails startup over HTTP. No effect on stdio. | `stateful` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Path policy

Three optional env vars limit which vault paths the tools can touch. Unset, reads and writes cover the full vault.

| Goal | Config |
|:---|:---|
| Read everywhere, write only in `projects/` and `scratch/` | `OBSIDIAN_WRITE_PATHS=projects/,scratch/` |
| Read only `public/`, write only `public/inbox/` | `OBSIDIAN_READ_PATHS=public/`, `OBSIDIAN_WRITE_PATHS=public/inbox/` |
| No writes anywhere | `OBSIDIAN_READ_ONLY=true` |

- Matching is by prefix, recursive, and case-insensitive; trailing slashes are normalized. Write paths are also readable.
- `OBSIDIAN_READ_ONLY=true` removes every write tool and the command-palette pair from `tools/list`, including `obsidian_manage_frontmatter` and `obsidian_manage_tags` (so their `get` / `list` go too). `obsidian_open_in_ui` still opens existing files but won't create one.
- A denial fails with `path_forbidden`, echoing the active scope in `data.activeScope` and the recovery hint. Search hits outside the read scope are dropped silently, and `obsidian_list_notes` shows an out-of-scope folder without walking it.
- Tag listings (`obsidian_list_tags`, `obsidian://tags`) are vault-wide, so tag names (never note contents) from outside the read scope can appear.
- The startup log prints the active scope.

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

The image defaults to HTTP transport on `0.0.0.0`, stateful sessions, and logs in `/var/log/obsidian-mcp-server`. Point `OBSIDIAN_BASE_URL` at `http://host.docker.internal:27123` (Docker Desktop) or use `--network host` (Linux) to reach the plugin. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

If the port is reachable from other machines, set `MCP_AUTH_MODE=jwt` (with `MCP_AUTH_SECRET_KEY`) or `oauth`. With the default `none`, every caller acts on your vault with your `OBSIDIAN_API_KEY`.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point: registers tools and resources, probes Omnisearch, applies the read-only and command gates. |
| `src/config` | Server-specific environment variable parsing (`OBSIDIAN_*`) with Zod. |
| `src/services/obsidian` | Local REST API client, path policy, markdown-patch format handling, frontmatter/section/tag parsing, domain types. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared schemas and helpers. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (none registered). |
| `tests/` | Vitest tests for tools, resources, services, and config. |
| `docs/` | Local REST API OpenAPI spec and the generated `tree.md`. |
| `changelog/` | Per-version release notes; `CHANGELOG.md` is the regenerated rollup. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; route every Local REST API call through `getObsidianService()`
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Bugs, feature requests, and documentation gaps belong in an issue; see [CONTRIBUTING.md](.github/CONTRIBUTING.md) for what makes one actionable and [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) for how we work together. Security reports go through [SECURITY.md](.github/SECURITY.md), never a public issue.

Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

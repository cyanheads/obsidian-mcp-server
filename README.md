<div align="center">
  <h1>obsidian-mcp-server</h1>
  <p><b>Read, write, search, and surgically edit Obsidian vault notes, tags, and frontmatter via MCP. STDIO or Streamable HTTP.</b>
  <div>14 Tools • 3 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-3.5.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/obsidian-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/obsidian-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/obsidian-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/obsidian-mcp-server/releases/latest/download/obsidian-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=obsidian-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9ic2lkaWFuLW1jcC1zZXJ2ZXIiXSwiZW52Ijp7Ik9CU0lESUFOX0FQSV9LRVkiOiJ5b3VyLWFwaS1rZXkifX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22obsidian-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22obsidian-mcp-server%22%5D%2C%22env%22%3A%7B%22OBSIDIAN_API_KEY%22%3A%22your-api-key%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Read, write, search, and surgically edit Obsidian vault notes — sections, frontmatter, tags — over the Local REST API plugin, with folder-scoped read/write permissions built in. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
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

### Resources

| Resource | Description |
|:---|:---|
| `obsidian://vault/{+path}` | A note in the vault — content, frontmatter, tags, and file metadata. |
| `obsidian://tags` | All tags found across the vault, with usage counts (full snapshot). |
| `obsidian://status` | Server reachability, auth status, plugin/Obsidian version info, and registered API extensions. |

Vault-note and tag data are also reachable via tools — `obsidian_get_note` for `obsidian://vault/{+path}`, `obsidian_list_tags` for `obsidian://tags` (count-ranked and capped, unlike the resource's raw snapshot). `obsidian://status` has no tool equivalent. Resources exist for clients that prefer attaching a note or vault snapshot to a conversation.

## Capability reference

### `obsidian_get_note` <sub>tool</sub>

- `format: "content" | "full" | "document-map" | "section"` selects the projection; `full` accepts `includeLinks: true` for outgoing wiki/markdown links (vault-internal only — external URLs are filtered)
- Addressed by vault `path`, the `active` file, or a `periodic` note (`daily` / `weekly` / `monthly` / `quarterly` / `yearly`)
- Heading sections use `Parent::Child` syntax, and every `#`-style heading path the document map lists reads back as itself (setext headings, underlined with `===` or `---`, are not recognized); a bare leaf name matching several headings, or a full path that repeats in the note, returns the first match and lists every colliding path in `candidates`
- Forgiving `path` resolution: a case-mismatched path retries against the canonical filename, an ambiguous case match fails with `Conflict`, and a `NotFound` carries `Did you mean: …?` suggestions when near-matches exist
- Typed errors include `note_missing`, `path_forbidden`, `no_active_file`, `periodic_unsupported` / `periodic_disabled`, and `path_traversal`

---

### `obsidian_list_notes` <sub>tool</sub>

- Recursive walk from `path` (default vault root); `depth` 1–20 (default 2 = target plus immediate children)
- Optional `extension` and `nameRegex` (≤256 chars, no nested quantifiers) filters; a directory failing `nameRegex` is skipped without recursing into it
- Hard cap of 1000 entries per call — `excluded.reason: "entry_cap"` signals a truncated walk; narrow `path` or the filters to see the rest
- Per-directory `truncated: true` marks entries cut off by the depth limit or by path policy

---

### `obsidian_list_tags` <sub>tool</sub>

- Vault-wide tag counts, including hierarchical parents (`work/tasks` contributes to both `work` and `work/tasks`)
- Ordered by count descending, capped at `limit` (default 200, max 10000); optional `nameRegex` and `minCount` narrow the candidate set before ranking
- Reports `truncated` / `shown` / `cap` when the limit withheld results
- Not narrowed by `OBSIDIAN_READ_PATHS` — tag names (never note contents) can surface from outside the read scope

---

### `obsidian_list_commands` <sub>tool</sub>

- Lists Obsidian command-palette IDs and display names; optional `nameRegex` filters on display name
- **Opt-in via `OBSIDIAN_ENABLE_COMMANDS=true`** — absent from `tools/list` when unset
- Discovery partner for `obsidian_execute_command`

---

### `obsidian_search_notes` <sub>tool</sub>

- `mode: "text" | "jsonlogic"` always; `"omnisearch"` is added to the schema only when the Omnisearch plugin's HTTP server is reachable at startup (restart to re-probe)
- `text` — whitespace-split tokens, all required, each matched case-insensitively as a substring (quotes are literal, so there is no phrase operator), with `contextLength`-sized context windows (default 100) and an optional `pathPrefix`; tokens within 2 × `contextLength` of each other, such as a phrase's words, share one match location; `jsonlogic` — a JSONLogic tree with `var` paths into `path` / `content` / `frontmatter.<key>` / `tags` / `stat.{ctime,mtime,size}`, plus `glob` / `regexp` operators taking `[PATTERN, VALUE]`; `omnisearch` — BM25-ranked, quoted phrases, `-exclusion`, `path:` / `ext:` filters, typo tolerance, PDF/OCR via Text Extractor, hard-capped at 50 upstream hits (`truncated: true` when likely hit)
- Cursor pagination — omit `cursor` for page one, pass `nextCursor` from the prior response; text-mode hits additionally clip to `maxMatchesPerHit` match locations (default 10), flagged with `truncated` / `totalMatches`
- No dedicated backlinks tool — express "what links here" via `jsonlogic`: `{"regexp": ["\\[\\[Target Note(\\||#|\\]\\])", {"var": "content"}]}`

---

### `obsidian_write_note` <sub>tool</sub>

- Without `section` — full-file write; refuses to clobber an existing note unless `overwrite: true` (`file_exists` conflict otherwise, naming the surgical-edit tools as the alternative)
- With `section` — `PATCH`-with-replace against a heading/block/frontmatter target, leaving the rest of the file untouched (`overwrite` is ignored); a bare heading leaf shared by several headings fails with `ambiguous_section` unless one of them has no parent heading, which the write then targets, and a full heading path that repeats in the note fails the same way
- Output reports `created`, plus `previousSizeInBytes` / `currentSizeInBytes` on every call to spot an accidental clobber or a mistyped path

---

### `obsidian_append_to_note` <sub>tool</sub>

- Without `section` — appends to an existing file, or creates it with the given content as the whole body (`created: true` flags the second case)
- With `section` — appends to a heading/block/frontmatter target; the file must already exist, and `createTargetIfMissing: true` brings the section itself into existence
- Block-reference targets concatenate with no separator — include a leading newline in `content` for one
- `previousSizeInBytes` / `currentSizeInBytes` bracket every call for drift detection

---

### `obsidian_patch_note` <sub>tool</sub>

- `operation: "append" | "prepend" | "replace"` against one heading, block reference, or frontmatter field per call
- Heading targets accept the full `Parent::Child` path or a bare leaf name; a leaf matching several headings fails with `ambiguous_section` and lists the candidates, unless one of them has no parent heading, which the patch then targets; a full path that repeats in the note fails with `ambiguous_section` too
- `patchOptions`: `createTargetIfMissing`, `applyIfContentPreexists` (idempotency guard — otherwise `content_preexists`), `trimTargetWhitespace`

---

### `obsidian_replace_in_note` <sub>tool</sub>

- One or more `replacements`, applied in array order, each over the previous one's output
- `scope: "body"` (default, frontmatter left byte-identical) | `"frontmatter"` | `"both"`; frontmatter/both re-parse the rewritten YAML afterward and write nothing if it breaks (`frontmatter_invalid`)
- Per-replacement options: `useRegex` (≤1024 chars, no nested quantifiers), `caseSensitive`, `wholeWord` (`\b…\b` in both modes), `flexibleWhitespace` (literal mode only), `replaceAll` (default `true`)
- `perReplacement[]` reports `bodyCount` / `frontmatterCount` per entry; `totalReplacements` sums them

---

### `obsidian_manage_frontmatter` <sub>tool</sub>

- `operation: "get" | "set" | "delete"` on a single frontmatter `key`; `set` requires a JSON-typed `value` (string, number, boolean, array, or object)
- `get` needs read access; `set` / `delete` need the path inside `OBSIDIAN_WRITE_PATHS` with `OBSIDIAN_READ_ONLY=false`
- `set` / `delete` return the full `frontmatter` after the change plus `previousSizeInBytes` / `currentSizeInBytes`

---

### `obsidian_manage_tags` <sub>tool</sub>

- `operation: "add" | "remove" | "list"`; `location: "frontmatter"` (default, canonical `tags:` array) | `"inline"` (body `#tag`, `add` appends at end-of-file) | `"both"` (reconciles both)
- Inline detection skips fenced/inline code spans, link spans (`[[...]]`, `[text](...)`, `[text][ref]`), HTML comments, and math (`$…$`, `$$…$$`), so a heading anchor or wikilink alias is never mistaken for a tag; `%% … %%` comments are still read, as Obsidian reads them
- Inline tags follow Obsidian's grammar: a tag starts at line start, after whitespace, or right after markup such as `**`, `==`, `<br>`, or a `\`-escape (`**#x**` is a tag; `(#x`, `.#x`, `a *#x`, and `\#x` are not) and runs through letters and digits in any script, emoji, `_`, `-`, and `/`, with at least one character that is not an ASCII digit (`#1990s`, `#café`, `#日本語`, and `#✅done` are tags; `#1984` is not)
- `add` / `remove` report `applied` vs. `skipped` tags plus the full `tags` set after the change; `list` ignores the input `tags` array

---

### `obsidian_delete_note` <sub>tool</sub>

- Always asks for confirmation first — the initial call returns an elicitation request naming the file's byte size, and is retried with the answer; declining fails with `cancelled` and issues no `DELETE`
- No API-level undo — recovery requires Obsidian's local trash
- Requires an MCP client that can serve an elicitation round-trip; every other tool works without one

---

### `obsidian_open_in_ui` <sub>tool</sub>

- `failIfMissing` (default `true`) controls open-vs-create: opening an existing file needs read access, opening a missing one (with `failIfMissing: false`) creates it and needs write access
- `newLeaf` opens in a split pane instead of the active one
- Same forgiving path resolution as `obsidian_get_note` (case fallback, `Did you mean` suggestions); `obsidian_delete_note` deliberately doesn't get it — a destructive op never silently rewrites its target
- Output reports `createdIfMissing` so the caller can tell which branch ran

---

### `obsidian_execute_command` <sub>tool</sub>

- Dispatches an Obsidian command-palette command by `commandId` (discover via `obsidian_list_commands`); runs with the same authority as a keyboard invocation
- **Opt-in via `OBSIDIAN_ENABLE_COMMANDS=true`** — absent from `tools/list` when unset
- Behavior is command-dependent — some are destructive (delete file, close vault), some open UI

---

### `obsidian://vault/{+path}` <sub>resource</sub>

- The `{+path}` segment captures everything after `/vault/`, including slashes
- Paths may be sent literally or percent-encoded — `Folder/Test Note.md` and `Folder/Test%20Note.md` resolve to the same note, as do non-ASCII names and a bare `%`
- Returns the same shape as `obsidian_get_note` with `format: "full"` — content, frontmatter, tags, stat
- Gated by `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` like the tool equivalent

---

### `obsidian://tags` <sub>resource</sub>

- Full snapshot of the upstream `/tags/` payload — unsorted, uncapped, includes hierarchical parents
- Not a mirror of `obsidian_list_tags`: no count-descending order, no `limit` / `nameRegex` / `minCount`

---

### `obsidian://status` <sub>resource</sub>

- Reachability, plugin version, `authenticated` (whether the configured `OBSIDIAN_API_KEY` was accepted), and plugin manifest info
- `apiExtensions[]` lists registered plugin extensions — check for `local-rest-api-periodic-notes` before relying on `periodic` targets on plugin v5.0.2 and later
- Still reports reachability when the API key is misconfigured; only `authenticated` reflects the key's validity

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

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Obsidian-specific:

- Wraps the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin — typed client, deterministic error mapping
- Section-aware editing across headings, block references, and frontmatter fields via `PATCH`-with-target operations
- Search across three modes — text, JSONLogic, and (when reachable) BM25-ranked Omnisearch — cursor-paginated per the MCP 2025-11-25 spec
- Tag reconciliation across both representations: frontmatter `tags:` array and inline `#tag` syntax
- Folder-scoped read/write permissions via `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` and a global `OBSIDIAN_READ_ONLY` kill switch; opt-in command-palette pair gated by `OBSIDIAN_ENABLE_COMMANDS`. Server-level `instructions` on `initialize` report the active policy to the caller

Agent-friendly output:

- Recovery-guided errors — every declared failure carries a `reason`, a JSON-RPC code, and a `recovery.hint` written for that case, so a rejection names what to do next instead of only what broke
- Size-delta self-correction — every mutating tool returns `previousSizeInBytes` / `currentSizeInBytes`, so a caller can spot an accidental clobber or unexpected upstream behavior without a follow-up read
- Ambiguity surfaced structurally — a heading leaf name shared by several headings returns `candidates` instead of silently picking one; tag operations report `applied` vs. `skipped` so a caller sees exactly what changed
- Discriminated output contracts — `format` on `obsidian_get_note`, `operation` on `obsidian_manage_frontmatter` and `obsidian_manage_tags`, `mode` on `obsidian_search_notes` — callers branch on typed fields instead of parsing text

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

The default `OBSIDIAN_BASE_URL` (`http://127.0.0.1:27123`) points at the container's own loopback, not your host — add `-e OBSIDIAN_BASE_URL=http://host.docker.internal:27123` (Docker Desktop) or run with `--network host` (Linux) so the container can reach the plugin.

For Streamable HTTP, set the transport and start the server. Inline env vars work for one-off runs; for repeated use, copy values into `.env` (see [`.env.example`](./.env.example)) and run `bun run start:http`.

```sh
MCP_TRANSPORT_TYPE=http OBSIDIAN_API_KEY=... bun run start:http
# Server listens at http://127.0.0.1:3010/mcp by default
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- The [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin, **v4.0.0 through v5.x**, installed and enabled in your vault. Generate an API key in **Settings → Community Plugins → Local REST API** and copy it into `OBSIDIAN_API_KEY`. Plugin v6.0 removes the markdown-patch 1.x wire format this server pins for section-targeted writes and the document map.
- Periodic-note targets (`target: { "type": "periodic" }`) work across that whole range: natively on plugin **v5.0.1 and earlier**, and on **v5.0.2 and later** — which moved the `/periodic/` routes out of the plugin — once the companion [periodic-notes API extension](https://github.com/coddingtonbear/obsidian-local-rest-api-periodic-notes) is installed. Without that extension on v5.0.2+, periodic targets fail with a `periodic_unsupported` error naming it; `obsidian://status` lists the registered extensions if you want to check first. Every other target type is unaffected.
- An MCP client that can answer an input request (elicitation). `obsidian_delete_note` always asks for confirmation before deleting, so a client without that support can read and write notes but cannot delete one.
- This server defaults to `http://127.0.0.1:27123` for simplicity. Enable **"Non-encrypted (HTTP) Server"** in the plugin settings to use it. To use the always-on HTTPS port instead, set `OBSIDIAN_BASE_URL=https://127.0.0.1:27124`; the plugin's self-signed cert is handled by `OBSIDIAN_VERIFY_SSL=false` (the default), which relaxes verification for this server's requests to that endpoint only.

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
| `OBSIDIAN_BASE_URL` | Base URL of the Local REST API plugin. Use `https://127.0.0.1:27124` for the always-on HTTPS port (self-signed cert). A trailing slash is stripped at startup. When nothing answers there (Obsidian closed, plugin disabled, wrong host or port), calls fail with `obsidian_unreachable` — a `GET`, `PUT`, or `DELETE` after its retries, any other request on the first attempt. | `http://127.0.0.1:27123` |
| `OBSIDIAN_VERIFY_SSL` | Verify the TLS certificate. Default `false` because the plugin uses a self-signed cert. The relaxation is applied per request, to an `https:` `OBSIDIAN_BASE_URL` only — every other HTTPS connection the process makes still verifies normally, on both Bun and Node. With `true`, a certificate the runtime does not trust fails every call on its first attempt with `certificate_rejected`. | `false` |
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
| `MCP_SESSION_MODE` | Session handling for the HTTP transport: `stateless`, `stateful`, or `auto`. Defaults to `stateful` here — `obsidian_delete_note` confirms via an elicitation round, and under `stateless` a 2025-era client's round is refused (`client_capability_missing`). | `stateful` |
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

The Dockerfile defaults to HTTP transport, stateful session mode (required for the `obsidian_delete_note` confirmation round), and logs to `/var/log/obsidian-mcp-server`. Point `OBSIDIAN_BASE_URL` at `http://host.docker.internal:27123` (Docker Desktop) or run with `--network host` (Linux) so the container reaches the plugin on your host. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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

Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

---
name: polish-docs-meta
description: >
  Finalize documentation and project metadata for a ship-ready MCP server. Use after implementation is complete, tests pass, and devcheck is clean. Safe to run at any stage — each step checks current state and only acts on what still needs work.
metadata:
  author: cyanheads
  version: "2.11"
  audience: external
  type: workflow
---

## When to Use

- Server implementation is functionally complete (tools, resources, prompts, services all working)
- `bun run devcheck` passes, tests pass
- You're preparing for first commit, first release, or making the repo public
- User says "polish", "polish docs", "finalize", "make it ship-ready", "clean up docs", or similar
- Re-running after adding/removing tools, resources, or other surface area changes

Prefer running after implementation is complete, but safe to re-run at any point — steps are idempotent.

**Companion:** pair with `security-pass` for a full pre-ship review — this skill polishes docs and metadata; `security-pass` audits handlers for MCP-specific security gaps.

## Prerequisites

- [ ] All tools/resources/prompts implemented and registered
- [ ] `bun run devcheck` passes
- [ ] Tests pass (`bun run test`)

If these aren't met, address them first.

## Steps

### 1. Audit the Surface Area

Read all tool, resource, and prompt definitions. Build a mental model of what the server actually does — names, descriptions, input/output shapes, auth scopes. This inventory drives every document below.

Read:

- `src/index.ts` (what's registered in `createApp()`)
- All files in `src/mcp-server/tools/definitions/`
- All files in `src/mcp-server/resources/definitions/`
- All files in `src/mcp-server/prompts/definitions/`
- All files in `src/services/` (if any)
- `src/config/server-config.ts` (if any)

Capture: tool count, resource count, prompt count, service count, required env vars.

### 2. README.md

Read `references/readme.md` for structure and conventions. If `README.md` doesn't exist, create it from scratch. If it exists, diff the current content against the audit — update tool/resource/prompt tables, env var lists, and descriptions to match the actual surface area. Don't rewrite sections that are already accurate.

The bold header tagline (the `<b>` text inside the first `<p>`) must match the `package.json` `description`. The surface count is a nested `<div>` inside the same `<p>`, separated by `•`.

### 3. Agent Protocol (CLAUDE.md / AGENTS.md)

Update the project's agent protocol file to reflect the actual server. Scope is the project-root `CLAUDE.md` / `AGENTS.md` only — **do not edit `skills/*/SKILL.md` or their `references/` files**. Those are external skill files synced from `@cyanheads/mcp-ts-core` and get overwritten on the next `maintenance` refresh.

Read `references/agent-protocol.md` for the full update checklist, then review the current file and address what's stale or missing:

- If a "First Session" onboarding block is still present and onboarding is complete, it can go
- If example patterns still use generic/template names (e.g., `searchItems`, `itemData`), replace with real definitions from this server
- If server-specific skills were added, update the skills table
- Verify the structure diagram matches the actual directory layout
- If custom scripts were added to `package.json`, update the commands table

### 4. `.env.example`

Compare `.env.example` against the server config Zod schema. Add any missing server-specific vars with a comment and default (if any). Remove vars for features that no longer exist. Group by category. Preserve existing framework vars that are still relevant.

### 5. `package.json` Metadata

Check for empty or placeholder metadata fields. Read `references/package-meta.md` for which fields matter and why. Fill in anything still missing — skip fields that are already correct.

Key fields: `name`, `description`, `repository`, `author`, `homepage`, `bugs`, `keywords`.

**`name` must communicate the server's domain at a glance.** See `references/package-meta.md` for the naming convention — ambiguous abbreviations and acronym-only names fail the scannability test for humans and agents alike.

**`name` and `title` in `createApp()` / `createWorkerHandler()` must match the unscoped `package.json` `name`** — display identity is the machine name on every surface; `lint:packaging` (run by `devcheck`) enforces the match and warns when the pair is partial. `description` is never duplicated into the entrypoint — `package.json` is the canonical source (the framework derives the served description from it). Adopting the pair also seeds `OTEL_SERVICE_NAME` when unset, so telemetry's `service.name` switches to the machine name on first boot — expect a one-time series split in backends keyed on the old scoped label.

**`description` is the canonical source.** Every other surface (README header, `server.json`, Dockerfile OCI label, GitHub repo description) derives from it. Write it here first, then propagate.

### 6. `server.json`

Read `references/server-json.md` for the official MCP server manifest schema. If `server.json` doesn't exist, create it from the surface area audit. If it exists, diff against current state and update stale fields.

Key sync points:
- `$schema` set to `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
- `name` matches `mcpName` from `package.json` (reverse-domain: `io.github.{owner}/{repo}`)
- `version` matches `package.json` version (in all three places: top-level + each package entry)
- `description` matches `package.json` description
- `environmentVariables` reflect the server config Zod schema — server-specific required vars in both entries, transport vars only in HTTP entry
- Two package entries: one for stdio, one for HTTP (if both transports supported)

### 7. GitHub Repository Metadata

Sync the GitHub repo with `package.json` using the `gh` CLI. Skip if the repo isn't hosted on GitHub or `gh` isn't available.

**Description:**

```bash
gh repo edit <owner>/<repo> --description "<package.json description>"
```

**Topics ↔ Keywords:**

Compare GitHub topics (`gh repo view --json repositoryTopics`) against `package.json` `keywords`. They should be the union — add any that exist in one but not the other:

- Missing from GitHub → `gh repo edit --add-topic <topic>`
- Missing from `package.json` → add to `keywords` array

Common keywords shared across MCP servers (e.g., `mcp`, `mcp-server`, `model-context-protocol`, `typescript`) should appear in both. Domain-specific keywords should also be present in both.

### 8. `bunfig.toml`

Verify a `bunfig.toml` exists at the project root. If not, create one:

```toml
[install]
auto = "fallback"
frozenLockfile = false

[run]
bun = true
```

### 9. Changelog

Two patterns are supported — pick one and stay consistent.

| Pattern | Best for |
|:---|:---|
| **Directory-based** (template default) | Published libraries, or servers whose consumers run the `maintenance` skill against them — per-version files ship inside `node_modules/<pkg>/changelog/<minor>.x/<version>.md` for direct agent inspection. |
| **Monolithic `CHANGELOG.md`** | Runtime-only consumer servers where nobody imports types and nobody runs `maintenance` against the package — skips the build step and devcheck drift gate. |

Both are acceptable. The template scaffolds the directory-based structure by default; collapse to monolithic only if the rollup tooling is pure ceremony for this project.

**Directory-based** — per-version files live at `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`), and `CHANGELOG.md` is a rollup regenerated by `bun run changelog:build`. Devcheck's `Changelog Sync` step enforces drift protection. `changelog/template.md` is a **pristine format reference** — never edited, never moved, never renamed. Read it to remember the frontmatter + section layout when scaffolding a new per-version file.

If the structure doesn't exist yet:

1. Make the `changelog/` directory
2. Create `changelog/template.md` once from the template (frontmatter stub + H1 `# <version> — YYYY-MM-DD` placeholder + empty Added/Changed/Fixed sections) — this file is a format reference only and stays as-is after creation
3. If the server already has a shipped version (e.g. 0.1.0), create the series directory and initial entry: `changelog/0.1.x/0.1.0.md` with H1 `# 0.1.0 — YYYY-MM-DD`, concrete version and date — do **not** rename or move `template.md` to create the version file; author the per-version file directly
4. Run `bun run changelog:build` to generate `CHANGELOG.md`

Per-version file format:

```markdown
---
summary: One-line headline for the rollup index — ≤350 chars, no markdown
breaking: false
---

# 0.1.0 — YYYY-MM-DD

Optional narrative intro (1-3 sentences).

## Added

- [list tools, resources, prompts, key capabilities]
```

**Frontmatter:** `summary` is required (powers the CHANGELOG.md index), `breaking` is optional and defaults to `false` (set `true` for releases requiring consumer code changes).

Never hand-edit `CHANGELOG.md` when using this pattern — it's a build artifact. Never edit `changelog/template.md` — it's the format reference. Never use `[Unreleased]` as a version header in a released file.

**Monolithic** — maintain `CHANGELOG.md` directly in [Keep a Changelog](https://keepachangelog.com/) format. To collapse from the template default: delete the `changelog/` directory, remove `changelog:build` and `changelog:check` from `package.json` scripts (and from `devcheck.config.json` if referenced), and drop `"changelog/"` from the `files` array. The `release` skill's directory-specific steps then don't apply — just edit `CHANGELOG.md` and bump version at release time.

### 10. Plugin Metadata (Codex / Claude Code)

`lint:packaging` (run by `devcheck`) now enforces the high-value subset automatically when these manifests are present: non-empty descriptions, and identity/install correctness — display fields (`name`, server key, `interface.displayName`) must be the **unscoped** machine name, while the `npx -y` install arg must be the full `package.json` `name` (scoped if scoped). Opt out per project with `"packaging": { "pluginManifests": false }` in `devcheck.config.json`. The checks below cover the fields the gate doesn't (version / repository / license sync, category, env vars).

If `.codex-plugin/plugin.json` exists, verify it's populated and in sync with `package.json` and `server.json`:

- `name` is the unscoped `package.json` `name` (display identity is the machine name on every surface)
- `version` matches `package.json` `version`
- `description` matches `package.json` `description`
- `repository` matches `package.json` `repository.url`
- `license` matches `package.json` `license`
- `interface.displayName` is the unscoped `package.json` `name`
- `interface.shortDescription` matches `package.json` `description`
- `interface.category` is set to a meaningful category

If `.codex-plugin/mcp.json` exists, verify the server-name key is the unscoped `package.json` `name`, the `npx -y` install arg is the full `package.json` `name`, and env vars include any required API keys from the server config schema.

If `.claude-plugin/plugin.json` exists, apply the same checks: `name` (unscoped), `version`, `description`, `repository`, `license` from `package.json`. Verify the inline `mcpServers` entry key is the unscoped name, its `npx -y` install arg is the full `package.json` `name`, and env vars include any required API keys.

### 11. MCPB Bundling Artifacts

If the project ships as an `.mcpb` bundle for Claude Desktop (check for `manifest.json` at the project root), verify the full artifact set is present and consistent. If the project doesn't ship `.mcpb` bundles, skip this step.

**Files that must exist:**

- `manifest.json` — MCPB manifest with `mcp_config.env`, `user_config`, and metadata
- `.mcpbignore` — controls what's excluded from the bundle

**`package.json` scripts:**

- `bundle` — builds the `.mcpb` (`mcpb pack`, then `scripts/clean-mcpb.ts` prunes dev deps and strips dependency-shipped agent docs)
- `lint:packaging` — validates `manifest.json` ↔ `server.json` env var consistency (run by `devcheck`)

**Cross-file consistency:**

- `manifest.json` version matches `package.json` version
- Env var names in `manifest.json` (`mcp_config.env` + `user_config`) match `server.json` `environmentVariables` — `lint:packaging` enforces this, but verify the set is complete
- `manifest.json` `name` matches `package.json` name **without the npm scope prefix** (e.g. `bls-mcp-server`, not `@cyanheads/bls-mcp-server`); `description` matches `package.json`
- `manifest.json` `author` is the full person object — `{ "name", "email", "url" }` — carrying the same identity as `package.json` `author` (name matches the LICENSE copyright holder, url is the author's site)
- `manifest.json` `user_config` entries must include `title` and `type` fields — `mcpb pack` validates these
- For each `user_config` entry referenced as `${user_config.X}` in `mcp_config.env`: if it's not `required: true`, set `"default": ""`. MCPB hosts (Claude Desktop included) pass the literal placeholder string through to the process when an optional field is left blank without a default — strict consumer validators (`z.email()`, `z.url()`, `.regex()`) then crash at lazy config load, exiting silently after `initialize`. Server-side: pair every optional env-backed strict-validator field with a `z.preprocess` that strips `${...}` placeholders to `undefined`.
- `server.json` env var `isRequired` must match the upstream API's actual requirement — if the API works without the value (rate-limited, DEMO_KEY fallback, polite pool), mark `isRequired: false` and describe the tradeoff in the description
- Server description aligned across all surfaces: `package.json`, `manifest.json`, `server.json` (condensed, hard 100-char limit), README header `<p><b>`, and GitHub repo description (`gh repo edit --description`)
- `package.json` `keywords` include baseline terms: `mcp`, `mcp-server`, `model-context-protocol`, `typescript`, `bun`, `stdio`, `streamable-http`, plus data-domain terms. GitHub repo topics (`gh repo edit --add-topic`) should match.

**README install badges:**

- If `manifest.json` exists, the README should include the Claude Desktop install badge linking to `releases/latest/download/<name>.mcpb`
- If the package is published to npm, include Cursor and VS Code install badges
- See `references/readme.md` for badge format and config generation commands

### 12. `LICENSE`

Confirm a license file exists. If not, ask the user which license to use (default: Apache-2.0, matching the scaffolded `package.json`). Create the file.

### 13. `Dockerfile`

If a `Dockerfile` exists, verify the OCI labels and runtime config match the actual server:

- `org.opencontainers.image.title` matches the package name
- `org.opencontainers.image.description` matches `package.json` `description`
- `org.opencontainers.image.source` points to the real repository URL (add if missing)
- Log directory path in `mkdir` and `LOGS_DIR` uses the correct server name

If no `Dockerfile` exists and the server is deployed via HTTP transport, consider scaffolding one — the template is available via `npx @cyanheads/mcp-ts-core init`.

### 14. `docs/tree.md`

Regenerate the directory structure:

```bash
bun run tree
```

Review the output for anything unexpected (leftover files, missing directories).

### 15. Final Verification

Run the full check suite one last time:

```bash
bun run devcheck
bun run test
```

Both must pass clean.

## Checklist

- [ ] Surface area audited — tool/resource/prompt/service inventory built
- [ ] `README.md` accurate — tool/resource tables, config, descriptions match actual code
- [ ] Agent protocol file accurate — no stale template content, real examples, structure matches reality
- [ ] `.env.example` in sync with server config schema
- [ ] `package.json` metadata complete (`description`, `mcpName`, `repository`, `author`, `keywords`, `engines`, `packageManager`)
- [ ] `server.json` matches official MCP schema, versions synced, env vars current
- [ ] GitHub repo description matches `package.json` description; topics ↔ keywords in sync
- [ ] `bunfig.toml` present
- [ ] Changelog current — either monolithic `CHANGELOG.md` (hand-edited, Keep a Changelog) or directory-based (`changelog/<minor>.x/<version>.md` + rollup regenerated and in sync)
- [ ] `.codex-plugin/plugin.json` populated and in sync with `package.json` (if present)
- [ ] `.codex-plugin/mcp.json` server name and env vars current (if present)
- [ ] `.claude-plugin/plugin.json` populated and in sync with `package.json` (if present)
- [ ] MCPB artifacts consistent (if `manifest.json` present) — version synced, env vars match `server.json`, `bundle` + `lint:packaging` scripts exist, README install badges present
- [ ] `LICENSE` file present
- [ ] `Dockerfile` OCI labels and runtime config accurate (if present)
- [ ] `docs/tree.md` regenerated
- [ ] `bun run devcheck` passes
- [ ] `bun run test` passes

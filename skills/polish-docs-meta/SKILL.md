---
name: polish-docs-meta
description: >
  Finalize documentation and project metadata for a ship-ready MCP server. Use after implementation is complete, tests pass, and devcheck is clean. Safe to run at any stage — each step checks current state and only acts on what still needs work.
metadata:
  author: cyanheads
  version: "1.8"
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

Key fields: `description`, `repository`, `author`, `homepage`, `bugs`, `keywords`.

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

### 10. `LICENSE`

Confirm a license file exists. If not, ask the user which license to use (default: Apache-2.0, matching the scaffolded `package.json`). Create the file.

### 11. `Dockerfile`

If a `Dockerfile` exists, verify the OCI labels and runtime config match the actual server:

- `org.opencontainers.image.title` matches the package name
- `org.opencontainers.image.description` matches `package.json` `description`
- `org.opencontainers.image.source` points to the real repository URL (add if missing)
- Log directory path in `mkdir` and `LOGS_DIR` uses the correct server name

If no `Dockerfile` exists and the server is deployed via HTTP transport, consider scaffolding one — the template is available via `npx @cyanheads/mcp-ts-core init`.

### 12. `docs/tree.md`

Regenerate the directory structure:

```bash
bun run tree
```

Review the output for anything unexpected (leftover files, missing directories).

### 13. Final Verification

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
- [ ] `LICENSE` file present
- [ ] `Dockerfile` OCI labels and runtime config accurate (if present)
- [ ] `docs/tree.md` regenerated
- [ ] `bun run devcheck` passes
- [ ] `bun run test` passes

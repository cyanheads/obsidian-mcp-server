---
name: maintenance
description: >
  Investigate, adopt, and verify dependency updates — with special handling for `@cyanheads/mcp-ts-core`. Captures what changed, understands why, cross-references against the codebase, adopts framework improvements, syncs project skills, and runs final checks. Supports two entry modes: run the full flow end-to-end, or review updates you already applied.
metadata:
  author: cyanheads
  version: "1.7"
  audience: external
  type: workflow
---

## When to Use

- After running `bun update --latest` yourself and wanting to review the impact (**Mode B** — typical)
- To run the whole flow end-to-end — outdated check → update → investigate → adopt → verify (**Mode A**)
- Periodically, to check for skill drift from the package

## Entry Modes

| Mode | Starting Point | First Step |
|:-----|:---------------|:-----------|
| **A — Full flow** | Lockfile is current; want to update | Step 1 |
| **B — Post-update review** | User already ran `bun update --latest` + `bun run rebuild` + `bun run test` | Skip to Step 3 with the update output or a `bun.lock` diff |

Both modes converge at Step 3 and end at Step 8.

## Steps

### 1. Survey what's outdated (Mode A only)

```bash
bun outdated
```

Note: `bun update --latest` crosses semver majors; `bun update` alone respects ranges. Use `--latest` unless a package is intentionally pinned.

### 2. Apply the update (Mode A only)

```bash
bun update --latest
```

Capture the `↑ package old → new` lines from stdout — these feed Step 3. Alternatively, diff `bun.lock` to surface version deltas after the fact.

### 3. Investigate changelogs

Invoke the **`changelog`** skill with the captured list of updated packages. It resolves each repo, fetches release notes (or CHANGELOG entries) between old and new versions, and cross-references changes against actual imports in `src/`. Output per package: what changed, impact on this project, action items.

Do not redo this investigation inline — the `changelog` skill handles tag-format detection, monorepo patterns, and fallbacks.

### 4. Framework review (`@cyanheads/mcp-ts-core`)

If `@cyanheads/mcp-ts-core` was updated, do a deeper pass beyond what the `changelog` skill covers. The framework ships a **directory-based changelog** grouped by minor series (`.x` semver-wildcard convention) — one file per released version at `node_modules/@cyanheads/mcp-ts-core/changelog/<major.minor>.x/<version>.md`. Read only the files between old and new rather than scanning a monolithic file.

Example — `0.5.2 → 0.5.4` means reading two new version files:

- `node_modules/@cyanheads/mcp-ts-core/changelog/0.5.x/0.5.3.md`
- `node_modules/@cyanheads/mcp-ts-core/changelog/0.5.x/0.5.4.md`

Cross-series updates span multiple directories — e.g., `0.4.1 → 0.5.2` reads `0.5.x/0.5.0.md`, `0.5.x/0.5.1.md`, `0.5.x/0.5.2.md`. Enumerate the series directories under `node_modules/@cyanheads/mcp-ts-core/changelog/` to find the relevant files.

If the per-version directory isn't present (pre-0.5.5 releases, or downstream package that hasn't adopted the convention), fall back to the monolithic rollup at `node_modules/@cyanheads/mcp-ts-core/CHANGELOG.md` and extract the relevant sections manually.

Scan specifically for:

| Area | Adoption Check |
|:-----|:---------------|
| New error factories in `/errors` | Replace ad-hoc `new McpError(...)` with factories where applicable |
| New utilities in `/utils` | Identify any that supersede local helper code |
| New context capabilities | Added `ctx.*` methods worth adopting |
| Provider/service APIs | Updates to `OpenRouterProvider`, `SpeechService`, `GraphService`, etc. |
| Deprecations | Migrate now, before the next breaking release |
| Config changes | New env vars, renamed keys, changed defaults |
| Linter rules | New definition-lint rules that may now flag existing tools/resources |
| New or materially-changed skills | Note new skills or workflow changes (renamed steps, new checklist items) worth surfacing at end-of-run. Don't auto-invoke — some skills (e.g. `security-pass`) are user-triggered. The per-version changelog entries (e.g. 0.6.14 calling out `skills/security-pass/ (v1.0)`) name what changed. |

Cross-reference each finding against the server's code. Collect adoption opportunities for Step 6.

**Template review.** The framework also ships `templates/CLAUDE.md` and `templates/AGENTS.md` as scaffolding for consumer agent protocol files. The consumer's `CLAUDE.md`/`AGENTS.md` was copied at init time and has since diverged (local customizations, echo replacements, server-specific sections). Read the upstream template fresh at `node_modules/@cyanheads/mcp-ts-core/templates/CLAUDE.md`.

Read the upstream template end-to-end, mentally comparing against the current `CLAUDE.md`/`AGENTS.md`. Apply framework-authored updates directly — new skill references in the skills table, new entries in the "What's Next?" section, updated convention callouts, clarified patterns. These are factual updates, not taste decisions; the consumer's agent protocol file is meant to track the framework's. Only surface a decision when a template change conflicts with a section the consumer has intentionally customized (server-specific domain context, bespoke checklists, etc.) — in that case, note the conflict and ask.

### 5. Sync project skills and scripts

Skills flow in two hops: package → project `skills/` → agent directories. Framework scripts flow in one: package → project `scripts/`. Both drift silently unless resynced.

**Phase A — Package → Project `skills/`**

1. **Package** — `node_modules/@cyanheads/mcp-ts-core/skills/` (canonical source)
2. **Project** — `skills/` at project root (working copy; may contain local overrides or server-specific skills)

Procedure:

1. List all skill directories in `node_modules/@cyanheads/mcp-ts-core/skills/`
2. For each skill with `metadata.audience: external` in its `SKILL.md` frontmatter:
   - If missing in project `skills/`, copy the full directory
   - If present, compare `metadata.version` — replace if the package version is newer
   - If the local version is equal or newer, skip (local override)
3. Do not touch skills in `skills/` that don't exist in the package (server-specific)

**Phase B — Project `skills/` → Agent directories**

The `setup` skill instructs consumers to copy `skills/*` into their agent's skill directory at init time. Those copies go stale unless re-synced. Detect which agent directories exist and propagate:

| Agent | Directory |
|:------|:----------|
| Claude Code | `.claude/skills/` |
| Generic / shared | `.agents/skills/` |
| Codex | `.codex/skills/` |
| Cursor | `.cursor/skills/` |
| Windsurf | `.windsurf/skills/` |

For each agent directory that exists:

1. For every directory in project `skills/`, copy it into the agent dir (overwrite on match, add if missing)
2. Do **not** delete skills in the agent dir that aren't in project `skills/` — they may be general-purpose skills sourced elsewhere (e.g., `code-security`, `cloudflare`, `changelog`)

If no agent directory exists, skip Phase B — the project hasn't opted in to per-agent skill copies.

**Phase C — Package scripts → Project `scripts/`**

The `init` CLI scaffolds a fixed set of framework scripts into consumer projects — these underpin `bun run build`, `bun run devcheck`, `bun run lint:mcp`, `bun run tree`, and the changelog build. They drift silently when the framework updates them. Compare by content hash and overwrite on mismatch:

```bash
for src in node_modules/@cyanheads/mcp-ts-core/scripts/*.ts; do
  s=$(basename "$src")
  dst="scripts/$s"
  if [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    echo "added: $s"
  elif ! cmp -s "$src" "$dst"; then
    cp "$src" "$dst"
    echo "updated: $s"
  fi
done
```

Scripts in `scripts/` that aren't present in the package directory are project-specific (custom deploy, codegen, etc.) — leave them alone. The package's `files:` field gates what ships into `node_modules/.../scripts/`, so enumerating that directory is the canonical "shipped scripts" set.

If the consumer customized a framework script, the overwrite discards those changes. After the sync runs, diff `scripts/` to surface replacements — review before committing. If a specific local customization needs to be preserved, revert that file using your git tools.

**Report** which skills were added/updated in Phase A (with version deltas), which agent directories were refreshed in Phase B, and which scripts were resynced in Phase C. The user needs to know what new guidance and tooling is now in play.

### 6. Adopt changes in the codebase

Apply the findings from Steps 3 and 4. Framework changes and third-party library changes have different adoption defaults — the asymmetry is deliberate.

**Framework changes (`@cyanheads/mcp-ts-core`) — default adopt.**

The consumer opted into the framework; its templates, skills, scripts, linter rules, and conventions are authoritative. Adopt directly unless the change genuinely conflicts with a documented local override.

- **Breaking changes** — fix call sites. Not optional.
- **Deprecations** — migrate now, while context is fresh.
- **New linter rules** — if the rule now flags existing code, fix the code; don't silence the rule.
- **New utilities that supersede local code** — swap them in. The point of the framework is to centralize.
- **New conventions** (template changes, new config keys, renamed env vars) — adopt and update `.env.example`, server config schema, `server.json`, and README if user-facing.
- **New framework features that don't match existing use cases** — skip; those are for future features, not retroactive refactors.

**Third-party library changes — default cost/benefit.**

- Read the changelog findings from Step 3, assess impact against actual call sites in `src/`.
- Adopt when the change is a clear win (performance, correctness, removed deprecation warning, smaller surface).
- Skip when marginal — a new convenience API isn't a reason to touch working code.
- If the library added a feature the server could use, note it but don't refactor speculatively.

### 7. Rebuild and verify

```bash
bun run rebuild
bun run devcheck
bun run test
```

`rebuild` (clean + build) catches API surface and type-alignment issues that `devcheck` alone may miss — module resolution, path aliases, post-build processing. `devcheck` includes `bun audit` and `bun outdated`, so no separate audit step is needed.

In **Mode B**, the user already ran rebuild + test before invoking this skill, but run them again here — Step 6 made code changes that need verification.

Fix anything that fails. Re-run until clean.

### 8. Summary

Present a concise numbered summary to the user:

1. **Updated packages** — short list with version deltas (N total)
2. **Breaking changes handled** — call sites fixed
3. **Features adopted** — new framework APIs now in use
4. **Skills synced** — added/updated with versions (Phase A) and agent directories refreshed (Phase B)
5. **New/changed skills available** — skills that appeared in Phase A for the first time or had materially-changed step sequences. Frame as "consider running when the time is right" rather than immediate actions; the user decides when to invoke them.
6. **Open decisions** — genuinely ambiguous items: breaking changes with multiple migration paths, framework changes that conflict with a documented local override, third-party adoptions where the cost/benefit is close
7. **Status** — rebuild / devcheck / test results

## Checklist

- [ ] Update applied (`bun update --latest`) — Mode A, or already done by user — Mode B
- [ ] `changelog` skill invoked for each updated package
- [ ] Framework CHANGELOG reviewed if `@cyanheads/mcp-ts-core` was updated
- [ ] Adoption opportunities identified and applied
- [ ] Project `skills/` synced from package (Phase A), with a change report
- [ ] Agent skill directories (`.claude/skills/`, `.agents/skills/`, etc.) refreshed from project `skills/` (Phase B)
- [ ] Framework `scripts/` resynced from package via content-hash compare (Phase C), with a change report; `scripts/` diff reviewed before committing
- [ ] `bun run rebuild` succeeds
- [ ] `bun run devcheck` passes (includes audit + outdated)
- [ ] `bun run test` passes
- [ ] Numbered summary presented to user

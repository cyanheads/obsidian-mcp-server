---
name: field-test-fix
description: >
  Workflow: field-test one or more existing MCP server projects against the live upstream API, file GH issues for valid findings, deploy fix sub-agents per server, optionally loop until clean, then wrap up and release. Chains the `field-test`, `report-issue-local`, `tool-defs-analysis`, `code-simplifier`, `git-wrapup`, and `release-and-publish` skills. Read `../SKILL.md` first for the universal rules and sub-agent strategy.
metadata:
  author: cyanheads
  version: "1.0"
  audience: external
  type: workflow
---

# Field-Test + Fix Workflow

Use after reading `../SKILL.md`. Drives field-testing, issue filing, fix application, verification, and (optional) release across N MCP server projects.

## When applicable

- One or more existing servers need a QA pass against the live upstream API — quality gate before launch, post-release smoke test, or "find and fix bugs" instruction
- The user wants observed bugs filed as GH issues and then fixed
- Optionally ends in a release; can also stop at "fixed, committed locally" if release isn't authorized yet

For known work (issues already tracked, handoff documents) where the discovery phase isn't needed, use `fix-wrapup-release.md` instead.

## Tier 1 skills referenced

| Phase | Tier 1 skill(s) |
|:---|:---|
| Field-test | `skills/field-test/SKILL.md` |
| Issue filing | `skills/report-issue-local/SKILL.md` + `.github/ISSUE_TEMPLATE/` |
| Tool definition quality (informs field-test framing) | `skills/tool-defs-analysis/SKILL.md` |
| Fix | (No single skill — sub-agent reads issues, validates, fixes) |
| Code simplify (optional) | `skills/code-simplifier/SKILL.md` |
| Wrap-up | `skills/git-wrapup/SKILL.md` |
| Release | `skills/release-and-publish/SKILL.md` |

## Pre-flight

Per target:

1. **Clean working tree** — `git status --short` must be empty
2. **Current version** — `git describe --tags --abbrev=0`, `grep '"version"' package.json`
3. **API keys** — `.env` files exist for servers requiring them. If missing, surface the list with registration URLs before proceeding.
4. **Issue template + `report-issue-local` skill present** per target
5. **`list-skills` script present** — `test -f scripts/list-skills.ts && grep -q '"list-skills"' package.json`
6. **Repo visibility** — `gh repo view --json visibility -q '.visibility'` per target. Determines wrap-up scope.
7. **Build** — `bun run rebuild` per target, parallel. All must pass before Phase 1.

## Phases

Each phase's Objective column is the goal state per target — the verifiable end state the phase must produce.

| # | Phase | Objective | Sub-agent mode | Gate after |
|:--|:---|:---|:---|:---|
| 1 | Field-test | Per target: live tool/resource/prompt surface exercised across happy/error/edge paths; valid findings filed as GH issues against the server's own repo; noise filtered | parallel fanout per target; within a target, 1 or 3 sub-agents (see below) | **barrier** — cross-target synthesis: orchestrator reconciles all findings before filing triage |
| 2 | Issue triage | Per-target GH issue count + severity breakdown reconciled against actual GH state | orchestrator (serial) | gate-free |
| 3 | Fix | Per target: priority issues fixed in source, tests updated, `devcheck` + `test` green, each issue commented with fix details, working tree dirty for review | parallel fanout (one sub-agent per target — hard constraint) | gate-free |
| 4 | Verify | Per target: full diff cold-reviewed; simplified if warranted; each fix re-exercised against the running server with actual tool output in the summary | parallel fanout | **barrier** — orchestrator loop decision (human/evidence-based: proceed, loop, or surface to user) |
| 5 | Loop decision | Orchestrator decision recorded — proceed to release, loop another field-test cycle, or pause/surface to user. Evidence-based | orchestrator (serial) | **barrier** — release authorization required before advancing |
| 6 | Wrap-up + release | (Optional) Per target: fixes split into per-file commits with a release commit on top; annotated tag; published per repo visibility; tag annotation is structured markdown with issue backlinks | parallel fanout (Bash git only) | gate-free |
| 7 | Issue cleanup | Every GH issue that shipped a fix closed with "Fixed in v\<version\>" comment; skipped issues remain open | orchestrator (serial) | — |

Phase 6 is optional — stop earlier if release isn't authorized. Phase 7 only runs if Phase 6 ran.

## Phase notes

### Phase 1: Field-test

**Default: one comprehensive sub-agent per target** that covers happy paths, error paths, and edge cases in sequence. Use three separate sub-agents only when the server has 8+ tools and a single agent would exhaust context.

| Category | What to test |
|:---|:---|
| Happy paths | Every tool/resource/prompt with realistic input — output shape, `content[]` readability, `structuredContent` parity, field selection |
| Error paths | Invalid inputs, missing fields, wrong types — error contract verification (code/reason), error text actionability |
| Edge cases | Boundaries, empty results, pagination limits, special characters, domain-specific oddities — crash resistance, 0-result messaging, date boundaries |

**Sub-agent isolation.** Each sub-agent gets a unique field-test ID in its helper file path: `/tmp/<project-name>-field-test-<ID>.sh`. Convention: `<SERVER-PREFIX>-<HP|ER|EC>-<5CHAR>`. The helper script is stateless — every function takes IDs as positional args.

**Build skip.** Pre-flight built the project. Tell sub-agents to modify their `mcp_start` helper to skip `bun run rebuild` — just start the server. This avoids concurrent builds racing on `dist/`. Each agent starts its own server instance; ports auto-increment.

**Issue filing.** Sub-agents file GH issues against the server's own repo using `report-issue-local` patterns. Constraints:
- **Noise filter** — before filing, the sub-agent asks: "Would a maintainer coming to this cold say 'yes, this needs fixing'?" If not, skip.
- **`gh issue create` with `--title` and `--body`** (not `--web`) — include server version, framework version, runtime, transport, repro steps, actual vs expected behavior
- **Do NOT file against `@cyanheads/mcp-ts-core`** unless the bug is clearly in the framework — file against the server's own repo
- **Redact secrets** — API keys, tokens, etc.

Sub-agent reads `skills/tool-defs-analysis/SKILL.md` as a primer — field-testing evaluates the agent-facing surface during live use, not just statically.

### Phase 2: Issue triage
Orchestrator verifies filed issues exist via `gh issue list -R <owner>/<repo>` per target. Reconciles sub-agent reports against actual GH state (sub-agents sometimes report filing but hit errors). Produces a per-target issue count and severity breakdown. If all sub-agents found 0 issues, skip to Phase 6 (or end the workflow if no release authorized).

### Phase 3: Fix
**One sub-agent per target — hard constraint.** No file-locking system exists for concurrent edits; multiple agents touching the same server's `src/` will conflict.

Each sub-agent:
1. Reads all open issues for its target via `gh issue list` + `gh issue view N --comments` (full thread — body alone misses clarifications)
2. **Validates each issue against source code** — a "fixed" issue is a misdiagnosed one if validation fails
3. Implements fixes in priority order: security → bugs → UX
4. Rebuilds after each fix or group of related fixes
5. Field-tests each fix live (starts server, runs repro steps from the issue)
6. Runs `bun run devcheck` and `bun run test` — exit gate
7. Comments on each GH issue with a concise fix summary
8. Leaves everything uncommitted

**Constraints to restate:**
- Surgical fixes only — don't refactor surrounding code unless the fix requires it
- If a fix is disproportionate (major architecture change), note it on the issue and skip
- Every fix verified live, not just compiled — include actual tool call output in the summary

### Phase 4: Verify
Fresh sub-agent per target, reads the full `git diff` cold. Two passes in one sub-agent:

1. **Code-simplify** — read `code-simplifier`, review the full diff through that lens, apply cleanup if warranted. Skip if changes are minimal — don't run as ceremony.
2. **Re-field-test** — spin up the server, run the repro steps from each fixed issue, include actual tool call output in the summary.

Exit gate: `bun run devcheck && bun run rebuild && bun run test`.

### Phase 5: Loop decision

| Signal | Action |
|:---|:---|
| All fixes validated, devcheck + tests green | Proceed to Phase 6 (or end if release not authorized) |
| Fix sub-agent reported skipped issues (disproportionate) | Note; proceed unless critical |
| Fix sub-agent couldn't reach green gates | Respawn fix sub-agent with specific failure context |
| Major architectural issues surfaced | Pause, surface to user |

The orchestrator makes this call based on evidence — don't defer when the data is clear.

If looping: respawn Phase 1 + Phase 3 for targets that had fixes applied; skip targets that passed clean. Diminishing returns after 2 cycles.

### Phase 6: Wrap-up + release (optional)
Each sub-agent reads both `skills/git-wrapup/SKILL.md` and `skills/release-and-publish/SKILL.md`.

**Commit structure.** Fixes are NOT collapsed into a single commit. Per the universal git rules:
1. Analyze the diff (`git diff --stat`, then spot-check actual changes)
2. Group by file boundaries — fixes sharing a file ship in the same commit
3. Commit each group: `fix(scope): description` (Conventional Commits)
4. Release commit on top — version bump + changelog + regenerated artifacts as `chore(release): v<version>`
5. Tag the release commit

The changelog carries the depth; the tag annotation covers every change at headline granularity — notable ones named, minor ones in one grouped bullet (per git-wrapup step 8). The commit split is about git history, not release notes.

**Version bump.** Default **patch** for field-test fix releases. **Minor** when enhancements are bundled in.

**Tag annotation format.** Tag subject omits the version number. Structured markdown:

```
Field-test bug fixes across N tools

Fixed:
- <tool_name>: <one-line fix description> (#<issue>)
- <tool_name>: <one-line fix description> (#<issue>)

<test count>; `bun run devcheck` clean.
```

Add a `Security:` section when the changelog frontmatter sets `security: true`.

**Wrap-up scope.** Determined by repo visibility:

| Status | Scope |
|:---|:---|
| Private / in-development | Version bump → changelog → commit → tag → mcpb bundle → push → `gh release create`. Skip `bun publish`, Docker, MCP Registry. |
| Public / launched | Full `release-and-publish`: push + `bun publish` + `publish-mcp` + bundle + GH release + Docker (if Dockerfile). |

### Phase 7: Issue cleanup
Close issues that shipped fixes — only those. Skipped issues stay open.

```bash
for n in <fixed-issue-numbers-from-phase-3>; do
  gh issue close "$n" -R "<owner>/<repo>" --reason completed --comment "Fixed in v<version>."
done
```

Collect specific issue numbers from Phase 3 sub-agent summaries — do not close all open issues indiscriminately.

## Workflow-specific gotchas

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | 3 sub-agents per server racing on `bun run rebuild` corrupts `dist/` | Pre-flight builds once; sub-agents skip rebuild in `mcp_start` |
| 2 | Tmp file collisions between concurrent field-test sub-agents | Unique IDs per agent in helper path: `/tmp/<project>-field-test-<ID>.sh` |
| 3 | Sub-agents file issues against `@cyanheads/mcp-ts-core` instead of the server | Restate explicitly in every Phase 1 prompt: "Do NOT file issues against mcp-ts-core" |
| 4 | Multiple fix sub-agents editing the same server's files | Hard constraint: 1 sub-agent per server in Phase 3 |
| 5 | Fix sub-agent can't live-verify due to API quota exhaustion | Accept fixes where the root cause is code-evident (wrong field path, missing guard); note that live verification was blocked by quota |
| 6 | Sub-agents file noise issues (nits, style preferences, bikeshedding) | Noise filter instruction in every Phase 1 prompt; sub-agents self-filter before filing |
| 7 | Field-test sub-agent reports success but didn't actually exercise the tool | Sub-agent must include actual tool call output in the summary; orchestrator spot-checks |
| 8 | Wrap-up sub-agent collapses multi-fix diff into a single commit | Phase 6 prompt enumerates the commit structure — group by file, release commit on top |
| 9 | Wrap-up sub-agent makes unplanned intermediate commits outside the planned structure | Prompt defines the exact commit shape; sub-agents must not invent extras |
| 10 | Loop decision deferred to user when orchestrator has enough data | Orchestrator decides on evidence |
| 11 | MCP Registry returns 502 transiently during publish | Retry up to 2x with backoff. First attempt may fail; second usually succeeds |
| 12 | Private repos need upstream set before first push | Agents should use `git push -u origin main` if upstream is unset |

## Checklist

- [ ] Pre-flight: working trees clean, API keys present, issue templates exist, all targets build clean
- [ ] Phase 1: field-test sub-agents launched with unique IDs, build-skip, orient blocks
- [ ] Phase 1: sub-agents tore down servers and cleaned tmp files before reporting
- [ ] Phase 2: issue counts verified against GH state
- [ ] Phase 3: 1 sub-agent per server (hard constraint), priority order followed, exit gate (devcheck + test) green
- [ ] Phase 3: GH issues commented with fix details
- [ ] Phase 4: verify pass — code-simplify (if applicable) + re-field-test, actual outputs in summary
- [ ] Phase 5: loop decision made on evidence
- [ ] Phase 6 (if releasing): version bumped, fix commits + release commit, annotated tag, scope matches private/public status
- [ ] Phase 7 (if releasing): fixed issues closed; skipped issues remain open
- [ ] Post-workflow verification: `git ls-remote --tags origin`, `npm view <pkg>@<version>` if public, GH release artifacts attached
- [ ] Tag/release quality review: tag subject omits version number, structured markdown, no marketing adjectives, issue backlinks present

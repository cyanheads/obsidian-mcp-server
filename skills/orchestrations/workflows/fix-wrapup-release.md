---
name: fix-wrapup-release
description: >
  Workflow for landing known work (handoff document findings, tracked GH issues, observed gaps) and shipping it: fix → optional simplify and field-test verification → wrap-up → release across one or more MCP server projects. Generalizes "I have known issues to fix and ship" regardless of how the issues were surfaced. Chains the `field-test`, `report-issue-local`, `code-simplifier`, `git-wrapup`, and `release-and-publish` skills. Read `../SKILL.md` first for the universal rules and sub-agent strategy.
metadata:
  author: cyanheads
  version: "1.0"
  audience: external
  type: workflow
---

# Fix + Wrap-up + Release Workflow

Use after reading `../SKILL.md`. Use this workflow when there's a clear list of known fixes to apply and ship — sourced from a handoff document, tracked GH issues, observed gaps you've already validated, or any combination.

## Trigger contexts

The input varies but the workflow is the same. Read the inputs into a common shape before kicking off:

| Source | Shape it as |
|:---|:---|
| Handoff document (numbered findings, repro steps, acceptance criteria) | Validate each finding live in Phase 1a; file each valid one as a GH issue via `report-issue-local`; skip invalidated findings |
| GH issues already filed | Use as-is. Read each with `gh issue view N --comments` to capture the full thread (the body alone misses clarifications and decision updates) |
| Observed gap or casual report ("I noticed this", "fix the description on tool X") | If material enough to ship in a release, file a GH issue first to capture rationale and create an audit trail. Trivial typo-fix-and-ship can skip the issue step. |

The validation/filing step is the difference between "input is a hypothesis" (handoff) and "input is verified" (tracked GH issues). The rest of the workflow is identical.

## When applicable

- One or more existing servers have known work to land — issues, handoff findings, or specific verified bugs
- The work is the deliverable; the workflow ends in a commit + tag and (optionally) a release
- N = 1 (single-server handoff) and N > 1 (multi-server fix batch) both apply

For unsourced QA — where the bugs are unknown until you test — use `field-test-fix.md` instead; that workflow includes the field-test discovery phase first.

## Tier 1 skills referenced

| Phase | Tier 1 skill(s) |
|:---|:---|
| Validate (handoff input only) | `skills/field-test/SKILL.md` + `skills/report-issue-local/SKILL.md` + `.github/ISSUE_TEMPLATE/` |
| Fix | (No single skill — sub-agent reads issues, validates, fixes) |
| Verify | `skills/field-test/SKILL.md` (live verification) + `skills/code-simplifier/SKILL.md` (optional) |
| Wrap-up | `skills/git-wrapup/SKILL.md` |
| Release | `skills/release-and-publish/SKILL.md` |

## Pre-flight

Per target:

1. **Identify issues** — collect GH issue numbers to fix, the handoff document, or the explicit gap description. Read each issue with `gh issue view N --comments` to capture the full thread.
2. **Clean working tree** — `git status --short` must be empty
3. **Current version** — `git describe --tags --abbrev=0`, `grep '"version"' package.json`
4. **Repo visibility** — `gh repo view --json visibility -q '.visibility'`. Determines wrap-up scope.
5. **Build** — `bun run rebuild` per target. All must pass before Phase 1.

## Phases

Each phase's Objective column is the goal state per target — the verifiable end state the phase must produce.

| # | Phase | Objective | Sub-agent mode | Gate after |
|:--|:---|:---|:---|:---|
| 1a | Validate (conditional) | Each handoff finding field-tested live; valid ones filed as GH issues; invalidated ones reported back with reason. If zero validate, workflow stops | one sub-agent per target | **barrier** — cross-target synthesis: orchestrator confirms validated findings before fix proceeds (or stops workflow if zero validate) |
| 1b | Fix | Per target: targeted issues fixed in source, tests updated/added, `devcheck` + `rebuild` + `test` green, each fixed issue commented with fix details, working tree dirty for review | parallel fanout (one sub-agent per target — hard constraint) | **barrier** — orchestrator reviews diffs before verify (explicit gate in checklist) |
| 2 | Verify | Per target: full diff cold-reviewed; simplified if warranted; each fix re-exercised against the running server with actual tool output in the summary | parallel fanout | **barrier** — orchestrator reviews simplified diff and verified outputs; release authorization required |
| 3 | Wrap-up + release | Per target: fixes split into per-file commits with a release commit on top; annotated tag; published per repo visibility; tag annotation is structured markdown with issue backlinks | parallel fanout (Bash git only) | gate-free |
| 4 | Issue cleanup | Every shipped issue closed (reason: completed) carrying exactly one what-landed comment that cites the version | orchestrator (serial) | — |

Phase 1a is conditional — only runs when the input is a handoff document or otherwise unvalidated. When the input is already tracked GH issues, skip directly to Phase 1b. The release portion of Phase 3 is conditional on user authorization to ship.

## Phase notes

### Phase 1a: Validate (handoff input)
One sub-agent per target. The sub-agent:
1. Field-tests each handoff claim against the running server (project-specific helpers per the `field-test` skill)
2. For validated findings, traces the relevant source to confirm shape of fix
3. Reads `.github/ISSUE_TEMPLATE/` first to understand the repo's issue conventions
4. Files one GH issue per validated finding using `report-issue-local` patterns
5. Reports back: validated (with GH issue links and one-line reason), invalidated (with why), and observations not in the original handoff

**Noise filter:** every filed issue must pass "Would a maintainer coming to this cold say 'yes, this needs fixing'?"

**Do not file against `@cyanheads/mcp-ts-core`** unless the bug is clearly in the framework — file against the server's own repo.

**Unique field-test ID** in helper file path: `/tmp/<project>-handoff-<5CHAR>.sh`.

If zero findings validate, report to the user and stop the workflow.

### Phase 1b: Fix
**One sub-agent per target — hard constraint** (no file-locking; concurrent edits to the same `src/` conflict).

Each sub-agent:
1. Reads all open issues for its target via `gh issue view N --comments` (full thread — body alone misses clarifications)
2. **Validates each issue against source code** — the issue's analysis or proposed approach may be wrong; sub-agent applies judgment about the right fix and notes any deviation in its GH comment
3. Prioritizes: security → crashes → bugs → enhancements → docs/chore
4. Implements fixes using the best modern approach (the GH issue is input, not a spec)
5. Updates or adds tests as needed
6. Exit gate: `bun run devcheck` + `bun run rebuild` + `bun run test` all pass before reporting completion
7. Comments on each fixed GH issue with a concise fix summary (cite file paths)
8. Leaves everything uncommitted

**Constraints to restate:**
- Surgical fixes only — don't refactor surrounding code unless the fix requires it
- If a fix is disproportionate (major architecture change), note it on the issue and skip
- The exit gate is non-negotiable — do not report completion if any of devcheck/rebuild/test is red

### Phase 2: Verify
Fresh sub-agent per target, reads the full `git diff` cold. Two passes:

1. **Code-simplify** — read `code-simplifier`, review the diff through that lens (over-engineering, unnecessary abstractions, redundant guards, style mismatches with surrounding code). Apply cleanup if warranted; skip if changes are minimal — don't run as ceremony.
2. **Re-field-test** — spin up the server, run the repro steps from each fixed issue, include actual tool call output in the summary. A fix that compiles but wasn't verified against a running server is not done.

Exit gate: `bun run devcheck && bun run rebuild && bun run test`.

### Phase 3: Wrap-up + release
Each sub-agent reads BOTH `skills/git-wrapup/SKILL.md` AND `skills/release-and-publish/SKILL.md`.

**Orchestrator responsibility:** before spawning Phase 3 sub-agents, collect all open GH issue numbers per target (`gh issue list -R <owner>/<repo> --state open --json number,title`) and include them in each sub-agent's prompt. Phase 3 sub-agents have no context from prior phases — they need the explicit issue list to know what to close.

**Commit structure.** Fixes are NOT collapsed into a single commit:
1. Analyze the diff — understand which fixes touch which files
2. Group by file boundaries — fixes sharing a file ship in the same commit
3. Commit each group: `fix(scope): description` (Conventional Commits)
4. Release commit on top: `chore(release): v<version>` — version bump + changelog + regenerated artifacts
5. Tag the release commit

The changelog carries the depth; the tag annotation covers every change at headline granularity — notable ones named, minor ones in one grouped bullet (per git-wrapup step 8). The commit split is about git history, not release notes.

**Version bump.** Default **patch** for bug-fix releases. **Minor** when enhancements are included.

**Wrap-up scope.** Determined by repo visibility:

| Status | Scope |
|:---|:---|
| Private / in-development | Version bump → changelog → commit → tag → mcpb bundle → push → `gh release create`. Skip `bun publish`, Docker, MCP Registry. |
| Public / launched | Full `release-and-publish`: push + `bun publish` + `publish-mcp` + bundle + GH release + Docker (if Dockerfile). |

**Tag annotations** are for end users — every changelog-worthy change stays visible in the tag, with minor/internal items (build config, repo hygiene, metadata) grouped into ONE compact bullet; only non-changelog churn (lockfile refreshes, lint fixes) stays in commit bodies alone.

### Phase 4: Issue cleanup
Close issues that shipped — only those. Skipped issues stay open.

Each issue gets exactly ONE substantive comment recording what landed — concrete changes, file paths, and the version — written either by the fix sub-agent (Phase 1b) or by the orchestrator here. Then close without an additional comment:

```bash
for n in <shipped-issue-numbers>; do
  gh issue close "$n" -R "<owner>/<repo>" --reason completed
done
```

If no what-landed comment exists yet, the version belongs in that one comment ("Shipped in v\<version\>: …"). Never stack a bare "Fixed in v\<version\>" trailer on top of an existing summary — it duplicates the record, and "fixed" misdescribes enhancements (enhancements ship/land; only bugs are fixed).

## Workflow-specific gotchas

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | Multiple fix sub-agents editing the same server's `src/` | Hard constraint: 1 sub-agent per server in Phase 1b |
| 2 | Fix sub-agent "fixed" an issue but the change is a band-aid | Orchestrator gate after Phase 1b reviews approach, not just "does it compile" |
| 3 | Fix sub-agent doesn't update tests for schema changes | Exit gate requires tests pass; sub-agent must update/add tests before finishing |
| 4 | Field-test in Phase 2 fails but sub-agent reports success | Sub-agent must include actual tool call output in summary; orchestrator spot-checks |
| 5 | Code-simplify removes intentional complexity | Orchestrator gate after Phase 2 reviews the full diff |
| 6 | Wrap-up sub-agent collapses multi-fix diff into one commit | Phase 3 prompt enumerates the commit structure |
| 7 | Wrap-up sub-agent makes unplanned intermediate commits outside the planned structure | Prompt defines exact commit shape; agents must not invent extras |
| 8 | Reading `gh issue view N` alone misses thread context where decisions were updated | Always include `--comments` |
| 9 | MCP Registry returns 502 transiently during publish | Retry up to 2x with backoff |
| 10 | Phase 1a sub-agent validates an issue that's actually a misunderstanding | Sub-agent must field-test, not just read the claim — live verification catches false positives |

## Checklist

- [ ] Pre-flight: issues identified per target (or handoff captured), working trees clean, builds pass
- [ ] Phase 1a (if handoff): findings validated live, GH issues filed for valid findings, invalidated reported back
- [ ] Phase 1b: fix sub-agents complete — fixes implemented, tests updated, GH issues commented, exit gate green
- [ ] Orchestrator gate after Phase 1b: diffs reviewed, devcheck + tests green
- [ ] Phase 2: verify sub-agents complete — code-simplify (if applicable), re-field-test with actual outputs in summary
- [ ] Orchestrator gate after Phase 2: simplified diff reviewed, field-test claims verified
- [ ] Phase 3: version bumped, fix commits + release commit, annotated tag per target — scope matches private/public status
- [ ] Phase 3: published per scope (push, npm if public, MCP Registry if applicable, GH release, Docker if applicable)
- [ ] Phase 4: shipped issues closed, one what-landed comment each; skipped issues remain open
- [ ] Post-workflow verification: `git ls-remote --tags origin`, `npm view <pkg>@<version>` if public, GH release artifacts attached
- [ ] Tag/release quality review: tag subject omits version number, structured markdown, no marketing adjectives, issue backlinks present

---
name: maintenance-release
description: >
  Workflow: run the `maintenance` skill against one or more existing MCP server projects (dependency updates, framework adoption, skill sync), verify adoption gaps in a double-check pass, then wrap up and release via `git-wrapup` and `release-and-publish`. Read `../SKILL.md` first for the universal rules and sub-agent strategy.
metadata:
  author: cyanheads
  version: "1.1"
  audience: external
  type: workflow
---

# Maintenance + Release Workflow

Use after reading `../SKILL.md`. Drives maintenance, adoption verification, wrap-up, and release across N existing MCP server projects.

## When applicable

- One or more existing servers built on `@cyanheads/mcp-ts-core` need updates from `bun outdated` landed and shipped
- N = 1 still benefits — fresh-context sub-agents per phase keep each focused and within context budget
- Each target should have a clean working tree before the workflow starts — uncommitted work blocks the `maintenance` skill's verification gate

**Scope boundary.** This workflow ships dependency, framework-adoption, and skill-sync upkeep — it does not consult, fix, or close issues in the tracker. Issue-driven work belongs to `fix-wrapup-release.md`. If a maintenance pass incidentally surfaces a genuine bug, file it (don't fix it here) and let a later `fix-wrapup-release` run address it.

## Tier 1 skills referenced

| Phase | Tier 1 skill(s) |
|:---|:---|
| Maintenance | `skills/maintenance/SKILL.md` |
| Double-check | `skills/polish-docs-meta/SKILL.md` (the cross-file consistency reference is the most commonly missed surface) |
| Wrap-up | `skills/git-wrapup/SKILL.md` |
| Release | `skills/release-and-publish/SKILL.md` |

## Pre-flight

Per target:

1. **Clean working tree** — `git status --short` must be empty. Halt if dirty; user fixes locally before re-invoking.
2. **Latest tag and version** — `git describe --tags --abbrev=0`, `grep '"version"' package.json`
3. **`list-skills` script presence** — `test -f scripts/list-skills.ts && grep -q '"list-skills"' package.json`. If missing, note it — the `maintenance` skill's Phase C will install it.
4. **`publish-mcp` script** — when `server.json` exists, check `grep -q '"publish-mcp"' package.json`. If missing, flag it — the maintenance sub-agent adds it.
5. **Publish destinations** — note which exist: `server.json` (MCP Registry), `manifest.json` (MCPB / GH Release), `Dockerfile` (GHCR). If `server.json` exists but `manifest.json` doesn't, flag — maintenance scaffolds it.
6. **`npm whoami`** — required if releasing publicly.
7. **Framework version delta** — `grep '"version"' node_modules/@cyanheads/mcp-ts-core/package.json` vs `npm view @cyanheads/mcp-ts-core version` to preview adoption scope.

## Phases

Each phase's Objective column is the goal state per target — the verifiable end state the phase must produce.

| # | Phase | Objective | Sub-agent mode | Gate after |
|:--|:---|:---|:---|:---|
| 1 | Maintenance | Per target: deps updated, framework adoption applied, project skills synced, `rebuild` + `devcheck` + `test` green, Step 8 numbered summary returned | parallel fanout | gate-free |
| 2 | Double-check | Adoption gaps from Phase 1 fixed; `manifest.json`/`server.json` content validated; audience compliance verified; `rebuild` + `devcheck` + `test` green | parallel fanout | **barrier** — cross-target synthesis: orchestrator roll-up + human decision on version-bump intent |
| 3 | Roll-up | Per-target headlines + cross-target patterns surfaced to user; version-bump intent confirmed (patch/minor/major) | orchestrator (serial) | **barrier** — release authorization required before wrap-up and publish |
| 4 | Wrap-up + release | Per target: version-bumped commit + annotated tag + push + publish per scope; tag annotation renders as structured markdown on GitHub Release | parallel fanout (Bash git only) | — |

Phase 4 combines wrap-up and release in one sub-agent because the work is sequential and shares context (version, changelog, tag annotation). The sub-agent reads both Tier 1 skills.

## Phase notes

### Phase 1: Maintenance
Each sub-agent runs `skills/maintenance/SKILL.md` Mode A — the full flow from `bun outdated` through verification.

**Prompt phrasing matters.** Generic "run the maintenance skill" prompts cause sub-agents to stop at changelog analysis without executing. Include explicit steps in the prompt body:
1. `bun outdated` — capture the list
2. `bun update --latest` — apply, capturing the `↑ package old → new` lines for Step 3
3. Invoke the `changelog` skill for each updated package (or read `node_modules/<pkg>/CHANGELOG.md` directly if the skill isn't synced yet)
4. If `@cyanheads/mcp-ts-core` updated, do the deeper framework review per the maintenance skill's Step 4
5. Run Step 5 skill/script sync — Phase A (package → project `skills/`), Phase B (project `skills/` → agent dirs), Phase C (package scripts + pristine references → project)
6. Adopt changes per Step 6 — framework changes are auto-adopt at every applicable site in this pass; third-party libs are cost/benefit
7. `bun run rebuild` → `bun run devcheck` → `bun run test`
8. Produce the Step 8 numbered summary

**Skill-version paradox.** If `node_modules/@cyanheads/mcp-ts-core/skills/maintenance/SKILL.md` version is newer than the synced project copy, feature-adoption rows added in the new version don't surface. Sub-agent prompt instructs: after Phase A sync completes, re-read the synced `maintenance` SKILL.md and continue from Step 5 with the new version.

**Skill audience compliance.** Only sync skills with `metadata.audience: external` into project `skills/`. Sub-agents miss this under context pressure — restate explicitly.

**Constraints to restate verbatim:**
- No commits, tags, pushes — leave working tree dirty for orchestrator review
- Read-only git allowed and expected — `git diff skills/` after Phase A surfaces adoption signal
- Halt and report verbatim if `bun run devcheck` can't be made green; `bun audit` failures from a transitive dep with no patch are note-not-halt
- Output the Step 8 numbered summary at the end — the orchestrator parses it

### Phase 2: Double-check
Independent maintenance sub-agents diverge on incidental choices and miss adoption sites under context pressure. The double-check pass catches gaps before wrap-up.

**Critical: these sub-agents audit AND fix, then re-verify.** Not analysis-only.

Audit categories (sub-agent prompt enumerates):

- **Adoption gaps** — features the updated skills say to do that weren't applied (error code semantic audit, missing scaffolding files like `manifest.json`/`.mcpbignore`, `publish-mcp` script)
- **Audience compliance** — only skills with `metadata.audience: external` belong in project `skills/`; agents sometimes sync `internal`-audience skills
- **Content accuracy** — `isRequired` flags in `server.json` match the upstream API's reality (does the API work without the key?); `manifest.json` `name` doesn't include the npm scope prefix; `user_config` entries have required `title` and `type` fields
- **Cross-target consistency** — if a feature shows up in 3 of 5 Phase 1 summaries, the other 2 likely missed it
- **Error code semantics** — `InvalidParams` only for malformed JSON-RPC params shape; `ValidationError` for domain validation; `NotFound` for missing entities
- **Description alignment** — `package.json`, `manifest.json`, `server.json` (≤100 char), README header, GH repo description should be consistent
- **README install badges** — Claude Desktop `.mcpb`, Cursor deeplink, VS Code deeplink — present when `manifest.json` exists

Exit gate: `bun run rebuild && bun run devcheck && bun run test` after fixes.

A lighter model (e.g. Sonnet-class) is appropriate here — verification + targeted fixes, not deep adoption work.

### Phase 3: Roll-up
The orchestrator collects Phase 1 + Phase 2 reports and produces:
1. **Per-target headlines** — short table: target → packages updated → mcp-ts-core delta → devcheck/test status → gaps fixed
2. **Cross-target patterns** — features adopted across multiple targets, breaking changes that hit a subset
3. **Open decisions** — per-target ambiguities; group by decision so the user can rule once across multiple targets when the choice is the same
4. **Outliers** — targets with unusually large diffs or where adoption couldn't complete cleanly

**Version bump intent.** Default is **patch** unless the change shape indicates otherwise:

| Bump | When |
|:---|:---|
| **patch** (default) | Dependency updates, framework adoption, doc polish, bug fixes — ~95% of maintenance runs |
| **minor** | New tools/resources/prompts added, new user-facing features, new env vars that change behavior |
| **major** | Breaking changes to the server's MCP surface (removed tools, renamed fields, changed semantics) |

If a target's diff suggests minor-or-above, **pause that target and surface to the user during roll-up** — unaffected targets proceed to Phase 4 at patch.

### Phase 4: Wrap-up + release
Each sub-agent reads BOTH `skills/git-wrapup/SKILL.md` AND `skills/release-and-publish/SKILL.md`. Runs wrap-up (version bump, changelog authoring, commit, annotated tag), then release (push, npm publish, MCP Registry, GH release, Docker).

**Framework changelog reading.** When `mcp-ts-core` was updated, the sub-agent must read the framework's changelog files for the version delta (e.g. `node_modules/@cyanheads/mcp-ts-core/changelog/0.9.x/0.9.2.md` through `0.9.6.md`) and distill user-facing changes relevant to this server into the changelog entry; the tag annotation carries at most a one-line framework mention with the version arrow. "Picks up upstream fixes" is not acceptable in the changelog — name what changed.

**Wrap-up scope.** Determined by repo visibility (`gh repo view --json visibility`):

| Status | Scope |
|:---|:---|
| Private / in-development | Version bump → changelog → commit → tag → mcpb bundle → push → `gh release create`. Skip `bun publish`, Docker, MCP Registry. |
| Public / launched | Full `release-and-publish`: push + `bun publish` + `publish-mcp` + bundle + GH release + Docker (if Dockerfile). |

**npm 2FA mode.** Parallel `bun publish` doesn't play nicely with interactive 2FA — OTP prompts from multiple sub-agents interleave. Either:
- Bypass token configured (granular access token with "Bypass 2FA for publish") → Phase 4 runs as parallel fanout
- No bypass → Phase 4 runs serially, orchestrator-driven, one target at a time
- No npm publish involved (private only) → non-issue

**Commit structure.** Group the work by concern, then land the release artifacts (version bumps + changelog + regenerated `docs/tree.md`/`server.json`/`manifest.json`) as a `chore(release): <version> — <theme>` commit on top — same model as `git-wrapup` Step 7. A single-concern pass (just dep updates, or one framework adoption) is one work commit plus the release commit; a pass spanning multiple distinct concerns splits into per-concern work commits with the release commit last. Regenerated meta-drift is release-artifact-shaped — it rides in the release commit, never carved out as its own.

**Tag annotations are for end users.** Every changelog-worthy change stays visible in the tag, with minor/internal items (build config, repo hygiene, metadata) grouped into ONE compact bullet; only non-changelog churn (lockfile refreshes, lint fixes) stays in commit bodies alone.

**Tag-moving protocol.** If post-version doc changes land after the version commit, move the tag to HEAD: delete remote release, delete remote + local tag, recreate tag at new HEAD with same annotation, re-push, recreate release with `.mcpb`. Authorized within the workflow — same-day forward move.

### Watchtower-style container refresh (if applicable)
For targets with hosted instances behind an auto-pull tool, trigger the refresh after GHCR images are verified reachable. This is operational, not part of the release-and-publish skill — handle in the orchestrator's post-Phase-4 step if the deployment infrastructure has it.

## Workflow-specific gotchas

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | Generic "run the maintenance skill" prompts cause ~50% of sub-agents to halt at changelog analysis without executing | Include explicit execution steps in Phase 1 prompt body; respawn with directive if Step 8 summary missing |
| 2 | Skill-version paradox — feature rows added in newer maintenance skill don't surface in the synced older copy | Sub-agent prompt: after Phase A sync, re-read synced `maintenance` SKILL.md and continue from Step 5 |
| 3 | Per-target adoption divergence is expected — projects on different starting framework versions adopt different things | Don't try to normalize. Surface divergence as informational in Phase 3 roll-up. |
| 4 | The `changelog` skill may not exist in a target's skill directory yet | Sub-agent falls back to direct `node_modules/<pkg>/CHANGELOG.md` reading |
| 5 | Sub-agent runs write git commands despite instruction | Restate the no-write-git list + no-`stash` rule in prompt body; verify via `git log --oneline -1` per target after Phase 1 — should show no new commits |
| 6 | Sub-agent syncs `internal`-audience skills into project `skills/` | Restate "Only sync skills with `metadata.audience: external`" — sub-agents miss this under context pressure |
| 7 | `manifest.json` scaffolded with scoped name from `package.json` (e.g. `@scope/server-name`) — renders in mcpb install dialog | Phase 2 verifies `manifest.json` `name` doesn't contain `/` |
| 8 | `manifest.json` `user_config` entries missing required `title`/`type` — `mcpb pack` fails at release time | Phase 2 verifies required fields |
| 9 | `server.json` `isRequired` doesn't match upstream API reality | Phase 2 verifies against actual API behavior |
| 10 | Framework version arrow in tag/changelog says nothing useful ("picks up upstream fixes") | Phase 4 prompt requires reading mcp-ts-core changelog files and distilling relevant changes |
| 11 | Tag annotations render as flat comma-separated strings or balloon into full CHANGELOG copies | Phase 4 prompt: structured markdown with sections (Fixed, Dependencies, etc.), dep arrows (`pkg ^old → ^new`), test footer; length is earned |
| 12 | Post-version doc changes land after the tag — release points at stale content | Tag-moving protocol; authorized within the workflow as a same-day forward move |
| 13 | Background sub-agent bails early on context | Orchestrator checks for Step 8 summary; respawns continuation sub-agent if missing |
| 14 | Big monorepo or many adoptions cause context exhaustion in a sub-agent | Narrow the prompt: if a target has many breaking framework changes, split the work into "update deps + verify" and "adopt features" against that target |

## Checklist

- [ ] Pre-flight: target list confirmed, clean working trees, `list-skills`/`publish-mcp`/`manifest.json` presence noted, framework version delta noted, npm 2FA mode confirmed if releasing publicly
- [ ] Phase 1: maintenance sub-agents complete — Step 8 summary present per target, devcheck + test green
- [ ] Phase 1 integrity: `git log --oneline -1` per target confirms no new commits written by sub-agents
- [ ] Phase 2: double-check sub-agents complete — adoption gaps fixed, audience compliance verified, `manifest.json` and `server.json` validated; devcheck + test green after fixes
- [ ] Phase 3: roll-up surfaced to user; version bump intent confirmed (patch default; minor/major surfaces if applicable)
- [ ] Phase 4: wrap-up + release sub-agents complete — commit + annotated tag + push + publish per target, scope matches private/public status
- [ ] Post-Phase-4 verification: `git ls-remote --tags origin` shows new tag; `npm view <pkg>@<version>` resolves (public); GH release artifacts attached; Docker image exists (if Dockerfile)
- [ ] Tag/release quality review: tag subject omits version number, structured markdown, no marketing adjectives, dep arrows present, issue backlinks where applicable

---
name: greenfield-build
description: >
  Workflow: scaffold one or more new MCP server projects from `bunx @cyanheads/mcp-ts-core init` through design → build → polish → first public release. Each phase invokes a foundational skill end-to-end; this file is the sequencing and gates, not the procedural detail. Read `../SKILL.md` first for the universal rules and sub-agent strategy.
metadata:
  author: cyanheads
  version: "1.4"
  audience: external
  type: workflow
---

# Greenfield Build Workflow

Use after reading `../SKILL.md`. Drives one or more freshly-scaffolded MCP servers from idea to first public release by sequencing foundational skills with gates and verification.

## When applicable

- One or more new servers from `bunx @cyanheads/mcp-ts-core init <name>` need to be driven through design → build → ship
- Each target is a freshly-scaffolded project with no implementation yet (echo definitions still present)
- N = 1 and N > 1 both apply — parallelism is the optimization; the phase structure is the value

## Pre-flight

1. **Target list** — absolute paths and intended GitHub owner/org per target
2. **`gh auth status`** — Phase 1 creates GH repos
3. **`npm whoami`** — required if Phase 18 publishes publicly
4. **API key inventory** per target — Phase 11 (field-test loop) skips targets without keys
5. **Gold-standard reference(s)** — repo(s) the `polish-docs-meta` phase anchors on for README/metadata style. Skip the phase if no anchor exists in the ecosystem.

## Versioning strategy

Everything stays at **v0.1.0** through the build. Intermediate commits don't bump versions. The launch version (typically v0.1.1) is set in Phase 17.

## Tier 1 skills referenced

| Phase | Tier 1 skill(s) |
|:---|:---|
| Scaffold (1) | `framework-skills/setup/SKILL.md` |
| Initial commit, design commit, build commit, pre-launch commit (2, 5, 10, 16) | `framework-skills/git-wrapup/SKILL.md` step 3 commit conventions only — see "Checkpoint commits" below |
| Design + validation (3, 4) | `framework-skills/design-mcp-server/SKILL.md` |
| Build (6) | `framework-skills/add-tool/SKILL.md`, `framework-skills/add-app-tool/SKILL.md`, `framework-skills/add-resource/SKILL.md`, `framework-skills/add-prompt/SKILL.md`, `framework-skills/add-service/SKILL.md` |
| Tool-def audit (7) | `framework-skills/tool-defs-analysis/SKILL.md` |
| Test coverage (8) | `framework-skills/add-test/SKILL.md` |
| Field-test loop (11) | → `workflows/field-test-fix.md` as a sub-loop (see Phase 11 note) |
| Simplify (12) | `framework-skills/code-simplifier/SKILL.md` |
| Polish docs/meta (13) | `framework-skills/polish-docs-meta/SKILL.md` |
| Security pass (14) | `framework-skills/security-pass/SKILL.md` |
| Final wrap-up (17) | `framework-skills/git-wrapup/SKILL.md` |
| Release (18) | `framework-skills/release-and-publish/SKILL.md` |

## Phases

Each phase's Objective column is the goal state per target — the verifiable end state the phase must produce. Phase notes only appear for orchestration overrides; phases without notes run the foundational skill end-to-end.

| # | Phase | Objective | Sub-agent mode | Gate after |
|:--|:---|:---|:---|:---|
| 1 | Scaffold + repo | `bunx init` scaffold complete; `--private` GH repo created; LICENSE in place; working tree dirty (no commit) | parallel fanout | gate-free |
| 2 | Initial commit | v0.1.0 commit + annotated tag + push to private GH repo | parallel fanout | gate-free |
| 3 | Design | `docs/design.md` authored with Decisions Log | parallel fanout | gate-free |
| 4 | Design validation | `docs/design.md` hardened by review pass; gate sub-agent returned PASS | two sub-agents per target | **barrier** — gate sub-agent must return PASS (or FAIL → fix loop) before build proceeds |
| 5 | Design commit | Design changes committed and pushed | parallel fanout | gate-free |
| 6 | Build | All designed tools/resources/prompts implemented; no echo definitions; `devcheck` + `test` green | parallel fanout | **barrier** — orchestrator inspects each target and spawns finish sub-agents for incomplete work (cross-target synthesis) |
| 7 | Tool-def audit | `tool-defs-analysis` findings reviewed and applied | parallel fanout | gate-free |
| 8 | Test coverage | Tests extended beyond happy path; `devcheck` + `test` green | parallel fanout | gate-free |
| 9 | Design ↔ implementation check | Every surface element in `docs/design.md` has a definition (or `docs/design.md` updated to reflect what shipped) | parallel fanout or orchestrator-direct | gate-free |
| 10 | Build commit | Build work committed and pushed | parallel fanout | gate-free |
| 11 | Field-test loop (optional) | Live API surface exercised; valid findings filed and fixed (or skipped with note) | conditional | gate-free |
| 12 | Simplify | `code-simplifier` applied; `devcheck` + `test` green — last source-code modification | parallel fanout | gate-free |
| 13 | Polish docs/meta | README, metadata, and agent protocol aligned to gold-standard reference | parallel fanout | gate-free |
| 14 | Security pass | `security-pass` findings addressed; no open security gaps | parallel fanout | gate-free |
| 15 | Final-state check | `rebuild` + `devcheck` + `test:all` + `lint:packaging` green; LICENSE present; no unfinished TODO/FIXME | orchestrator-direct | gate-free |
| 16 | Pre-launch commit | Final polish + security work committed and pushed | parallel fanout | **barrier** — human decision: version-bump intent (typically v0.1.1) |
| 17 | Final wrap-up | Launch version (typically v0.1.1) release commit on top of the stack — on `main`, or on a pushed `release/<version>` branch with the PR open in release PR mode; no tag | parallel fanout (Bash git only) | **barrier** — release authorization required before push and publish |
| 18 | Release | Repo public when the release is public; merged (release PR mode), tagged, pushed, and published per scope; tag annotation passes `bun run release:github -- --check`, so the GitHub Release renders a flat headline digest; artifacts reachable | parallel fanout or serial (per npm 2FA mode) | — |

Phase 11 is optional. Phase 12 is the last phase that modifies source code — everything after is docs/metadata/verification.

## Phase notes

Only phases with orchestration overrides or non-obvious instructions appear below. Other phases run their foundational skill end-to-end.

### Phase 1: Scaffold + repo
Sub-agent runs `bunx @cyanheads/mcp-ts-core init <name>`, follows the `setup` skill, then creates a **private** GitHub repo (`gh repo create --private`) and immediately runs `gh repo edit --enable-squash-merge=false --enable-rebase-merge=false` — release PRs land by local fast-forward, so the GitHub UI must not be able to squash or rewrite a stack. Override the `setup` skill's commit step — **do NOT commit**; Phase 2 is the commit. Copy `LICENSE` from `node_modules/@cyanheads/mcp-ts-core/LICENSE` if not already present.

### Phase 2: Initial commit
Sub-agent verifies `gh repo view --json visibility` returns `PRIVATE` (or has explicit user authorization for public) before push. Tag is `v0.1.0`.

A private repository without GitHub Advanced Security has no code scanning, so the scaffolded `.github/workflows/codeql.yml` fails on every push until the repo is public. Keep the file. GitHub registers the workflow on the first push, and that push already runs it. Right after this push, disable it with `gh workflow disable CodeQL` and cancel that run with `gh run cancel <id>` before it fails. Keep the cancelled run: deleting a workflow's only run unregisters the workflow, and the next push registers it again as active and runs it. It stays disabled through the private checkpoints; after each checkpoint push, confirm that `gh api repos/<owner>/<repo>/actions/workflows` still shows it `disabled_manually`. Phase 18 turns it back on.

### Checkpoint commits (Phases 2, 5, 10, 16)
Plain commits on `main`, pushed to the private repo. They follow `git-wrapup`'s step 3 conventions — grouped by concern, staged and committed by pathspec, one- or two-line bodies — and nothing else from that skill: no version bump, no changelog entry, no release branch or PR. Run end to end, `git-wrapup` bumps the version and, when the project declares a release PR mode, moves the work to `release/<version>` and opens a PR; that belongs to Phase 17 alone. Only Phase 2 tags (`v0.1.0`, annotated, `--cleanup=whitespace`).

### Phase 4: Design validation
Two sub-agents per target, sequential:

1. **Review** — fresh sub-agent re-runs `design-mcp-server` against the existing `docs/design.md` cold (no `docs/idea.md`, no prior context). Goal: spot what the original author justified away. Output: hardened `docs/design.md`.
2. **Gate** — sub-agent reads ONLY the hardened design and returns **PASS** or **FAIL**. PASS means "ready to build as-is." FAIL flags structural issues that would cause wasted build effort: missing tool the API clearly supports and users would expect; wrong endpoint or data model that would fail at runtime; contradictory constraints; missing error handling strategy for common failures. **Filter style preferences and marginal scope suggestions** — those are not gate failures.

If gate fails, spawn a focused fix sub-agent for that target, then re-gate.

### Phase 6: Build
Sub-agents will exhaust context on targets with 4+ tools — work persists to disk but the sub-agent can't continue. Plan a follow-up "finish" iteration as a normal backstop, not a fallback for failure. After Phase 6 lands, the orchestrator inspects each target (`bun run devcheck`, `bun run test`, `ls src/mcp-server/tools/definitions/`) and spawns a narrow-scope finish sub-agent per incomplete target with a concrete punch list: "X TS errors here, tools A/B/C missing tests, echo definitions still present in `<file>`." Narrow scope is the antidote to context exhaustion.

### Phase 9: Design ↔ implementation check
For each tool / resource / prompt named in `docs/design.md`, verify a definition file exists in `src/mcp-server/{tools,resources,prompts}/definitions/`. For missing surface, decide: implement it (spawn a narrow-scope sub-agent), drop it from the design (update `docs/design.md`), or defer to a follow-up (record in the Decisions Log). This is orchestration glue — small enough that the orchestrator can run it directly for N ≤ 3, fan out for larger N.

### Phase 11: Field-test loop (optional)
When the upstream API supports live testing and an API key is available, run Phases 1–5 of `field-test-fix.md` as a sub-loop here (field-test → triage → fix → verify → loop decision). Skip its Phase 6 wrap-up + release: the fixes stay in the working tree and land in the next checkpoint commit. Its Phase 7 issue cleanup runs after the Phase 18 launch, since nothing else closes the issues the loop filed. Skip with a note if blocked.

### Phase 12: Simplify
Last phase that modifies source code. Everything after is docs/metadata/verification.

### Phase 15: Final-state check
Orchestrator-direct mechanical verification per target: `bun run rebuild`, `bun run devcheck`, `bun run test:all` (or `test`), `bun run lint:packaging`. `LICENSE` present. No `TODO`/`FIXME` indicating unfinished work. `CHANGELOG.md` current. `docs/tree.md` reflects current structure. Fix anything red before Phase 16; this is verification, not a sub-agent task.

### Phase 17: Final wrap-up
Version bump intent is typically **patch** — v0.1.0 was the scaffold tag; the launch is the first real release at v0.1.1. Runs `git-wrapup` end to end, Bash git only. In release PR mode it pushes `release/<version>` and opens the PR; otherwise nothing is pushed. No tag — Phase 18 merges, tags, pushes `main`, and publishes.

### Phase 18: Release
`release-and-publish` never changes repo visibility. When the release is public, the orchestrator makes the repo public before the release runs: scan the full git history (not just tracked files) for secrets and private content, since every commit goes public, then `gh repo edit <owner>/<repo> --visibility public --accept-visibility-change-consequences`. Publishing from a still-private repo leaves the npm repository link, the GitHub Release, and the `.mcpb` download URL unreachable. Right after the flip, run `gh workflow enable CodeQL`. Enabling it starts no scan: the template has no `workflow_dispatch`, and in release PR mode the PR opened in Phase 17, while the workflow was still disabled. Close and reopen the PR (`gh pr close <N> && gh pr reopen <N>`) — the `reopened` event is a `pull_request` event, and it runs the first scan. Without a release PR, the push to `main` runs it. Wait on that check, then read the PR's open alerts with `gh api 'repos/<owner>/<repo>/code-scanning/alerts?ref=refs/pull/<N>/merge&state=open'`. The Analyze job passes even when alerts are open, so the check conclusion alone proves nothing. Land a real finding as a commit on the release branch before merging.

## Workflow-specific gotchas

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | `gh repo create` defaults to public if `--private` is omitted | Phase 1 prompt restates the rule; Phase 2 sub-agent re-verifies `gh repo view --json visibility` before push |
| 2 | Build sub-agents exhaust context on targets with 4+ tools | Expected — plan a finish iteration with a concrete punch list, narrow scope |
| 3 | Design gate sub-agents flag style preferences as failures | Gate prompt: "Do NOT flag style preferences or marginal scope suggestions — only structural issues that would cause wasted build effort" |
| 4 | Sub-agent commits during Phase 1 despite the orchestration override | Phase 1 prompt restates: "Do NOT commit — leave working tree dirty for Phase 2" verbatim |
| 5 | A checkpoint commit routed through `git-wrapup` end to end bumps the version mid-build, or opens a release PR in release PR mode | Checkpoint commits use `git-wrapup`'s commit conventions only (see "Checkpoint commits"); the full skill runs once, in Phase 17 |
| 6 | The scaffolded CodeQL workflow fails on every push while the repo is private (no code scanning there) | Disable it after the Phase 2 push. After the Phase 18 visibility flip, re-enable it, then close and reopen the release PR, whose `opened` event fired while the workflow was off (see Phases 2 and 18) |

## Checklist

- [ ] Pre-flight: targets confirmed, `gh` + `npm` auth verified, gold-standard reference(s) named, API key inventory complete
- [ ] Phase 1: scaffold + setup run, private repo created, LICENSE present, working tree dirty (no commits)
- [ ] Phase 2: v0.1.0 commit + annotated tag + push verified per target; CodeQL workflow disabled while the repo is private
- [ ] Phase 3: `docs/design.md` authored per target with Decisions Log
- [ ] Phase 4: design hardened by review pass; gate returns PASS per target
- [ ] Phase 5: design committed per target
- [ ] Phase 6: build complete — all designed surface implemented, green devcheck + test
- [ ] Phase 7: `tool-defs-analysis` audit + fixes applied
- [ ] Phase 8: dedicated test coverage pass — beyond happy path
- [ ] Phase 9: every designed surface element has a definition (or `docs/design.md` updated to reflect what shipped)
- [ ] Phase 10: build committed per target
- [ ] Phase 11 (optional): field-test loop completed or skipped with note
- [ ] Phase 12: code-simplifier — final source-code cleanup, green devcheck + test
- [ ] Phase 13: polish-docs-meta against named gold-standard
- [ ] Phase 14: security-pass complete, findings addressed
- [ ] Phase 15: final-state check — rebuild + devcheck + test:all + lint:packaging green; LICENSE; no TODO/FIXME
- [ ] Phase 16: pre-launch commit per target
- [ ] Phase 17: final wrap-up — version bumped, changelog authored, release commit per target (release PR open in release PR mode); no tag
- [ ] Phase 18: release — repo public first when the release is public (full-history scan clean), CodeQL re-enabled, the release PR closed and reopened so its first scan runs, and its code-scanning alerts read, published per scope, artifacts verified reachable; field-test issues closed with the version that fixed them

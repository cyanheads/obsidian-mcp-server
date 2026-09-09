---
name: greenfield-build
description: >
  Workflow: scaffold one or more new MCP server projects from `bunx @cyanheads/mcp-ts-core init` through design → build → polish → first public release. Each phase invokes a foundational skill end-to-end; this file is the sequencing and gates, not the procedural detail. Read `../SKILL.md` first for the universal rules and sub-agent strategy.
metadata:
  author: cyanheads
  version: "1.1"
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
| Scaffold (1) | `skills/setup/SKILL.md` |
| Initial commit, design commit, build commit, pre-launch commit (2, 5, 10, 16) | `skills/git-wrapup/SKILL.md` (commit + tag, no push) |
| Design + validation (3, 4) | `skills/design-mcp-server/SKILL.md` |
| Build (6) | `skills/add-tool/SKILL.md`, `skills/add-app-tool/SKILL.md`, `skills/add-resource/SKILL.md`, `skills/add-prompt/SKILL.md`, `skills/add-service/SKILL.md` |
| Tool-def audit (7) | `skills/tool-defs-analysis/SKILL.md` |
| Test coverage (8) | `skills/add-test/SKILL.md` |
| Field-test loop (11) | → `workflows/field-test-fix.md` as a sub-loop (see Phase 11 note) |
| Simplify (12) | `skills/code-simplifier/SKILL.md` |
| Polish docs/meta (13) | `skills/polish-docs-meta/SKILL.md` |
| Security pass (14) | `skills/security-pass/SKILL.md` |
| Final wrap-up (17) | `skills/git-wrapup/SKILL.md` |
| Release (18) | `skills/release-and-publish/SKILL.md` |

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
| 17 | Final wrap-up | Launch version (typically v0.1.1) commit + annotated tag in place; **not pushed** | parallel fanout (Bash git only) | **barrier** — release authorization required before push and publish |
| 18 | Release | Pushed and published per scope; tag annotation renders as structured markdown on GitHub Release; artifacts reachable | parallel fanout or serial (per npm 2FA mode) | — |

Phase 11 is optional. Phase 12 is the last phase that modifies source code — everything after is docs/metadata/verification.

## Phase notes

Only phases with orchestration overrides or non-obvious instructions appear below. Other phases run their foundational skill end-to-end.

### Phase 1: Scaffold + repo
Sub-agent runs `bunx @cyanheads/mcp-ts-core init <name>`, follows the `setup` skill, then creates a **private** GitHub repo (`gh repo create --private`) and immediately runs `gh repo edit --enable-squash-merge=false --enable-rebase-merge=false` — release PRs land by local fast-forward, so the GitHub UI must not be able to squash or rewrite a stack. Override the `setup` skill's commit step — **do NOT commit**; Phase 2 is the commit. Copy `LICENSE` from `node_modules/@cyanheads/mcp-ts-core/LICENSE` if not already present.

### Phase 2: Initial commit
Sub-agent verifies `gh repo view --json visibility` returns `PRIVATE` (or has explicit user authorization for public) before push. Tag is `v0.1.0`.

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
When the upstream API supports live testing and an API key is available, run the phases of `field-test-fix.md` as a sub-loop here, ending at its field-test commit. Skip with a note if blocked.

### Phase 12: Simplify
Last phase that modifies source code. Everything after is docs/metadata/verification.

### Phase 15: Final-state check
Orchestrator-direct mechanical verification per target: `bun run rebuild`, `bun run devcheck`, `bun run test:all` (or `test`), `bun run lint:packaging`. `LICENSE` present. No `TODO`/`FIXME` indicating unfinished work. `CHANGELOG.md` current. `docs/tree.md` reflects current structure. Fix anything red before Phase 16; this is verification, not a sub-agent task.

### Phase 17: Final wrap-up
Version bump intent is typically **patch** — v0.1.0 was the scaffold tag; the launch is the first real release at v0.1.1. Bash git only; **do not push** — Phase 18 owns the push.

## Workflow-specific gotchas

| # | Gotcha | Mitigation |
|:--|:-------|:-----------|
| 1 | `gh repo create` defaults to public if `--private` is omitted | Phase 1 prompt restates the rule; Phase 2 sub-agent re-verifies `gh repo view --json visibility` before push |
| 2 | Build sub-agents exhaust context on targets with 4+ tools | Expected — plan a finish iteration with a concrete punch list, narrow scope |
| 3 | Design gate sub-agents flag style preferences as failures | Gate prompt: "Do NOT flag style preferences or marginal scope suggestions — only structural issues that would cause wasted build effort" |
| 4 | Sub-agent commits during Phase 1 despite the orchestration override | Phase 1 prompt restates: "Do NOT commit — leave working tree dirty for Phase 2" verbatim |

## Checklist

- [ ] Pre-flight: targets confirmed, `gh` + `npm` auth verified, gold-standard reference(s) named, API key inventory complete
- [ ] Phase 1: scaffold + setup run, private repo created, LICENSE present, working tree dirty (no commits)
- [ ] Phase 2: v0.1.0 commit + annotated tag + push verified per target
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
- [ ] Phase 17: final wrap-up — version bumped, changelog authored, commit + annotated tag per target
- [ ] Phase 18: release — published per scope, artifacts verified reachable

---
name: orchestrations
description: >
  Pick and run a multi-phase workflow that chains foundational task skills (`git-wrapup`, `release-and-publish`, `maintenance`, `field-test`, `setup`, etc.) end-to-end. Routes user intent to a workflow file under `workflows/` — greenfield builds, maintenance + release, field-test + fix, or known-work + release. Single source for the universal rules (no commits without authorization, no destructive git, no marketing language), the orchestrator posture (own the goal, ground sub-agents in primary sources, verify against the goal), and the sub-agent strategy (orient block, parallel fanout, isolation, normalization) that apply across every workflow. Sub-agents are an optional capability — workflows run linearly when fanout isn't available.
metadata:
  author: cyanheads
  version: "1.4"
  audience: external
  type: workflow
---

## When to Use

Multi-phase work that chains several foundational skills against one or more MCP server projects. Typical triggers:

- "Build N new servers" / "scaffold and ship X, Y, Z" → `workflows/greenfield-build.md`
- "Update and release these servers" / "run maintenance and ship" → `workflows/maintenance-release.md`
- "QA / field-test / find-and-fix bugs in these servers" → `workflows/field-test-fix.md`
- "Fix these issues and ship" / handoff document with findings to act on → `workflows/fix-wrapup-release.md`

Single-skill work — running just `maintenance`, just `git-wrapup`, just `release-and-publish` — invokes the foundational skill directly. Use this orchestrations skill when at least two phases need to chain.

## Mental Model — Three Tiers

| Tier | Layer | Examples | Who reads it |
|:---|:---|:---|:---|
| **1** | Foundational task skills | `git-wrapup`, `release-and-publish`, `maintenance`, `field-test`, `setup`, `design-mcp-server`, `polish-docs-meta`, `code-simplifier`, `add-tool`, `add-resource`, `add-service`, `add-test`, etc. | Orchestrator AND sub-agents (by direct path reference) |
| **2** | Orchestration workflows | The four files under `workflows/` | Orchestrator only |
| **3** | Router | This `SKILL.md` | Orchestrator only |

Workflows in Tier 2 sequence Tier 1 skills with gates and verification. They never duplicate Tier 1 content — they direct to it. A workflow file says "Phase N: agent reads and runs `skills/git-wrapup/SKILL.md`," not "here's how to wrap up a release."

The orchestrator is the agent driving the workflow — the one reading this SKILL.md. Sub-agents the orchestrator spawns receive prompts pointing at Tier 1 skills directly; they do not receive this skill or the workflow file. That boundary prevents recursive sub-agent spawning.

## Pick a Workflow

Identify the workflow from user intent first, then sanity-check against project state if intent is ambiguous.

| User intent / state signal | Workflow |
|:---|:---|
| New scaffold(s) from `bunx @cyanheads/mcp-ts-core init`, no implementation yet (echo definitions still present, no released changelog) | `workflows/greenfield-build.md` |
| Existing server(s), `bun outdated` shows updates, want to land them and ship | `workflows/maintenance-release.md` |
| Existing server(s), want to find bugs via live testing and fix them, optionally ship | `workflows/field-test-fix.md` |
| Existing server(s) with known issues (GH issues, handoff document, observed gap), want to fix and ship | `workflows/fix-wrapup-release.md` |

If intent is ambiguous (no clear signal), surface the candidate workflows to the user and confirm. Don't pick silently.

A workflow file is the orchestrator's playbook for one run. Read it end-to-end before kicking off the first phase.

## Universal Rules

These apply to every workflow. Workflow files don't restate them; the orchestrator carries them forward and restates them in sub-agent prompts where applicable.

1. **No commits, pushes, tags, branch creation, or destructive ops without explicit user authorization.** Work phases leave the working tree dirty for orchestrator review. Wrap-up and release phases run only after the user authorizes — though once authorized, the authorization is durable through the workflow's end (no re-asking at each phase boundary).
2. **No `git stash`, no `git reset --hard`, no `git restore .`, no `git clean -f`, no `git checkout -- .`.** These bypass safety and risk silent data loss. Read-only git (`status`, `diff`, `log`, `show`, `blame`) is always safe.
3. **No `--no-verify`, no `--no-gpg-sign`, no bypassing commit hooks.** If a hook fails, investigate the underlying issue.
4. **`bun run devcheck` is the handoff gate between phases.** Work phases must hand back a green devcheck. If a phase can't reach green, halt and report the failing step verbatim rather than carrying broken state forward.
5. **No marketing adjectives** in commits, tags, READMEs, or changelog entries — no "comprehensive", "robust", "enhanced", "seamless", "improved". State the change, not its quality.
6. **One workflow per orchestration run.** Don't interleave two workflows in the same session. If a target needs both (e.g., maintenance surfaces a bug fix that needs field-testing first), sequence them as two workflow runs with a clean handoff in between.
7. **`gh release create --notes-from-tag` is incompatible with `--repo`.** Always `cd` into the target repo directory for `gh release` commands.
8. **Annotated tags only** (`git tag -a`), never lightweight. Tag annotation subject omits the version number — GitHub prepends `v<VERSION>:` to release titles when using `--notes-from-tag`, so including the version in the subject creates stutter.
9. **Conventional Commits subjects** (`feat|fix|refactor|chore|docs|test|build(scope): message`). One logical concern per commit. The release commit (version bump + changelog + regenerated artifacts) lands on top of a stack of feature/fix commits, never collapsed alongside them.
10. **Email on any artifact is the user's domain email**, never a personal address that might appear in git config.

## Orchestrator Posture

The orchestrator owns the goals. Workflow phases are not "run skill X" — they are "achieve goal Y, using skill X as the path." Sub-agents (when used) are instruments for hitting the goals, not the work itself. The same posture applies in linear mode — the orchestrator runs the phase directly, but the goal is still the contract.

Before running a phase (or spawning a sub-agent for it), write down four things:

1. **Goal** — the verifiable end state this phase must produce. Concrete and testable: "v0.5.2 tag exists at HEAD with structured-markdown annotation; `bun run devcheck` green; `npm view <pkg>@0.5.2` resolves." Not fuzzy: "ran the release-and-publish skill."
2. **Primary sources** — the specific files, GH issues, and reference docs the sub-agent must read directly. Inlining content into the prompt is a paraphrase that loses nuance; agents grounded in the source catch details the orchestrator's summary missed. For GH issues, instruct both `gh issue view N --comments` (the comment thread) and the timeline cross-reference query in the Orient block (what references the issue, including cross-repo) — the body alone misses both. The orchestrator reads these sources too (to construct the prompt), but that's prompt construction, not a substitute for the sub-agent reading them.
3. **Path** — the Tier 1 skill(s) and steps that get to the goal. This is what gets handed to the sub-agent.
4. **Verification** — the read-only checks that confirm the goal was hit. Defined upfront, not as an afterthought.

Why the framing matters:

- **Verification follows from goal definition.** If the goal is concrete, the verification is obvious — check that exact state. If the goal is fuzzy, verification degrades to "did the sub-agent say it worked?"
- **Sub-agent self-reports describe intent, not always reality.** A goal you wrote down beforehand is the falsification target — the sub-agent's report is a hypothesis to verify against it.
- **Replanning is local.** When verification fails, the goal is unchanged; the orchestrator picks a different path (re-spawn with the failure context, re-slice the work, intervene directly). Phase rework doesn't cascade.

**Inform without inlining.** An enhanced sub-agent prompt names the specific primary sources and the goal — it does NOT paraphrase them. "Review GH issue #123 (read it via `gh issue view 123 --comments`); the goal is X; verify with Y" is the right shape. Pasting the issue body into the prompt forces the sub-agent to work from a paraphrase. Let the sub-agent read the source and explore for additional context as needed.

## Sub-Agent Strategy (if available)

Sub-agents are optional. Match the mechanism to your platform's capability — three tiers, in increasing order:

1. **No fanout** — run phases linearly. The phase structure is the value; parallelism is the optimization.
2. **Parallel sub-agents** — compose N prompts, launch concurrently, collect, verify (the pattern below). Single-target workflows usually run linearly anyway; multi-target workflows get one sub-agent per target.
3. **Programmatic orchestration** — if your platform offers deterministic multi-agent control flow, use its primitives: schema-validated sub-agent returns, automatic concurrency management, resumable/journaled runs, and barrier-free pipelining across phases.

Phases, gates, goals, and constraints are identical across all three tiers — only the fanout mechanism changes. Use the most capable tier available, and don't hand-roll what the platform does natively (e.g., rolling concurrency). Choose by scope and capability, not by default.

**Model tier ≠ orchestration tier.** A higher orchestration tier is not automatically the right choice. On some platforms, programmatically-orchestrated or *nested* sub-agents (an agent spawning agents) silently run on a cheaper/downgraded model, while the strongest model is reachable only by sub-agents the **main loop spawns directly** (tier 2). When a phase needs the top model (heavy generation, design, framework adoption), prefer direct main-loop fanout even when a more "capable" orchestration primitive exists — the primitive can cost you the model. Verify the model your platform actually assigned via its UI/telemetry; never infer it from a sub-agent's transcript, which interleaves auxiliary calls (titles, summaries) on cheaper models and will mislead you.

The decision tree below is orthogonal to tier — it governs *whether* a given phase fans out, by target count and conflict risk:

| Situation | Strategy |
|:---|:---|
| Single target, small change | Linear, orchestrator runs the phases itself |
| Single target, large change likely to exhaust orchestrator context | Sub-agent per phase; orchestrator gates between phases |
| N > 1 targets, independent work per target | One sub-agent per target per phase (parallel fanout) |
| N > 1 targets, work that conflicts across targets (e.g., all editing the same file) | Linear or serial — the parallel model assumes target independence |
| Sub-agents not available | Linear, regardless of N — same phases, just sequential |

### Orient block

Every sub-agent prompt opens with this block. Sub-agents do not inherit the orchestrator's `CLAUDE.md`/`AGENTS.md` chain or skill registry — both must be reconstructed in the prompt. Substitute the bracketed values per target.

```text
You are working on `[project name]` at `[project absolute path]`.

Orient first. These steps are required before any task work — do them in
order. If any file does not exist, note it and continue.

1. Read the global agent protocol at `~/.claude/CLAUDE.md` (or your agent's equivalent — `~/.codex/AGENTS.md`, etc.).
2. Read the workspace-level protocol if one exists at `[workspace agent protocol path]`
   — skip this step if no workspace-tier protocol applies.
3. Read the project protocol at `[project absolute path]/CLAUDE.md` (or `AGENTS.md`, whichever the project keeps).
4. Run `cd [project absolute path] && bun run list-skills` to see the project's
   available skills with descriptions and locations.
5. Read the skill file(s) for this task: `[Tier 1 skill paths]`.
6. Read the primary sources for this task directly — design docs (`docs/design.md`),
   GH issues, handoff documents, reference/gold-standard files. For a GH issue, read
   both the comment thread and its cross-references — the body alone misses both:
     - `gh issue view <N> --comments` — description + comment thread
     - `gh api 'repos/{owner}/{repo}/issues/<N>/timeline' --paginate --jq '.[] | select(.event=="cross-referenced") | .source.issue | "\(.repository.full_name)#\(.number) — \(.title)"'` — issues/PRs that reference this one, including from other repos
   List each source explicitly: `[primary source paths and gh commands]`. Skip this
   step only if no primary source applies (rare).

Only after that, begin the task below.

**Goal:** [the verifiable end state this phase must produce — concrete, testable]
**Path:** [Tier 1 skill(s) and steps the sub-agent should follow]
**Constraints:** [no-go list — restate git/commit rules and other invariants verbatim]
**Expected outputs:** [report shape you want back — e.g., "Step 8 numbered summary", "list of files touched with one-line rationale per fix"]
```

The sub-agent reads the primary sources directly during orient (step 6) — do not paste their contents into the prompt. The orchestrator names them; the sub-agent reads them.

### Isolation rules

1. **Bash `git` in each sub-agent's own CWD.** Parallel sub-agents run git through the shell against their own working directory — independent, no shared state across agents.

2. **Sub-agents do not receive this orchestrations skill or workflow files.** Their prompts include Tier 1 skill paths only. This prevents recursive sub-agent spawning — if a sub-agent decides it needs to fan out work, that's a signal the orchestrator sliced the work too wide. Re-slice; don't let the sub-agent recurse.

3. **Sub-agent prompts must restate the no-git-write and no-`stash` rules verbatim.** The orchestrator's `CLAUDE.md`/`AGENTS.md` rules aren't visible to sub-agents at prompt time.

4. **Narrow scope per fanout.** A sub-agent doing "implement everything, write tests, run devcheck, polish, commit, tag" will exhaust its context window before finishing — the work lands on disk but the agent can't continue. Split phases so each sub-agent finishes well under the context limit. Plan a follow-up "finish" phase as a normal backstop, not a fallback for failure.

### Parallel fanout pattern

For N targets in a phase:

1. Compose N sub-agent prompts (one per target) with the orient block + task body + workflow's phase-specific constraints
2. Launch them as parallel sub-agents in a single orchestrator action
3. Collect their reports
4. Verify with a read-only orchestrator check before advancing to the next phase

**Barriers only where gates sit.** Step 4's "advance to the next phase" implies a barrier — collect every target's phase-N result before any target starts phase N+1. That barrier is only required when a gate sits between the phases: a human decision (authorization, version-bump intent) or cross-target synthesis (the roll-up). Where no gate intervenes, a target may flow through consecutive phases independently — tier-3 platforms pipeline this for wall-clock, and even hand-spawned runs can let one sub-agent carry a target across adjacent gate-free phases. Keep the barrier at gate boundaries; drop it elsewhere. Each workflow's phases table encodes this directly: the `Gate after` column marks every boundary as `barrier` (with a terse reason) or `gate-free` so the spawn/round structure is derivable without re-derivation.

### Editor / wrap-up separation

Editing phases and wrap-up phases never go in the same sub-agent. Editing sub-agents make file changes and run devcheck — they do not commit, tag, or push. Wrap-up sub-agents read the working tree, commit, tag, and (when releasing) push and publish — they do not edit source. This separation lets the orchestrator review diffs before they become permanent and keeps the commit graph clean.

### Normalization

Independent sub-agents diverge on incidental choices — scoped vs. unscoped package names, script invocation form, README hero structure, badge ordering. When choices should be uniform across targets, plan an explicit normalization step after the fanout — don't expect alignment for free.

For small N or small diffs, the orchestrator normalizes directly. For large N or non-trivial fixes, spawn a narrow-scope fanout with an explicit rule list.

### Rolling concurrency

If your platform manages sub-agent concurrency automatically (tier 3), rely on it rather than hand-rolling the below. Otherwise: rate limits on parallel sub-agent spawning are intermittent — sometimes 15 concurrent agents work fine, sometimes 3 get throttled. Don't hard-cap; use rolling concurrency. Launch an initial batch, then as each agent completes, kick off the next in line. If a wave gets rate-limited, shrink the window for the next wave.

### Cross-project naming hygiene

When N targets share a phase, never name other targets in a sub-agent's prompt — even as examples. Sub-agents pattern-match on everything in their prompt, and cross-project names leak into commits, messages, and variable names. Each sub-agent's prompt references its own target only.

## Verification (orchestrator)

Verification runs against the goal *you* defined for the phase — not against the sub-agent's self-report. A sub-agent that reports "done" without producing the goal state is not done. The artifact checks below are the *means* of confirming the goal; pick the ones that exercise your specific goal definition.

Sub-agent self-reports describe intent, not always reality. After every phase that touched the filesystem or remote services, run a read-only check against the goal:

- **Files** — `ls`, `git status`, `git diff --stat`
- **Commits** — `git log --oneline -5`
- **Tags** — `git tag --points-at HEAD`, `git ls-remote --tags origin`
- **GitHub** — `gh repo view --json visibility`, `gh release view v<VERSION>`, `gh issue list`, `gh issue view <N> --comments` to confirm the fix comment landed
- **npm / registries** — `npm view <pkg>@<version>`, registry-specific checks
- **Build state** — re-run `bun run devcheck` if the previous phase was supposed to land green
- **Quality** — tag annotation reads as structured markdown (not flat string), subject omits the version number, no marketing adjectives, dep arrows present where applicable, issue backlinks where applicable

If verification disagrees with the sub-agent's report, that's the signal to re-spawn with the actual state and the unmet goal in the prompt — not to trust the report. The goal hasn't changed; only the path needs to.

## Authorization Flow

| Phase type | Authorization required |
|:---|:---|
| Reads, analysis, file edits (working tree only) | Implicit — initial workflow approval covers these |
| Local commits, annotated tags | Explicit at workflow start; durable through workflow end |
| Push to remote, npm / registry publish, GH release create, Docker push | Explicit at workflow start; durable through workflow end |
| Destructive ops (force push, tag delete, remote branch delete, etc.) | Always re-confirm, never assume |

Pipeline authorization is durable through to completion. Once the user authorizes a workflow run, don't re-ask at each phase boundary — proceed automatically through gates that pass. Conditions that always require a fresh check-in: destructive ops on shared resources, external actions without sign-off, errors that need human judgment.

## Workflow File Discipline

Workflow files are thin by design. Each phase row in a workflow's phases table maps to a Tier 1 skill or a thin orchestration step. **Phase notes are for orchestration overrides only** — sequencing rules, fanout-specific constraints, non-obvious instructions, decisions the foundational skill leaves to the caller. Never paraphrase what a foundational skill already documents. A phase that runs a Tier 1 skill end-to-end with no orchestration override needs no phase note — just the row in the table.

The same discipline applies to gotchas: workflow-specific gotchas are about the orchestration pattern itself (e.g., parallel sub-agent context exhaustion, normalization gaps). Gotchas about a Tier 1 skill's internals belong in that skill, not the workflow.

## When the Workflow List Doesn't Fit

For scenarios that don't map cleanly to one of the four workflow files — security audits across N servers, framework-wide migrations, design-only extensions, ad-hoc multi-step work — the universal rules and sub-agent strategy above still apply. Author a new workflow file at `workflows/<scenario>.md` when the pattern is repeatable enough to codify. Follow the shape of the existing workflow files. Open with the back-pointer every workflow carries — a "Read `../SKILL.md` first" tail on the frontmatter `description`, plus a "Use after reading `../SKILL.md`." line under the H1 — so an orchestrator that opens the file directly (not routed through this skill) still picks up the universal rules and sub-agent strategy. Then, when applicable: Tier 1 skills referenced, pre-flight, phases table, phase notes, workflow-specific gotchas, checklist. Apply the workflow file discipline above.

## Pre-flight Checklist (every workflow)

Verify before kicking off the first phase. Workflow files add their own pre-flight items on top of these.

- [ ] Target list captured with absolute paths
- [ ] Intent and state signals point to a single workflow (or confirmed with user if ambiguous)
- [ ] Selected workflow file read end-to-end
- [ ] Phase objectives understood (the Objective column of the phases table is the goal contract — verification runs against these)
- [ ] Plan surfaced to user: workflow, targets, phase objectives, applicable universal rules
- [ ] User authorization captured for the workflow's commit/push/publish phases (if any apply)
- [ ] Sub-agent capability confirmed (or fallback to linear execution noted)

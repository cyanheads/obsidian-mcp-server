---
name: git-wrapup
description: >
  Land working-tree changes as logical commits — the work grouped by concern, topped by a release commit (version bump, changelog, regenerated artifacts). The work commits land first, then the version bump, verification, and the release commit on top. Stops at "committed locally on main" — or, when the project releases through a release PR, at "release branch pushed, PR open". No tag, no push to main, no publish: the release-and-publish skill merges, tags, and ships from here. Distilled from the git_wrapup_instructions protocol.
metadata:
  author: cyanheads
  version: "1.19"
  audience: external
  type: workflow
---

## When to use

Working-tree or staged changes are ready to ship as a new version. This skill lands them as a stack of logical commits — the work grouped by concern, topped by a release commit (version + changelog + tree). It does NOT tag, push to main, or publish — `release-and-publish` does all three.

Common triggers:
- Feature work, bug fixes, or dependency updates are done and tested
- A maintenance or polish pass left changes in the working tree
- An orchestrator says "wrapup this project"

## Release PR mode

A project can route every release through a pull request — one PR per version, for the audit trail and a stable review target. The mode is declared in the project's `CLAUDE.md`/`AGENTS.md` or in the caller's brief; when neither says anything, there is no release PR and the stack lands on `main` directly.

| Mode | Wrapup ends at | Then |
|:--|:--|:--|
| *(none — default)* | commit stack on `main`, tree clean | `release-and-publish` tags HEAD and ships |
| **gated** | commit stack on `release/<version>`, branch pushed, PR open | a review pass on the PR (`release-pr-review` skill), then a separate `release-and-publish` run fast-forwards `main`, tags, and ships |
| **straight-through** | same as gated | the same agent continues straight into `release-and-publish` |

The branch is created at wrapup time, never before: work happens on `main` until the version is known, then the uncommitted tree moves to `release/<version>` in one step (step 3), ahead of the first commit. The commit stack, the release commit, and the tag format are identical in every mode — the PR adds an artifact around them, it does not change them.

## Pre-wrapup gate checklist

Every item must be true before starting wrapup. Committing means releasing — a commit only happens when the work is ready to ship, not just "the edits are done." Each item is a goal to verify.

- [ ] **Changes exist** — uncommitted files or commits since the last tag
- [ ] **Work is complete** — no half-finished features, no "I'll add the test later," no TODO placeholders. The diff represents a shippable unit.
- [ ] **Code simplified** — if the diff spans more than ~50 changed lines or touches 3+ source files, the `code-simplifier` skill has been run across the changes
- [ ] **`bun run devcheck` passes** — typecheck + lint clean
- [ ] **`bun run rebuild` succeeds** — full clean build from scratch
- [ ] **All tests pass** — `bun run test:all` (or `bun run test`), plus `bun run test:package` where the project defines one: it guards the public-export manifest and is not part of `test:all`. New tests and regression tests added as needed for the changes being shipped.
- [ ] **Fixes verified** — bug fixes validated, generally via `bun run rebuild` and field-testing. Not just written — confirmed to resolve the described behavior.
- [ ] **No known regressions** — the changes don't break existing functionality
- [ ] **GH issues updated** — issues addressed by this work commented with what landed and any follow-ups needed. Concise. Backlinked as needed.
- [ ] **Docs updated** — surgical updates to existing docs as needed. New docs for new features. No large rewrites for documentation that's still accurate.

If any gate is red, fix it before proceeding. This skill re-verifies build + tests in step 7, but the work is committed by then — starting wrapup on a broken tree wastes the version number and turns the fix into an extra commit on a stack that should have been green.

## Steps

### 1. Review the diff

Understand what's about to ship before touching version numbers:

```bash
git status
git log v<latest-tag>..HEAD --oneline    # commits since last release
git diff HEAD --stat                      # every uncommitted change, staged or not
git diff HEAD                             # review the actual content
```

Diff against `HEAD`, not the index: plain `git diff` omits staged changes entirely, so a group already staged before wrap-up began — a `git mv` from a migration step, a hook's output — shows up in `git status` as a line to scroll past and nowhere in the diff review. Whatever is staged is part of what ships and gets grouped in step 3 like everything else.

If the working tree is clean AND there are no commits since the last tag, halt — nothing to wrap up.

### 2. Determine the new version

Read the current version from `package.json`. Apply the intended bump:

| Bump | When |
|:-----|:-----|
| **patch** | Bug fixes, dependency updates, metadata changes, docs |
| **minor** | New tools, new features, new env vars, behavioral changes |
| **major** | Breaking changes to tool schemas, removed tools, incompatible config |

Default to **patch** unless the diff clearly warrants minor or major.

### 3. Commit the work — one commit per concern

**Release PR mode only — move to the release branch first, before the first commit:**

```bash
git branch --show-current                 # must be main
git switch -c release/<version>           # uncommitted work rides along
```

Commits never land on `main` in this mode. If a `release/*` branch already exists locally, a prior release PR was never merged — halt and report it rather than stacking a second release on top.

**The work is committed before the version is bumped.** Work concerns routinely share a file with the version — a dependency refresh edits `package.json`, a doc edit lands in a `CLAUDE.md`/`AGENTS.md` that pins a version string — and the file is the atomic boundary, so whichever commit comes first takes the file whole. Committing the work first leaves the version hunk (step 4) as the only thing those files carry into the release commit.

Do NOT `git add -A` into one commit. Group the working tree into a handful of logical commits — never one blob. A feature spanning multiple layers splits by layer: runtime/logic, linter/tooling, docs/skills. Unrelated changes (two separate fixes, an incidental doc tweak) are their own commits. A dependency refresh is its own commit — `chore(deps): …` carrying `package.json`, the lockfile, and any pins it moved elsewhere. Work commits do not carry the version.

Stage each group explicitly, commit it by pathspec, then move to the next:

```bash
git add <paths-for-this-concern>
git commit --only <paths-for-this-concern> -m "<subject>" -m "<body>"
# repeat per concern
```

**Commit by pathspec, never the bare index.** A bare `git commit` commits everything staged, not the paths just added, so anything staged before wrap-up began — a `git mv` left by a migration step, a concurrent stage from a second session or a hook — rides into the first concern's commit. `--only` takes the named paths' working-tree content and disregards the rest of the index, so a pre-staged group never rides along; it stays staged, to be committed as its own concern (`chore(skills): move the skill tree to framework-skills/`) or reported. Anything still staged when the release commit lands then fails step 10's clean-tree check instead of shipping silently.

**The file is the atomic boundary:** NEVER split a single file's working-tree changes across commits, regardless of mechanism — not `git add -p`, not an index-only patch (`git apply --cached`), not editing the file between commits to remove-then-re-add a hunk. When one file serves two concerns, it ships whole in the commit of its dominant concern; a later commit may touch the file again only for changes made AFTER the first commit (the version bump applied in step 4).

**Subject format:** Conventional Commits, no version in the subject — `feat: hosted server endpoint`, `fix: handle empty SPARQL result sets`, `feat(linter): enrichment contract rules`, `docs: document the enrichment block`, `chore(deps): refresh dev dependencies`.

**Body: every commit has one, and it is one or two lines.** Uniform across the stack — no commit ships subject-only, none ships a paragraph. One sentence stating the *why* or the load-bearing constraint, a second only if the first genuinely cannot carry it. Two lines is the hard ceiling.

```
fix: handle empty SPARQL result sets

Upstream returns 200 with an empty bindings array rather than 404.
```

**Never put a closing keyword in a commit body.** `Fixes #N`, `Closes #N`, `Resolves #N` and friends close the issue the moment the commit is pushed — before the close-out comment recording what shipped, so the issue closes with no account of the fix. Reference issues as bare `(#N)` backlinks in the subject or body; closing is a deliberate later step.

A body is too long the moment it:
- enumerates the files, subsystems, or symbols touched — that is `git show --stat`
- walks through how the implementation works — that is the code
- narrates a fix's mechanism across multiple sentences — that is the changelog entry
- runs to a second paragraph, ever

The changelog carries the depth, the tag carries the headline, the commit carries one line of why. When the body wants to grow, that pressure is telling you the content belongs in the changelog entry.

**Rules:**
- Plain `-m` flag only — no heredoc, no command substitution
- No `Co-authored-by` or `Generated with` trailers
- No marketing adjectives ("comprehensive", "robust", "enhanced", "seamless", "improved")
- Each commit message stands alone for someone reading `git log` — no chat context, option numbers, or "as discussed"

**Right-size it.** "Group by concern" is not "always split." A genuinely single-concern change — one fix, a dependency bump, a small doc edit — is one work commit, with step 8's release commit on top of it. Only when the version bump *is* the whole change — a republish, a metadata-only patch with nothing else in the tree — is there no work commit to make, and step 8's release commit becomes the entire stack. The failure mode to prevent is the inverse: a large, multi-layer feature crammed into one commit alongside the release artifacts.

When every concern is committed, `git status` is clean. That clean tree is what makes everything steps 4–6 touch a release artifact and nothing else — confirm it before moving on.

### 4. Bump version everywhere

Every file that declares a version must be updated. Skip any file that doesn't exist in the project. For `@cyanheads/mcp-ts-core` projects:

- `package.json` — `version`
- `server.json` — top-level `version` AND every `packages[].version` entry
- `manifest.json` (if present) — `version`. Verify `name` is the bare package name (e.g. `bls-mcp-server`, not `@cyanheads/bls-mcp-server`)
- `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (if present) — `version`. Packaging validation fails on a mismatch; `.codex-plugin/mcp.json` is connection config and carries none
- `README.md` — version badge. Packaging validation fails on a mismatch with `package.json`; a literal `-` in a prerelease is escaped as `--` (`Version-0.14.0--rc.1-`)
- `CLAUDE.md` / `AGENTS.md` — if they pin a version string
- `Dockerfile` — OCI labels if they pin the version

Catch stragglers (replace the placeholder with the actual current version string, e.g. `0.9.7`):

```bash
grep -rn "0.9.7" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=changelog
```

Resolve hits case by case — historical changelog entries are correct as-is; everything else should match the new version.

### 5. Author the changelog

Create `changelog/<major.minor>.x/<version>.md`. Use `changelog/template.md` as the format reference — never edit, rename, or move that file.

**Frontmatter (required):**

```yaml
---
summary: "<one-line headline, ≤350 chars, no markdown>"
breaking: false    # true if consumers must change code to upgrade
security: false    # true ONLY for a security fix in this server's own source — NOT a dependency/transitive CVE bump (those go under ## Dependencies)
---
```

**Write `summary:` LAST, derived from the body you just wrote — never independently.** It is the line most readers see: `changelog:build` copies it verbatim into the `CHANGELOG.md` rollup, which ships inside the npm tarball, and in release PR mode it opens the PR body. Written from recollection rather than from the body, it reliably names a mechanism that was never built or a target that was never fixed, while the body beside it stays correct. After writing it, re-read the body and confirm every claim in the summary appears there. Derived-from-the-body means the facts come from the body — not that every body item appears: it is one headline, and comma-stitching every change into an inventory near the 350-char cap is the failure mode.

**`security:` is a source-code signal — not a dependency-CVE signal.** Set `security: true` only when this release fixes a vulnerability or adds hardening in code *this server ships*. A dependency or transitive CVE bump — even one that clears an advisory (`bun audit` going 1 → 0) — is routine maintenance: record it under `## Dependencies` with the advisory ID and leave the flag `false`. The `🛡️ Security` badge answers "does the server itself have a vuln"; a dep bump must not trip it.

**Body:** Section order follows Keep a Changelog — Added / Changed / Deprecated / Removed / Fixed / Security. Include only sections with entries. Delete empty sections.

**Tone:** Terse, fact-dense. Bullet = **symbol** + what changed + at most one consumer-facing caveat; one sentence by default, two max — a bullet past ~40 words or three sentences is wrong. The linked issue carries the why and the commit diff the how; the changelog names what changed and what a consumer does about it. Cut: history/justification narration, design-rationale defense, "X unchanged" clauses (short parenthetical only where a misread is likely), edge-case inventories. **Verified ≠ included** — the diff-is-source-of-truth rule bounds the truth of what you write, never the amount. Model length on `changelog/template.md`'s authoring guide, never on the previous entry (entries modeled on entries compound). `agent-notes` carries adoption steps only, never a second rendering of the body; a consequence shared by many bullets is stated once, not per bullet. Full conventions: the authoring guide in `changelog/template.md`.

**Re-read the entry file after writing it, then sweep for harness markup:** `grep -rlF -e '</invoke>' -e '</content>' changelog/` must print nothing. A stray closing tag at EOF is the authoring tool's own syntax bleeding into the file; `changelog/` is in `package.json` `files`, so it ships inside the npm tarball, and `changelog:check` cannot catch it — the rollup drops the trailing line, so a clean `CHANGELOG.md` proves nothing about the entry.

### 6. Regenerate derived artifacts

```bash
bun run changelog:build    # rebuilds CHANGELOG.md rollup from per-version files
bun run tree               # regenerates docs/tree.md — run when files were added, removed, or moved in src/
```

Both scripts are idempotent — safe to run even if nothing changed.

### 7. Run the verification gate

The stack being shipped must pass verification. Both must succeed:

```bash
bun run devcheck
bun run test:all           # or `bun run test` if no test:all script exists
bun run test:package       # only if the script exists — NOT part of test:all
```

**If either fails, halt.** Do not bypass verification to land the release commit.

The work is already committed by this point, so the fix is a new commit on top of the stack, under step 3's conventions — never `git commit --amend`, never a rebase, reset, or any other rewrite of a commit the stack already carries. Land the fix, then re-run this step. The same holds when the gate passes but leaves the tree dirty: `devcheck` auto-fixes as it runs, and a formatter fix to a file committed in step 3 is a follow-up commit of its own, not something to fold into the release commit.

Only the version bump, the changelog entry, and the regenerated artifacts may still be uncommitted when this step goes green.

### 8. Commit the release artifacts

One commit, on top of the work stack from step 3, carrying only what steps 4–6 produced: the version bumps (`package.json`, `server.json`, `manifest.json`, the plugin manifests, README badge, `CLAUDE.md`/`AGENTS.md`), the changelog entry, `CHANGELOG.md`, and `docs/tree.md`.

```bash
git add <release-artifact-paths>
git commit --only <release-artifact-paths> -m "chore(release): <version> — <theme>" -m "<body>"
```

**Subject leads with the version:** `chore(release): 0.2.1 — empty SPARQL result handling`. Step 3's conventions carry over unchanged — pathspec staging rather than the bare index, a one- or two-line body, no closing keywords, no trailers, no marketing adjectives.

Anything else still uncommitted at this point was made after step 3 — a formatter auto-fix, a gate fix. It is committed on its own first, and the release commit goes on top of it; it is never folded in.

### 9. Open the release PR (release PR mode only)

Skip this step entirely when the project has no release PR mode — go to step 10.

```bash
git push -u origin release/<version>
gh pr create --base main --head release/<version> --title "<release commit subject>" --body-file <path-to-body.md>
```

**Title:** the release commit's subject, verbatim — `chore(release): <version> — <theme>`.

**Body — always via `--body-file`, never an inline `--body` string** (backticks inside a double-quoted argument are command substitution and silently vanish). Write the file to a scratch location, not into the repo.

The body is the release digest — the `## Changes` bullets and changelog link the annotated tag will carry, under a theme line and above a gates record that both stay on the PR. The digest is written here, reviewed on the PR, and copied into the tag at release time, so it is the one place the release notes get reviewed before they become permanent. Format:

```
<theme — the changelog entry's summary: line, plain prose, one line. It opens the PR; the tag's subject is written fresh at release time and is not this line>

## Changes

- <notable user-facing change> (#N)
- <notable user-facing change> (#N)
- <ONE compact grouped line for the minor/internal changes — build config, repo hygiene, metadata>
- deps: `@cyanheads/mcp-ts-core` ^0.10.6 → ^0.10.14 (+ dev-dep bumps)

## Gates

- `bun run devcheck` — clean
- `bun run rebuild` — ok
- `bun run test:all` — <N> passed
- `bun run test:package` — <N> passed   (only where the project defines it)

[CHANGELOG v<version>](https://github.com/<OWNER>/<REPO>/blob/main/changelog/<major.minor>.x/<version>.md)
```

**Rules:**
- **`## Changes` follows the tag rules exactly** (`release-and-publish` step 4): flat bullets, never Keep-a-Changelog section headers; complete at headline granularity — notable changes get their own bullet, minor/internal items share ONE grouped bullet; deps one line max, naming only what earns it; no narrative, no marketing adjectives. Depth lives in the changelog entry, which is in this PR's diff and linked on the last line.
- **Every claim traces to the diff and to the changelog entry.** The body is derived from the entry you authored in step 5, never written independently of it.
- **`## Gates` is the one release surface that carries gate results** — the exact commands from step 7 with their outcomes. It never enters the tag.
- **Issue references are bare `(#N)` backlinks — never a closing keyword** (`Closes #N`, `Fixes #N`); the merge would close the issue before its close-out comment lands.
- **Changelog link is the final line**, same form as the tag, blank line above it.
- Length is earned — a theme, two bullets, gates, and the link is a complete body for a small patch.

If the review pass changes what ships, `release-pr-review` updates `## Changes` and `## Gates` to match; `release-and-publish` then lifts `## Changes` plus the final link into the tag verbatim.

**Gated mode: halt here.** Report the PR URL, the branch, and the commit stack. Do not tag, do not merge, do not touch `main`. The review pass and `release-and-publish` run as separate steps after this one.

**Straight-through mode:** continue directly into `release-and-publish`.

### 10. Verify end state

```bash
git log --oneline -8              # confirm the commit stack: work commits + release commit on top
git status                        # must be clean
git tag --points-at HEAD          # must print nothing — tagging is release-and-publish's job
git branch --show-current         # main, or release/<version> in release PR mode
gh pr view --json number,url,state   # release PR mode: OPEN, head = the branch above
```

If the working tree isn't clean or the release commit isn't at HEAD, something went wrong — investigate before proceeding.

**Do NOT tag, push `main`, or publish.** This skill stops here. `release-and-publish` merges the release branch when there is one, creates the tag, pushes, and publishes.

## Constraints

- **No push to `main`, no tag, no publish.** The only remote writes this skill makes are the release-branch push and the PR create in release PR mode
- **Never stash.** Not for quick checks, not for testing, not for any reason
- **Never destructive.** No `git reset --hard`, `git restore .`, `git clean -f`, `git checkout -- .`, no force-push
- **Bash git only.** Drive every git operation through the shell
- If `v<version>` already exists as a tag, **halt and report the conflict** — include the version string, existing tag SHA, and current HEAD SHA so the caller can resolve it. Do not delete or move tags without explicit authorization

## Checklist

- [ ] Diff reviewed end-to-end before the first commit
- [ ] Work concerns committed before the version bump — a version-bearing file a work concern also touches ships whole in that concern's commit, so the release commit brings it the version hunk alone
- [ ] Version bumped in every declaring file (`package.json`, `server.json`, `manifest.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, README badge, `CLAUDE.md`/`AGENTS.md` if they pin a version) — verify by command, not by eye: `v=$(jq -r .version package.json); grep -rl "$v" package.json server.json manifest.json .claude-plugin/plugin.json .codex-plugin/plugin.json README.md | wc -l` must equal the count of files that exist, and `grep -c "Version-$v-" README.md` must print `1`. `lint:packaging` checks the README badge against `package.json`, so a stale badge now fails `devcheck` instead of shipping unnoticed — the grep still catches a badge written in a shape the check skips
- [ ] GH issues addressed by this work commented with what landed (if working from GH issues)
- [ ] Docs updated for any new or changed features
- [ ] Changelog authored at `changelog/<major.minor>.x/<version>.md`
- [ ] `CHANGELOG.md` rollup regenerated (`bun run changelog:build`)
- [ ] `docs/tree.md` regenerated if structure changed (`bun run tree`)
- [ ] `bun run devcheck` passes
- [ ] `bun run test:all` (or `test`) passes
- [ ] `bun run test:package` passes, when the project defines it — it guards the public-export manifest and `test:all` does not run it
- [ ] Release PR mode: stack committed on `release/<version>`, never on `main`
- [ ] Work grouped into logical commits (large features split by layer); release artifacts (version + changelog + tree) committed separately on top, subject leading with the version
- [ ] A gate failure after the work is committed landed as a new commit on the stack — nothing amended, rebased, or otherwise rewritten
- [ ] Every commit carries a body, and every body is one or two lines — none subject-only, none a paragraph
- [ ] Release PR mode: branch pushed, PR open — title = release commit subject; body = theme line, `## Changes` in tag rules, `## Gates`, changelog link last (via `--body-file`, no closing keywords)
- [ ] Working tree clean
- [ ] No tag at HEAD, nothing pushed to `main` — `release-and-publish` owns both

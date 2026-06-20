---
name: git-wrapup
description: >
  Land working-tree changes as logical commits — the work grouped by concern, topped by a release commit (version bump, changelog, regenerated artifacts) and an annotated tag. Verify, commit, tag. Stops at "committed and tagged locally" — no push, no publish. The release-and-publish skill picks up from here. Distilled from the git_wrapup_instructions protocol.
metadata:
  author: cyanheads
  version: "1.4"
  audience: external
  type: workflow
---

## When to use

Working-tree or staged changes are ready to ship as a new version. This skill lands them as a stack of logical commits — the work grouped by concern, topped by a release commit (version + changelog + tree) — with an annotated tag. It does NOT push or publish — that's a separate step (`release-and-publish`).

Common triggers:
- Feature work, bug fixes, or dependency updates are done and tested
- A maintenance or polish pass left changes in the working tree
- An orchestrator says "wrapup this project"

## Pre-wrapup gate checklist

Every item must be true before starting wrapup. Committing means releasing — a commit only happens when the work is ready to ship, not just "the edits are done." Each item is a goal to verify.

- [ ] **Changes exist** — uncommitted files or commits since the last tag
- [ ] **Work is complete** — no half-finished features, no "I'll add the test later," no TODO placeholders. The diff represents a shippable unit.
- [ ] **Code simplified** — if the diff spans more than ~50 changed lines or touches 3+ source files, the `code-simplifier` skill has been run across the changes
- [ ] **`bun run devcheck` passes** — typecheck + lint clean
- [ ] **`bun run rebuild` succeeds** — full clean build from scratch
- [ ] **All tests pass** — `bun run test:all` (or `bun run test`). New tests and regression tests added as needed for the changes being shipped.
- [ ] **Fixes verified** — bug fixes validated, generally via `bun run rebuild` and field-testing. Not just written — confirmed to resolve the described behavior.
- [ ] **No known regressions** — the changes don't break existing functionality
- [ ] **GH issues updated** — issues addressed by this work commented with what landed and any follow-ups needed. Concise. Backlinked as needed.
- [ ] **Docs updated** — surgical updates to existing docs as needed. New docs for new features. No large rewrites for documentation that's still accurate.

If any gate is red, fix it before proceeding. This skill re-verifies build + tests in step 6, but starting wrapup on a broken tree wastes the version number and creates a revert-or-amend situation.

## Steps

### 1. Review the diff

Understand what's about to ship before touching version numbers:

```bash
git status
git log v<latest-tag>..HEAD --oneline    # commits since last release
git diff --stat                           # uncommitted changes
git diff                                  # review the actual content
```

If the working tree is clean AND there are no commits since the last tag, halt — nothing to wrap up.

### 2. Determine the new version

Read the current version from `package.json`. Apply the intended bump:

| Bump | When |
|:-----|:-----|
| **patch** | Bug fixes, dependency updates, metadata changes, docs |
| **minor** | New tools, new features, new env vars, behavioral changes |
| **major** | Breaking changes to tool schemas, removed tools, incompatible config |

Default to **patch** unless the diff clearly warrants minor or major.

### 3. Bump version everywhere

Every file that declares a version must be updated. Skip any file that doesn't exist in the project. For `@cyanheads/mcp-ts-core` projects:

- `package.json` — `version`
- `server.json` — top-level `version` AND every `packages[].version` entry
- `manifest.json` (if present) — `version`. Verify `name` is the bare package name (e.g. `bls-mcp-server`, not `@cyanheads/bls-mcp-server`)
- `README.md` — version badge
- `CLAUDE.md` / `AGENTS.md` — if they pin a version string
- `Dockerfile` — OCI labels if they pin the version

Catch stragglers (replace the placeholder with the actual current version string, e.g. `0.9.7`):

```bash
grep -rn "0.9.7" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=changelog
```

Resolve hits case by case — historical changelog entries are correct as-is; everything else should match the new version.

### 4. Author the changelog

Create `changelog/<major.minor>.x/<version>.md`. Use `changelog/template.md` as the format reference — never edit, rename, or move that file.

**Frontmatter (required):**

```yaml
---
summary: "<one-line headline, ≤350 chars, no markdown>"
breaking: false    # true if consumers must change code to upgrade
security: false    # true if this release contains a security fix
---
```

**Body:** Section order follows Keep a Changelog — Added / Changed / Deprecated / Removed / Fixed / Security. Include only sections with entries. Delete empty sections.

**Tone:** Terse, fact-dense. Lead each bullet with the symbol or concept in **bold**. One sentence per bullet by default. See the authoring guide in `changelog/template.md` for full conventions.

### 5. Regenerate derived artifacts

```bash
bun run changelog:build    # rebuilds CHANGELOG.md rollup from per-version files
bun run tree               # regenerates docs/tree.md — run when files were added, removed, or moved in src/
```

Both scripts are idempotent — safe to run even if nothing changed.

### 6. Run the verification gate

The tree being committed must pass verification. Both must succeed:

```bash
bun run devcheck
bun run test:all           # or `bun run test` if no test:all script exists
```

**If either fails, halt.** Do not bypass verification to land the commit. Fix the issue first, then re-run from step 6.

### 7. Commit — group by concern, release artifacts on top

Do NOT `git add -A` into one commit. Group the working tree into a handful of logical commits — never one blob:

1. **The work — one commit per concern.** A feature spanning multiple layers splits by layer: runtime/logic, linter/tooling, docs/skills. Unrelated changes (two separate fixes, an incidental doc tweak) are their own commits. Work commits do not carry the version.
2. **The release commit — last, on top.** Version bumps (`package.json`, `server.json`, README badge, `CLAUDE.md`/`AGENTS.md`), the changelog entry, `CHANGELOG.md`, and `docs/tree.md` go in a single final commit that sits on top of the work stack — never mixed into a feature commit.

Stage each group explicitly, commit it, then move to the next — the release commit goes last:

```bash
git add <paths-for-this-concern>
git commit -m "<subject>"
# repeat per concern; version + changelog + tree are the final commit
```

**The file is the atomic boundary:** NEVER split a single file's changes across commits. When one file serves two concerns, it ships whole in the commit of its dominant concern.

**Subject format:** Conventional Commits.
- Work commits (no version): `feat: hosted server endpoint`, `fix: handle empty SPARQL result sets`, `feat(linter): enrichment contract rules`, `docs: document the enrichment block`
- Release commit (subject leads with the version): `chore(release): 0.2.1 — empty SPARQL result handling`

**Rules:**
- Plain `-m` flag only — no heredoc, no command substitution
- No `Co-authored-by` or `Generated with` trailers
- No marketing adjectives ("comprehensive", "robust", "enhanced", "seamless", "improved")
- Each commit message stands alone for someone reading `git log` — no chat context, option numbers, or "as discussed"

**Right-size it.** "Group by concern" is not "always split." A genuinely single-concern change — one fix, a dependency bump, a small doc edit — is one work commit plus the release commit; when the change and its version bump are inseparable for a tiny patch, a single commit whose subject leads with the version is fine. The failure mode to prevent is the inverse: a large, multi-layer feature crammed into one commit alongside the release artifacts.

### 8. Create an annotated tag

```bash
git tag -a v<version> -m "<tag message with embedded newlines>"
```

Use `-m` with embedded newlines in the string (the commit `-m`-only constraint applies here too — no heredoc). The tag message renders as the GitHub Release body via `--notes-from-tag`. It must be structured markdown, not a flat string. Format:

```
<theme — omit version number, GitHub prepends v<VERSION>:>

<optional context — one concise line, two max>

<Sections — Keep a Changelog names, only those with entries>

Added:

- <bullet>

Changed:

- <bullet>

<dep arrows if applicable>

Dependency bumps:

- `pkg` ^old → ^new

<N> tests pass; `bun run devcheck` clean.
```

**Rules:**
- Subject line omits the version number (GitHub prepends `v<VERSION>:` to the release title)
- **No narrative preamble** — context under the subject is one concise line, two max; never paragraph blocks. Detail belongs in the bullets
- Not a CHANGELOG copy — terse, scannable
- No marketing adjectives
- Length is earned — two-line tags are fine for small patches
- **Issue backlinks:** when changes address GitHub issues, include `(#N)` references in the relevant bullets — same as the changelog entry. The backlinks render as clickable links in the GitHub Release body.

### 9. Verify end state

```bash
git log --oneline -8              # confirm the commit stack: work commits + release commit on top
git show v<version> --stat | head -20   # confirm tag points at HEAD (the release commit)
git status                        # must be clean
```

If the working tree isn't clean or the tag doesn't point at HEAD, something went wrong — investigate before proceeding.

**Do NOT push.** This skill stops here. Use the `release-and-publish` skill for the push + publish workflow.

## Constraints

- **Local only.** No `git push`, no remote operations
- **Never stash.** Not for quick checks, not for testing, not for any reason
- **Never destructive.** No `git reset --hard`, `git restore .`, `git clean -f`, `git checkout -- .`
- **Bash git only.** Drive every git operation through the shell
- If `v<version>` already exists as a tag, **halt and report the conflict** — include the version string, existing tag SHA, and current HEAD SHA so the caller can resolve it. Do not delete or move tags without explicit authorization

## Checklist

- [ ] Diff reviewed end-to-end before version bump
- [ ] Version bumped in every declaring file (`package.json`, `server.json`, `manifest.json`, README badge, `CLAUDE.md`/`AGENTS.md` if they pin a version)
- [ ] GH issues addressed by this work commented with what landed (if working from GH issues)
- [ ] Docs updated for any new or changed features
- [ ] Changelog authored at `changelog/<major.minor>.x/<version>.md`
- [ ] `CHANGELOG.md` rollup regenerated (`bun run changelog:build`)
- [ ] `docs/tree.md` regenerated if structure changed (`bun run tree`)
- [ ] `bun run devcheck` passes
- [ ] `bun run test:all` (or `test`) passes
- [ ] Work grouped into logical commits (large features split by layer); release artifacts (version + changelog + tree) committed separately on top, subject leading with the version
- [ ] Annotated tag `v<version>` with structured markdown message
- [ ] Working tree clean
- [ ] Nothing pushed — local only

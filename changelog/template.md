---
# FORMAT REFERENCE — do not edit. Copy this file to
# `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.8.x/0.8.6.md`)
# to author a new release. Set that file's H1 to `# <version> — YYYY-MM-DD`
# with a concrete date.

# Required. One-line GitHub Release-style headline. ~250 character soft cap.
# Default short and scannable. Don't pad, don't stitch unrelated changes with
# semicolons — pick the headline. Quotes required: unquoted YAML treats `: `
# inside the value as a key separator and fails GitHub's strict parser.
summary: ""

# Set `true` when consumers must change code to upgrade: API removals,
# signature changes, config renames, behavior changes that break existing
# usage. Flagged as `Breaking` in the rollup.
breaking: false

# Set `true` if this release contains any security fix. Pairs with the
# `## Security` section below. Flagged as `Security` in the rollup so
# users can triage upgrade urgency at a glance.
security: false
---

# <version> — YYYY-MM-DD

<!--
  AUTHORING GUIDE — applies to the new per-version file you create from this
  template.

  Audience: someone scanning release notes to decide what affects them. Lead
  each bullet with the symbol or concept name in **bold** so they can skip
  what's irrelevant and zoom in on what's not.

  Tone: terse, fact-dense, not verbose. Default to one sentence per bullet —
  name the symbol, state what changed, stop. Use a second sentence only when
  it carries weight. If a bullet feels long, it is.

  Cut: mechanism walkthroughs (those belong in JSDoc, AGENTS.md, or the
  relevant skill), ceremonial framings ("This release introduces…",
  backwards-compat paragraphs), file-by-file test enumerations, internal
  implementation notes. Prefer code/symbol names over English re-explanations.

  Narrative intro: skip by default. Add one short sentence only when the
  release theme genuinely needs framing the bullets can't carry.

  Sections: Keep a Changelog order — Added, Changed, Deprecated, Removed,
  Fixed, Security. Include only sections with entries; delete the rest
  (including the commented-out scaffolding below). Don't ship empty headers.

  Include: every distinct fact a reader needs to adopt or audit the release —
  new exports, signatures, lint rule IDs, env vars, breaking changes, version
  bumps on shipped skills. Nothing more.

  Links: link issues, PRs, docs, or skills where they help a reader jump to
  context. Once per item per entry — don't re-link the same issue in summary,
  narrative, and bullet. Skip links for inline symbol names; code spans speak
  for themselves.

  Issue/PR URLs: use full URLs. GitHub's bare `#NN` auto-link only resolves
  inside its own UI, not in npm reads or local editors.

      [#38](https://github.com/cyanheads/mcp-ts-core/issues/38)   ← issue
      [#42](https://github.com/cyanheads/mcp-ts-core/pull/42)     ← PR

  Verify numbers exist before linking (`gh issue view NN`, `gh pr view NN`).
  Never speculate on a future number — `#42` for an upcoming PR silently
  resolves to whatever real item already owns 42, and timeline previews pull
  in that unrelated item's metadata.
-->

## Added

-

## Changed

-

<!-- ## Deprecated

- -->

<!-- ## Removed

- -->

## Fixed

-

<!-- ## Security

- -->
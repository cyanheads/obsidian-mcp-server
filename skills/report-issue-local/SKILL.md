---
name: report-issue-local
description: >
  File a bug or feature request against this MCP server's own repo. Use for server-specific issues — tool logic, service integrations, config problems, or domain bugs that aren't caused by the framework.
metadata:
  author: cyanheads
  version: "1.3"
  audience: external
  type: workflow
---

## When to Use

The bug is in this server's code, not in `@cyanheads/mcp-ts-core`. Typical triggers:

- A tool handler returns wrong results or throws on valid input
- A service integration (external API, database, third-party SDK) fails or misbehaves
- Server-specific config (`server-config.ts`) rejects valid env vars or has wrong defaults
- Resource handlers return stale, incomplete, or incorrect data
- Domain logic errors — wrong calculations, missing edge cases, bad state transitions
- Missing or incorrect `.describe()` on schema fields causing poor LLM tool use

**If the issue is in the framework itself** (builders, Context, utilities, type exports, linter), use `report-issue-framework` instead.

For general `gh` CLI workflows outside issue filing (PRs, workflows, API access), see the `github-cli` skill.

## Before Filing

1. **Identify the repo**:

```bash
gh repo view --json nameWithOwner -q '.nameWithOwner'
```

2. **Search existing issues**:

```bash
gh issue list --search "your error message or keyword"
```

3. **Reproduce the issue** — confirm it's reproducible. Note the exact input, transport mode, and any relevant env vars.

4. **Check logs** — review `ctx.log` output and any framework telemetry for clues. If running HTTP, check the response body for structured error details.

## Writing Well-Structured Issues

Good issues are scannable, concrete, and self-contained. These patterns apply to both bugs and features — the guidance targets any prose block (Description, Additional context, feature proposals).

- **Lead with specifics.** Name the tool, service, resource, or symptom. "Currently `search_docs` returns an empty array for queries containing `&`" beats "Search is broken." A reader should know what's wrong before the end of the first sentence.
- **Embed library/service links on first mention.** `[Hono](https://hono.dev/)`, `[Supabase](https://supabase.com/)`. Link to the canonical repo or homepage so readers can verify the dependency and reach docs in one click.
- **Use `owner/repo#N` for cross-repo issue references.** GitHub auto-renders them as linked references (e.g. `cyanheads/mcp-ts-core#46`). Bare `#N` only works for same-repo issues — useful when the bug depends on or relates to a framework issue.
- **Add a `Related: #N` line** near the top when the issue grows from prior context (discussions, other issues, PRs). Makes provenance clickable.
- **Lead design sections with a philosophy sentence.** Bold a short principle before the tradeoff details — e.g. "Philosophy: **return best-effort data, don't fail the tool call on parsing edge cases.**" Establishes the lens for the rest of the section.
- **Prefer Markdown tables for comparisons.** When showing options, data sources, strategies, or tradeoffs — tables are the highest-density format for scanning N rows × M attributes.
- **Separate `### Scope` from `### Out of scope`.** The latter is as important as the former — it pre-empts scope-creep debates in comments and signals you've thought about the boundaries.
- **Use `Depends on: owner/repo#N`** to declare ordering explicitly when implementation is blocked on an upstream framework change or another issue landing first.
- **Skip collaborator-framing sign-offs.** Lines like "Happy to open a PR", "let me know if you'd like", "willing to contribute", "if that's the preferred flow" read as noise. A PR link beats an offer; if you're the maintainer filing against your own repo, the offer is redundant. End the body at the last substantive point.

## Redact Before Posting

GitHub issues are **public**. Do not include secrets, credentials, API keys, or tokens. Redact sensitive values from env vars, headers, and logs before submitting. Replace with obvious placeholders: `REDACTED`, `sk-...REDACTED`. Do not rely on partial masking — partial keys can still be exploited.

## Filing a Bug

This repo includes YAML form issue templates (scaffolded from the framework). Use `--web` to open the form in the browser (preferred when available), or pass `--title` + `--body` for non-interactive use.

### Browser (interactive)

```bash
gh issue create --template "Bug Report" --web
```

### CLI (non-interactive)

Structure the `--body` to match the template's form fields:

````bash
gh issue create \
  --title "bug(tool_name): concise description" \
  --label "bug" \
  --assignee "@me" \
  --body "$(cat <<'ISSUE'
### Server version

0.1.0

### mcp-ts-core version

0.1.29

### Runtime

Bun

### Runtime version

Bun 1.2.x

### Transport

stdio

### Description

What happened and what you expected instead.

### Steps to reproduce

1. Call `tool_name` with input: `{ "key": "value" }`
2. Observe error / wrong output

### Actual behavior

```
Error or incorrect output here
```

### Expected behavior

What should have happened.

### Additional context

Relevant `ctx.log` output, stack traces, or telemetry spans.
ISSUE
)"
````

### Title conventions

Format: `type(scope): description`

- **type:** `bug`, `feat`, `docs`, `chore`
- **scope:** tool name, service name, resource name, `config`, `auth`, or domain area

Examples:
- `bug(search_docs): returns empty results for queries with special characters`
- `feat(analytics): add date range filter to usage_report tool`
- `docs(setup): .env.example missing REDIS_URL`

### Labels

Every issue needs exactly one primary label. Stack secondary labels on top when applicable.

**Primary (required — pick one):**

| Label | When |
|:------|:-----|
| `bug` | Something broken |
| `enhancement` | New feature or improvement |
| `documentation` | Documentation is wrong, missing, or misleading |

**Secondary (optional — stack on top of primary):**

| Label | When |
|:------|:-----|
| `regression` | Worked before, broken after a change |
| `performance` | Memory, CPU, latency, or resource usage |
| `security` | Vulnerability, CVE, or hardening work |
| `breaking-change` | Change will break public API; requires a major bump |

Combine labels: `--label "bug" --label "regression"`.

Secondary labels are not GitHub defaults — if `gh issue create --label "regression"` fails with `label not found`, create it once:

```bash
gh label create regression --color e99695 --description "Worked before, broken after a change"
gh label create performance --color 5319e7 --description "Memory, CPU, latency, or resource usage"
gh label create security --color b60205 --description "Vulnerability, CVE, or hardening work"
gh label create breaking-change --color d93f0b --description "Change will break public API; requires a major bump"
```

### Attaching logs or large output

```bash
bun run dev:stdio 2>&1 | head -200 > /tmp/server-error.log

# As part of a new issue
gh issue create \
  --title "bug(ingest): crashes on large payload" \
  --label "bug" \
  --assignee "@me" \
  --body-file /tmp/server-error.log

# Or as a comment on an existing issue
gh issue comment <number> --body-file /tmp/server-error.log
```

## Filing a Feature Request

### Browser (interactive)

```bash
gh issue create --template "Feature Request" --web
```

### CLI (non-interactive)

Template below demonstrates the richer structure. Omit sections you don't need — simple requests don't require Flow / Design / Dependencies blocks.

````bash
gh issue create \
  --title "feat(scope): concise description" \
  --label "enhancement" \
  --assignee "@me" \
  --body "$(cat <<'ISSUE'
Concrete statement of what's currently missing or broken. Name the specific tool, service, resource, or domain area. Two or three sentences — the reader should know the gap before the end of the paragraph.

Related: #N

## Proposal

What you want the server to do, in one paragraph. Link external libraries or services on first mention: [lib name](https://github.com/owner/repo). Include a short justification — what this gives users that they don't have today.

### Proposed behavior

Describe the new behavior or surface. For tool/resource changes, show example input/output or the new schema fields:

```ts
// Example: new input field or output shape
```

### Flow (optional)

Ordered steps — e.g. `request → lookup → fallback → respond`. Useful when the change spans multiple phases or fallbacks.

### Design / Tradeoffs (optional)

Philosophy: **one-line principle in bold.**

| Option | Strengths | Weaknesses |
|:---|:---|:---|
| A | ... | ... |
| B | ... | ... |

### Scope

- Files or modules touched
- New env vars, config keys, or service integrations
- New or modified tools / resources / prompts

### Out of scope

- What we're deliberately not doing
- Adjacent work that belongs in a separate issue

### Dependencies (optional)

- Depends on: cyanheads/mcp-ts-core#N (upstream framework change)
- Depends on: owner/repo#N (other server work)

### Alternatives considered

What you tried or evaluated instead, and why it didn't fit.
ISSUE
)"
````

## Triage: Framework vs Server

Not sure where the bug lives? Quick checks:

| Signal | Likely framework | Likely server |
|:-------|:-----------------|:--------------|
| Error originates in `node_modules/@cyanheads/mcp-ts-core/` | Yes | |
| Error in `src/mcp-server/tools/` or `src/services/` | | Yes |
| Same bug reproduces with a bare `tool()` definition (no services) | Yes | |
| Bug disappears when you swap in a dummy handler | | Yes |
| `ctx.state`, `ctx.log`, `ctx.elicit` behave wrong on any tool | Yes | |
| Only one specific tool/resource is affected | | Yes |

When genuinely ambiguous, file against this server's repo and note that it might be a framework issue. The maintainer can transfer it upstream.

## Following Up

```bash
# View issue details
gh issue view <number>

# Add context
gh issue comment <number> --body "Additional findings..."

# List your open issues
gh issue list --author @me

# Close if resolved
gh issue close <number> --reason completed --comment "Fixed in <commit or PR>"
```

## Checklist

- [ ] Confirmed bug is in server code, not the framework
- [ ] Searched existing issues — no duplicate found
- [ ] All secrets, credentials, and tokens redacted
- [ ] Issue filed with: version, runtime, repro steps, actual vs expected behavior

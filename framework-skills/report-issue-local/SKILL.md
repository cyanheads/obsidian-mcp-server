---
name: report-issue-local
description: >
  File a bug or feature request against this MCP server's own repo. Use for server-specific issues — tool logic, service integrations, config problems, or domain bugs that aren't caused by the framework.
metadata:
  author: cyanheads
  version: "1.12"
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

2. **Search existing issues** — if a close match exists (same symptom, different tool; same tool, different symptom; closed issue that might cover the new case), add a comment on that issue instead of filing a new one — unless the symptom or scope is distinct enough to warrant separate tracking:

```bash
gh issue list --search "your error message or keyword" --state all

# Assess a close match before commenting — is it already linked to a fix or referenced elsewhere?
gh issue view <number>              # body
gh issue view <number> --comments   # thread only — without a TTY it prints no body
gh api 'repos/{owner}/{repo}/issues/<number>/timeline' --paginate \
  --jq '.[] | select(.event=="cross-referenced") | .source.issue | "\(.repository.full_name)#\(.number) — \(.title)"'
```

3. **Reproduce the issue** — confirm it's reproducible. Note the exact input, transport mode, and any relevant env vars.

4. **Check logs** — review `ctx.log` output and any framework telemetry for clues. If running HTTP, check the response body for structured error details.

## Writing Well-Structured Issues

Good issues are terse and fact-dense. **Budget: a bug reads in ~150 words, a feature in ~250, code and logs excluded.** Every section past the form's required fields must earn its place — a section you could delete without changing the fix is noise. One or two sentences per bullet; if a bullet runs long, split it or cut it.

- **Cut what dilutes the signal.** Mechanism walkthroughs (link the PR or doc instead), ceremonial framings ("This issue covers…"), conversation references ("as discussed", "per offline"), restated context the reader already has, and kitchen-sink Additional context blocks. If a paragraph isn't pulling weight, drop it.
- **Lead with specifics.** Name the tool, service, resource, or symptom. "Currently `search_docs` returns an empty array for queries containing `&`" beats "Search is broken." A reader should know what's wrong before the end of the first sentence.
- **Embed library/service links on first mention.** `[Hono](https://hono.dev/)`, `[Supabase](https://supabase.com/)`. Link to the canonical repo or homepage so readers can verify the dependency and reach docs in one click.
- **Use `owner/repo#N` for cross-repo issue references.** GitHub auto-renders them as linked references (e.g. `cyanheads/mcp-ts-core#46`). Bare `#N` only works for same-repo issues — useful when the bug depends on or relates to a framework issue.
- **Add a `Related: #N` line** near the top when the issue grows from prior context (discussions, other issues, PRs). Makes provenance clickable.
- **Cite cross-references once per body.** Link an issue/PR in `Related:`, the description, or Additional context — not all three. The reader sees them all; redundant linking dilutes signal.
- **Prefer Markdown tables for comparisons.** When showing options, data sources, strategies, or tradeoffs — tables are the highest-density format for scanning N rows × M attributes.
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

Structure the `--body` to match the template's form fields. Description is two or three sentences; the reproduction is the exact input and the observed output, nothing else. Add `### Additional context` only when it changes the fix (a workaround, a related issue, the one log line that matters) — omitted by default.

````bash
gh issue create \
  --title "bug(tool_name): concise description" \
  --label "bug" \
  --assignee "@me" \
  --body "$(cat <<'ISSUE'
### Server version

<package.json version>

### mcp-ts-core version

<installed version from node_modules/@cyanheads/mcp-ts-core/package.json — not the ^ range>

### Runtime

Bun

### Runtime version

<bun --version>

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
| `breaking-change` | Change will break public API or an existing tool contract |
| `blocked-by-framework` | Fix requires a released change in `@cyanheads/mcp-ts-core`; pairs with a `Depends on: cyanheads/mcp-ts-core#N` line in the body |
| `blocked-by-sdk` | Fix requires changes in `@modelcontextprotocol/sdk` |
| `surplus-token-idea` | Worth exploring when token budget allows |

`blocked-by-framework` comes off when this server adopts the release that ships the fix. An issue blocked on the SDK *through* the framework takes `blocked-by-framework`, not `blocked-by-sdk` — the server's own unblock is still a framework release.

Combine labels: `--label "bug" --label "regression"`.

Secondary labels are not GitHub defaults — if `gh issue create --label "regression"` fails with `label not found`, create it once:

```bash
gh label create regression --color e99695 --description "Worked before, broken after a change"
gh label create performance --color 5319e7 --description "Memory, CPU, latency, or resource usage"
gh label create security --color b60205 --description "Vulnerability, CVE, or hardening work"
gh label create breaking-change --color d93f0b --description "Change will break public API or an existing tool contract"
gh label create blocked-by-framework --color fbca04 --description "Fix requires a released change in @cyanheads/mcp-ts-core"
gh label create blocked-by-sdk --color c5def5 --description "Fix requires changes in @modelcontextprotocol/sdk"
gh label create surplus-token-idea --color FF10F0 --description "Worth exploring when token budget allows"
```

### Attaching logs or large output

Note: `--body-file` replaces the entire body — it does not supplement a `--body` flag. For structured bugs with logs, either embed the log content in the `Additional context` section of a normal `--body`, or file the issue first and add the log as a comment:

```bash
bun run rebuild && bun run start:stdio 2>&1 | head -200 > /tmp/server-error.log

# As part of a new issue (the log becomes the entire body — no template fields)
gh issue create \
  --title "bug(ingest): crashes on large payload" \
  --label "bug" \
  --assignee "@me" \
  --body-file /tmp/server-error.log

# Or as a comment on an existing issue (preferred — keeps the structured body intact)
gh issue comment <number> --body-file /tmp/server-error.log
```

## Filing a Feature Request

### Browser (interactive)

```bash
gh issue create --template "Feature Request" --web
```

### CLI (non-interactive)

The first three headings are the Feature Request form's own fields, in its order — `Use case` and `Proposed behavior` are required by the form, so a body without them does not satisfy it. `Out of scope` is one or two lines. Nothing else by default: a `Scope`, `Flow`, `Design / Tradeoffs`, or `Depends on` block is added only when the reader cannot act without it, and each stays to a few lines.

````bash
gh issue create \
  --title "feat(scope): concise description" \
  --label "enhancement" \
  --assignee "@me" \
  --body "$(cat <<'ISSUE'
### Use case

One or two sentences: who hits this gap and why it matters. Name the specific tool, service, resource, or domain area. Kept short on purpose — a field that invites a paragraph gets padded with background and skipped by the next reader.

Related: #N

### Proposed behavior

What you want the server to do, then the new behavior or surface. For tool/resource changes, show example input/output or the new schema fields. Link external libraries or services on first mention: [lib name](https://github.com/owner/repo).

```ts
// Example: new input field or output shape
```

### Alternatives considered

What you tried or evaluated instead, and why it didn't fit.

### Out of scope

- Adjacent work that belongs in a separate issue
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
| `ctx.state`, `ctx.log`, `ctx.inputs` behave wrong on any tool | Yes | |
| Only one specific tool/resource is affected | | Yes |

When genuinely ambiguous, file against this server's repo and note that it might be a framework issue. The maintainer can transfer it upstream.

## Following Up

```bash
# View the issue body, then its comment thread (--comments without a TTY prints no body)
gh issue view <number>
gh issue view <number> --comments

# Add context
gh issue comment <number> --body "Additional findings..."

# List your open issues
gh issue list --author @me

# Close if resolved
gh issue close <number> --reason completed --comment "Fixed in <commit or PR>"
```

## Checklist

- [ ] Confirmed bug is in server code, not the framework
- [ ] Searched existing issues — no duplicate found; close matches commented instead of duplicated
- [ ] All secrets, credentials, and tokens redacted
- [ ] Title follows `type(scope): description` format
- [ ] Primary label assigned (`bug` / `enhancement` / `documentation`)
- [ ] If bug: version, runtime, repro steps, actual vs expected behavior included
- [ ] If feature: `Use case` and `Proposed behavior` present (the form's required fields), `Alternatives considered` third; Out of scope defined
- [ ] Inside the budget — ~150 words for a bug, ~250 for a feature, code and logs excluded — and every section past the form's fields earns its place

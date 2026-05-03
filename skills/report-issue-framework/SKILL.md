---
name: report-issue-framework
description: >
  File a bug or feature request against @cyanheads/mcp-ts-core when you hit a framework issue. Use when a builder, utility, context method, or config behaves contrary to the documented API — not for server-specific application bugs.
metadata:
  author: cyanheads
  version: "1.5"
  audience: external
  type: workflow
---

## When to Use

You've isolated a problem to `@cyanheads/mcp-ts-core` itself — not your server code, not a misconfiguration, not a missing peer dependency. Typical triggers:

- Framework builder (`tool()`, `resource()`, `prompt()`) rejects valid input or produces incorrect output
- `createApp()` or `createWorkerHandler()` fails on a valid config
- `Context` properties (`ctx.log`, `ctx.state`, `ctx.elicit`, etc.) behave contrary to docs
- A utility from `/utils`, `/errors`, `/auth`, `/storage`, `/services` returns wrong results or throws unexpectedly
- Type exports are incorrect or missing (compile error on documented usage)
- The definition linter (`bun run lint:mcp`) produces false positives or misses real violations

For general `gh` CLI workflows outside issue filing (PRs, workflows, API access), see the `github-cli` skill.

## Before Filing

1. **Confirm framework version** — `bun pm ls @cyanheads/mcp-ts-core` or check `node_modules/@cyanheads/mcp-ts-core/package.json`
2. **Check you're on latest** — `bun outdated @cyanheads/mcp-ts-core`. If behind, update and retest before filing.
3. **Isolate the issue** — reproduce with a minimal handler or standalone script. Strip server-specific services, config, and dependencies. If the bug disappears when isolated, it's likely in your server code.
4. **Search existing issues** — don't file duplicates:

```bash
gh issue list -R cyanheads/mcp-ts-core --search "your error message or keyword"
```

## Writing Well-Structured Issues

Good issues are scannable, concrete, and self-contained. These patterns apply to both bugs and features — the guidance targets any prose block (Description, Additional context, feature proposals).

- **Lead with specifics.** Name the tool, function, module, or symptom. "Currently `createApp()` throws `ConfigurationError` when `MCP_HTTP_PORT` is set to `0`" beats "There's a problem with the config." A reader should know what's broken or missing before the end of the first sentence.
- **Embed library/service links on first mention.** `[Hono](https://hono.dev/)`, `[linkedom](https://github.com/WebReflection/linkedom)`. Link to the canonical repo or homepage so readers can verify the dependency and reach docs in one click.
- **Use `owner/repo#N` for cross-repo issue references.** GitHub auto-renders them as linked references (e.g. `cyanheads/pubmed-mcp-server#34`). Bare `#N` only works for same-repo issues.
- **Add a `Related: #N` line** near the top when the issue grows from prior context (discussions, other issues, PRs). Makes provenance clickable.
- **Lead design sections with a philosophy sentence.** Bold a short principle before the tradeoff details — e.g. "Philosophy: **fail fast on config errors, degrade gracefully on runtime errors.**" Establishes the lens for the rest of the section.
- **Prefer Markdown tables for comparisons.** When showing options, tiers, strategies, or tradeoffs — tables are the highest-density format for scanning N rows × M attributes.
- **Separate `### Scope` from `### Out of scope`.** The latter is as important as the former — it pre-empts scope-creep debates in comments and signals you've thought about the boundaries.
- **Use `Depends on: owner/repo#N`** to declare ordering explicitly when implementation is blocked on another issue landing first.
- **Skip collaborator-framing sign-offs.** Lines like "Happy to open a PR", "let me know if you'd like", "willing to contribute", "if that's the preferred flow" read as noise. A PR link beats an offer; if you're the maintainer filing against your own repo, the offer is redundant. End the body at the last substantive point.

## Redact Before Posting

GitHub issues are **public**. Do not include secrets, credentials, API keys, or tokens. Redact sensitive values from env vars, headers, and logs before submitting. Replace with obvious placeholders: `REDACTED`, `sk-...REDACTED`. Do not rely on partial masking — partial keys can still be exploited.

## Filing a Bug

The repo has YAML form issue templates. Use `--web` to open the form in the browser (preferred when available), or pass `--title` + `--body` for non-interactive use.

### Browser (interactive)

```bash
gh issue create -R cyanheads/mcp-ts-core --template "Bug Report" --web
```

### CLI (non-interactive)

Structure the `--body` to match the template's form fields:

````bash
gh issue create -R cyanheads/mcp-ts-core \
  --title "bug(scope): concise description" \
  --label "bug" \
  --assignee "@me" \
  --body "$(cat <<'ISSUE'
### mcp-ts-core version

0.1.29

### Runtime

Bun

### Runtime version

Bun 1.2.x

### Transport

stdio

### OS

macOS 15.x

### Description

Brief explanation of the bug — what you expected vs what happened.

### Reproduction

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';

export const broken = tool('broken_example', {
  description: 'Minimal repro.',
  input: z.object({ id: z.string().describe('ID') }),
  output: z.object({
    name: z.string().describe('Name'),
    extra: z.string().optional().describe('Optional field'),
  }),
  async handler(input, ctx) {
    return { name: 'test' }; // omitting optional field causes validation error
  },
});
```

### Actual behavior

```
Error: Output validation failed: ...
```

### Expected behavior

Omitting an optional output field should pass validation.

### Additional context

Any workarounds, related issues, or observations.
ISSUE
)"
````

### Title conventions

Format: `bug(<scope>): concise description`

| Scope | When |
|:------|:-----|
| `tool` | Tool builder, handler, format, annotations |
| `resource` | Resource builder, handler, list, params |
| `prompt` | Prompt builder, generate, args |
| `context` | Context, logger, state, progress, elicit, sample |
| `config` | AppConfig, parseConfig, env parsing |
| `errors` | McpError, error factories, typed contracts (`errors[]` / `ctx.fail`), conformance lint, `httpErrorFromResponse`, auto-classification |
| `auth` | Auth modes, scope checking, JWT/OAuth |
| `storage` | StorageService, providers |
| `transport` | stdio/http transport, SSE, session handling |
| `worker` | createWorkerHandler, Worker runtime |
| `utils` | Utilities (formatting, parsing, pagination, etc.) |
| `linter` | Definition linter false positives/negatives |
| `types` | Type exports, type inference |
| `services` | LLM, Speech, Graph services |
| `deps` | Dependency issues, peer dep conflicts |

### Labels

Every issue needs exactly one primary label. Stack secondary labels on top when applicable.

**Primary (required — pick one):**

| Label | When |
|:------|:-----|
| `bug` | Something broken |
| `enhancement` | Feature request or improvement |
| `documentation` | Documentation is wrong, missing, or misleading |

**Secondary (optional — stack on top of primary):**

| Label | When |
|:------|:-----|
| `regression` | Worked before, broken after an update |
| `performance` | Memory, CPU, latency, or resource usage |
| `security` | Vulnerability, CVE, or hardening work |
| `breaking-change` | Fix/feature will break public API; requires a major bump |
| `surplus-token-idea` | Worth exploring when token budget allows |

Combine labels: `--label "bug" --label "regression"`.

### Attaching logs or stack traces

For long output, write to a file and attach:

```bash
bun run rebuild && bun run start:stdio 2>&1 | head -100 > /tmp/mcp-error.log

# As part of a new issue
gh issue create -R cyanheads/mcp-ts-core \
  --title "bug(transport): stdio crashes on large payload" \
  --label "bug" \
  --assignee "@me" \
  --body-file /tmp/mcp-error.log

# Or as a comment on an existing issue
gh issue comment <number> -R cyanheads/mcp-ts-core --body-file /tmp/mcp-error.log
```

## Filing a Feature Request

### Browser (interactive)

```bash
gh issue create -R cyanheads/mcp-ts-core --template "Feature Request" --web
```

### CLI (non-interactive)

Template below demonstrates the richer structure. Omit sections you don't need — simple requests don't require Flow / Design / Dependencies blocks.

````bash
gh issue create -R cyanheads/mcp-ts-core \
  --title "feat(scope): concise description" \
  --label "enhancement" \
  --assignee "@me" \
  --body "$(cat <<'ISSUE'
Concrete statement of what's currently missing or broken in the framework. Name the specific builder, utility, context method, or config field. Two or three sentences — the reader should know the gap before the end of the paragraph.

Related: #N

## Proposal

What you want the framework to do, in one paragraph. Link external libraries on first mention: [lib name](https://github.com/owner/repo). Include a short justification — what this gives us that we don't have today.

### Proposed API

```ts
import { withRetry } from '@cyanheads/mcp-ts-core/utils';

const result = await withRetry(() => fetchExternal(url), {
  maxAttempts: 3,
  backoff: 'exponential',
});
```

### Flow (optional)

Ordered steps — e.g. `trigger → resolve → fetch → degrade`. Useful when the change spans multiple phases or fallbacks.

### Design / Tradeoffs (optional)

Philosophy: **one-line principle in bold.**

| Option | Strengths | Weaknesses |
|:---|:---|:---|
| A | ... | ... |
| B | ... | ... |

### Scope

- Files or modules touched
- New exports, env vars, or config keys
- Tier (Tier 1 core / Tier 2 standard / Tier 3 optional peer dep)

### Out of scope

- What we're deliberately not doing
- Adjacent work that belongs in a separate issue

### Dependencies (optional)

- Depends on: owner/repo#N

### Alternatives considered

What you tried or evaluated instead, and why it didn't fit.
ISSUE
)"
````

## Following Up

```bash
# Check issue status
gh issue view <number> -R cyanheads/mcp-ts-core

# Add context or respond to maintainer questions
gh issue comment <number> -R cyanheads/mcp-ts-core --body "Additional context..."

# List your open issues
gh issue list -R cyanheads/mcp-ts-core --author @me
```

## Checklist

- [ ] Confirmed bug is in `@cyanheads/mcp-ts-core`, not server code
- [ ] Running latest (or documented) framework version
- [ ] Searched existing issues — no duplicate found
- [ ] All secrets, credentials, and tokens redacted
- [ ] Issue filed with: version, runtime, repro code, actual vs expected behavior

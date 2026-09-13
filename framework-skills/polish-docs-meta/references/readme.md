# README.md Conventions for MCP Servers

Structure and content guide for creating or updating a README for an MCP server built on `@cyanheads/mcp-ts-core`. If a README already exists, use this as a reference to audit and improve it — don't blindly rewrite sections that are already accurate.

The reference implementation is the `pubmed-mcp-server` README — https://github.com/cyanheads/pubmed-mcp-server/blob/main/README.md. Read it in full before writing, mirror its structure, reuse its non-server-specific content, and treat it as authoritative wherever this file lags behind it.

## Concision

A README is read once by a human deciding whether and how to use the server. It is not the changelog, not the schema, and not a proof that a feature works. Apply these on every pass, including re-runs over a README that is already accurate — accuracy is the floor, not the finish.

**Keep, always:** canonical identifiers (tool, resource, prompt, field, env var, and enum names, exactly as the code spells them); per-call caps and limits; input alternatives and which are required; the fields a caller branches on (discriminators, typed reasons, status values); feature flags and the env var that controls each; anything a caller must know before the first call. Brevity never earns semantic loss — if cutting a clause drops a fact from this list, the clause stays.

**Cut:** narration of how a guarantee is implemented ("so a value stays under the header it belongs to"); restated `.describe()` semantics — the schema carries them at call time; edge-case walkthroughs; the distinction between two similar values when the names already carry it; release-note accretion (a bullet that exists because a version added it, not because a reader needs it); marketing adjectives; a heading's intro sentence that repeats its Overview row.

**The test, per bullet:** would a reader lose a fact they need before their first call? If not, cut or merge. If a bullet needs more than two sentences, it is describing mechanism — keep the contract, drop the mechanism.

**Validate what stays.** Condensing is where wrong facts creep in — a merged bullet can silently combine two tools' limits or promote a default to a rule. Every identifier, cap, enum value, and default that survives the pass is checked against the definition file before the run ends. Never condense from memory of what the tool does; condense from the schema.

## Structure

Use this section order. Omit sections that don't apply (e.g., skip Docker/Workers if the server doesn't deploy there).

```text
# {Server Name}                         ← centered HTML block (h1 + tagline + surface count)
Info badges                             ← one centered row — Version, License, Docker, MCP SDK, npm, TypeScript, Bun
Install badges                          ← one centered row — Claude Desktop, Cursor, VS Code
Framework badge                         ← solo spotlight row — `Built on @cyanheads/mcp-ts-core` (cyan-300 #67E8F9)
[Public hosted callout if present]      ← centered HTML block, directly under the Framework badge
---
## Overview                             ← short description paragraph → `### Tools` / `### Resources` / `### Prompts` two-column tables
## Capability reference                 ← one `###` entry per primitive, heading tagged `<sub>tool|resource|prompt</sub>`, contract-shaped bullets
## Features                             ← one-sentence framework line + domain-specific bullets + agent-friendly output bullets
## Getting started                      ← hosted (if any), bunx/npx/docker configs, HTTP one-liner, prerequisites, install
## Configuration                        ← env var table + `.env.example` pointer
## Running the server                   ← dev, production, Workers/Docker
## Project structure                    ← directory/purpose table
## Development guide                    ← link to CLAUDE.md/AGENTS.md, key rules
## Contributing                         ← issues only
## License                              ← one line
```

## Section Guide

### Title Block

Centered HTML. The `<h1>` is the server name — use the scoped package name if published under a scope (e.g., `@cyanheads/my-mcp-server`). The `<p>` is a bold **action-first** one-liner: lead with what the server _does_, not what it _is_. List the headline actions/workflows, then end with `via MCP. STDIO or Streamable HTTP.` (or whichever transports apply). Avoid `MCP server for/that …` framings — they describe the wrapper instead of the capability. **Nest the surface count as a `<div>` inside the same `<p>`**, separated by `•` (U+2022 bullet) — not as a second `<p>`. This matches the shipping convention across `@cyanheads/*` servers.

```html
<div align="center">
  <h1>@cyanheads/my-mcp-server</h1>
  <p><b>Search projects, manage tasks, track teams via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-1.0.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/my-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/my-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/my-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/my-mcp-server/releases/latest/download/my-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=my-mcp-server&config=<BASE64_CONFIG>) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?<URLENCODED_JSON>)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>
```

Generate the `<BASE64_CONFIG>` (Cursor) and `<URLENCODED_JSON>` (VS Code) payloads — replace `<PACKAGE_NAME>` / `<SHORT_NAME>` and add `env` only for required API keys:

```bash
# Cursor: base64-encoded JSON. Split command/args, add env when keys are needed.
echo -n '{"command":"npx","args":["-y","<PACKAGE_NAME>"],"env":{"API_KEY":"your-api-key"}}' | base64
# Without env (no required keys):
echo -n '{"command":"npx","args":["-y","<PACKAGE_NAME>"]}' | base64

# VS Code: URL-encoded JSON. Same shape plus a `name` field.
node -p 'encodeURIComponent(JSON.stringify({name:"<SHORT_NAME>",command:"npx",args:["-y","<PACKAGE_NAME>"],env:{API_KEY:"your-api-key"}}))'
# Without env:
node -p 'encodeURIComponent(JSON.stringify({name:"<SHORT_NAME>",command:"npx",args:["-y","<PACKAGE_NAME>"]}))'
```

Both clients use the same `{command, args, env}` shape; VS Code adds a top-level `name`. Omit `env` entirely when no API keys are needed — don't include empty objects or framework-only vars like `MCP_TRANSPORT_TYPE`. Install links route through HTTPS endpoints (`cursor.com/en/install-mcp`, `vscode.dev/redirect`) because GitHub-rendered markdown strips non-HTTP schemes — a raw `cursor://` or `vscode:` link won't click through. Omit any install badge whose target doesn't apply (e.g. no `.mcpb` bundle → drop the Claude Desktop badge).

The header tagline must match the `package.json` `description`.

**Badge selection:** All info badges use `style=flat-square`; install badges use `style=for-the-badge`. Include what applies — don't add badges for things the server doesn't have:

| Badge | Row | When to include |
|:------|:----|:----------------|
| Version | info | Always — link to `CHANGELOG.md` |
| License | info | Always |
| Docker | info | Published to ghcr.io or Docker Hub |
| MCP SDK | info | Always — show the `@modelcontextprotocol/server` version |
| npm | info | Published to npm |
| TypeScript | info | Always |
| Bun | info | If using Bun (standard for this framework) |
| MCP Spec | info | Optional — rarely included; the SDK badge usually suffices |
| Status | info | Optional — Stable, Beta, etc. |
| Code Coverage | info | If coverage is tracked |
| Install in Claude Desktop | install | Repo publishes an `.mcpb` bundle on GitHub Releases (orange `D97757`, anthropic logo) |
| Install in Cursor | install | Published to npm — uses the official `cursor://` deep link |
| Install in VS Code | install | Published to npm — uses the official `vscode:mcp/install` deep link |
| Framework | spotlight | Always — links to `@cyanheads/mcp-ts-core` on npm. Cyan-300 (`67E8F9`) for dark text. **Solo on its own row.** |

**Layout:** three centered `<div>` blocks in a fixed order. (1) **Info row** — one line with all info badges in the order above (release/license/distribution first, then SDK/ecosystem/language). (2) **Install + spotlight block** — install badges on one line, then a blank line, then the Framework badge alone on its own line as the brand link back to the framework. (3) **Public hosted callout** if applicable (see next section). Add a `---` horizontal rule after the whole header block.

Omit a whole row when nothing in it applies — e.g. a server with no `.mcpb` bundle and not on npm has no install row at all, so the install + spotlight block collapses to just the Framework badge.

### Public Hosted Callout (if present)

If a public hosted instance is available, **promote it to a top-level callout** in its own centered `<div>` immediately below the Framework badge — don't bury it inside Getting Started. This is the highest-value piece of information for a visitor who wants to try the server with zero install.

```html
<div align="center">

**Public Hosted Server:** [https://my-server.example.com/mcp](https://my-server.example.com/mcp)

</div>
```

Keep the full connection-config JSON block inside a `### Public Hosted Instance` subsection under Getting Started (covered below). This callout is just the visibility pointer.

### Overview

The first section after the header rule. Two parts: a short description paragraph, then one two-column table per primitive type. This is what a visitor reads to decide whether the server is for them, so it must scan in one screen.

**Description paragraph:** two or three sentences — what the server sits on top of (the upstream APIs), what a user can do with it (the headline workflows, action verbs), and how it runs (transports, the hosted endpoint if any). Not a count, and not "an MCP server that…" framing.

**Primitive tables:** a `### Tools` table, then `### Resources` and `### Prompts` tables when the server has any. Omit a heading whose table would be empty, but keep a one-row table rather than folding it into another. Two columns, Name/Description, one-line descriptions — the detail lives in the Capability reference.

```markdown
## Overview

An MCP server over the Acme v2 API. Search projects, manage tasks, and track team activity from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `acme_search_projects` | Search projects by name, status, or team, with pagination and field selection |
| `acme_get_task` | Fetch one or more tasks by ID, with full or summary data |

### Resources

| Resource | Description |
|:---|:---|
| `acme://projects/{projectId}` | Project details by ID |

### Prompts

| Prompt | Description |
|:---|:---|
| `project_summary` | Summarize a project's status and open tasks |
```

Derive every row from the actual definitions — real names and descriptions from the Zod schemas.

If resource data is also reachable through tools, say so in one line under the Resources table; many MCP clients are tool-only and never surface resources. If a prompt has a design doc, link it in one line under the Prompts table.

### Capability reference

One `###` entry per primitive — every tool, resource, and prompt, in the same order as the Overview tables — with the heading tagged by type in a `<sub>` so a reader scanning headings can tell them apart without a section break. Entries are separated by `---` rules. No intro sentence under the heading — the Overview row already said what it does — go straight to bullets.

**Bullet density is contract shape, not changelog narration.** Three to six bullets covering: accepted inputs and per-call caps; the output's discriminating fields; the failure shape (typed reasons, per-item status); the knobs (filters, budgets, feature flags). Behavior a caller discovers from the schema at call time — field-by-field semantics, edge-case handling, the mechanism behind a guarantee — belongs in the definition's `.describe()` text, not here. An entry running past six bullets has started transcribing release notes.

```markdown
## Capability reference

### `acme_search_projects` <sub>tool</sub>

- Free-text query plus typed `status` / `phase` filters; up to 100 per page, offset pagination
- Optional `fields` selection to trim the response
- Results carry `source` and `fetchedAt` so callers can reason about freshness

---

### `acme_get_task` <sub>tool</sub>

- Up to 5 task IDs per call; `detail: "full"` adds subtasks, comments, attachments, and history
- Per-item `status` rows — a partial batch returns the resolved tasks alongside typed errors for the rest

---

### `acme://projects/{projectId}` <sub>resource</sub>

- Project record as `application/json` — name, status, owners, open task count
- `projectId` comes from `acme_search_projects`

---

### `project_summary` <sub>prompt</sub>

- Arguments: `projectId` required; `includeClosed` (`"true"` / `"false"`) optional
- Returns two messages — an assistant framing message and a user message carrying the summary request
```

Link an examples file from an entry when one exists: `[View detailed examples](./examples/acme_search_projects.md)`.

### Features

A one-sentence framework line naming what a user gets from the framework (transports, auth, storage, observability — not how the code is organized; contributor facts belong in the Development guide), then two bullet groups: domain-specific capabilities, then agent-friendly output design.

```markdown
## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Acme-specific:

- Type-safe client for the Acme v2 API
- Automatic cleaning and simplification of API responses for agent consumption
- Workflow tools parallelize related sub-requests under a configurable concurrency limit

Agent-friendly output:

- Provenance on every response — source labels, effective-query echo, and confidence/coverage caveats so agents can reason about trust
- Graceful partial failure — batch tools return per-item success/error rows instead of failing the request, with structured status codes and actionable next-step text
- Discriminated output contracts — typed status and source fields let callers branch on data, not string parsing
```

The **Agent-friendly output** subsection documents output-design choices that make the server work well as an AI-agent backend. Include it when the server exhibits at least two of these patterns. Write bullets grounded in the server's actual behavior — not aspirational framework capabilities. Examples of what fits:

- Provenance: source labels (`viaSource`, `source`), license/access-level fields, effective-query echo, best-effort warnings on lossy tiers
- Partial failure: per-item status in batch operations, structured error rows alongside successes, recovery hints ("Next Step" text)
- Discriminated outputs: union types on `source` or `status` fields, typed `unavailable` reasons, per-tier outcome traces (`triedTiers`)
- Response shaping: stripping upstream noise, normalizing inconsistent schemas, deduplicating nested structures

### Getting Started

Lead with the lowest-friction option. If a public hosted instance exists, show that first. Then the **three standard install configs in order — `bunx`, `npx`, `docker run`** — followed by the HTTP one-liner quickstart, then prerequisites and install steps.

**Standard three-block pattern** (the house style across shipping `@cyanheads/*` servers):

```markdown
## Getting started

Add the following to your MCP client configuration file. See [`docs/api-key.md`](./docs/api-key.md) for how to generate an API key.

\`\`\`json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/my-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "ACME_API_KEY": "your-api-key"
      }
    }
  }
}
\`\`\`

Or with npx (no Bun required):

\`\`\`json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/my-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "ACME_API_KEY": "your-api-key"
      }
    }
  }
}
\`\`\`

Or with Docker:

\`\`\`json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "ACME_API_KEY=your-api-key",
        "ghcr.io/cyanheads/my-mcp-server:latest"
      ]
    }
  }
}
\`\`\`

For Streamable HTTP, set the transport and start the server:

\`\`\`sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 ACME_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
\`\`\`
```

Refer to "your MCP client configuration file" generically — don't prescribe `claude_desktop_config.json` by name. Different clients use different config paths and the server isn't client-specific.

**If a public hosted instance exists**, precede the three-block pattern with a `### Public Hosted Instance` subsection and wrap the local configs in a `### Self-Hosted / Local` subsection:

```markdown
### Public Hosted Instance

A public instance is available at `https://my-server.example.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

\`\`\`json
{
  "mcpServers": {
    "my-server": {
      "type": "streamable-http",
      "url": "https://my-server.example.com/mcp"
    }
  }
}
\`\`\`

### Self-Hosted / Local

[bunx / npx / docker blocks here]
```

**Prerequisites:** Include a Bun version line and any domain-specific setup (API key format, rate-limit tiers, required accounts). Don't just list Bun — readers need to know what else to prepare.

```markdown
### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- An Acme API key — see [`docs/api-key.md`](./docs/api-key.md) for how to generate one.
```

**Installation:** Standard four steps (clone, cd, install, configure env):

```markdown
### Installation

1. **Clone the repository:**

\`\`\`sh
git clone https://github.com/cyanheads/my-mcp-server.git
\`\`\`

2. **Navigate into the directory:**

\`\`\`sh
cd my-mcp-server
\`\`\`

3. **Install dependencies:**

\`\`\`sh
bun install
\`\`\`

4. **Configure environment:**

\`\`\`sh
cp .env.example .env
# edit .env and set required vars
\`\`\`
```

Omit the clone/install steps if the server is npm-only (not meant to be cloned).

### Configuration

Table of environment variables. Include framework vars only if the server uses non-default values. Mark required vars with bold **Required.** in the description rather than a separate column. **Close with a pointer to `.env.example`** for the full list of optional overrides.

```markdown
## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `ACME_API_KEY` | **Required.** API key for the Acme service. | — |
| `ACME_BASE_URL` | API base URL. | `https://api.acme.com` |
| `ACME_TIMEOUT_MS` | Per-request timeout in milliseconds. | `60000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.
```

Source from the server config Zod schema and `.env.example`.

### Running the Server

Separate from Getting Started. Show dev, build + run, and Workers/Docker deployment if applicable.

```markdown
## Running the server

### Local development

- **Build and run:**

  \`\`\`sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  \`\`\`

- **Run checks and tests:**

  \`\`\`sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  \`\`\`

### Docker

\`\`\`sh
docker build -t my-mcp-server .
docker run --rm -e ACME_API_KEY=your-key -p 3010:3010 my-mcp-server
\`\`\`

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/my-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

### Cloudflare Workers

1. **Build the Worker bundle:**

\`\`\`sh
bun run build:worker
\`\`\`

2. **Deploy:**

\`\`\`sh
bun run deploy:prod
\`\`\`
```

Include the Docker or Workers subsection only if the server supports it. The Docker trailing paragraph (log directory, OTEL build arg) is important — it documents Dockerfile behavior that isn't obvious from the build command.

### Project Structure

Directory/purpose table orienting contributors to the codebase.

```markdown
## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources/prompts and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). |
| `src/services` | Domain service integrations. |
| `tests/` | Unit and integration tests mirroring `src/`. |
```

### Development Guide

Brief — link to CLAUDE.md/AGENTS.md for full details. State 3-4 key rules. **Include the "validate → normalize → never fabricate" bullet** — it's the canonical anti-hallucination convention for external API wrappers and reinforces the framework's `no fabricated signal` principle.

```markdown
## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
```

### Contributing

Issues only. Never write "pull requests are welcome" or any PR invitation — contributions arrive as issues, and `.github/CONTRIBUTING.md` says the same.

```markdown
## Contributing

Issues are welcome. Run checks and tests before submitting:

\`\`\`sh
bun run devcheck
bun run test
\`\`\`
```

### License

One line referencing the LICENSE file.

```markdown
## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
```

## Principles

- **Gold standard first.** The `pubmed-mcp-server` README is the reference implementation; where it and this file disagree, the README wins.
- **Accuracy over aspiration.** Only document what exists. Don't describe planned features as if they're implemented.
- **Surface first.** The primitives are the most important content. The Overview leads with them.
- **Tables over prose** for structured data (tools, config, directories). Scannable and diff-friendly.
- **Overview + reference.** Overview tables for scanning; a Capability reference entry for every primitive, none skipped, with contract-shaped bullets rather than release-note narration.
- **Concise on every pass.** Re-runs tighten as well as correct; see § *Concision* for what survives a cut and what doesn't, and validate everything that survives.
- **One two-column table per primitive type.** Tools, resources, and prompts each get a small heading and a Name/Description table, even when a table has one row. No `Type` column — most servers are tool-heavy and many have no resources or prompts.
- **Promote hosted instances.** If there's a public URL, put it in a top-level callout under the badges — not buried in Getting Started.
- **Three install configs.** `bunx`, `npx`, `docker run` in that order. Each as a complete MCP-client JSON block.
- **Real names from code.** Tool names, env vars, and URIs must match the source exactly. Copy from the definitions, don't paraphrase.
- **Lowest friction first.** Hosted instance > bunx > npx > docker > clone.
- **No badges unless publishing.** Badges for unpublished packages are noise.
- **Client-agnostic framing.** Say "your MCP client configuration file", not `claude_desktop_config.json`.
- **Keep it current.** Update the README whenever tools are added or removed.

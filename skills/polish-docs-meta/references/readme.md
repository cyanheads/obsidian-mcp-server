# README.md Conventions for MCP Servers

Structure and content guide for creating or updating a README for an MCP server built on `@cyanheads/mcp-ts-core`. If a README already exists, use this as a reference to audit and improve it — don't blindly rewrite sections that are already accurate.

## Structure

Use this section order. Omit sections that don't apply (e.g., skip Docker/Workers if the server doesn't deploy there).

```text
# {Server Name}                         ← centered HTML block
[Public hosted callout if present]      ← centered HTML block, directly under badges
Badges row                              ← npm, Docker, Version, Framework, MCP SDK, License, TS, Bun, Coverage
---
## Tools                                ← grouping sentence → summary table → per-tool subsections
## Resources and prompts (if any)       ← single combined table (Type / Name / Description)
## Features                             ← framework bullets + domain-specific bullets
## Getting started                      ← hosted (if any), bunx/npx/docker configs, HTTP one-liner, prerequisites, install
## Configuration                        ← env var table + `.env.example` pointer
## Running the server                   ← dev, production, Workers/Docker
## Project structure                    ← directory/purpose table
## Development guide                    ← link to CLAUDE.md, key rules
## Contributing                         ← brief
## License                              ← one line
```

## Section Guide

### Title Block

Centered HTML. The `<h1>` is the server name — use the scoped package name if published under a scope (e.g., `@cyanheads/my-mcp-server`). The `<p>` is a bold one-liner: what the server wraps, key capabilities, transport/deployment options. **Nest the surface count as a `<div>` inside the same `<p>`**, separated by `•` (U+2022 bullet) — not as a second `<p>`. This matches the shipping convention across `@cyanheads/*` servers.

```html
<div align="center">
  <h1>@cyanheads/my-mcp-server</h1>
  <p><b>MCP server for the Acme API — search projects, manage tasks, track teams. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/my-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/my-mcp-server) [![Version](https://img.shields.io/badge/Version-1.0.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>
```

The header tagline must match the `package.json` `description`.

**Badge selection:** All badges use `style=flat-square`. Include what applies — don't add badges for things the server doesn't have:

| Badge | When to include |
|:------|:----------------|
| npm | Published to npm |
| Docker | Published to ghcr.io or Docker Hub |
| Version | Always — link to CHANGELOG.md |
| Framework | Always — links to `@cyanheads/mcp-ts-core` on npm |
| MCP SDK | Always — show the `@modelcontextprotocol/sdk` version |
| License | Always |
| TypeScript | Always |
| Bun | If using Bun (standard for this framework) |
| MCP Spec | Optional — rarely included; the SDK badge usually suffices |
| Status | Optional — Stable, Beta, etc. |
| Code Coverage | If coverage is tracked |

Add a `---` horizontal rule after the badge block.

### Public Hosted Callout (if present)

If a public hosted instance is available, **promote it to a top-level callout** immediately below the badge block — don't bury it inside Getting Started. This is the highest-value piece of information for a visitor who wants to try the server with zero install.

```html
<div align="center">

**Public Hosted Server:** [https://my-server.example.com/mcp](https://my-server.example.com/mcp)

</div>
```

Keep the full connection-config JSON block inside a `### Public Hosted Instance` subsection under Getting Started (covered below). This callout is just the visibility pointer.

### Tools

This is the most important section — it tells humans and LLMs exactly what the server exposes. Three layers: a **grouping framing sentence**, a summary table, then per-tool subsections for tools with non-trivial behavior.

**Grouping framing sentence:** Lead with one sentence that explains how the tool surface is organized. Richer than a bare count — tells the reader what mental model to apply. Examples:

- "Seventeen tools grouped by shape — workflow helpers orchestrate common flows end-to-end, primitive tools expose fine-grained CRUD, and the instruction tool returns procedural guidance merged with live account state."
- "Nine tools for working with PubMed and NCBI data:"
- "Five tools covering project lifecycle — discovery, task CRUD, and team analytics."

If the tools aren't meaningfully grouped, a single sentence count ("Seven tools for working with Acme data:") is acceptable.

**Summary table:**

```markdown
## Tools

Seven tools for working with Acme data:

| Tool Name | Description |
|:----------|:------------|
| `acme_search_projects` | Search projects by name, status, or team. |
| `acme_create_task` | Create a new task in a project. |
| `acme_get_task` | Fetch one or more tasks by ID, with full or summary data. |
```

**Per-tool subsections:**

Below the table, add a `### tool_name` subsection for each tool that has meaningful detail beyond its one-line description. Include:

- Bullet list of key capabilities (what inputs it accepts, what filtering/pagination it supports, edge cases it handles)
- Link to example file if one exists: `[View detailed examples](./examples/tool_name.md)`
- Separate subsections with `---` horizontal rules

```markdown
### `acme_search_projects`

Search for projects using free-text queries and filters.

- Full-text search plus typed status/phase filters
- Geographic proximity filtering by coordinates and distance
- Pagination (up to 100 per page) and sorting
- Field selection to limit response size

[View detailed examples](./examples/acme_search_projects.md)

---

### `acme_get_task`

Fetch one or more tasks by ID, with full data or concise summaries.

- Batch fetch up to 5 tasks at once
- Full data includes subtasks, comments, attachments, and history
- Partial success reporting when some tasks in a batch fail
```

Skip the per-tool subsection for simple tools where the table description says everything (e.g., an `acme_get_field_values` lookup tool).

### Resources and Prompts (combined)

**Use a single combined table with a `Type` column** rather than separate `## Resources` and `## Prompts` sections. This is the shipping convention — it scales better when a server has only 1 or 2 of each, and co-locates related content.

```markdown
## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `acme://projects/{projectId}` | Project details by ID |
| Resource | `acme://tasks/{taskId}` | Task details by ID |
| Prompt | `project_summary` | Summarize a project's status and open tasks |
```

Use singular ("Resource and prompt") if there's only one of each.

**Always include the tool-coverage note** directly under the table. Many MCP clients are tool-only and don't surface resources — this tells both the reader and downstream agents that the data is still reachable:

```markdown
All resource data is also reachable via tools. Large collections (`projects`, `tasks`) are not exposed as resources — use the `list` operation on the corresponding tool instead.
```

If a prompt has an associated design doc or reference, link it in the same paragraph: `Design reference for the prompt: [\`docs/email-design-playbook.md\`](./docs/email-design-playbook.md).`

Derive all tool/resource/prompt rows directly from the actual definitions. Use the real names and descriptions from the Zod schemas.

### Features

Two subsection groups: framework capabilities, then domain-specific capabilities. Bullet lists, not prose.

```markdown
## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Acme-specific:

- Type-safe client for the Acme v2 API
- Automatic cleaning and simplification of API responses for agent consumption
- Workflow tools parallelize related sub-requests under a configurable concurrency limit
```

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v22+).
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
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.
```

Source from the server config Zod schema and `.env.example`.

### Running the Server

Separate from Getting Started. Show dev, build + run, and Workers/Docker deployment if applicable.

```markdown
## Running the server

### Local development

- **Hot-reload dev mode:**

  \`\`\`sh
  bun run dev:stdio
  bun run dev:http
  \`\`\`

- **Build and run the production version:**

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

Brief — link to CLAUDE.md for full details. State 3-4 key rules. **Include the "validate → normalize → never fabricate" bullet** — it's the canonical anti-hallucination convention for external API wrappers and reinforces the framework's `no fabricated signal` principle.

```markdown
## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields
```

### Contributing

```markdown
## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

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

- **Accuracy over aspiration.** Only document what exists. Don't describe planned features as if they're implemented.
- **Tools first.** The tool surface is the most important content. Lead with it.
- **Tables over prose** for structured data (tools, config, directories). Scannable and diff-friendly.
- **Two-layer tool docs.** Grouping sentence + summary table for quick scanning, per-tool subsections for detail. Skip subsections for trivial tools.
- **Combined resources + prompts.** Single table with a `Type` column, not separate sections.
- **Promote hosted instances.** If there's a public URL, put it in a top-level callout under the badges — not buried in Getting Started.
- **Three install configs.** `bunx`, `npx`, `docker run` in that order. Each as a complete MCP-client JSON block.
- **Real names from code.** Tool names, env vars, and URIs must match the source exactly. Copy from the definitions, don't paraphrase.
- **Lowest friction first.** Hosted instance > bunx > npx > docker > clone.
- **No badges unless publishing.** Badges for unpublished packages are noise.
- **Client-agnostic framing.** Say "your MCP client configuration file", not `claude_desktop_config.json`.
- **Keep it current.** Update the README whenever tools are added or removed.

# package.json Metadata

Fields that may still be empty or generic from scaffolding. Check each one and fill in anything that's missing or placeholder.

## Fields to Check

| Field | Default / Scaffolded | What It Should Be |
|:------|:---------------------|:------------------|
| `name` | `{{PACKAGE_NAME}}` (substituted by init) | Verify it communicates the server's domain at a glance. A human or agent scanning a list should know what this server does from the name alone. Prefer full names over ambiguous abbreviations (`libofcongress` not `loc`, `federal-reserve` not `fred`). Non-obvious acronyms get a descriptive suffix (`eia-energy`, `bls-labor`). Use scoped name if publishing (`@org/my-server`). |
| `version` | `0.1.0` | Keep for initial development. Bump via the `release-and-publish` skill. |
| `mcpName` | _(often missing)_ | Reverse-domain identifier: `"io.github.{owner}/{repo}"`. Used in `server.json` `name` field and Dockerfile OCI labels. |
| `description` | `""` (empty) | One **action-first** sentence — lead with the actions/workflows, end with `via MCP. STDIO or Streamable HTTP.` (or the transports that apply). Example: `"Search projects, manage tasks, track teams via MCP. STDIO or Streamable HTTP."` Avoid `"MCP server for/that …"` framings. Appears on npm and in `npm search`; the README header tagline and `server.json` `description` derive from this (server.json drops the `via MCP …` suffix). |
| `repository` | _(often missing)_ | `{ "type": "git", "url": "git+https://github.com/org/repo.git" }` |
| `homepage` | _(often missing)_ | Repository URL or docs URL. |
| `bugs` | _(often missing)_ | `{ "url": "https://github.com/org/repo/issues" }` |
| `author` | _(often missing)_ | `"Name <email> (https://author-site.example)"`. The URL is the **author's** site, not the repo — `repository`/`homepage` already carry that. Name should match the LICENSE copyright holder. |
| `keywords` | `["mcp", "mcp-server", "model-context-protocol"]` | Add domain-specific keywords. Keep the MCP ones. |
| `license` | `Apache-2.0` | Change if using a different license. Must match the LICENSE file. |

## Fields That Should Be Correct

These are set by `init` and generally don't need changes. Verify they're present and correct:

| Field | Value | Why |
|:------|:------|:----|
| `type` | `"module"` | ESM — required by the framework |
| `main` | `"dist/index.js"` | Entry point after build |
| `types` | `"dist/index.d.ts"` | TypeScript declarations |
| `files` | `["dist/"]` | What npm publishes |
| `engines` | `{ "node": ">=24.0.0", "bun": ">=1.3.0" }` | Node runs the built `dist/`; Bun is the dev floor |
| `packageManager` | `"bun@1.3.14"` | Pins the dev package manager; keep current with the framework's Bun version |
| `scripts` | _(various)_ | Build, dev, test scripts |
| `dependencies` | `@cyanheads/mcp-ts-core` | Core framework |

## Keywords

Good keywords improve npm discoverability. Include:

1. The base MCP keywords (already scaffolded): `mcp`, `mcp-server`, `model-context-protocol`
2. The domain: `project-management`, `task-tracking`, `acme-api`
3. The transport if non-default: `http`, `sse`, `cloudflare-workers`

Example:

```json
"keywords": [
  "mcp",
  "mcp-server",
  "model-context-protocol",
  "acme",
  "project-management",
  "task-tracking"
]
```

## Publishing Checklist

If publishing to npm, also verify these (skip for private/internal servers):

- `name` doesn't conflict with an existing package
- `publishConfig.access` is `"public"` (already set by init for scoped packages)
- `files` includes everything needed at runtime (`dist/` is correct for most servers)
- `bin` is set if the server should be runnable via `npx` (add `"bin": { "my-server": "dist/index.js" }`)

The `bin` field is the most commonly missed one. Without it, `npx my-server` won't work — the client config must use `node dist/index.js` instead.

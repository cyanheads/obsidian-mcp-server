# server.json — MCP Server Manifest

Machine-readable metadata file following the [official MCP server manifest schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json). Describes the server for MCP registries, clients, and tooling. Place at the project root.

## When to Create

Create `server.json` if:

- Publishing to npm or a registry
- The server will be listed in an MCP client's server catalog
- You want machine-readable metadata beyond what `package.json` provides

Skip for internal/private servers where discoverability doesn't matter.

## Schema

The manifest uses the official MCP schema. A typical server has two package entries — one for stdio, one for HTTP:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.org-name/my-mcp-server",
  "description": "Search projects, manage tasks, track teams.",
  "repository": {
    "url": "https://github.com/org-name/my-mcp-server",
    "source": "github"
  },
  "version": "1.0.0",
  "packages": [
    {
      "registryType": "npm",
      "registryBaseUrl": "https://registry.npmjs.org",
      "identifier": "@org-name/my-mcp-server",
      "runtimeHint": "npx",
      "version": "1.0.0",
      "environmentVariables": [
        {
          "name": "ACME_API_KEY",
          "description": "API key for the Acme service.",
          "format": "string",
          "isRequired": true
        },
        {
          "name": "MCP_LOG_LEVEL",
          "description": "Sets the minimum log level for output (e.g., 'debug', 'info', 'warn').",
          "format": "string",
          "isRequired": false,
          "default": "info"
        }
      ],
      "transport": {
        "type": "stdio"
      }
    },
    {
      "registryType": "npm",
      "registryBaseUrl": "https://registry.npmjs.org",
      "identifier": "@org-name/my-mcp-server",
      "runtimeHint": "npx",
      "version": "1.0.0",
      "environmentVariables": [
        {
          "name": "ACME_API_KEY",
          "description": "API key for the Acme service.",
          "format": "string",
          "isRequired": true
        },
        {
          "name": "MCP_TRANSPORT_TYPE",
          "description": "Selects the HTTP transport.",
          "format": "string",
          "value": "http"
        },
        {
          "name": "MCP_HTTP_HOST",
          "description": "The hostname for the HTTP server.",
          "format": "string",
          "isRequired": false,
          "default": "127.0.0.1"
        },
        {
          "name": "MCP_HTTP_PORT",
          "description": "The port to run the HTTP server on.",
          "format": "string",
          "isRequired": false,
          "default": "3010"
        },
        {
          "name": "MCP_HTTP_ENDPOINT_PATH",
          "description": "The endpoint path for the MCP server.",
          "format": "string",
          "isRequired": false,
          "default": "/mcp"
        },
        {
          "name": "MCP_AUTH_MODE",
          "description": "Authentication mode to use: 'none', 'jwt', or 'oauth'.",
          "format": "string",
          "isRequired": false,
          "default": "none"
        },
        {
          "name": "MCP_LOG_LEVEL",
          "description": "Sets the minimum log level for output (e.g., 'debug', 'info', 'warn').",
          "format": "string",
          "isRequired": false,
          "default": "info"
        }
      ],
      "transport": {
        "type": "streamable-http",
        "url": "http://localhost:3010/mcp"
      }
    }
  ]
}
```

## Field Reference

### Top-Level

| Field | Required | Description |
|:------|:---------|:------------|
| `$schema` | Yes | Always `"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"` |
| `name` | Yes | Reverse-domain identifier: `io.github.{owner}/{repo}`. Matches `mcpName` in `package.json`. |
| `description` | Yes | One-line description of the server. **Action-first** — lead with the actions/workflows (e.g., `"Search projects, manage tasks, track teams."`), not `"MCP server for …"`. Drop the `via MCP. STDIO …` suffix that the `package.json` description carries — registry context already implies MCP. |
| `repository` | No | `{ "url": "https://github.com/...", "source": "github" }` |
| `version` | Yes | Semver version. Must match `package.json` version. |
| `packages` | Yes | Array of package entries — one per transport/runtime combo. |

### Package Entry

Each entry in `packages[]` describes one way to install and run the server:

| Field | Required | Description |
|:------|:---------|:------------|
| `registryType` | Yes | `"npm"` for npm packages. |
| `registryBaseUrl` | Yes | `"https://registry.npmjs.org"` for npm. |
| `identifier` | Yes | The npm package name (e.g., `@org/my-server`). |
| `runtimeHint` | No | `"npx"` for npm packages, the registry's runner for npm. A client that runs the hint as the command launches `<runtimeHint> <identifier>@<version>`, so `"node"` or `"bun"` there names a file path that does not exist. |
| `version` | Yes | Package version. Must match top-level `version`. |
| `packageArguments` | No | Arguments appended to the launch command. Omit it: a framework server's bin reads none (see Package Arguments). |
| `environmentVariables` | No | Array of env var descriptors (see below). |
| `transport` | Yes | `{ "type": "stdio" }` or `{ "type": "streamable-http", "url": "..." }` |

### Environment Variable

| Field | Required | Description |
|:------|:---------|:------------|
| `name` | Yes | The env var name (e.g., `ACME_API_KEY`). |
| `description` | Yes | Human-readable purpose. |
| `format` | No | `"string"` (default). |
| `isRequired` | No | `true` if the server won't start without it. |
| `default` | No | Value used when the user sets none. The user can change it. |
| `value` | No | Fixed value the client always sets; the user cannot change it. Use it for a setting the entry depends on, such as `MCP_TRANSPORT_TYPE` on the HTTP entry. |

### Package Arguments

A registry client launches an npm entry as `npx <identifier>@<version> <packageArguments>`, with the entry's `environmentVariables` set. That runs the package's bin (`dist/index.js`), not an npm script, and the bin reads no arguments: it takes its transport from `MCP_TRANSPORT_TYPE`. Leave `packageArguments` out. A `run` + `start:stdio` / `start:http` pair is npm-script syntax that reaches the bin as argv it ignores, and `lint:packaging` rejects it on any npm entry.

### Transport Patterns

**stdio only** (one package entry). stdio is the framework's default transport, so the entry needs no transport variable:

```json
"transport": { "type": "stdio" }
```

**stdio + HTTP** (two package entries): the stdio entry above, plus an entry with `{ "type": "streamable-http", "url": "http://localhost:{port}/mcp" }` that fixes the transport in its `environmentVariables`:

```json
{ "name": "MCP_TRANSPORT_TYPE", "description": "Selects the HTTP transport.", "format": "string", "value": "http" }
```

Use `value`, not `default`: a default is user-editable, and without the variable the server starts on stdio. `lint:packaging` fails a `streamable-http` npm entry that does not set it to `"http"`. The HTTP entry also carries env vars for host, port, endpoint path, and auth mode.

## Generating / Updating

If `server.json` doesn't exist, create it from the surface area audit. If it exists, diff against current state and update stale fields.

1. Set `$schema` to the official MCP schema URL
2. Set `name` to `io.github.{owner}/{repo}` — match `mcpName` from `package.json`
3. Sync `version` and `description` from `package.json`
4. Set `repository` from `package.json` repository URL, with `"source": "github"`
5. Create package entries — one for stdio, one for HTTP (if the server supports both transports)
6. Set `identifier` to the npm package name from `package.json`
7. Set `runtimeHint` to `"npx"`
8. Leave out `packageArguments` — the bin takes its transport from `MCP_TRANSPORT_TYPE`, not from arguments
9. Populate `environmentVariables` — server-specific required vars in both entries, `MCP_TRANSPORT_TYPE` with `"value": "http"` and the transport-specific vars (host, port, endpoint, auth) only in the HTTP entry, `MCP_LOG_LEVEL` in both
10. All three `version` fields (top-level, and each package entry) must be identical and match `package.json`

## Keeping in Sync

`server.json` is a snapshot. Update it when:

- Bumping the version (three places: top-level + each package entry)
- Adding or removing required environment variables
- Changing the default port or endpoint path

The `polish-docs-meta` skill handles both creation and updates.

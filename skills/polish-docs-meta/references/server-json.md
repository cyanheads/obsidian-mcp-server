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
  "description": "MCP server for the Acme API — project management and task tracking.",
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
      "runtimeHint": "bun",
      "version": "1.0.0",
      "packageArguments": [
        { "type": "positional", "value": "run" },
        { "type": "positional", "value": "start:stdio" }
      ],
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
      "runtimeHint": "bun",
      "version": "1.0.0",
      "packageArguments": [
        { "type": "positional", "value": "run" },
        { "type": "positional", "value": "start:http" }
      ],
      "environmentVariables": [
        {
          "name": "ACME_API_KEY",
          "description": "API key for the Acme service.",
          "format": "string",
          "isRequired": true
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
| `description` | Yes | One-line description of the server. |
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
| `runtimeHint` | No | `"bun"` or `"node"`. Tells clients which runtime to use. |
| `version` | Yes | Package version. Must match top-level `version`. |
| `packageArguments` | No | Array of `{ "type": "positional", "value": "..." }` args passed after the package command. |
| `environmentVariables` | No | Array of env var descriptors (see below). |
| `transport` | Yes | `{ "type": "stdio" }` or `{ "type": "streamable-http", "url": "..." }` |

### Environment Variable

| Field | Required | Description |
|:------|:---------|:------------|
| `name` | Yes | The env var name (e.g., `ACME_API_KEY`). |
| `description` | Yes | Human-readable purpose. |
| `format` | No | `"string"` (default). |
| `isRequired` | No | `true` if the server won't start without it. |
| `default` | No | Default value if not set. |

### Package Arguments

The `packageArguments` array tells clients what args to pass when running the package. For `bun run start:stdio`:

```json
"packageArguments": [
  { "type": "positional", "value": "run" },
  { "type": "positional", "value": "start:stdio" }
]
```

### Transport Patterns

**stdio only** (one package entry):

```json
"transport": { "type": "stdio" }
```

**stdio + HTTP** (two package entries): One entry with `start:stdio` and `{ "type": "stdio" }`, another with `start:http` and `{ "type": "streamable-http", "url": "http://localhost:{port}/mcp" }`. The HTTP entry includes additional env vars for host, port, endpoint path, and auth mode.

## Generating / Updating

If `server.json` doesn't exist, create it from the surface area audit. If it exists, diff against current state and update stale fields.

1. Set `$schema` to the official MCP schema URL
2. Set `name` to `io.github.{owner}/{repo}` — match `mcpName` from `package.json`
3. Sync `version` and `description` from `package.json`
4. Set `repository` from `package.json` repository URL, with `"source": "github"`
5. Create package entries — one for stdio, one for HTTP (if the server supports both transports)
6. Set `identifier` to the npm package name from `package.json`
7. Set `runtimeHint` to `"bun"`
8. Set `packageArguments` for each transport (`start:stdio`, `start:http`)
9. Populate `environmentVariables` — server-specific required vars in both entries, transport-specific vars (host, port, endpoint, auth) only in the HTTP entry, `MCP_LOG_LEVEL` in both
10. All three `version` fields (top-level, and each package entry) must be identical and match `package.json`

## Keeping in Sync

`server.json` is a snapshot. Update it when:

- Bumping the version (three places: top-level + each package entry)
- Adding or removing required environment variables
- Changing the default port or endpoint path

The `polish-docs-meta` skill handles both creation and updates.

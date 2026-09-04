---
name: api-config
description: >
  Reference for core and server configuration in `@cyanheads/mcp-ts-core`. Covers env var tables with defaults, priority order, server-specific Zod schema pattern, and Workers lazy-parsing requirement.
metadata:
  author: cyanheads
  version: "1.15"
  audience: external
  type: reference
---

## Overview

Configuration has two layers: **core config** (managed by the framework, env-driven) and **server config** (your own Zod schema for domain-specific env vars). Never merge them.

Import: `AppConfig`, `config`, `parseConfig`, `resetConfig`, `ConfigSchema` from `@cyanheads/mcp-ts-core/config`.

---

## Core config

Managed by `@cyanheads/mcp-ts-core`. Validated via Zod from environment variables. Uses a lazy proxy — parsing is deferred until the first property read.

**Priority (highest to lowest):**

1. `name`/`version`/`title`/`websiteUrl`/`description`/`icons` options passed to `createApp()` or `createWorkerHandler()`
2. Environment variables
3. `package.json` fields

**Where `package.json` is read from:** the application root — the nearest `package.json` at or above the process entry module (`process.argv[1]`), which is the served package on every launch path (`npx`, `.mcpb`, a client config naming `dist/index.js`), none of which run from the package root. The launching client's working directory is never the anchor: a stdio client starts the server from wherever it happens to be, so reading identity from there makes a server report a foreign project's name and version. When the entry module is a tool installed under the project's own `node_modules` and the process runs from that project — a test runner is the usual case — the project's manifest wins. With no manifest reachable, the framework's own identity is the fallback.

---

### Identity

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `MCP_SERVER_NAME` | `mcpServerName` | `package.json` `name` | Overrides package name |
| `MCP_SERVER_VERSION` | `mcpServerVersion` | `package.json` `version` | Overrides package version |
| `MCP_SERVER_DESCRIPTION` | `mcpServerDescription` | `package.json` `description` | Optional; `createApp({ description })` wins when set |
| `PACKAGE_NAME` | `pkg.name` | `package.json` `name` | Rarely needed |
| `PACKAGE_VERSION` | `pkg.version` | `package.json` `version` | Rarely needed |

**SDK identity fields** (API-only, no env var equivalent — passed to `createApp()` / `createWorkerHandler()`, forwarded to `initialize` and `/.well-known/mcp.json`):

| Option | Type | Notes |
|:-------|:-----|:------|
| `title` | `string?` | Human-readable display name shown in client listings |
| `websiteUrl` | `string?` | Canonical homepage / repository URL |
| `description` | `string?` | One-line description; wins over `MCP_SERVER_DESCRIPTION` when set |
| `icons` | `Implementation['icons']?` | Array of icon objects: `{ src, mimeType?, sizes?: string[], theme?: 'light'\|'dark' }` |
| `cacheHints` | `CacheHints?` | Cache hints for the 2026-07-28 cacheable results, keyed by operation — see below |

#### Cache hints (`cacheHints`)

API-only, no env var. Sets the `ttlMs` / `cacheScope` a client may cache a cacheable result for on protocol revision 2026-07-28. Keys are the closed set of cacheable operations: `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`.

```ts
await createApp({
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/read': { ttlMs: 60_000 },
  },
});
```

- `ttlMs` — cache lifetime in milliseconds; must be a non-negative safe integer. An invalid value fails at startup with a `ConfigurationError` naming the field.
- `cacheScope` — `'private'` (only the requesting client may cache) or `'public'` (shared caches may too).
- A resource's own `cacheHint` overrides the `resources/read` entry for that resource, field by field — see the `add-resource` skill.
- Omitting a hint keeps the SDK defaults (`ttlMs: 0`, `cacheScope: 'private'`). Responses to 2025-era clients are never affected.

---

### Environment & logging

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `NODE_ENV` | `environment` | `development` | Aliases: `dev`→`development`, `prod`→`production`, `test`→`testing` |
| `MCP_LOG_LEVEL` | `logLevel` | `debug` | Aliases: `warn`→`warning`, `err`→`error`, `fatal`/`silent`→`emerg`, `trace`→`debug`, `information`→`info` |
| `LOGS_DIR` | `logsPath` | `<app-root>/logs` | Node.js only; absolute paths are used verbatim, relative ones resolve against the application root (see Core config) — never the framework's install directory |

### Transport

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `MCP_TRANSPORT_TYPE` | `mcpTransportType` | `stdio` | `stdio` \| `http` |
| `MCP_HTTP_PORT` | `mcpHttpPort` | `3010` | Port for HTTP transport |
| `MCP_HTTP_HOST` | `mcpHttpHost` | `127.0.0.1` | Bind address |
| `MCP_HTTP_ENDPOINT_PATH` | `mcpHttpEndpointPath` | `/mcp` | HTTP endpoint path |
| `MCP_HTTP_MAX_BODY_BYTES` | `mcpHttpMaxBodyBytes` | `1048576` (1 MiB) | Max **inbound** JSON-RPC request body; oversized requests get `413` before per-request allocation. Does **not** cap upstream data staged into a canvas or response sizes. `0` disables (defer to runtime/proxy). |
| `MCP_HTTP_MAX_PORT_RETRIES` | `mcpHttpMaxPortRetries` | `15` | Rungs of the port ladder walked when a bind collides; each rung tries `port + 1`. See [Port binding](#port-binding) |
| `MCP_HTTP_PORT_RETRY_DELAY_MS` | `mcpHttpPortRetryDelayMs` | `50` | Delay between port retries (ms) |
| `MCP_SESSION_MODE` | `mcpSessionMode` | `auto` | `stateless` \| `stateful` \| `auto`; `auto` resolves to `stateful`. `stateless` also disables the 2025-era multi-round-trip shim, so v1 HTTP clients cannot answer a `ctx.requestInput` round — 2026-07-28 clients and stdio are unaffected |
| `MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS` | `mcpStatefulSessionStaleTimeoutMs` | `1800000` | 30 min; stale session eviction |
| `MCP_HTTP_RESUMABILITY` | `mcpHttpResumability` | `true` | SSE stream replay under stateful HTTP. On by default — selecting a session mode is the opt-in. Kill switch only; no effect on stateless serving or the session-less 2026-07-28 era |
| `MCP_HTTP_RESUMABILITY_MAX_EVENTS` | `mcpHttpResumabilityMaxEvents` | `512` | Events retained per session for replay; oldest evicted first. Lower it on a server whose tools return large results |
| `MCP_HTTP_RESUMABILITY_TTL_MS` | `mcpHttpResumabilityTtlMs` | `300000` | 5 min; how long a retained event stays replayable |
| `MCP_RESPONSE_VERBOSITY` | `mcpResponseVerbosity` | `standard` | `minimal` \| `standard` \| `full` |
| `MCP_ALLOWED_ORIGINS` | `mcpAllowedOrigins` | — | Comma-separated list; omit to allow all |
| `MCP_SERVER_RESOURCE_IDENTIFIER` | `mcpServerResourceIdentifier` | — | RFC 8707 resource indicator URL |
| `MCP_PUBLIC_URL` | `mcpPublicUrl` | — | Public-facing origin for reverse proxies (Cloudflare Tunnel, nginx, ALB) so emitted URLs carry the correct scheme |
| `MCP_HEARTBEAT_INTERVAL_MS` | `mcpHeartbeatIntervalMs` | `0` (disabled) | Heartbeat ping interval; 0 disables |
| `MCP_HEARTBEAT_MISS_THRESHOLD` | `mcpHeartbeatMissThreshold` | `3` | Missed heartbeats before session is considered stale |
| `MCP_GC_PRESSURE_INTERVAL_MS` | `mcpGcPressureIntervalMs` | `0` (disabled) | Bun-only opt-in forced GC loop for HTTP deployments with heap growth |

#### Port binding

`MCP_HTTP_PORT` is where the HTTP transport starts, not necessarily where it ends up. Startup walks a ladder: bind `MCP_HTTP_PORT`, and on a collision wait `MCP_HTTP_PORT_RETRY_DELAY_MS` and try the next port, up to `MCP_HTTP_MAX_PORT_RETRIES` times. Read the bound port off the `HTTP transport listening at …` log line or the startup banner — with the defaults the server may be anywhere in `3010`–`3025`. Pin the port by setting `MCP_HTTP_MAX_PORT_RETRIES=0`, which makes a collision a startup failure instead of a silent move.

- **Startup resolves only once the server reports `'listening'`.** A bind failure arriving after the listen call — a collision the pre-bind probe could not see, because another process took the port in between — is routed to the ladder like any other, not reported as a successful start.
- **A failure the ladder cannot clear rejects immediately.** Each rung only changes the port, so `EACCES` (privileged port, typically `<1024` as a non-root user) and `EADDRNOTAVAIL` (the `MCP_HTTP_HOST` address is not local to this machine) fail startup on the first attempt with the OS error as the rejection's `cause`, rather than burning every rung. Ladder exhaustion carries the last bind error as `cause` too, when a real bind attempt produced one.
- **Runtime caveat:** Bun reports a permission-denied bind as `EADDRINUSE` where Node reports `EACCES`. On Bun a privileged port therefore reads as an ordinary collision and walks the whole ladder before failing with `Failed to bind to any port after N retries.` — on Node the same port fails on the first attempt, naming `EACCES`.

---

### Auth

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `MCP_AUTH_MODE` | `mcpAuthMode` | `none` | `none` \| `jwt` \| `oauth` |
| `MCP_AUTH_SECRET_KEY` | `mcpAuthSecretKey` | — | Required for `jwt` mode; min 32 chars |
| `MCP_AUTH_DISABLE_SCOPE_CHECKS` | `mcpAuthDisableScopeChecks` | `false` | When `true`, bypasses both `withRequiredScopes` (declared `auth: [...]`) and `checkScopes` (runtime/tenant scopes). Token validation (sig/aud/iss/exp) intact. Logs a `WARNING` at startup. See `api-auth` skill. |
| `OAUTH_ISSUER_URL` | `oauthIssuerUrl` | — | Required for `oauth` mode |
| `OAUTH_AUDIENCE` | `oauthAudience` | — | Required for `oauth` mode |
| `OAUTH_JWKS_URI` | `oauthJwksUri` | — | Override JWKS endpoint (otherwise derived from issuer) |
| `OAUTH_JWKS_COOLDOWN_MS` | `oauthJwksCooldownMs` | `300000` | 5 min; min time between JWKS refetches |
| `OAUTH_JWKS_TIMEOUT_MS` | `oauthJwksTimeoutMs` | `5000` | JWKS fetch timeout (ms) |
| `DEV_MCP_AUTH_BYPASS` | `devMcpAuthBypass` | `false` | Skip auth in development; blocked in `production` |
| `MCP_JWT_EXPECTED_ISSUER` | `mcpJwtExpectedIssuer` | — | Optional issuer validation for JWT mode |
| `MCP_JWT_EXPECTED_AUDIENCE` | `mcpJwtExpectedAudience` | — | Optional audience validation for JWT mode |
| `DEV_MCP_CLIENT_ID` | `devMcpClientId` | — | Dev-only: override client ID |
| `DEV_MCP_SCOPES` | `devMcpScopes` | — | Dev-only: comma-separated scope overrides |

#### OAuth proxy (optional sub-object)

Activated when `OAUTH_PROXY_AUTHORIZATION_URL` or `OAUTH_PROXY_TOKEN_URL` is set.

| Env Var | `AppConfig` field | Notes |
|:--------|:-----------------|:------|
| `OAUTH_PROXY_AUTHORIZATION_URL` | `oauthProxy.authorizationUrl` | Proxy authorization endpoint |
| `OAUTH_PROXY_TOKEN_URL` | `oauthProxy.tokenUrl` | Proxy token endpoint |
| `OAUTH_PROXY_REVOCATION_URL` | `oauthProxy.revocationUrl` | Optional |
| `OAUTH_PROXY_ISSUER_URL` | `oauthProxy.issuerUrl` | Optional |
| `OAUTH_PROXY_SERVICE_DOCUMENTATION_URL` | `oauthProxy.serviceDocumentationUrl` | Optional |
| `OAUTH_PROXY_DEFAULT_CLIENT_REDIRECT_URIS` | `oauthProxy.defaultClientRedirectUris` | Comma-separated list |

---

### Storage

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `STORAGE_PROVIDER_TYPE` | `storage.providerType` | `in-memory` | `in-memory` \| `filesystem` \| `supabase` \| `cloudflare-r2` \| `cloudflare-kv` \| `cloudflare-d1`; aliases: `mem`, `fs` |
| `STORAGE_FILESYSTEM_PATH` | `storage.filesystemPath` | `./.storage` | Used only when `providerType` is `filesystem` |

---

### Canvas (DataCanvas primitive — Tier 3, optional peer dep `@duckdb/node-api`)

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `CANVAS_PROVIDER_TYPE` | `canvas.providerType` | `none` | `none` \| `duckdb`. Set to `duckdb` to enable `core.canvas`. Fails closed on Cloudflare Workers (DuckDB has no V8-isolate build). |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | `canvas.defaultMemoryLimitMb` | `1024` | Per-canvas DuckDB `memory_limit` PRAGMA value, in MB. |
| `CANVAS_EXPORT_PATH` | `canvas.exportRootPath` | `./.canvas-exports` | Sandbox root for path-targeted exports. Absolute paths and `..` traversal are rejected. |
| `CANVAS_TEMP_PATH` | `canvas.tempRootPath` | `<os.tmpdir()>/mcp-canvas` | Scratch root: DuckDB's `temp_directory` for queries that spill past `memory_limit`, plus the transient files behind stream exports and the spillover round-trip. Never resolves to the process cwd — DuckDB's own cwd-relative `.tmp` default fails on a non-root or read-only container rootfs. |
| `CANVAS_MAX_CANVASES_PER_TENANT` | `canvas.maxCanvasesPerTenant` | `100` | Active canvas cap per tenant; throws `RateLimited` when exceeded. |
| `CANVAS_TTL_MS` | `canvas.ttlMs` | `86400000` | Sliding TTL (24 h). Every operation extends the expiry. |
| `CANVAS_ABSOLUTE_CAP_MS` | `canvas.absoluteCapMs` | `604800000` | Absolute cap from creation (7 d). Sliding window clamps to this. |
| `CANVAS_SWEEPER_INTERVAL_MS` | `canvas.sweeperIntervalMs` | `60000` | Background sweep interval. Set to `0` to disable. |
| `CANVAS_DEFAULT_ROW_LIMIT` | `canvas.defaultRowLimit` | `10000` | Default cap on rows materialized into a query response. |
| `CANVAS_SCHEMA_SNIFF_ROWS` | `canvas.schemaSniffRows` | `100` | Rows to materialize for schema inference when `schema` is omitted. |

**Platform support:** Linux/macOS/Windows × x64 supported, Linux/macOS arm64 supported. Windows arm64 unsupported (DuckDB upstream). See `api-canvas` skill for the full DataCanvas reference.

#### Supabase (optional sub-object)

Activated when both `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set.

| Env Var | `AppConfig` field | Notes |
|:--------|:-----------------|:------|
| `SUPABASE_URL` | `supabase.url` | Required to activate |
| `SUPABASE_ANON_KEY` | `supabase.anonKey` | Required to activate |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase.serviceRoleKey` | Optional; elevated access |

---

### LLM

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `OPENROUTER_API_KEY` | `openrouterApiKey` | — | Optional; enables LLM provider |
| `OPENROUTER_APP_URL` | `openrouterAppUrl` | `http://localhost:3000` | Reported to OpenRouter |
| `OPENROUTER_APP_NAME` | `openrouterAppName` | `package.json` `name` | Reported to OpenRouter |
| `LLM_DEFAULT_MODEL` | `llmDefaultModel` | `google/gemini-2.5-flash-preview-05-20` | OpenRouter model ID |
| `LLM_DEFAULT_TEMPERATURE` | `llmDefaultTemperature` | — | Float |
| `LLM_DEFAULT_TOP_P` | `llmDefaultTopP` | — | Float |
| `LLM_DEFAULT_MAX_TOKENS` | `llmDefaultMaxTokens` | — | Integer |
| `LLM_DEFAULT_TOP_K` | `llmDefaultTopK` | — | Integer |
| `LLM_DEFAULT_MIN_P` | `llmDefaultMinP` | — | Float |

---

### Telemetry

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `OTEL_ENABLED` | `openTelemetry.enabled` | `false` | Enable OpenTelemetry export |
| `OTEL_SERVICE_NAME` | `openTelemetry.serviceName` | `createApp` `name` → `package.json` `name` | Seeded from `createApp({ name })` when unset; an env value wins |
| `OTEL_SERVICE_VERSION` | `openTelemetry.serviceVersion` | `package.json` `version` | |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `openTelemetry.tracesEndpoint` | — | OTLP traces endpoint URL |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `openTelemetry.metricsEndpoint` | — | OTLP metrics endpoint URL |
| `OTEL_TRACES_SAMPLER_ARG` | `openTelemetry.samplingRatio` | `1.0` | 0–1; fraction of traces to export |
| `OTEL_LOG_LEVEL` | `openTelemetry.logLevel` | `INFO` | OTel SDK internal log level: `NONE` \| `ERROR` \| `WARN` \| `INFO` \| `DEBUG` \| `VERBOSE` \| `ALL` |

---

### Speech (optional sub-object)

Activated when `SPEECH_TTS_ENABLED` or `SPEECH_STT_ENABLED` is set.

#### TTS (Text-to-Speech)

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `SPEECH_TTS_ENABLED` | `speech.tts.enabled` | `false` | Enable TTS |
| `SPEECH_TTS_PROVIDER` | `speech.tts.provider` | `elevenlabs` | Currently only `elevenlabs` |
| `SPEECH_TTS_API_KEY` | `speech.tts.apiKey` | — | Provider API key |
| `SPEECH_TTS_BASE_URL` | `speech.tts.baseUrl` | — | Override provider base URL |
| `SPEECH_TTS_DEFAULT_VOICE_ID` | `speech.tts.defaultVoiceId` | — | Default voice identifier |
| `SPEECH_TTS_DEFAULT_MODEL_ID` | `speech.tts.defaultModelId` | — | Default model identifier |
| `SPEECH_TTS_TIMEOUT` | `speech.tts.timeout` | — | Request timeout (ms) |

#### STT (Speech-to-Text)

| Env Var | `AppConfig` field | Default | Notes |
|:--------|:-----------------|:--------|:------|
| `SPEECH_STT_ENABLED` | `speech.stt.enabled` | `false` | Enable STT |
| `SPEECH_STT_PROVIDER` | `speech.stt.provider` | `openai-whisper` | Currently only `openai-whisper` |
| `SPEECH_STT_API_KEY` | `speech.stt.apiKey` | — | Provider API key |
| `SPEECH_STT_BASE_URL` | `speech.stt.baseUrl` | — | Override provider base URL |
| `SPEECH_STT_DEFAULT_MODEL_ID` | `speech.stt.defaultModelId` | — | Default model identifier |
| `SPEECH_STT_TIMEOUT` | `speech.stt.timeout` | — | Request timeout (ms) |

---

## Server config (separate schema)

Define your own Zod schema for domain-specific env vars. **Never merge with core's schema.**

Use the lazy init/accessor pattern — do not parse `process.env` at module top-level.

```ts
// src/config/server-config.ts
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('External API key'),
  maxResults: z.coerce.number().default(100),
  verboseLogging: z.stringbool().default(false).describe('Enable verbose logging'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'MY_API_KEY',
    maxResults: 'MY_MAX_RESULTS',
    verboseLogging: 'MY_VERBOSE_LOGGING',
  });
  return _config;
}
```

**Env booleans — use `z.stringbool()`, never `z.coerce.boolean()`.** `z.coerce.boolean()` runs `Boolean(value)`, so `"false"`, `"0"`, and `"no"` all coerce to `true` — the flag becomes impossible to disable through the environment except by omitting it entirely. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` (case-insensitive) and rejects anything else, so `MY_VERBOSE_LOGGING=false` actually disables and a typo fails loudly at startup instead of silently coercing. Empty string and unset both fall through to `.default()`.

**Why `parseEnvConfig`?** It maps Zod schema paths to env var names so validation errors name the actual variable at fault. A missing `MY_API_KEY` produces:

```
Server config validation failed:
  - MY_API_KEY (apiKey): Invalid input: expected string, received undefined
```

Instead of a raw `ZodError` dump at startup. The framework catches the resulting `ConfigurationError` and prints a clean banner (full stack behind `DEBUG=true`).

Direct `ServerConfigSchema.parse(...)` still works — the framework intercepts raw `ZodError` thrown from `setup()` and converts it — but error messages won't know about env var names, so they show the Zod path (`apiKey`) instead of the variable name (`MY_API_KEY`).

**Workers:** Do not parse `process.env` at module top-level. In Workers, env bindings are injected at request time via `injectEnvVars()`, after all static imports. Lazy parsing is required.

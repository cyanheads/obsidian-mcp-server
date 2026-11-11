---
name: api-workers
description: >
  Cloudflare Workers deployment using `createWorkerHandler` from `@cyanheads/mcp-ts-core/worker`. Covers the full handler signature, binding types, CloudflareBindings extensibility, runtime compatibility guards, and wrangler.toml requirements.
metadata:
  author: cyanheads
  version: "1.13"
  audience: external
  type: reference
---

## Overview

`@cyanheads/mcp-ts-core/worker` exports `createWorkerHandler` — the Workers entry point. It wraps tool/resource/prompt registries into a per-request `McpServer` factory that integrates with the Cloudflare Workers runtime.

---

## `createWorkerHandler(options)`

```ts
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { echoTool } from './mcp-server/tools/definitions/echo.tool.js';
import { echoResource } from './mcp-server/resources/definitions/echo.resource.js';
import { echoPrompt } from './mcp-server/prompts/definitions/echo.prompt.js';
import { initMyService } from './services/my-domain/my-service.js';

export default createWorkerHandler({
  tools: [echoTool],
  resources: [echoResource],
  prompts: [echoPrompt],
  setup(core) {
    initMyService(core.config, core.storage);
  },
  extraEnvBindings: [['MY_API_KEY', 'MY_API_KEY']],
  extraObjectBindings: [['MY_CUSTOM_KV', 'MY_CUSTOM_KV']],
  onScheduled: async (controller, env, ctx) => {
    // Cloudflare cron trigger handler
  },
});
```

Fresh scaffolds register definitions directly in the entry point as shown above. If your project later adds barrel files for definitions, importing arrays from those barrels is also fine.

### Options

| Option | Type | Purpose |
|:-------|:-----|:--------|
| `tools` | `AnyToolDefinition[]` | Tool definitions to register |
| `resources` | `AnyResourceDefinition[]` | Resource definitions to register |
| `prompts` | `PromptDefinition[]` | Prompt definitions to register |
| `extensions` | `Record<string, object>` | SEP-2133 extensions to advertise in server capabilities |
| `instructions` | `string \| (env: CloudflareBindings) => string` | Server-level orientation forwarded to the model on every `initialize`. Resolver form runs inside `initializeApp(env)` so env-derived text is available (see Workers-specific warnings). Empty string treated as unset. |
| `skills` | `Record<string, string \| Uint8Array>` | Published skills to serve over MCP (SEP-2640): paths under the skills folder mapped to file contents — see [Serving skills](#serving-skills) |
| `setup` | `(core: CoreServices) => void \| Promise<void>` | Runs after core services are ready, during the first request (lazy init inside the fetch handler) |
| `decodeResourceParams` | `boolean` | Percent-decode each matched resource URI template variable once before `params` validation; default `false`, same as on `createApp`. Turning it on and deleting a handler's own `decodeURIComponent` are one change, or the handler decodes twice — see `add-resource` § Percent-encoded template variables |
| `extraEnvBindings` | `[bindingKey: string, processEnvKey: string][]` | Maps CF string bindings to `process.env` keys |
| `extraObjectBindings` | `[bindingKey: string, globalKey: string][]` | Maps CF object bindings (KV, R2, D1, AI) to `globalThis` keys |
| `onScheduled` | `(controller, env, ctx) => Promise<void>` | Cloudflare cron trigger handler |

### Key design points

- **Per-request `McpServer` factory**: a new server instance is created for each request. Required by SDK security advisory GHSA-345p-7cg4-v4c7.
- **Env bindings refreshed per-request**: Cloudflare may rotate binding object references between requests; the handler re-injects them on every call.
- **OTel NodeSDK is disabled in Workers** — `canUseNodeSDK()` returns `false` for V8 isolates, so the framework registers no tracer or meter provider and exports no OTLP spans or metrics itself. Structured logs via `ctx.log` still work. A Worker that registers its own tracer provider receives the framework's spans under the scope `OTEL_SERVICE_NAME` / `OTEL_SERVICE_VERSION` names, and `OTEL_ENABLED=true` adds the `@hono/otel` request spans on the MCP endpoint when that optional peer is installed. `ctx.waitUntil()` is received and passed through to `app.fetch` and `onScheduled` but not called by the framework (nothing to flush asynchronously).
- **Singleton app promise with retry-on-failure**: the framework init runs once; if it fails, the next request retries rather than leaving the Worker in a permanently broken state.
- **Core config is re-parsed on the first request**: init drops any config cached before it and parses again after the bindings are injected, with or without `name`/`version`, so `MCP_AUTH_MODE`, `ENVIRONMENT`, and the always-`http` transport hold even when something read `config` at module load. A `resetConfig(overrides)` call made before that request does not survive it.

---

## Binding types

Cloudflare Workers bindings come in two kinds with different injection mechanisms:

| Type | Examples | Injection mechanism | Runtime access |
|:-----|:---------|:--------------------|:---------------|
| String values | API keys, base URLs, feature flags | `injectEnvVars()` → `process.env` | `process.env.MY_API_KEY` |
| Object bindings | KV namespace, R2 bucket, D1 database, AI | `storeBindings()` → `globalThis` | `(globalThis as any).MY_CUSTOM_KV` |

**`extraEnvBindings`**: array of `[bindingKey, processEnvKey]` tuples. The value of `env[bindingKey]` is assigned to `process.env[processEnvKey]` at request time.

**`extraObjectBindings`**: array of `[bindingKey, globalKey]` tuples. The object at `env[bindingKey]` is stored on `globalThis[globalKey]` at request time.

Both are refreshed on every request. Never cache binding references between requests.

### Core string bindings

Every variable the core config parser reads is either fed by a core binding or excluded for a stated reason. `createWorkerHandler` copies each core binding into `process.env` on every request, before config is parsed, so it applies whether or not the runtime populates `process.env` from bindings (`nodejs_compat_do_not_populate_process_env`, `disallow_importable_env`). `CloudflareBindings` types each one as an optional string. A blank value is skipped.

| Group | Bindings |
|:------|:---------|
| Renamed | `ENVIRONMENT` → `NODE_ENV`; `LOG_LEVEL` → `MCP_LOG_LEVEL` (an unrecognized level becomes `info`) |
| Identity | `MCP_SERVER_NAME`, `MCP_SERVER_VERSION`, `MCP_SERVER_DESCRIPTION`, `MCP_SERVER_HOMEPAGE`, `PACKAGE_NAME`, `PACKAGE_VERSION`, `PACKAGE_DESCRIPTION`, `PACKAGE_KEYWORDS` |
| Logging | `LOG_TOOL_FAILURE_PAYLOADS`, `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES`, `MCP_LOG_RATE_LIMIT_THRESHOLD`, `MCP_LOG_RATE_LIMIT_WINDOW_MS`, `LOG_LLM_INTERACTIONS` |
| HTTP surface | `MCP_HTTP_ENDPOINT_PATH`, `MCP_HTTP_MAX_BODY_BYTES`, `MCP_PUBLIC_URL`, `MCP_ALLOWED_ORIGINS`, `MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS`, `MCP_HTTP_RESUMABILITY`, `MCP_HTTP_RESUMABILITY_MAX_EVENTS`, `MCP_HTTP_RESUMABILITY_TTL_MS` |
| Auth | `MCP_AUTH_MODE`, `MCP_AUTH_SECRET_KEY`, `MCP_AUTH_DISABLE_SCOPE_CHECKS`, `MCP_JWT_EXPECTED_AUDIENCE`, `MCP_JWT_EXPECTED_ISSUER`, `MCP_SERVER_RESOURCE_IDENTIFIER`, `MCP_REQUEST_STATE_KEY`, `OAUTH_ISSUER_URL`, `OAUTH_AUDIENCE`, `OAUTH_JWKS_URI`, `OAUTH_JWKS_COOLDOWN_MS`, `OAUTH_JWKS_TIMEOUT_MS` |
| Storage and canvas | `STORAGE_PROVIDER_TYPE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CANVAS_PROVIDER_TYPE` (so `duckdb` reaches the factory and fails closed) |
| LLM | `OPENROUTER_API_KEY`, `OPENROUTER_APP_URL`, `OPENROUTER_APP_NAME`, `LLM_DEFAULT_MODEL`, `LLM_DEFAULT_TEMPERATURE`, `LLM_DEFAULT_TOP_P`, `LLM_DEFAULT_MAX_TOKENS`, `LLM_DEFAULT_TOP_K`, `LLM_DEFAULT_MIN_P` |
| Speech | `SPEECH_TTS_ENABLED`, `SPEECH_TTS_PROVIDER`, `SPEECH_TTS_API_KEY`, `SPEECH_TTS_BASE_URL`, `SPEECH_TTS_DEFAULT_VOICE_ID`, `SPEECH_TTS_DEFAULT_MODEL_ID`, `SPEECH_TTS_TIMEOUT`, `SPEECH_STT_ENABLED`, `SPEECH_STT_PROVIDER`, `SPEECH_STT_API_KEY`, `SPEECH_STT_BASE_URL`, `SPEECH_STT_DEFAULT_MODEL_ID`, `SPEECH_STT_TIMEOUT` |
| Telemetry | `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION` (the scope of every framework span and meter), `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` |

No core binding feeds these, because none has an effect on a Worker:

| Variables | Reason |
|:----------|:-------|
| `MCP_TRANSPORT_TYPE` | The Worker sets `http` itself |
| `MCP_SESSION_MODE` | Workers take the `sessionMode` option, not the env session contract |
| `DEV_MCP_AUTH_BYPASS`, `DEV_MCP_CLIENT_ID`, `DEV_MCP_SCOPES` | Development-only auth bypass |
| `MCP_HTTP_PORT`, `MCP_HTTP_HOST`, `MCP_HTTP_MAX_PORT_RETRIES`, `MCP_HTTP_PORT_RETRY_DELAY_MS` | A Worker binds no listener |
| `MCP_GC_PRESSURE_INTERVAL_MS`, `MCP_HEARTBEAT_INTERVAL_MS`, `MCP_HEARTBEAT_MISS_THRESHOLD` | Read only by `createApp` |
| `LOGS_DIR`, `STORAGE_FILESYSTEM_PATH` | A Worker has no filesystem |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB`, `CANVAS_EXPORT_PATH`, `CANVAS_TEMP_PATH`, `CANVAS_MAX_CANVASES_PER_TENANT`, `CANVAS_TTL_MS`, `CANVAS_ABSOLUTE_CAP_MS`, `CANVAS_SWEEPER_INTERVAL_MS`, `CANVAS_DEFAULT_ROW_LIMIT`, `CANVAS_SCHEMA_SNIFF_ROWS` | DuckDB does not run on Workers |
| `OTEL_TRACES_SAMPLER_ARG`, `OTEL_LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | The OpenTelemetry SDK does not run on Workers |

On a Worker whose `process.env` is populated from its bindings, a same-named binding for one of these still reaches the parser; an `extraEnvBindings` entry reaches it on any Worker.

**`DEV_MCP_AUTH_BYPASS` on Workers** is honored only when the Worker's environment is explicitly `development` or `testing` (or the aliases `dev`, `test`), declared by the `ENVIRONMENT` binding or by a `NODE_ENV` that reaches `process.env`. With the flag on and neither set, initialization fails with a `ConfigurationError` naming `DEV_MCP_AUTH_BYPASS` and `ENVIRONMENT`, and the Worker serves nothing; `production` refuses the flag on every runtime. For local development, set `ENVIRONMENT=development` beside the flag in `.dev.vars`:

```ini
ENVIRONMENT=development
DEV_MCP_AUTH_BYPASS=true
```

---

## `CloudflareBindings` extensibility

Core defines `CloudflareBindings` without an index signature, so servers extend it via intersection rather than module augmentation:

```ts
import type { CloudflareBindings as CoreBindings } from '@cyanheads/mcp-ts-core/worker';

interface MyBindings extends CoreBindings {
  MY_CUSTOM_KV: KVNamespace;
  MY_R2_BUCKET: R2Bucket;
}
```

Pass `MyBindings` as a type parameter where the framework accepts a generic env type (e.g., Hono route handlers, `onScheduled`).

---

## Runtime compatibility

### `runtimeCaps` feature detection

```ts
import { runtimeCaps } from '@cyanheads/mcp-ts-core/utils';

if (runtimeCaps.isWorkerLike) {
  // Workers-specific path
}

if (runtimeCaps.isNode) {
  // Node.js-specific path (e.g., filesystem access)
}
```

`runtimeCaps` is a snapshot taken at import time. Fields: `isNode`, `isBun`, `isWorkerLike`, `isBrowserLike`, `hasProcess`, `hasBuffer`, `hasTextEncoder`, `hasPerformanceNow`. All booleans, never throw.

### Serverless storage whitelist

In Workers, only these storage providers are allowed:

| Provider | Notes |
|:---------|:------|
| `in-memory` | Default — data lost on cold start, no persistence |
| `cloudflare-kv` | KV namespace binding — eventually consistent. Each value is stored under `<tenantId>:<key>`, capped at 512 bytes: a key past it throws `ValidationError` before the binding is called |
| `cloudflare-r2` | R2 bucket binding — object storage. Each value is stored under `<tenantId>:<key>`, capped at 1,024 bytes: a key past it throws `ValidationError` before the binding is called |
| `cloudflare-d1` | D1 database binding — SQLite-compatible |

`filesystem`, `supabase`, and unknown provider types are not on the whitelist:

- **`filesystem`** and unknown types throw `ConfigurationError` in serverless environments.
- **`supabase`** does **not** silently fall back. The serverless provider whitelist check fires immediately at the top of `createStorageProvider()` — Supabase credentials are never validated. Worker startup fails with `ConfigurationError` because Supabase is not on the serverless whitelist. Do not set `STORAGE_PROVIDER_TYPE=supabase` in a Worker.

Set `STORAGE_PROVIDER_TYPE` to one of the four whitelisted values to avoid unexpected behavior.

---

## `wrangler.toml` requirements

```toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2025-09-01"  # must be >= 2025-09-01

# Built-in storage providers require these exact binding names:
[[kv_namespaces]]
binding = "KV_NAMESPACE"       # required for cloudflare-kv storage
id = "..."

[[r2_buckets]]
binding = "R2_BUCKET"          # required for cloudflare-r2 storage
bucket_name = "..."

[[d1_databases]]
binding = "DB"                 # required for cloudflare-d1 storage
database_id = "..."
```

`nodejs_compat` is required for Node.js API shims (e.g., `process.env`, `Buffer`, `crypto`). The minimum `compatibility_date` activates the required shim set.

**Binding names for core storage are hardcoded** — the storage factory looks for `KV_NAMESPACE`, `R2_BUCKET`, and `DB` on `globalThis`. Using different binding names will cause a `ConfigurationError`. For custom (non-storage) bindings, use `extraObjectBindings` to map arbitrary binding names to `globalThis` keys.

**Bundling requires a `@duckdb/node-api` alias.** Wrangler's esbuild step follows the framework's lazy `import('@duckdb/node-api')` (the DataCanvas DuckDB provider) even though that path never executes on Workers, and fails on DuckDB's native platform bindings (`Could not resolve "@duckdb/node-bindings-*/duckdb.node"`). Alias the module to a local stub:

```toml
[alias]
"@duckdb/node-api" = "./duckdb-stub.ts"
```

```ts
// duckdb-stub.ts — rejects the lazy import if a misconfigured Worker ever reaches it
throw new Error('@duckdb/node-api is not available in Cloudflare Workers.');
export {};
```

---

## Serving skills

`createApp({ skills: 'skills' })` reads a folder; a Worker has no filesystem, so `createWorkerHandler` takes the same tree as a record: each key a path under the skills folder (`<skill>/SKILL.md`, `<skill>/references/<file>.md`), each value the file's contents. Only files in the record are served — list every reference file the skill links to. Build it from Wrangler `Text` module imports:

```ts
// src/worker.ts
import guideMd from '../skills/my-server-guide/SKILL.md';
import idsMd from '../skills/my-server-guide/references/ids.md';

export default createWorkerHandler({
  tools: allToolDefinitions,
  skills: {
    'my-server-guide/SKILL.md': guideMd,
    'my-server-guide/references/ids.md': idsMd,
  },
});
```

Wrangler's default module rules don't cover `.md`, so add a `Text` rule (`fallthrough` keeps the defaults), and declare the module type for TypeScript:

```toml
[[rules]]
type = "Text"
globs = ["**/*.md"]
fallthrough = true
```

```ts
// src/markdown.d.ts
declare module '*.md' {
  const text: string;
  export default text;
}
```

The record is loaded once per isolate, on the first request, with the same non-strict loading as `createApp`: a skill the SDK rejects is skipped with a logged warning, and a path that leaves the tree fails init with a `ConfigurationError`. Opting in adds the same surface as on Node — the `io.modelcontextprotocol/skills` extension capability, `skills/list`, `skills/get`, `resources/directory/read`, each `SKILL.md` in `resources/list`, and the `skill://{+path}` template. `add-skill` covers authoring the tree.

---

## Workers-specific warnings

**`instructions` resolver runs after env injection.** When `instructions` is a function, it runs inside `initializeApp(env)` — after `injectEnvVars()` — so env-derived text reaches the model without fighting the Workers module-load lifecycle:

```ts
export default createWorkerHandler({
  tools: [echoTool],
  instructions: (env) =>
    `Region: ${env.ENVIRONMENT ?? 'production'}.` +
    (env.MAINTENANCE_MODE ? ' Read-only mode — writes disabled.' : ''),
});
```

Plain strings work the same as on `createApp`. Type extends `Omit<CreateAppOptions, 'instructions' | 'skills' | 'teardown'>`: `instructions` and `skills` are the two options whose shape differs between Node and Worker entry points, and `teardown` does not exist on Workers (an isolate is evicted without notice).

**Lazy env parsing is mandatory.** The framework writes bindings into `process.env` at request time via `injectEnvVars()`, after all static module imports complete. Under `nodejs_compat` with a `compatibility_date` of 2025-04-01 or later, a same-named binding is already in `process.env` at module load, but a renamed one (`extraEnvBindings` targets, `ENVIRONMENT` → `NODE_ENV`, `LOG_LEVEL` → `MCP_LOG_LEVEL`) is not, and with `nodejs_compat_do_not_populate_process_env` none are. Never parse `process.env` at module top-level in Workers:

```ts
// WRONG — parsed before env is injected
const apiKey = process.env.MY_API_KEY;  // missing whenever the binding isn't copied at load

// CORRECT — lazy parse inside a function or getter
export function getServerConfig() {
  return ServerConfigSchema.parse({ apiKey: process.env.MY_API_KEY });
}
```

**`in-memory` storage is volatile.** Data stored with the `in-memory` provider is lost between cold starts and is not shared across Worker instances. Use `cloudflare-kv`, `cloudflare-r2`, or `cloudflare-d1` for any state that must persist or be shared.

**Multi-round-trip retries land on any isolate.** Each 2026-07-28 request builds its own `McpServer`, and the retry after an `input_required` result can be routed to a different isolate. Set `MCP_REQUEST_STATE_KEY` (≥ 32 bytes) as a Worker secret — it is a core binding, injected like the rest — so every isolate seals and verifies `requestState` with the same key, and keep a consent gate's record (`api-context` § *Consent gates*) in `cloudflare-d1`. `in-memory` loses it to the next isolate, so the retry asks again. Never `cloudflare-kv`: it is eventually consistent, so a retry served elsewhere may not see the record yet, and a deletion may not yet stop an immediate replay — it widens the window concurrent retries already have, since redeeming is not atomic on any provider until `ctx.state` gains a `take` ([#593](https://github.com/cyanheads/mcp-ts-core/issues/593)).

**Node-only utilities throw in Workers.** `scheduler` (`node-cron`), `sanitizePath` (fs-based), and `filesystem` storage provider all throw `ConfigurationError` when called from a Worker. Guard with `runtimeCaps.isNode` or avoid entirely.

**DataCanvas is unavailable in Workers.** DuckDB has no V8-isolate build, so `core.canvas` is always `undefined` on Workers. Setting `CANVAS_PROVIDER_TYPE=duckdb` (the only non-default value) in `wrangler.toml` triggers a fail-closed `ConfigurationError` at init time:

> `DuckDB canvas requires Node.js or Bun. Set CANVAS_PROVIDER_TYPE=none or omit it for Cloudflare Workers deployment.`

Leave the env unset (or set to `none`) for Worker deployments. Tools that conditionally use canvas should check the module-level accessor (`if (!getCanvas()) { ... }`) and surface a clear "feature unavailable on this deployment" message. See `api-canvas` for the full DataCanvas reference and setup wiring pattern.

**The default notification bus is per-isolate.** `core.notify` and the modern era's `subscriptions/listen` streams share a change-event bus that defaults to in-process — which on Workers means one bus per isolate, so a background emission reaches only the listeners that happen to live in the isolate that produced it. Handler-time `ctx.notify*` is unaffected (the listen stream and the handler are the same request). For fan-out that must cross isolates, supply a bus of your own, backed by a Durable Object or another shared channel:

```ts
createWorkerHandler({ tools, eventBus: myDurableObjectBackedBus });
```

The interface is the SDK's `ServerEventBus` — `publish(event)` and `subscribe(listener)`. See `api-context`'s notification section for what publishes onto it.

---

## Testing Workers with miniflare

`bun run test:worker` runs the worker suite under `tests/config/vitest.worker.ts` (using `@cloudflare/vitest-pool-workers` + miniflare). Each test **file** gets its own fresh V8 isolate — module scope (including `createWorkerHandler`'s `appPromise` singleton) is reset between files.

### tests/config/vitest.worker.ts miniflare bindings

Declare all storage bindings used in the suite:

```ts
cloudflareTest({
  main: './tests/fixtures/worker-runtime.fixture.ts',
  miniflare: {
    bindings: { STORAGE_PROVIDER_TYPE: 'cloudflare-kv', ... },
    kvNamespaces: ['KV_NAMESPACE', 'CUSTOM_KV'],
    r2Buckets:    ['R2_BUCKET'],
    d1Databases:  ['DB'],
  },
})
```

Binding names must match the hardcoded names in `storageFactory.ts` (`KV_NAMESPACE`, `R2_BUCKET`, `DB`).

### Per-provider test isolation

`bindings.STORAGE_PROVIDER_TYPE` is a global default. Per-provider test files override it by passing a modified env to `worker.fetch()`:

```ts
import { env } from 'cloudflare:workers';

// Fresh isolate per file — appPromise starts null.
// First fetch initialises the singleton with the overridden provider type.
const r2Env = { ...env, STORAGE_PROVIDER_TYPE: 'cloudflare-r2' };
await worker.fetch(request, r2Env, ctx);
```

Use `reset()` from `cloudflare:test` in `afterEach` to clear binding state between tests. For D1, re-apply migrations immediately after each `reset()` (reset wipes the schema):

```ts
import { applyD1Migrations, reset } from 'cloudflare:test';

afterEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{ name: '0001_schema', queries: [CREATE_TABLE_SQL] }]);
});
```

### D1 schema setup

The `cloudflare-d1` provider requires the `kv_store` table before any operations. Apply it in `beforeAll` via `applyD1Migrations`:

```ts
const KV_STORE_MIGRATION = `
CREATE TABLE IF NOT EXISTS kv_store (
  tenant_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (tenant_id, key)
)`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: '0001_create_kv_store', queries: [KV_STORE_MIGRATION] },
  ]);
  sessionId = await openSession(d1Env);
});
```

### List page size on KV and R2

KV and R2 return at most 1,000 keys per `list()` call. Both providers ask for no more than that, so `ctx.state.list()` accepts any `limit` up to the framework's 10,000 on either binding, Miniflare included; a page asked for more than 1,000 keys holds at most 1,000 and carries a cursor. Follow `cursor` until it is absent rather than counting items:

```ts
let cursor: string | undefined;
do {
  const page = await ctx.state.list(prefix, { limit: 5_000, ...(cursor && { cursor }) });
  // ... page.items
  cursor = page.cursor;
} while (cursor);
```

### Storage probe pattern

Expose storage operations as MCP tools in the fixture to test them through the real HTTP surface:

```ts
const storageSetTool = tool('storage_set', {
  input: z.object({ key: z.string().describe('...'), value: z.string().describe('...') }),
  output: z.object({ ok: z.boolean().describe('Always true on success') }),
  async handler(input, ctx) {
    await ctx.state.set(input.key, input.value);
    return { ok: true };
  },
  format: (r) => [{ type: 'text', text: `ok=${r.ok}` }],
});
```

Call via `tools/call` over MCP JSON-RPC and assert on `structuredContent`. See `tests/worker/storage-r2.worker.test.ts` and `tests/worker/storage-d1.worker.test.ts` for the full pattern.

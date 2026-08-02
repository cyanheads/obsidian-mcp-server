---
name: api-workers
description: >
  Cloudflare Workers deployment using `createWorkerHandler` from `@cyanheads/mcp-ts-core/worker`. Covers the full handler signature, binding types, CloudflareBindings extensibility, runtime compatibility guards, and wrangler.toml requirements.
metadata:
  author: cyanheads
  version: "1.6"
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
| `setup` | `(core: CoreServices) => void \| Promise<void>` | Runs after core services are ready, during the first request (lazy init inside the fetch handler) |
| `extraEnvBindings` | `[bindingKey: string, processEnvKey: string][]` | Maps CF string bindings to `process.env` keys |
| `extraObjectBindings` | `[bindingKey: string, globalKey: string][]` | Maps CF object bindings (KV, R2, D1, AI) to `globalThis` keys |
| `onScheduled` | `(controller, env, ctx) => Promise<void>` | Cloudflare cron trigger handler |

### Key design points

- **Per-request `McpServer` factory**: a new server instance is created for each request. Required by SDK security advisory GHSA-345p-7cg4-v4c7.
- **Env bindings refreshed per-request**: Cloudflare may rotate binding object references between requests; the handler re-injects them on every call.
- **OTel NodeSDK is disabled in Workers** — `canUseNodeSDK()` returns `false` for V8 isolates, so no OTLP spans or metrics are emitted. Structured logs via `ctx.log` still work. `OTEL_ENABLED=true` has no effect in Workers. `ctx.waitUntil()` is received and passed through to `app.fetch` and `onScheduled` but not called by the framework (nothing to flush asynchronously).
- **Singleton app promise with retry-on-failure**: the framework init runs once; if it fails, the next request retries rather than leaving the Worker in a permanently broken state.

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
| `cloudflare-kv` | KV namespace binding — eventually consistent |
| `cloudflare-r2` | R2 bucket binding — object storage |
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

Plain strings work the same as on `createApp`. Type extends `Omit<CreateAppOptions, 'instructions'>`, so this is the only option whose shape differs between Node and Worker entry points.

**Lazy env parsing is mandatory.** Cloudflare injects env bindings at request time via `injectEnvVars()`, after all static module imports complete. Never parse `process.env` at module top-level in Workers:

```ts
// WRONG — parsed before env is injected
const apiKey = process.env.MY_API_KEY;  // undefined in Workers

// CORRECT — lazy parse inside a function or getter
export function getServerConfig() {
  return ServerConfigSchema.parse({ apiKey: process.env.MY_API_KEY });
}
```

**`in-memory` storage is volatile.** Data stored with the `in-memory` provider is lost between cold starts and is not shared across Worker instances. Use `cloudflare-kv`, `cloudflare-r2`, or `cloudflare-d1` for any state that must persist or be shared.

**Node-only utilities throw in Workers.** `scheduler` (`node-cron`), `sanitizePath` (fs-based), and `filesystem` storage provider all throw `ConfigurationError` when called from a Worker. Guard with `runtimeCaps.isNode` or avoid entirely.

**DataCanvas is unavailable in Workers.** DuckDB has no V8-isolate build, so `core.canvas` is always `undefined` on Workers. Setting `CANVAS_PROVIDER_TYPE=duckdb` (the only non-default value) in `wrangler.toml` triggers a fail-closed `ConfigurationError` at init time:

> `DuckDB canvas requires Node.js or Bun. Set CANVAS_PROVIDER_TYPE=none or omit it for Cloudflare Workers deployment.`

Leave the env unset (or set to `none`) for Worker deployments. Tools that conditionally use canvas should check the module-level accessor (`if (!getCanvas()) { ... }`) and surface a clear "feature unavailable on this deployment" message. See `api-canvas` for the full DataCanvas reference and setup wiring pattern.

---

## Testing Workers with miniflare

`bun run test:worker` runs the worker suite under `vitest.worker.ts` (using `@cloudflare/vitest-pool-workers` + miniflare). Each test **file** gets its own fresh V8 isolate — module scope (including `createWorkerHandler`'s `appPromise` singleton) is reset between files.

### vitest.worker.ts miniflare bindings

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

### R2 list limit

The R2 provider fetches `limit + 1` objects to detect further pages. Miniflare caps R2 `MaxKeys` at 1000, so the default `limit=1000` → request 1001 → error. Pass `limit: 100` (or any value ≤ 999) to `ctx.state.list()` in test fixtures to stay under the cap:

```ts
const result = await ctx.state.list(prefix, { limit: 100 });
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

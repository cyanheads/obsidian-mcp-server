---
name: api-canvas
description: >
  DataCanvas primitive reference — a Tier 3 SQL/analytical workspace for tabular MCP servers, backed by DuckDB. Use when registering tables from upstream APIs, running ad-hoc SQL across them, and exporting results. Covers the acquire → register → query → export flow, per-table TTL, the token-sharing pattern for multi-agent collaboration, env config, and Cloudflare Workers fail-closed behavior.
metadata:
  author: cyanheads
  version: "1.7"
  audience: external
  type: reference
---

## Overview

`DataCanvas` is a primitive for **storage stashes, canvas computes**. The existing `IStorageProvider` is a key/value abstraction — it can stash blobs but exposes no analytical surface. `DataCanvas` is the analytical surface: register tabular data from upstream APIs, run SQL across multiple registered tables, and export results as CSV/Parquet/JSON.

**Tier 3** — `@duckdb/node-api` is an optional peer dependency (`bun add @duckdb/node-api`). Servers that don't enable canvas pay zero install cost. Lazy-loaded on first use.

**Disabled by default.** Set `CANVAS_PROVIDER_TYPE=duckdb` to enable. Otherwise `core.canvas` is `undefined`.

**Cloudflare Workers:** unsupported. DuckDB has no V8-isolate build. Setting `CANVAS_PROVIDER_TYPE=duckdb` on a Worker fails closed with a `ConfigurationError` at init time.

---

## When canvas earns its keep

Two gates before wiring canvas in — **both** must be yes. Canvas that fails either is a SQL surface nobody queries.

1. **Is the data analytical, not just large?** Canvas is for tabular/numeric result sets an agent runs SQL over — aggregate, group, join, time-series filter. A **discovery/search surface** returning categorical metadata (titles, IDs, types, dates) where the workflow is *find the record, then drill into it* does **not** qualify, regardless of row count. A 5,000-row search result is still discovery. The gate is **shape, not size**: the right question is "would an agent write `SELECT … GROUP BY` against this?", not "does it have many rows?" For name→ID resolution over a bounded list, reach for MCP-side list filtering (see the `design-mcp-server` skill) instead.
2. **Is it too big to inline?** A result that fits the response (≤ ~100 rows of compact data) just gets inlined — no canvas. Canvas is the third option only when shape *and* size both call for it.

If canvas earns its keep, it carries an obligation: **a tool that emits a `canvas_id` MUST ship a `dataframe_query` tool in the same server's surface** (see the [simple-shape Tools row](#simple-shape-defaults) and the [Checklist](#checklist)). A `canvas_id` with no query tool is dead output — the agent literally cannot reach the staged data.

---

## Imports

```ts
import type { DataCanvas, CanvasInstance, ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
```

The framework wires the optional service onto `CoreServices`, accessible in the `setup()` callback — **not on `Context`**. Handlers access canvas via a module-level accessor:

```ts
// src/services/canvas-accessor.ts
import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;
export const setCanvas = (c: DataCanvas | undefined) => { _canvas = c; };
export const getCanvas = () => _canvas;
```

```ts
// src/index.ts — wire in setup()
import { setCanvas } from './services/canvas-accessor.js';

await createApp({
  setup(core) {
    setCanvas(core.canvas);
  },
});
```

```ts
interface CoreServices {
  canvas?: DataCanvas;     // present when CANVAS_PROVIDER_TYPE !== 'none'
  // ... other services
}
```

---

## The token-sharing model

A canvas is identified by an opaque 10-character URL-safe `canvasId` (~10¹⁸ keyspace). Tools that touch canvas state accept an optional `canvas_id` input parameter:

| Caller passes | Result |
|:--------------|:-------|
| **Omitted** | Framework mints a fresh canvasId, returns it in the tool output. Caller surfaces it to the user / next tool call / another agent. |
| **Existing id (own tenant)** | Resolves to that canvas, slides TTL forward, returns `isNew: false`. |
| **Existing id (other tenant)** | Throws `NotFound` — uniform with unknown to avoid leaking existence across tenants. |
| **Unknown id** | Throws `NotFound` with a hint to omit the parameter on retry. |

When auth is enabled, the effective scope is the composite `(tenantId, canvasId)`. In `MCP_AUTH_MODE=none`, `tenantId` collapses to `'default'` and the canvasId is the only differentiator — entropy + TTL + the framework's rate limiter make brute-force discovery operationally infeasible. **Designed for public-data servers (BrAPI, OpenFEC, etc.). Don't put PII on a no-auth canvas.**

---

## Lifecycle

| Behavior | Default | Override |
|:---------|:--------|:---------|
| Sliding TTL | 24 h, extended on every operation | `CANVAS_TTL_MS` |
| Absolute cap from creation | 7 days | `CANVAS_ABSOLUTE_CAP_MS` |
| Per-tenant active cap | 100 canvases | `CANVAS_MAX_CANVASES_PER_TENANT` |
| Sweeper interval | 60 s | `CANVAS_SWEEPER_INTERVAL_MS` (0 to disable) |
| Persistence | In-memory only | — (v1; restart drops all canvases) |

The sweeper runs as an `unref`'d `setInterval` — does not keep the event loop alive on its own. Shutdown via `core.canvas.shutdown(ctx)` (called automatically from `ServerHandle.shutdown()`) stops the sweeper and tears down every active DuckDB instance.

---

## API

### `canvas.acquire(maybeId, ctx, options?) → CanvasInstance`

Resolves an existing canvas or creates a new one. Returns a {@link CanvasInstance} bound to `(canvasId, tenantId)`. Subsequent operations don't repeat them.

```ts
import { getCanvas } from '@/services/canvas-accessor.js';

const canvas = getCanvas();
if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
const instance = await canvas.acquire(input.canvas_id, ctx);
// instance.canvasId — surface to the agent
// instance.isNew    — true on first call
// instance.expiresAt — ISO 8601 after sliding extension
```

### `instance.registerTable(name, rows, options?)`

Register an in-memory or async-iterable rowset as a canvas table.

```ts
await instance.registerTable('germplasm', rows);

// Explicit schema for AsyncIterable (required — sniffer can't peek).
await instance.registerTable('big_dataset', asyncRows, {
  schema: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR', nullable: true },
  ],
});

// Per-table TTL — this table ages on its own clock (30 min sliding window).
// The canvas itself is unaffected; other tables on the same canvas are not touched.
await instance.registerTable('recent_fetch', rows, { ttlMs: 30 * 60 * 1000 });
```

**Schema inference** when `schema` is omitted: sniffer materializes the first 100 rows, unions JS-side types per column, and maps to DuckDB types. All inferred columns are **always nullable** — a sample can prove a column is nullable, but can never prove NOT NULL (a null may appear past the sniff window). Pass an explicit `schema` when `NOT NULL` enforcement is required. Fall-backs to `VARCHAR` for ambiguous unions (string mixed with numerics). Numeric widening: `INTEGER + DOUBLE → DOUBLE`, `INTEGER + BIGINT → BIGINT`. Column ordering follows first-appearance.

**Per-table TTL (`ttlMs`)** — optional sliding TTL for this table specifically. When set:
- The sweep loop drops the table (and clears its bookkeeping) when its window expires.
- The TTL slides on any read or write against this table: on `registerTable` (initial set), on `query()` (both when the table appears in the SQL text and when it is the `registerAs` target).
- The canvas itself is unaffected — canvas-level expiry is independent.
- Tables registered without `ttlMs` inherit the canvas lifecycle exactly as before (no change to default behavior).
- `instance.describe()` surfaces `TableInfo.expiresAt` (ISO 8601) for tables that have a per-table TTL; absent otherwise.

### `instance.query(sql, options?)`

Run SQL across registered tables. Returns at most `rowLimit` rows (default 10 000). When the result exceeds `rowLimit`, the response carries `truncated: true` and `rowCount` reflects the number of materialized rows (not the full result set). For full result sets and exact counts, pass `registerAs` — the result is materialized as a new canvas table; the response carries a `preview` slice and the exact `rowCount`.

Querying a table that does not exist throws `NotFound` (`data.reason: 'missing_table'`) with a recovery hint to re-stage the table or call `describe()`. This happens when a table has expired (per-table TTL), been dropped, or the name is mistyped. The error is `NotFound`, not `ValidationError` — agents should re-stage, not fix the SQL shape.

A `SELECT` that parses but fails to prepare for any other reason — a mistyped column, an unknown function, an invalid expression — throws `ValidationError` (`data.reason: 'invalid_sql'`) and preserves the DuckDB binder detail in `data.binderMessage` (e.g. `Referenced column "x" not found...`, often with a candidate suggestion). This is distinct from `non_select_statement`, reserved for statements that genuinely aren't `SELECT`s — here the shape is fine, so the agent should fix the named column or function.

```ts
const result = await instance.query(`
  SELECT germplasmName, COUNT(*) AS n
  FROM germplasm GROUP BY germplasmName ORDER BY n DESC
`);

// Materialize a join result for follow-up queries.
const joined = await instance.query(`
  SELECT g.germplasmName, o.value
  FROM germplasm g JOIN observations o ON g.germplasmDbId = o.germplasmDbId
`, { registerAs: 'g_with_obs', preview: 10 });
// joined.tableName === 'g_with_obs'; joined.rows.length === 10; joined.rowCount === <full count>

// Materialize with a per-table TTL so the chained result ages independently.
const chained = await instance.query(
  'SELECT * FROM recent_fetch WHERE score > 0.8',
  { registerAs: 'high_score', ttlMs: 15 * 60 * 1000 },
);
```

`registerAs` rejects with `ValidationError` (`data.reason: 'register_as_clash'`) if the target name already exists — drop it first.

`ttlMs` on `query({ registerAs })` assigns a per-table TTL to the materialized table — the same sliding semantics as `registerTable({ ttlMs })`. The SQL text is also scanned for referenced table names; any tracked per-table TTL entry found is slid on each `query()` call.

`denySystemCatalogs?: boolean` (default `false`) — when `true`, the gate rejects any reference to system catalog namespaces (`information_schema`, `pg_catalog`, `sqlite_master`, `duckdb_<name>()` calls) at the text-scan layer before the query executes. Use on shared canvases where handle possession is the access boundary — catalog namespaces let callers enumerate every staged handle. Rejection throws `ValidationError` with `data.reason: 'system_catalog_access'`. Canvas-token servers that explicitly expose `describe()` to agents do not need this; only servers that intentionally hide the full catalog should opt in.

**Read-only enforcement** (four layers + optional catalog layer):
1. Text-level deny-list — pre-parse scan for file/HTTP-reading table functions (`read_csv*`, `read_json*`, `read_parquet*`, `read_text`, `read_blob`, `glob`, `iceberg_scan`, `delta_scan`, `postgres_scan`, `mysql_scan`, `sqlite_scan`, plus pre-staged spatial ones).
2. Statement count (must be 1) via `extractStatements`.
3. Statement type (must be `SELECT`) via `prepared.statementType`.
4. EXPLAIN-plan walk against an allowlisted set of physical operators + a denied-function rescan over plan metadata strings.

Any layer's rejection throws `ValidationError` with a structured `data.reason`. File-reading scans (`READ_CSV`, `READ_PARQUET`, `READ_JSON`), DDL (`CREATE_*`, `DROP_*`, `ALTER_*`), DML (`INSERT`, `UPDATE`, `DELETE`), exports (`COPY_TO_FILE`), and utility statements (`PRAGMA`, `ATTACH`, `LOAD`, `SET`) are all rejected.

### `instance.registerView(name, selectSql, options?)`

Register a SQL view on the canvas. The `SELECT` runs through the same gate `query()` enforces (four layers), so a malicious definition fails at registration time, not later when the view is referenced. Pass `{ denySystemCatalogs: true }` to also block catalog namespace references in the view definition — same semantics as the `query()` flag.

```ts
await instance.registerView(
  'sales_by_region',
  'SELECT region, SUM(amount) AS total FROM sales GROUP BY region',
);
// { viewName: 'sales_by_region', columns: ['region', 'total'] }

// Subsequent queries against the view inherit normal gate enforcement at execution time.
const result = await instance.query("SELECT total FROM sales_by_region WHERE region = 'a'");
```

`CREATE OR REPLACE VIEW` semantics: re-registering the same name succeeds. Conflict with an existing base table throws `validationError({ reason: 'view_table_clash' })`.

### `instance.importFrom(sourceCanvasId, sourceTableName, options?)`

Copy a table from another canvas the caller controls into this one. The lifecycle wrapper validates tenancy on both ids before the provider sees either. Round-trips through a sandbox-rooted Parquet temp file so `TIMESTAMP`/`DATE`/`BLOB` columns survive losslessly.

```ts
const imported = await target.importFrom(source.canvasId, 'orders', { asName: 'orders_copy' });
// { tableName: 'orders_copy', rowCount: 2, columns: [...] }
```

Idempotent on re-import (drop + create on the target). `asName` defaults to `sourceTableName`. Throws `validationError({ reason: 'import_same_canvas' })` if source and target are the same canvas — use `query({ registerAs })` to materialize within a single canvas. Throws `notFound` if the source table is missing; `validationError({ reason: 'import_view_clash' })` if the target name collides with an existing view.

### `instance.export(tableName, target, options?)`

Export a canvas table. Path-based exports are sandboxed to `CANVAS_EXPORT_PATH` (default `./.canvas-exports`). Absolute paths and `..` traversal are rejected.

```ts
// Path target — written inside the sandbox.
await instance.export('g_with_obs', { format: 'parquet', path: 'observations.parquet' });

// Stream target — copied to a temp file in the sandbox, piped to the stream, unlinked.
await instance.export('g_with_obs', { format: 'csv', stream: writableStream });
```

### `instance.describe(options?)` / `instance.drop(name)` / `instance.clear()`

```ts
const tables = await instance.describe();
// [{ name: 'germplasm', kind: 'table', rowCount: 200, approxSizeBytes: 8192, columns: [...] }, ...]

// Filter by kind ('table' | 'view').
const onlyViews = await instance.describe({ kind: 'view' });

await instance.drop('staging_table');   // detects kind, emits DROP TABLE or DROP VIEW; false if missing
await instance.clear();                  // returns count dropped (drops views before tables to avoid dependency errors)
```

`TableInfo.kind` discriminates `'table'` vs `'view'`. For views, `rowCount` is materialized at describe time via `COUNT(*)` — not free; treat as an approximation if the view is expensive.

`TableInfo.approxSizeBytes` is set for base tables (DuckDB's `estimated_size` from `duckdb_tables()`). It is `undefined` for views — views have no entry in `duckdb_tables()`. Use it to decide what to drop when a canvas approaches its memory limit.

### Cancellation

`registerTable`, `query`, and `export` accept `options.signal: AbortSignal`. The provider opens a fresh DuckDB connection per query/export so `connection.interrupt()` cancels exactly the in-flight work without disturbing other ops on the same canvas.

---

## Result row shape

Rows are returned via DuckDB's `getRowObjectsJson()` for JSON-safe serialization:

| DuckDB type | JS type returned |
|:------------|:-----------------|
| `VARCHAR`, `JSON` | `string` |
| `INTEGER`, `DOUBLE` | `number` |
| `BIGINT` | `string` (lossless for values outside JS Number range) |
| `BOOLEAN` | `boolean` |
| `DATE`, `TIMESTAMP` | `string` |
| `BLOB` | `string` (base64) |
| `NULL` | `null` |

If your tool surfaces row data via `structuredContent`, the JSON-safe shape flows through unchanged.

---

## Configuration

| Env Var | `AppConfig` field | Default |
|:--------|:-----------------|:--------|
| `CANVAS_PROVIDER_TYPE` | `canvas.providerType` | `none` (also: `duckdb`) |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | `canvas.defaultMemoryLimitMb` | `1024` |
| `CANVAS_EXPORT_PATH` | `canvas.exportRootPath` | `./.canvas-exports` |
| `CANVAS_MAX_CANVASES_PER_TENANT` | `canvas.maxCanvasesPerTenant` | `100` |
| `CANVAS_TTL_MS` | `canvas.ttlMs` | `86_400_000` (24 h) |
| `CANVAS_ABSOLUTE_CAP_MS` | `canvas.absoluteCapMs` | `604_800_000` (7 d) |
| `CANVAS_SWEEPER_INTERVAL_MS` | `canvas.sweeperIntervalMs` | `60_000` |
| `CANVAS_DEFAULT_ROW_LIMIT` | `canvas.defaultRowLimit` | `10_000` |
| `CANVAS_SCHEMA_SNIFF_ROWS` | `canvas.schemaSniffRows` | `100` |

---

## Minimum viable spillover server

Most canvas use cases are public-data analytics: fetch from an upstream API, stage the full result, let the agent SQL it. The primitives are domain-neutral — `canvas.acquire()`, `spillover()`, `instance.query()` — so the minimum viable shape is small and generic. Reach for it first; add scoping only when a real multi-tenant requirement appears.

### Simple-shape defaults

| Concern | Simple-shape answer |
|:--|:--|
| Canvas scoping | One shared canvas per tenant. Omit `canvas_id` on the first call to mint one; pass the returned id back to reuse it. |
| Table naming | `spillover()` auto-names the table `spilled_<id>`; pass `tableName` for a stable handle. A dataframe-query surface commonly adds its own `df_<id>` convention. |
| Access control | Possession of the `canvas_id` is access — unguessable in practice (see [token-sharing model](#the-token-sharing-model)). TTL + the framework rate limiter backstop brute force. |
| Enable flag | None of your own — canvas presence is the gate (`CANVAS_PROVIDER_TYPE=duckdb`; `getCanvas()` returns `undefined` otherwise). |
| Tools | A fetcher that spills **plus a `dataframe_query` tool — mandatory once anything emits a `canvas_id`**: a token with no query tool in the same server is dead output (the agent can't reach the staged data). `dataframe_describe` is strongly recommended — it lets the agent discover staged table and column names before writing SQL. `dataframe_drop` is optional. None are framework-provided; you register them. |
| Fetcher output | Two things in one response: the inline preview (answer to the immediate question) and the table handle (escape hatch for follow-up SQL via `dataframe_query`). Neither replaces the other. |

> The `MCP_HTTP_MAX_BODY_BYTES` request-body cap is **inbound-only** — it bounds the JSON-RPC request, not the upstream data a handler stages into the canvas or the rows it returns. Canvas servers send small requests (queries, SQL, canvas IDs) regardless of dataset size, so the cap never constrains canvas ingestion.

### Recipe

A fetcher that spills and a query tool that runs SQL across what was spilled — the whole surface. Swap `fetchUpstream` for any paginated or streamed source; nothing here is domain-specific.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas-accessor.js';

/** Fetch an upstream dataset, inline a preview, spill the full result to a canvas table. */
export const fetchDataset = tool('fetch_dataset', {
  description:
    'Fetch a dataset and stage it on a DataCanvas. Returns an inline preview plus a ' +
    'canvas_id + table you can query with dataframe_query for the full result set.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z.string().describe('Upstream search/filter expression'),
    canvas_id: z
      .string()
      .optional()
      .describe('Canvas ID from a prior call. Omit to start fresh — the response returns a new one.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Canvas ID — pass to dataframe_query or another fetch call'),
    table_name: z.string().describe('Canvas table holding the full result (empty when not spilled)'),
    spilled: z.boolean().describe('True when the result exceeded the preview and was staged'),
    preview: z.array(z.record(z.string(), z.unknown())).describe('Inline rows — the immediate answer'),
    row_count: z.number().describe('Rows staged on the canvas (preview length when not spilled)'),
  }),
  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await spillover({
      canvas: instance,
      source: fetchUpstream(input.query), // any AsyncIterable<Row> | Iterable<Row>
      previewChars: 100_000, // ≈ 25k tokens inline
      signal: ctx.signal,
    });

    return {
      canvas_id: instance.canvasId,
      table_name: result.spilled ? result.handle.tableName : '',
      spilled: result.spilled,
      preview: result.previewRows,
      row_count: result.spilled ? result.handle.rowCount : result.previewRows.length,
    };
  },
});

/** Run read-only SQL across tables staged on a canvas. */
export const dataframeQuery = tool('dataframe_query', {
  description: 'Run a read-only SQL SELECT against tables staged on a canvas by fetch_dataset.',
  annotations: { readOnlyHint: true },
  input: z.object({
    canvas_id: z.string().describe('Canvas ID returned by fetch_dataset'),
    sql: z.string().describe('Read-only SELECT. Reference tables by the names fetch_dataset returned.'),
  }),
  output: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).describe('Result rows (capped at the canvas row limit)'),
    row_count: z.number().describe('Full result count before the row cap'),
  }),
  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    return { rows: result.rows, row_count: result.rowCount };
  },
});
```

### When the simple shape is enough

| Condition | Simple shape suffices? |
|:--|:--|
| Underlying data is publicly accessible | ✅ |
| Single-user deployment (stdio, or HTTP with one user) | ✅ — no cross-user surface regardless of data sensitivity |
| Use case is research / analytics, not multi-tenant SaaS | ✅ |
| Dataframes must age individually | ✅ Use `registerTable({ ttlMs })` or `query({ registerAs, ttlMs })` — per-table TTL is independent of canvas-level expiry. The sweep loop drops expired tables while keeping the canvas (and other tables) alive. |
| Per-user row visibility matters in a multi-user deployment | ❌ — add session/tenant scoping at the server level |

The germplasm-flavored [consumer tool template](#consumer-tool-template) below is the same pattern with domain-specific naming.

## Consumer tool template

A domain-specific instance of the [minimum viable spillover server](#minimum-viable-spillover-server) above — the same `acquire → register → return handle` flow with germplasm naming.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCanvas } from '@/services/canvas-accessor.js';

export const fetchAndStage = tool('fetch_and_stage_germplasm', {
  description: 'Fetch germplasm matching a query and stage it on a DataCanvas for follow-up SQL.',
  input: z.object({
    query: z.string().describe('Search query'),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional 10-char canvas ID returned from a prior call. Omit on first call to start a fresh canvas; the response will include a new canvas_id you can pass to subsequent calls or share with another agent.',
      ),
  }),
  output: z.object({
    canvas_id: z.string().describe('Canvas ID — pass to subsequent tool calls'),
    is_new_canvas: z.boolean().describe('True if a new canvas was created'),
    table_name: z.string().describe('Canvas table where rows were registered'),
    row_count: z.number().describe('Rows registered'),
    expires_at: z.string().describe('ISO 8601 expiry after sliding 24h window'),
  }),
  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const rows = await fetchGermplasm(input.query);
    const tableInfo = await instance.registerTable('germplasm', rows);
    return {
      canvas_id: instance.canvasId,
      is_new_canvas: instance.isNew,
      table_name: tableInfo.tableName,
      row_count: tableInfo.rowCount,
      expires_at: instance.expiresAt,
    };
  },
});
```

---

## Pattern: spillover

A handler produces a tabular result that's too big to inline: a paginated REST call that returns 50k rows, a streamed CSV, a database cursor. Inlining everything blows the agent's context; inlining a fixed slice leaves it blind to the rest. **Spillover** is the third option — show a small preview, register the whole result on the canvas, hand back a token pointing at it. The agent reads the preview directly and reaches for SQL when it needs the rest.

### `spillover(opts)`

```ts
import { spillover } from '@cyanheads/mcp-ts-core/canvas';

const result = await spillover({
  canvas: instance,
  source: fetchAllPages(),         // any AsyncIterable<Row> or Iterable<Row>
  previewChars: 100_000,           // ≈ 25k tokens of inline rows
  caps: { maxRows: 50_000 },       // hard upper bound on registered rows
  signal: ctx.signal,
  ttlMs: 30 * 60 * 1000,          // optional: per-table TTL forwarded to registerTable
});

if (result.spilled) {
  // result.previewRows  → inline these in the response
  // result.handle.tableName → surface so the agent can SQL the full set
  // result.truncated    → true if caps.maxRows was hit before the source exhausted
} else {
  // result.previewRows  → entire source fit; no canvas table was created
}
```

The discriminated union narrows on `result.spilled` — no runtime checks needed.

### Sizing the preview

The budget is **characters of `JSON.stringify(row)`**, not rows. A row count is a leaky proxy: the same `50` rows is ~500 tokens for compact IDs and ~25k tokens for nested observations. A character budget gives one number that works across heterogeneous tools.

| Token budget you want | Rough `previewChars` |
|:---------------------|:---------------------|
| 10k tokens           | 40_000               |
| 25k tokens           | 100_000              |
| 50k tokens           | 200_000              |

Heuristic: ~4 chars per token for typical JSON. Refine empirically per tool if the row shape is unusual.

### Flow

1. **Drain.** Pull rows, accumulating `JSON.stringify(row).length` per row, until the running total would exceed `previewChars` (the row that crosses the budget is the **overflow sentinel**) or the source exhausts.
2. **Source fit.** Drain finished under budget — return `{ spilled: false, previewRows }`. No canvas call was made.
3. **Source overflows.** The sentinel proves there are more rows than fit. Build a merged iterable of *(buffered preview rows + sentinel + remaining iterator)*, hand it to `canvas.registerTable`, return `{ spilled: true, previewRows, handle, truncated }`.

The merged iterable streams — the helper does not double-buffer the full source.

### Schema handling

| Source | Schema | Behavior |
|:-------|:-------|:---------|
| Sync or async | Caller-supplied | Forwarded to `registerTable` as-is |
| Sync or async | Omitted | Helper infers via `inferSchemaFromRows` over preview buffer + sentinel |

When the preview budget is small (single-digit rows) and the sniff window matters, pass `schema` explicitly — the helper's window is only as large as the preview budget allows.

### Cancellation and partial state

`signal.abort()` throws on the next iteration of the preview drain or the spill drain. If abort fires after `canvas.registerTable` has begun appending rows, the helper best-effort calls `canvas.drop(tableName)` before the throw propagates — the contract is "partial drain is not registered."

### When *not* to use spillover

- **Discovery/search surfaces.** A result that's categorical metadata for *find-then-drill-in* — search hits, ID lookups, catalog browsing — is not analytical and doesn't earn a canvas regardless of row count (see [When canvas earns its keep](#when-canvas-earns-its-keep)). Use MCP-side list filtering or plain pagination instead.
- **Tiny known result.** If the upstream call returns ≤ 100 rows, just inline them — no canvas needed.
- **Headless register** (caller wants the full set on canvas with zero preview rows). Call `canvas.registerTable` directly. `previewChars` is rejected at `0`; spillover always implies a visible preview.
- **Workers runtime.** Canvas requires DuckDB native; spillover is a canvas-coupled helper. For Workers parity, persist via `ctx.state` instead.

### Out of scope

- **Provenance metadata** (source URI, original query). Caller stores externally via `ctx.state` or tool output — canvas tables carry data only, not lineage.
- **Pagination-flavored builder.** A `paginate(fetchPage) → AsyncIterable<Row>` adapter is deferred until a second non-paginated consumer surfaces.
- **Token-accurate budget.** `previewTokens` (tokenizer-driven) is a future option; characters cover the common case.
- **`caps.maxBytes`.** Row caps cover the common case without re-doing serialization the canvas appender skips.

---

## Trade-offs

- **DuckDB only in v1.** Polars/SQLite/DataFusion don't fit the "agent writes ad-hoc SQL across N registered tables" shape.
- **In-memory only.** Server restart drops all canvases. For public-data servers, restart is rare and re-fetching upstream data is cheap. Disk persistence is a v2 concern.
- **Single process.** Tokens issued by one process are not portable to another. Multi-process distributed canvases are out of scope.
- **Read-only relative to upstream.** Canvas mutations (register, drop, clear, query+registerAs) all stay behind typed methods. Arbitrary SQL cannot mutate.
- **No OTel in v1.** Canvas operations are not instrumented at the framework level. Add manually via `ctx.log` if needed.

---

## Platform support

| Platform | Status |
|:---------|:-------|
| Linux x64 / arm64 | Supported |
| macOS x64 / arm64 | Supported |
| Windows x64 | Supported |
| Windows arm64 | **Not supported** (DuckDB upstream limitation) |
| Cloudflare Workers | **Not supported** — fail-closed at init time |

---

## Checklist

- [ ] `@duckdb/node-api` installed as a peer dependency (`bun add @duckdb/node-api`)
- [ ] `CANVAS_PROVIDER_TYPE=duckdb` set in `.env`
- [ ] Canvas accessor module created (`src/services/canvas-accessor.ts` or equivalent)
- [ ] Accessor wired in `setup()` callback via `setCanvas(core.canvas)`
- [ ] Handler guards for canvas availability (`if (!canvas) throw ...`)
- [ ] `canvas_id` accepted as optional input, returned in output
- [ ] A `dataframe_query` tool is registered in this server whenever any tool emits a `canvas_id` — a token with no query tool is dead output. Register `dataframe_describe` too (lets the agent discover staged table/column names)
- [ ] Canvas earns its keep: the staged data is analytical (an agent would SQL it), not a discovery/search surface of categorical metadata
- [ ] SQL queries are read-only (enforced by the four-layer gate, but don't attempt writes)
- [ ] Testing: mock the module-level `getCanvas()` accessor with `vi.spyOn` or a test setup that calls `setCanvas(mockCanvas)`
- [ ] `bun run devcheck` passes

## Related skills

- `add-tool` — scaffold a new MCP tool definition (use the canvas template above)
- `api-config` — full env var reference
- `api-workers` — Worker fail-closed behavior

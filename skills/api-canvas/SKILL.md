---
name: api-canvas
description: >
  DataCanvas primitive reference — a Tier 3 SQL/analytical workspace for tabular MCP servers, backed by DuckDB. Use when registering tables from upstream APIs, running ad-hoc SQL across them, and exporting results. Covers the acquire → register → query → export flow, the token-sharing pattern for multi-agent collaboration, env config, and Cloudflare Workers fail-closed behavior.
metadata:
  author: cyanheads
  version: "1.1"
  audience: external
  type: reference
---

## Overview

`DataCanvas` is a primitive for **storage stashes, canvas computes**. The existing `IStorageProvider` is a key/value abstraction — it can stash blobs but exposes no analytical surface. `DataCanvas` is the analytical surface: register tabular data from upstream APIs, run SQL across multiple registered tables, and export results as CSV/Parquet/JSON.

**Tier 3** — `@duckdb/node-api` is an optional peer dependency. Servers that don't enable canvas pay zero install cost. Lazy-loaded on first use.

**Disabled by default.** Set `CANVAS_PROVIDER_TYPE=duckdb` to enable. Otherwise `core.canvas` is `undefined`.

**Cloudflare Workers:** unsupported. DuckDB has no V8-isolate build. Setting `CANVAS_PROVIDER_TYPE=duckdb` on a Worker fails closed with a `ConfigurationError` at init time.

---

## Imports

```ts
import type { DataCanvas, CanvasInstance, ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
```

The framework wires the optional service onto `CoreServices`:

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
const instance = await ctx.core.canvas!.acquire(input.canvas_id, ctx);
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
```

**Schema inference** when `schema` is omitted: sniffer materializes the first 100 rows, unions JS-side types per column, and maps to DuckDB types. Fall-backs to `VARCHAR` for ambiguous unions (string mixed with numerics). Numeric widening: `INTEGER + DOUBLE → DOUBLE`, `INTEGER + BIGINT → BIGINT`. Column ordering follows first-appearance.

### `instance.query(sql, options?)`

Run SQL across registered tables. Returns at most `rowLimit` rows (default 10 000). For full result sets, pass `registerAs` — the result is materialized as a new canvas table; the response carries a `preview` slice plus the table reference.

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
```

`registerAs` rejects with `Conflict` if the target name already exists — drop it first.

**Read-only enforcement** (four layers):
1. Text-level deny-list — pre-parse scan for file/HTTP-reading table functions (`read_csv*`, `read_json*`, `read_parquet*`, `read_text`, `read_blob`, `glob`, `iceberg_scan`, `delta_scan`, `postgres_scan`, `mysql_scan`, `sqlite_scan`, plus pre-staged spatial ones).
2. Statement count (must be 1) via `extractStatements`.
3. Statement type (must be `SELECT`) via `prepared.statementType`.
4. EXPLAIN-plan walk against an allowlisted set of physical operators + a denied-function rescan over plan metadata strings.

Any layer's rejection throws `ValidationError` with a structured `data.reason`. File-reading scans (`READ_CSV`, `READ_PARQUET`, `READ_JSON`), DDL (`CREATE_*`, `DROP_*`, `ALTER_*`), DML (`INSERT`, `UPDATE`, `DELETE`), exports (`COPY_TO_FILE`), and utility statements (`PRAGMA`, `ATTACH`, `LOAD`, `SET`) are all rejected.

### `instance.registerView(name, selectSql, options?)`

Register a SQL view on the canvas. The `SELECT` runs through the same four-layer gate `query()` enforces, so a malicious definition fails at registration time, not later when the view is referenced.

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
// [{ name: 'germplasm', kind: 'table', rowCount: 200, columns: [...] }, ...]

// Filter by kind ('table' | 'view').
const onlyViews = await instance.describe({ kind: 'view' });

await instance.drop('staging_table');   // detects kind, emits DROP TABLE or DROP VIEW; false if missing
await instance.clear();                  // returns count dropped (drops views before tables to avoid dependency errors)
```

`TableInfo.kind` discriminates `'table'` vs `'view'`. For views, `rowCount` is materialized at describe time via `COUNT(*)` — not free; treat as an approximation if the view is expensive.

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

## Consumer tool template

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';

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
    const canvas = ctx.core.canvas;
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

## Related skills

- `add-tool` — scaffold a new MCP tool definition (use the canvas template above)
- `api-config` — full env var reference
- `api-workers` — Worker fail-closed behavior

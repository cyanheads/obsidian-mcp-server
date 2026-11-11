---
name: api-canvas
description: >
  DataCanvas primitive reference — a Tier 3 SQL/analytical workspace for tabular MCP servers, backed by DuckDB. Use when registering tables from upstream APIs, running ad-hoc SQL across them, and exporting results. Covers the acquire → register → query → export flow, per-table TTL, the token-sharing pattern for multi-agent collaboration, env config, and Cloudflare Workers fail-closed behavior.
metadata:
  author: cyanheads
  version: "2.15"
  audience: external
  type: reference
---

## Overview

`DataCanvas` is a primitive for **storage stashes, canvas computes**. The existing `IStorageProvider` is a key/value abstraction — it can stash blobs but exposes no analytical surface. `DataCanvas` is the analytical surface: register tabular data from upstream APIs, run SQL across multiple registered tables, and export results as CSV/Parquet/JSON.

**Tier 3** — `@duckdb/node-api` is an optional peer dependency (`bun add @duckdb/node-api`; 1.5.5-r.1 and later 1.5.x, or 2.0.0-r.1 and later 2.x). Servers that don't enable canvas pay zero install cost. Lazy-loaded on first use.

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
| **Unknown id** | Throws `NotFound` (`data.reason: 'canvas_not_found'`) with a recovery hint to re-run the producing tool or re-check the id. |
| **Malformed id** | Throws `ValidationError` (`data.reason: 'canvas_id_malformed'`) before any lookup, with a hint naming the format. A value that cannot be an id is an input error; only a well-formed id that is absent is a lookup miss. |
| **Omitted, tenant at its cap** | Throws `RateLimited` (`data.reason: 'canvas_capacity_exhausted'`, `retryable: true`) carrying `tenantId`, `activeCount`, and `cap`. The hint names no tool: it leads with reusing an id the caller already holds — the one reclaim path present in every configuration — then retrying once idle canvases expire. |

When auth is enabled, the effective scope is the composite `(tenantId, canvasId)`. In `MCP_AUTH_MODE=none`, `tenantId` collapses to `'default'` and the canvasId is the only differentiator — entropy + TTL + the framework's rate limiter make brute-force discovery operationally infeasible. **Designed for public-data servers (BrAPI, OpenFEC, etc.). Don't put PII on a no-auth canvas.**

That collapse is also why the capacity hint reads the way it does: under `default` the occupied slots may belong to other callers, so "drop an unused canvas" is advice nobody can follow. Nor does the hint name a drop tool. Dropping a table (`instance.drop(name)`) or every table (`instance.clear()`) leaves the canvas registered and frees no slot; only `canvas.drop(canvasId, ctx)` destroys the canvas and releases one, and the framework cannot tell which of the two a server's drop tool does. A server whose drop tool calls `canvas.drop` can catch the reason in the tools that mint and re-raise it through their own `ctx.fail('canvas_capacity_exhausted', …, { cause })` with a hint naming that drop tool. The cap is reached only on the mint path, when `canvas_id` was omitted. The refusal keeps `-32003` and its HTTP 429 mapping; `data.reason` is what separates it from upstream throttling, including in the `mcp.tool.error_category` metric, where it files under `server` rather than `upstream`.

### Advertising the id shape

`CanvasIdSchema` is exported from `@cyanheads/mcp-ts-core/canvas` — `z.string().regex(/^[A-Za-z0-9_-]{10}$/, message)` with a `.describe()` naming where an id comes from. A tool that declares its `canvas_id` field with it advertises the constraint in `inputSchema`, so a model sees the shape before it calls and an impossible value is rejected at argument validation rather than inside the handler:

```ts
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';

input: z.object({
  canvas_id: CanvasIdSchema.optional().describe(
    'Optional canvas ID from a prior call. Omit on first call to start a fresh canvas.',
  ),
}),
```

The two halves are independent. On a tool that adopts the shape, `"x"` or a table name like `"df_abc123"` fails as `InvalidParams` (-32602) with the framework's own `reason: 'invalid_arguments'`, and the handler never runs — so `canvas_id_malformed` never fires there. The rejection's message, `data.issues[0].message`, and recovery hint carry the schema's own sentence rather than the bare pattern: *Expected a canvas ID exactly as an earlier response on this server returned it: 10 characters of letters, digits, hyphens, and underscores. A table name is not a canvas ID.* A check message is not part of the emitted JSON Schema, so the advertised `inputSchema` stays `pattern` plus `description`. It covers tools that have not adopted it and ids the registry receives from somewhere other than a validated argument, `importFrom`'s source id in particular. Adopting the shape does not change any existing server's advertised schema until that server adopts it.

---

## Lifecycle

| Behavior | Default | Override |
|:---------|:--------|:---------|
| Sliding TTL | 24 h, extended on every operation | `CANVAS_TTL_MS` |
| Absolute cap from creation | 7 days | `CANVAS_ABSOLUTE_CAP_MS` |
| Per-tenant active cap | 500 canvases (one shared tenant under `MCP_AUTH_MODE=none`) | `CANVAS_MAX_CANVASES_PER_TENANT` |
| Sweeper interval | 60 s | `CANVAS_SWEEPER_INTERVAL_MS` (0 to disable) |
| Persistence | In-memory only | — (v1; restart drops all canvases) |

The sweeper runs as an `unref`'d `setInterval` — does not keep the event loop alive on its own. Shutdown via `core.canvas.shutdown(ctx)` (called automatically from `ServerHandle.shutdown()`) stops the sweeper and tears down every active DuckDB instance.

### Scratch directory

On first use the DuckDB provider creates one private directory, `mcp-canvas-XXXXXX`, under `CANVAS_TEMP_PATH` (the OS temp directory when unset) with `mkdtemp` — mode `0700` on POSIX; on Windows it inherits the parent's ACL, so there the parent must not grant other users access. All scratch I/O stays inside it:

- **Spills.** Each canvas gets its own DuckDB `temp_directory` there. DuckDB v1.5 names spill files by block size alone, so canvases sharing one directory would overwrite each other's evicted blocks once two of them spill past `memory_limit` at the same time.
- **Staging.** Stream exports and `importFrom` write their transient files directly in it, under `crypto.randomUUID()` names, and unlink them once consumed. The directory's mode is the boundary, not the name.

Dropping or expiring a canvas removes its spill directory once the calls still running on it settle, without waiting for them, since those calls can still be reading back the blocks it spilled. `shutdown()` removes the whole private directory once the calls still running against it settle, and does not wait for them: until then the directory stays in place and private, so no other local user can re-create its name and receive what those calls still write. A canvas whose creation straddles the shutdown is refused with `ServiceUnavailable` (-32000). A provider used again afterwards makes a fresh directory. After a crash or `SIGKILL` the directory stays behind, still private, and the next start does not sweep it — remove stale `mcp-canvas-*` directories by hand. A configured `CANVAS_TEMP_PATH` is created if missing and gets no ownership or mode check, so it must not be a directory another local user controls. When the private directory cannot be created, canvas creation fails with `ConfigurationError` (-32008) and the next attempt retries.

### Engine file access

Each canvas's DuckDB instance reads and writes files only under `CANVAS_EXPORT_PATH` and the private scratch directory, and its configuration is locked when the canvas is created, so no statement can widen that bound or raise the memory limit. A read naming any other path is refused by the engine itself, beneath the [SQL gate](#instancequerysql-options). The export root is part of the bound: a broad `CANVAS_EXPORT_PATH` widens what the engine can reach. It is also a trust boundary: it must be writable only by the server's own user.

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

### `canvas.acquireShared(ctx, options?) → CanvasInstance`

For a server that keeps the caller's canvas itself instead of handing out a token: resolves the canvas whose id `ctx.state` holds, and mints it once when none is live. Hand-rolling the same read → mint → write-back breaks under concurrent first calls: each one mints, the last write wins, and the tables the others staged sit on canvases no stored id reaches (`missing_table`), each holding a tenant cap slot until it expires.

```ts
const instance = await canvas.acquireShared(ctx, {
  onReplace: () => purgeTableRecords(ctx), // records kept for the dead canvas
});
const live = await canvas.acquireShared(ctx, { create: false }); // describe/drop: never mints
```

| Option | Default | Meaning |
|:--|:--|:--|
| `stateKey` | `'canvas-id'` | `ctx.state` key holding the id. `ctx.state` is tenant-scoped, so the default keeps one canvas per tenant; a narrower scope (per session) passes its own key. An invalid key throws `ctx.state`'s `ValidationError` before anything is minted. |
| `create` | `true` | `false` returns the live canvas or `undefined`, and never mints. |
| `onReplace` | — | `(previousId) => void \| Promise<void>`, run whenever no live canvas is found, before the mint or before `undefined` returns. `previousId` is the dead id, `undefined` when none is stored — which includes a canvas that reached its absolute cap, since the stored id expires with it. Purge by key, not by `previousId`. |

- **Liveness is the registry's.** A stored id the registry holds for the tenant returns at once, without queueing. No stored value, a canvas that is gone (`canvas_not_found`), or a value that is not a canvas id means no live canvas. Any other failure — a cancelled `ctx.signal`, a registry shutting down — propagates and leaves the stored id as it was.
- **One resolution at a time per (tenant, `stateKey`).** A call that finds no live canvas queues; in its turn it re-reads the id under its own `ctx`, so the calls behind the one that mints receive that canvas (`isNew: false`), each bound to its own `ctx`. A queued call whose `ctx.signal` aborts rejects at once with the signal's reason.
- **`onReplace` runs in that turn.** No call obtains the new canvas until it settles, so a purge there cannot delete a record another call wrote for the new canvas; a purge run after the call returns can. It must be idempotent: it runs again when it throws (nothing is minted or stored, the error reaches that caller, and the next queued call takes its own turn), when the mint fails, and when the call holding the turn is cancelled. Purge only what belongs to this key's canvas.
- **Stored value:** the bare canvas id, with a TTL of the registry's absolute cap in whole seconds (`CANVAS_ABSOLUTE_CAP_MS`, rounded up), which no canvas outlives. An id stored earlier under the same key as a bare string is reused. If the write fails — a storage error, or the call's own cancellation — the new canvas is dropped and the error propagates. `create: false` deletes a dead stored value.
- **Scope is one process**, like canvases themselves. Instances sharing one storage backend read each other's ids as dead, replace them, and run `onReplace` over each other's records; route each tenant (or key) to one instance.

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

**Replacement is atomic.** Registering an existing name replaces the table in one transaction: other calls read the previous table until the new one commits, and a source that throws, a value that fails conversion, or an abort rolls back to the previous table and its TTL — or, on a first registration, to no table. A sync source the call stops reading early is closed, so its `finally` runs. Two registrations of one name at once fail the second with DuckDB's write-write conflict.

### `instance.query(sql, options?)`

Run SQL across registered tables. Returns at most `rowLimit` rows (default 10 000). When the result exceeds `rowLimit`, the response carries `truncated: true` and `rowCount` reflects the number of materialized rows (not the full result set). For full result sets and exact counts, pass `registerAs` — the result is materialized as a new canvas table; the response carries a `preview` slice and the exact `rowCount`.

Querying a table that does not exist throws `NotFound` (`data.reason: 'missing_table'`, `data.tableName` carrying the full name as DuckDB reports it, spaces included) with a recovery hint to re-run the tool that staged the table or list what is currently staged. This happens when a table has expired (per-table TTL), been dropped, or the name is mistyped. The error is `NotFound`, not `ValidationError` — agents should re-stage, not fix the SQL shape. Only a read qualifies: a statement DuckDB parses as a SELECT, whatever it opens with — `SELECT`, `WITH`, DuckDB's FROM-first `FROM`, `VALUES`, `TABLE`, `PIVOT … IN (…)`, `UNPIVOT`, `SUMMARIZE`, `DESCRIBE`, `SHOW`, a parenthesised query, or any of them behind a comment. A `DROP`, `DELETE`, `INSERT`, `UPDATE`, or `ALTER` naming a missing table is `non_select_statement`, refused before it is prepared, since re-staging would not make it pass. A name holding a path separator (`/` or `\`) is never a staged table: it is refused as a file reference (`sql_read_only`, below) whether or not anything exists there, while a dotted name DuckDB looked up as a table (`"a.b"`, `"main.gone"`) stays `missing_table`. A well-formed but unknown or expired `canvas_id` fails the same way (`data.reason: 'canvas_not_found'`, with its own recovery hint) — thrown by `acquire()` and every canvas operation. An id that fails the format check is a different failure: `ValidationError` with `data.reason: 'canvas_id_malformed'`, raised before the lookup on each of the three entry points that take a caller-supplied id — `acquire`, `drop` (which previously reported it as a silent `false`), and `importFrom`'s source id.

A `SELECT` that fails to parse or prepare for any other reason — a syntax error, a mistyped column, an unknown scalar or table function, type, or collation, a schema the canvas does not have, an invalid expression — throws `ValidationError` (`data.reason: 'invalid_sql'`) and preserves the DuckDB detail in `data.binderMessage` (e.g. `Referenced column "x" not found...`, often with a candidate suggestion). The recovery hint follows the engine's error class: a `Parser Error` asks for the syntax fix (and `AS` before an alias that is a keyword), a `Catalog Error` for the function, type, collation, or schema name it reports missing, an `Invalid Input Error` for the constant argument it rejects, an `IO Error` for a read-only `SELECT` over the staged tables, and anything else — a binder error such as an unknown column — for the column or function the message names. This is distinct from `non_select_statement`, reserved for statements that genuinely aren't `SELECT`s — here the shape is fine, so the agent should fix the SQL the message names. Every read listed under `missing_table` above counts as a `SELECT` here, DuckDB's FROM-first form (`FROM t`, `FROM t SELECT a`) included: one that fails to prepare is classified from DuckDB's own parse of it, never from its first word. A statement DuckDB cannot parse has no parse to go on, so its opening decides: past its leading comments, whitespace, and opening parentheses, one of those read keywords makes it `invalid_sql` with the parser message, and anything else `non_select_statement`.

A `SELECT` that prepares and then fails on the staged data throws `ValidationError` (`data.reason: 'sql_execution_error'`) with the engine message preserved and a hint for its class. The split follows DuckDB's own execution-error classes, matched on the message prefix: `Conversion Error` (wrap the cast in `TRY_CAST`, or filter out the rows), `Invalid Input Error` (filter out the rows, or use the function's `TRY` variant), `Out of Range Error` (cast to a wider type such as `HUGEINT` or `DOUBLE`, or filter out the rows), and `Binder Error`, which reaches this split only from a statement that already prepared (correct the argument it names, such as a zero step or an infinite bound in `range` or `generate_series`, or define again a view whose table was staged again without the column the view reads). An export or import that reads a view fails the same way when the view does. `sql_read_only` and `sql_parse_error` are matched the same way: DuckDB's `Permission Error` or a write refused in `read-only mode`, and `Parser Error`, bare or behind the `Failed to extract statements:` wrapper the Node client puts on statement extraction. DuckDB v1.5 cannot keep a `DESCRIBE`, `SUMMARIZE`, or `SHOW` as a table or view, so one sent with `registerAs` or to `registerView` fails there as `sql_parse_error` and leaves nothing behind; v2.0 keeps it. A SELECT that names a file is `sql_read_only` (`"<path>" names a file, not a staged table.`) with a hint pointing back to the staged tables and nothing from the file in the rejection — or `denied_function` when it reads the file through a named reader; any other statement is `non_select_statement` before it is prepared, whatever it names. Each fails the same way whether or not the file exists, can be read, or holds what its reader expects, and whether the path is inside the canvas's [engine file access](#engine-file-access) or outside it: the gate's parse-tree layer decides it, not the engine's refusal or the file's state. Engine faults (`IO Error`, `INTERNAL Error`, `Out of Memory Error`, and anything unmatched) stay `DatabaseError` whatever their text says, so an export, import, or spill failing on I/O — `Permission denied`, `Read-only file system` — is never reported to the caller as bad SQL. An out-of-memory message is cut before the `SET` advice DuckDB appends, none of which a canvas accepts, and an export's carries `export_out_of_memory` (see [export](#instanceexporttablename-target-options)). A table missing while a statement runs — a view an export or import reads, after its table was dropped — is the `missing_table` `NotFound` that `query()` gives. Every engine message the provider throws has the export root and the [scratch directory](#scratch-directory) replaced with `[path]`, leaving only the part below them (the caller's own export name); the raw engine error stays on `cause` for logs. `DUCKDB_ERROR_REASONS` exports these, and `view_unreadable` (a view `describe()` cannot read — see [describe](#instancedescribeoptions--instancedropname--instanceclear)), alongside `SQL_GATE_REASONS`.

**Every gate and engine rejection carries `data.recovery.hint`**, which the framework mirrors into `content[]` as a `Recovery:` line — so the guidance reaches `structuredContent`-only and `content[]`-only clients alike. The hints name a capability, never a framework method: an MCP client sees only the consuming server's tool names, so `registerTable()` or `describe()` in a hint is guidance it cannot follow. Write your own hints the same way (see `api-errors`).

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

`denySystemCatalogs?: boolean` (default `false`) — when `true`, the gate rejects any reference to system catalog namespaces (`information_schema`, `pg_catalog`, `duckdb_<name>()` calls) and to DuckDB's internal metadata views (`duckdb_tables`, `duckdb_columns`, `sqlite_master`, `pg_class`, `pg_settings`, and the rest of the internal views in DuckDB's `system.main` and `system.pg_catalog` schemas), schema-qualified or not, at the text-scan layer before the query executes. The scan reads names, not their role in the statement, so a column or alias spelled like one of those names is rejected too; a string literal or comment holding one is not. Use on shared canvases where handle possession is the access boundary — catalog namespaces let callers enumerate every staged handle. Rejection throws `ValidationError` with `data.reason: 'system_catalog_access'`. Canvas-token servers that explicitly expose `describe()` to agents do not need this; only servers that intentionally hide the full catalog should opt in.

**Read-only enforcement** (five layers + optional catalog layer, over the engine's own [file access bound](#engine-file-access)):
1. Text-level deny-list — pre-parse scan for file/HTTP-reading table functions (`read_csv*`, `read_json*`, `read_parquet*`, `read_duckdb`, `read_text`, `read_blob`, `glob`, `iceberg_scan`, `delta_scan`, `postgres_scan`, `mysql_scan`, `sqlite_scan`, plus pre-staged spatial ones) and the `pragma_*` namespace. This scan and the catalog layer skip string literals and comments exactly where DuckDB's tokenizer ends them — standard, `E'…'` escape, and dollar-quoted literals, nested block comments, `--` to the line end — so text the engine reads as code is always scanned; anything the engine cannot tokenize, or that DuckDB versions tokenize differently, is scanned as written.
2. Statement count (must be 1) via `extractStatements`.
3. Statement type (must be `SELECT`). A statement DuckDB's own serializer cannot represent is not a SELECT and is refused before it is prepared, with one refusal whatever it names (`non_select_statement`, `Canvas query must be SELECT.`, `statementType: 'UNKNOWN'`); `prepared.statementType` confirms the rest. A `PIVOT` without an `IN` list is never one SELECT: DuckDB creates an enum type of the pivoted column's values before its SELECT runs, which v1.5 extracts as two statements and v2.0 as one its serializer cannot represent. On both it is refused the same way before anything is prepared, as `non_select_statement` with a hint to list the values (`PIVOT t ON c IN ('a', 'b') USING sum(v)`); a `PIVOT` that lists them is a SELECT and passes.
4. Parse-tree check — DuckDB's own parse of the statement. A call to a function that reads an engine setting (`current_setting`, `current_schema`, `current_schemas`, `in_search_path`), runs SQL or names a table from a string (`query`, `query_table`), or reads a file (the layer-1 list) is rejected as `denied_function`, and so is every `pragma_*` function, however its name is quoted, cased, or qualified. So is an unqualified `current_schema` written without parentheses, quoted or not: DuckDB binds it to the function whenever no column of that name is in scope, and the parse tree cannot tell the two apart, so a staged column named `current_schema` is read qualified (`c.current_schema`). That refusal says so in its message and carries its own recovery hint — qualify the column with its table, or remove the reference — in place of the remove-the-function hint every other `denied_function` refusal carries. It is the one denied name DuckDB binds bare; columns named after the others (`query`, `current_setting`) read unqualified. A table reference that names a file — a name holding a dot or path separator, or qualified by a schema or catalog the canvas does not have; a `DESCRIBE` or `SHOW` subject included — is rejected as `sql_read_only`, except the name DuckDB reports missing from its catalog: it looked that name up as a table rather than reading it as a file, so the miss is what the caller gets (`missing_table`, or `invalid_sql` for a missing schema), unless the name holds a path separator. This layer also reads a statement that fails to prepare, before the engine's own refusal or a missing table is reported, so its answer never depends on the engine or the file's state. `SHOW` and `DESCRIBE` of a staged table or view answer its column listing. The one exception is `query()` over a single plain string literal: that SQL is gated as its own single SELECT statement — the catalog layer and layers 1–4 again, recursively — up to 4 `query()` levels deep, and layer 5 covers its plan inside the outer statement's. Any other `query()` argument, and nesting past 4 levels, is `denied_function`.
5. EXPLAIN-plan walk against an allowlisted set of physical operators + a denied-function rescan of the fields that name each scan's function, on the node or inside its `extra_info` — the scan's own allowlisted operator name aside, never the caller's literals or aliases elsewhere in the plan. A table function plans under its own name, so the allowlist admits the `range` and `generate_series` series (integers, or `TIMESTAMP`/`TIMESTAMPTZ` with an `INTERVAL` step) called with constant arguments, for calendar spines and gap-filling; called over a column (lateral) or a subquery argument they plan as `INOUT_FUNCTION` and are refused. `SELECT t.x, unnest(range(t.x)) FROM t` is the per-row form.

Any layer's rejection throws `ValidationError` with a structured `data.reason`. File-reading scans (`READ_CSV`, `READ_PARQUET`, `READ_JSON`), DDL (`CREATE_*`, `DROP_*`, `ALTER_*`), DML (`INSERT`, `UPDATE`, `DELETE`), exports (`COPY_TO_FILE`), and utility statements (`PRAGMA`, `ATTACH`, `LOAD`, `SET`) are all rejected.

### `instance.registerView(name, selectSql, options?)`

Register a SQL view on the canvas. The `SELECT` runs through the same gate `query()` enforces (five layers), so a malicious definition fails at registration time, not later when the view is referenced. Pass `{ denySystemCatalogs: true }` to also block system catalog and internal metadata view references in the view definition — same semantics as the `query()` flag.

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

Copy a table from another canvas the caller controls into this one. The lifecycle wrapper validates tenancy on both ids before the provider sees either. Round-trips through a Parquet file in the provider's [scratch directory](#scratch-directory) so `TIMESTAMP`/`DATE`/`BLOB` columns survive losslessly. The source canvas writes that file as a Parquet [export](#instanceexporttablename-target-options) does — one engine thread, in the source's order, row groups capped — so a copy holds one 2,048-row slice of the source plus the writer's buffers, whatever its row count.

```ts
const imported = await target.importFrom(source.canvasId, 'orders', { asName: 'orders_copy' });
// { tableName: 'orders_copy', rowCount: 2, columns: [...] }
```

Idempotent on re-import: the target table is replaced in one transaction, and a copy that fails or is cancelled leaves the previous one in place. `asName` defaults to `sourceTableName`. Throws `validationError({ reason: 'import_same_canvas' })` if source and target are the same canvas — use `query({ registerAs })` to materialize within a single canvas. Throws `notFound({ reason: 'missing_table' })` if the source table is missing, or if a source view reads a table that is gone — the same rejection `query()` gives that view; `validationError({ reason: 'import_view_clash' })` if the target name collides with an existing view.

### `instance.export(tableName, target, options?)`

Export a canvas table. Path-based exports are sandboxed to `CANVAS_EXPORT_PATH` (default `./.canvas-exports`). Absolute paths and `..` traversal are rejected.

Every export writes rows in the table's insertion order, or in the order a view's `ORDER BY` sets, from one engine thread, so the memory it holds does not grow with the table's row count. A Parquet export caps its row groups, so it holds one 2,048-row slice of the table plus the writer's buffers, as CSV and JSON exports do; a table whose 2,048 widest rows do not fit beside them inside the canvas memory limit still fails, with `export_out_of_memory`. A CSV export holds about three copies of that slice as text and a JSON export about 13 (about 10 on v1.5): roughly 26 MB of `CANVAS_DEFAULT_MEMORY_LIMIT_MB` per KB of row width. `rowCount` counts the rows the export wrote, read in the same transaction as the export itself.

An export the engine runs out of memory writing fails with `DatabaseError`, `data.reason: 'export_out_of_memory'`, `data.format` naming the format, the first line of the engine's message, and a hint for that format: JSON's names CSV and Parquet, which need far less; CSV's and Parquet's name an export of a selection that leaves out the widest columns, or a larger `CANVAS_DEFAULT_MEMORY_LIMIT_MB`. `query()` and `registerTable()` running out of memory stay `DatabaseError` with no reason.

A path export writes `.<name>.<UUID>.partial` beside its target, through the same sandbox and symbolic-link checks as the target (`<name>` shortened at a character boundary when the staging name would pass 255 bytes), and renames it over the target once its transaction commits, after checking the target's path again. A target that is a symbolic link at either check fails the export with `export_path_symlink`, and the rename replaces a link at the target rather than writing through it. An export that rejects, cancelled included, removes the staging file and leaves the target as it found it: a file already there keeps its content and a missing one is not created. One that resolves replaces the target whole; `sizeBytes` is the size of the file it wrote. Error messages name the requested path, never the staging file. A stream export writes no staging file; to Parquet it writes with the same single writer and row-group cap as a path export, so it carries the rows, row order, and column types a path export of that table does.

```ts
// Path target — written inside the sandbox.
await instance.export('g_with_obs', { format: 'parquet', path: 'observations.parquet' });

// Stream target — copied to a file in the provider's scratch directory, piped to the stream, unlinked.
await instance.export('g_with_obs', { format: 'csv', stream: writableStream });
```

### `instance.describe(options?)` / `instance.drop(name)` / `instance.clear()`

```ts
const tables = await instance.describe({ signal: ctx.signal });
// [{ name: 'germplasm', kind: 'table', rowCount: 200, columns: [...] }, ...]

// Filter by kind ('table' | 'view').
const onlyViews = await instance.describe({ kind: 'view' });

await instance.drop('staging_table');   // detects kind, emits DROP TABLE or DROP VIEW; false if missing
await instance.clear();                  // returns count dropped (drops views before tables to avoid dependency errors)
```

`TableInfo.kind` discriminates `'table'` vs `'view'`. A view's `rowCount` is counted when `describe()` runs, by reading the view; the count need not evaluate the view's select list, so a view whose select list fails only on its values can still be counted and described while a query that reads those values fails. `describe()` accepts `signal` and rejects as `cancelled` the way `query()` does, and it runs on a connection of its own, so a describe in progress does not hold up other calls on the canvas.

A view can stop being readable after it is registered: its table is dropped or expires, its table is staged again without a column the view reads, it is defined again to read itself, or it passes `range` or `generate_series` an argument the engine rejects only as the statement runs. `describe()` reads every object in scope, then rejects once with `ValidationError` (`data.reason: 'view_unreadable'`), `data.views` listing each unreadable view as `{ name, engineMessage }` (host paths redacted), and a hint to drop the view or define it again over the tables as now staged. It never returns an entry with a count it did not take. A call whose scope leaves the view out (`kind: 'table'`, or a `tableName` naming another object) answers as before, and `drop()` of the named view always works. An I/O or memory fault while reading a view stays `DatabaseError`.

`drop()` classifies an engine failure the way every other call does: a drop that races a registration of the same name fails with the engine's write-write conflict as `DatabaseError`.

Each entry's `columns` are `DescribedColumn`s: `ColumnSchema` plus `engineType`, the column's type exactly as the engine spells it (`DECIMAL(10,2)`, `BIGINT[]`, `STRUCT(a INTEGER, b VARCHAR)`, `TIMESTAMP WITH TIME ZONE`), set on every column. `type` stays the coarse `ColumnType` tag, a registration-oriented approximation: a numeric type takes the tag that holds every one of its values exactly (`INTEGER` for `TINYINT`, `SMALLINT`, `UTINYINT`, and `USMALLINT`; `BIGINT` for `UINTEGER`), and a type no tag holds — `UBIGINT`, `HUGEINT`, `UHUGEINT`, `DECIMAL`, `BIGNUM`, `TIME`, `INTERVAL`, `UUID`, the nested types — is `VARCHAR`. The tag does not predict the JSON form of a value `query()` returns ([Result row shape](#result-row-shape)); `engineType` does. `ColumnSchema`, the `registerTable` input, has no `engineType`, and described columns still pass to `registerTable({ schema })`.

`TableInfo.approxSizeBytes` is `@deprecated` and never populated. DuckDB exposes no per-table byte footprint, so there is no size figure to report and no size-based eviction heuristic to build on; `rowCount` and the canvas memory limit are what `describe()` gives you. The member stays on the type so existing readers compile, and goes away in a future major.

### Cancellation

`registerTable`, `query`, `export`, `describe`, `registerView`, and `importFrom` accept `options.signal: AbortSignal`. `query`, `export`, `describe`, and `importFrom` run their engine work on a fresh DuckDB connection per call, so `connection.interrupt()` cancels exactly that call without disturbing other ops on the same canvas.

An abort at any point before one of those calls settles rejects it with `Timeout` (`data.reason: 'cancelled'`), never with rows: already aborted at the call, landing during the read-only gate, or arriving before the engine has begun a statement (DuckDB discards an interrupt it receives then, so the provider re-issues it once the statement starts). A cancelled `registerAs` leaves no table behind, and a cancelled `importFrom` no target table. A path export's commit point is the rename that publishes it: an abort before the rename leaves the target as it found it, and one after it is not honored. `registerView` rejects the same way up to its view DDL, which is catalog-only and commits once begun. `registerTable` checks the signal between rows and rethrows the signal's own reason (an `AbortError` by default) unchanged.

---

## Result row shape

Rows are returned via DuckDB's `getRowObjectsJson()` for JSON-safe serialization:

| DuckDB type | JS type returned |
|:------------|:-----------------|
| `VARCHAR`, `JSON`, `UUID`, `BIT`, `ENUM`, `TIME` and its variants | `string` |
| `TINYINT`, `SMALLINT`, `INTEGER`, `UTINYINT`, `USMALLINT`, `UINTEGER`, `FLOAT`, `DOUBLE` | `number` |
| `BIGINT`, `UBIGINT`, `HUGEINT`, `UHUGEINT`, `BIGNUM`, `DECIMAL` | `string` (lossless for values outside JS Number range; a `DECIMAL` keeps its scale, `"12.345"`) |
| `BOOLEAN` | `boolean` |
| `DATE`, `TIMESTAMP` and its variants | `string` (`TIMESTAMP WITH TIME ZONE` in the server process's time zone) |
| `INTERVAL` | `{ months, days, micros }`, `micros` a string |
| `BLOB`, `GEOMETRY` | `string` (bytes outside printable ASCII as `\xNN` escapes) |
| `LIST`, `ARRAY` (`T[]`, `T[n]`) | array |
| `STRUCT` | object |
| `MAP` | array of `{ key, value }` |
| `UNION` | `{ tag, value }` |
| `NULL` | `null` |

The coarse `type` tag `describe()` reports does not predict this form: a `BIGINT` column's values are strings, and a `UINTEGER` column, tagged `BIGINT`, returns numbers. Read a column's `engineType` against this table.

If your tool surfaces row data via `structuredContent`, the JSON-safe shape flows through unchanged.

---

## Configuration

| Env Var | `AppConfig` field | Default |
|:--------|:-----------------|:--------|
| `CANVAS_PROVIDER_TYPE` | `canvas.providerType` | `none` (also: `duckdb`) |
| `CANVAS_DEFAULT_MEMORY_LIMIT_MB` | `canvas.defaultMemoryLimitMb` | `1024` — also caps each engine at one thread per 64 MB, below the count DuckDB detects (cores, or a container's CPU quota), bounding the working memory a query's threads hold |
| `CANVAS_EXPORT_PATH` | `canvas.exportRootPath` | `./.canvas-exports` |
| `CANVAS_TEMP_PATH` | `canvas.tempRootPath` | `os.tmpdir()` — parent of the private [scratch directory](#scratch-directory) |
| `CANVAS_MAX_CANVASES_PER_TENANT` | `canvas.maxCanvasesPerTenant` | `500` |
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
| Canvas scoping | One shared canvas per tenant. Either the caller carries it — omit `canvas_id` on the first call to mint one, pass the returned id back to reuse it — or the server keeps it through `canvas.acquireShared(ctx)` ([recipe](#recipe-a-canvas-the-server-keeps)). Never hand-roll the stored-id read and mint: concurrent first calls each mint a canvas. |
| Table naming | `spillover()` auto-names the table `spilled_<id>`; pass `tableName` for a stable handle. A dataframe-query surface commonly adds its own `df_<id>` convention. |
| Access control | Possession of the `canvas_id` is access — unguessable in practice (see [token-sharing model](#the-token-sharing-model)). TTL + the framework rate limiter backstop brute force. |
| Enable flag | None of your own — canvas presence is the gate (`CANVAS_PROVIDER_TYPE=duckdb`; `getCanvas()` returns `undefined` otherwise). |
| Tools | A fetcher that spills **plus the dataframe trio — all three ship whenever canvas is integrated**. `dataframe_query` is mandatory once anything emits a `canvas_id`: a token with no query tool in the same server is dead output (the agent can't reach the staged data). `dataframe_describe` is required alongside it — the agent discovers staged table and column names before writing SQL. `dataframe_drop` is implemented but **opt-in via a server env var**: when the flag is off, register it with `disabledTool()` (see `add-tool`) so it stays visible in the manifest with the enable hint while uncallable. `acquire()`'s `canvas_not_found` already carries a re-stage hint, which a declared contract recovery never overrides — right for describe/query, wrong for drop (a missing canvas has nothing left to remove). The drop handler catches that reason and re-raises it through its own `ctx.fail('canvas_not_found', …, { cause })`, leaving the contract entry unmarked by `thrownBy: 'service'`. None are framework-provided; you register them. |
| Fetcher output | Two things in one response: the inline preview (answer to the immediate question) and the table handle (escape hatch for follow-up SQL via `dataframe_query`). Neither replaces the other. |

> The `MCP_HTTP_MAX_BODY_BYTES` request-body cap is **inbound-only** — it bounds the JSON-RPC request, not the upstream data a handler stages into the canvas or the rows it returns. Canvas servers send small requests (queries, SQL, canvas IDs) regardless of dataset size, so the cap never constrains canvas ingestion.

### Recipe

A fetcher that spills and a query tool that runs SQL across what was spilled — the whole surface. Swap `fetchUpstream` for any paginated or streamed source; nothing here is domain-specific.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas-accessor.js';

/** Fetch an upstream dataset, inline a preview, spill the full result to a canvas table. */
export const fetchDataset = tool('fetch_dataset', {
  description:
    'Fetch a dataset and stage it on a DataCanvas. Returns an inline preview plus a ' +
    'canvas_id + table you can query with dataframe_query for the full result set.',
  annotations: { readOnlyHint: true },
  input: z.object({
    query: z.string().describe('Upstream search/filter expression'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID from a prior call. Omit to start fresh — the response returns a new one.',
    ),
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
    canvas_id: CanvasIdSchema.describe('Canvas ID returned by fetch_dataset'),
    sql: z.string().describe('Read-only SELECT. Reference tables by the names fetch_dataset returned.'),
  }),
  output: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).describe('Result rows (capped at the canvas row limit)'),
    row_count: z.number().describe('Rows returned — at most the canvas row limit, not the size of the full result'),
    truncated: z.boolean().optional().describe('True when the result has more rows than came back; aggregate or page with ORDER BY … LIMIT … OFFSET to reach the rest'),
  }),
  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');

    const instance = await canvas.acquire(input.canvas_id, ctx);
    const result = await instance.query(input.sql, { signal: ctx.signal });
    // Forward the cap flag: without it a capped result reads as the whole answer.
    return {
      rows: result.rows,
      row_count: result.rowCount,
      ...(result.truncated && { truncated: true }),
    };
  },
});
```

### Recipe: a canvas the server keeps

When the tools take no `canvas_id`, the server keeps one canvas per tenant and records what it staged in `ctx.state`. Every tool reaches the canvas through one bridge:

```ts
// src/services/canvas-bridge.ts
import type { Context } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas-accessor.js';

function requireCanvas() {
  const canvas = getCanvas();
  if (!canvas) throw new Error('DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.');
  return canvas;
}

/** For staging: the tenant's canvas, minted once. Records kept for a dead canvas go first. */
export function stagingCanvas(ctx: Context): Promise<CanvasInstance> {
  return requireCanvas().acquireShared(ctx, { onReplace: () => purgeTableRecords(ctx) });
}

/** For describe, query, and drop: the live canvas, or undefined when nothing is staged. */
export function liveCanvas(ctx: Context): Promise<CanvasInstance | undefined> {
  return requireCanvas().acquireShared(ctx, {
    create: false,
    onReplace: () => purgeTableRecords(ctx),
  });
}

async function purgeTableRecords(ctx: Context): Promise<void> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.state.list('df-meta/', cursor ? { cursor } : {});
    keys.push(...page.items.map((item) => item.key));
    cursor = page.cursor;
  } while (cursor);
  if (keys.length > 0) await ctx.state.deleteMany(keys);
}
```

The fetcher stages through `stagingCanvas(ctx)` and writes `df-meta/<table>` after `registerTable`; the dataframe tools go through `liveCanvas(ctx)` and answer "nothing staged" on `undefined` instead of minting an empty canvas. A narrower scope — one canvas per session — passes its own `stateKey` and keys its records under the same scope, so a purge touches only that canvas's records. Several server instances over one storage backend need each tenant routed to one of them ([scope](#canvasacquiresharedctx-options--canvasinstance)).

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
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas-accessor.js';

export const fetchAndStage = tool('fetch_and_stage_germplasm', {
  description: 'Fetch germplasm matching a query and stage it on a DataCanvas for follow-up SQL.',
  input: z.object({
    query: z.string().describe('Search query'),
    canvas_id: CanvasIdSchema.optional().describe(
      'Optional canvas ID returned from a prior call. Omit on first call to start a fresh canvas; the response will include a new canvas_id you can pass to subsequent calls or share with another agent.',
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

Pass `schema` explicitly whenever a column's type can't be read off the first rows — a fractional column whose leading values are all `0` or `null` sniffs as `BIGINT` (or `VARCHAR`), and the appender then truncates or stringifies every later value without an error. The sniff window is only as large as the preview budget, so shrinking `previewChars` widens the exposure; the same applies to `registerTable` called without a schema. Derive the schema from the row type once and pass it to both calls.

### Cancellation and partial state

`signal.abort()` throws on the next iteration of the preview drain or the spill drain. A partial drain is never registered: `registerTable` rolls an abort or failure back, so the canvas is left as it was, a table of the same name included. Every early exit — the `maxRows` cap, an abort, a failed registration — closes the source, so a generator's `finally` (closing a paginated stream, releasing a cursor) runs; a source that ran out or threw is not closed again.

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
| Windows x64 / arm64 | Supported (`@duckdb/node-api` 1.5.6-r.1 and 2.0.0-r.1 publish prebuilt bindings for both) |
| Cloudflare Workers | **Not supported** — fail-closed at init time |

---

## Checklist

- [ ] `@duckdb/node-api` installed as a peer dependency (`bun add @duckdb/node-api`)
- [ ] `CANVAS_PROVIDER_TYPE=duckdb` set in `.env`
- [ ] Canvas accessor module created (`src/services/canvas-accessor.ts` or equivalent)
- [ ] Accessor wired in `setup()` callback via `setCanvas(core.canvas)`
- [ ] Handler guards for canvas availability (`if (!canvas) throw ...`)
- [ ] `canvas_id` accepted as optional input, returned in output
- [ ] A `dataframe_query` tool is registered in this server whenever any tool emits a `canvas_id` — a token with no query tool is dead output. Register `dataframe_describe` too (lets the agent discover staged table/column names), and `dataframe_drop` behind its opt-in env flag — wrapped in `disabledTool()` while the flag is off
- [ ] Canvas earns its keep: the staged data is analytical (an agent would SQL it), not a discovery/search surface of categorical metadata
- [ ] SQL queries are read-only (enforced by the five-layer gate, but don't attempt writes)
- [ ] Testing: mock the module-level `getCanvas()` accessor with `vi.spyOn` or a test setup that calls `setCanvas(mockCanvas)`
- [ ] `bun run devcheck` passes

## Related skills

- `add-tool` — scaffold a new MCP tool definition (use the canvas template above)
- `api-config` — full env var reference
- `api-workers` — Worker fail-closed behavior

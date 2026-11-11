---
name: api-mirror
description: >
  Stand up a persistent, self-refreshing local mirror of a bulk upstream dataset with the MirrorService (@cyanheads/mcp-ts-core/mirror). Use when a server wraps a large or slow API and should query a synced local index (embedded SQLite + FTS5) instead of paginating the live API per request.
metadata:
  author: cyanheads
  version: "1.10"
  audience: external
  type: reference
---

## Context

The MirrorService owns the source-agnostic half of a local mirror — the embedded store, the sync-state machine, the runner — so a server supplies only the two parts that are irreducibly per-source: the **ingester** (a `sync` generator) and the **schema**. It targets the embedded-SQLite tier (~10⁴–10⁷ rows). Node/Bun only: `bun:sqlite` is built-in on Bun, `better-sqlite3` is an optional peer dependency on Node; the store is unavailable on Workers (no SQLite, no persistent filesystem). On Bun the store needs 1.4.4 or later, the framework's `engines.bun` floor. An older Bun keeps running a multi-statement `exec` past a statement that fails, so a migration that fails partway is recorded as applied; opening a store there rejects with `ConfigurationError` (`data.reason: 'unsupported_bun_version'`) naming both versions, before any file is created. Bun does not enforce `engines` itself, at install or at run.

Import from `@cyanheads/mcp-ts-core/mirror`.

## The shape

```ts
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';

const papers = defineMirror({
  name: 'arxiv-papers',
  store: sqliteMirrorStore({
    path: config.mirrorPath,
    table: 'papers',                                 // primary table; FTS index is `papers_fts`
    primaryKey: 'id',
    columns: { id: 'TEXT', title: 'TEXT', authors: 'TEXT', abstract: 'TEXT', updated: 'TEXT' },
    fts: ['title', 'authors', 'abstract'],          // opt-in FTS5 external-content index
    indexes: [{ columns: ['updated'] }],
  }),
  // The ingester — the one part that is always server-specific.
  async *sync({ mode, cursor, checkpoint, signal }) {
    for await (const page of harvestPages({ resumeFrom: cursor, since: checkpoint, signal })) {
      yield {
        records: page.rows,             // objects keyed by declared column
        tombstones: page.deletedIds,    // primary-key values to delete
        cursor: page.token,             // volatile resume position (see below)
        checkpoint: page.maxStamp,      // durable high-water mark (see below)
      };
    }
  },
});

await papers.runSync({ mode: 'init', signal: AbortSignal.timeout(3_600_000) }); // full; resumes on interrupt
await papers.runSync({ mode: 'refresh' });                                       // incremental
const { rows, total } = await papers.query({ match: 'transformers', limit: 10, offset: 0 });
const status = await papers.status();   // { status, ready, checkpoint, total, ... }
```

## cursor vs. checkpoint — the core distinction

Two resume dimensions, deliberately separate. Conflating them silently corrupts resume for token-paged sources.

| | `cursor` | `checkpoint` |
|---|---|---|
| Meaning | Volatile intra-run resume position (e.g. an OAI-PMH resumption token, a page token) | Durable incremental high-water mark (e.g. the max record datestamp) |
| Lifetime | One run; may expire; **cleared on completion** | Persists; **advances monotonically with each committed page**, and a failed or stopped run keeps the value it reached |
| Used for | Resuming an interrupted run of the same mode | Seeding the next `refresh` |

Why they can't merge: during a from-scratch init the records aren't ordered by the high-water field, so the max-so-far is not a valid resume position — only the cursor is. Once an init ends the cursor is meaningless, but the high-water mark seeds the next refresh. **The checkpoint must be lexicographically monotonic** (ISO 8601 works); the runner advances the stored checkpoint only when a page's value compares greater. A sync that walks several partitions in turn (one congress, collection, or feed after another, each ordered by the high-water field on its own) yields its checkpoint only with the final page: a mid-walk value from an early partition can already sit past a later partition's unvisited updates, so a refresh that fails there would skip them on every later run.

**Resume rule.** The framework persists both per page, with the mode of the run that wrote them. A run continues an interrupted run of its own mode (`in_progress` after a kill, `error` after a caught failure or a stop): `sync()` receives that run's `cursor` and `checkpoint`. Otherwise an `init` receives neither and a `refresh` receives only `checkpoint`, including the one an interrupted init reached. That init's walk was not ordered by the high-water field, so a record it never reached that compares below its checkpoint is skipped by every refresh until an init completes: rerun `init`, which resumes its cursor, before refreshing. A state written before runs recorded their mode reads as an `init`'s; the SQLite store adds the column on open, with no migration of yours. The source owns the cursor's validity: when its upstream rejects a resumed cursor (an expired OAI-PMH resumption token, `badResumptionToken`), continue from `checkpoint` in the same run. The runner has no expiry signal, so a source that throws instead fails every later run of that mode on the same cursor.

## What you own vs. what the framework owns

| Framework | Server |
|---|---|
| Cross-runtime SQLite handle, WAL + `busy_timeout`; an open waits out another connection's lock for `busyTimeoutMs` | The `sync` generator (the ingester) |
| `mirror_sync_state` + cursor/checkpoint state machine | Translating your query syntax → FTS5 `match` |
| `runSync({ init \| refresh })`, per-page persist, resume | Mapping upstream records → row objects |
| Schema gen (columns + FTS + tokenizer + triggers) | Migration *content* (the `up` functions) |
| `schema_version` + migration *runner* | Scheduling + init/refresh bootstrap (see below) |
| Generic `query()` + the raw-handle escape hatch | Server-specific access paths via the raw handle |

A store that cannot be opened or initialized (a lock held past `busyTimeoutMs`, an unreadable or corrupted file, a parent directory that cannot be created, a migration that throws) rejects with `DatabaseError` (`-32010`). The caller sees the store's file name and a `data.recovery.hint`, never its directory; the driver or filesystem error stays on `cause` for the log.

Values the store binds (record fields, tombstones, ids, filter values, `match`) are strings, numbers, or null. A number that is a safe integer (other than `-0`) binds as an integer on both runtimes, so a `TEXT` column stores `2024` as `'2024'`, never `'2024.0'`; any other number binds as REAL and `NaN` as NULL, and every number reads back as a number. A boolean, as `JSON.parse` produces, stores as the integer `1`/`0` on both runtimes (`'1'`/`'0'` in a `TEXT` column). Bytes (a `Uint8Array`, `Buffer`, other typed array, `DataView`, `ArrayBuffer`, or `SharedArrayBuffer`) store as a blob of the bytes they view. An object, array, or `Date` rejects with `ValidationError` naming where it sat (`records[3].authors`, `tombstones[0]`), and so does a `bigint` outside the signed 64-bit range, by its parameter position or key. Serialize structured fields to JSON text, and pass primary-key values, not records, as tombstones.

The raw handle (`raw()`, a migration's `up(handle)`) binds every value the same way, in two forms that behave alike on Bun and Node: positional values for anonymous `?` placeholders, as separate arguments or one array passed alone (`get([a, b])` binds as `get(a, b)`), or one plain object passed alone, keyed without the prefix (`{ id: 'a' }` for `$id`, `:id`, or `@id`). The array's elements and the object's values are mapped like positional values, in a copy, so what you pass is never changed. Numbered `?NNN` placeholders, prefixed keys (`{ $id: 'a' }`), an object passed beside positional values, and an array passed beside other arguments bind differently on the two runtimes.

## Querying

`query({ match?, filters?, sort?, limit, offset })` covers the common case:

- `match` — an FTS5 `MATCH` expression (only when the store declares `fts` columns). Translate your own query grammar to FTS5 before calling. An expression FTS5 cannot parse (`a OR`, `"unbalanced`, `nosuchcol:x`) rejects with `ValidationError` (`-32007`, `data.field: 'match'`), its message carrying SQLite's reason, so a tool can hand it back as the caller's own input. A store failure under a valid expression (a missing FTS table, a corrupted file) keeps its own error.
- `filters` — `[{ column, op, value }]`, AND-combined, over declared columns. `op` ∈ `eq|ne|gt|gte|lt|lte|in` (`in` takes an array); any other `op`, or an array on a scalar `op`, rejects with `ValidationError` before any SQL runs. An `in` list binds as one parameter, so its length meets no bound-parameter ceiling on either runtime, and it matches exactly the rows its values bound one by one would; a list holding bytes, or a `bigint` outside the signed 64-bit range, binds one parameter per value. `getByIds` binds its ids the same way and finds the row an `eq` filter on the key finds: a `TEXT` key matches the number `2024` as `'2024'`.
- `sort` — `{ column, direction }` or `'relevance'` (FTS bm25; requires `match`). Defaults to insertion order. `direction` is `'asc'` or `'desc'`; anything else rejects with `ValidationError`.

For access paths the generic query can't express — junction tables for index-backed multi-value filtering, denormalized counters, bespoke `bm25` weighting — use the **raw handle**: `const db = await mirror.raw();` then run prepared statements against your own auxiliary tables (declare them via a migration). Add the auxiliary DDL in a `migrations` step; maintain it from your `sync` mapping or SQL triggers. SQLite never indexes a foreign-key child column on its own. Give every auxiliary table an index whose leading column is the one your writes match on, usually the parent's primary key. Without it, a per-record rebuild such as `DELETE FROM paper_categories WHERE paper_id = ?`, or an `ON DELETE CASCADE` fired by a tombstone, scans the whole table on every row, and a page that should take milliseconds takes minutes on a million-row junction. Confirm with `EXPLAIN QUERY PLAN`: the plan should say `SEARCH … USING INDEX`, never `SCAN`.

A migration runs identically on first creation and on upgrade: a fresh database runs every migration up to `version` right after the declarative DDL, an existing one runs only those above its stored version. So `up()` must tolerate a database that already has the current declarative shape — `CREATE TABLE IF NOT EXISTS` for auxiliary objects, never an `ALTER` that assumes an older layout of a declared column. Each migration runs exactly once per database, in one write transaction with its version stamp: processes opening the store together wait on the write lock and skip what another already applied, and a throw from `up()` leaves nothing of it applied and the version unchanged. It need not be idempotent. `handle.exec()` runs a multi-statement string in order and throws at the first statement that fails, running nothing after it, so a failure partway through one `exec` aborts the migration like any other throw.

## Readiness — key off the completion marker, not live status

`status().ready` is `true` once a full sync has **ever completed** (`completedAt != null`), not when `status === 'complete'`. The dataset stays transactionally queryable during a refresh, so a mirror mid-refresh — or one whose last refresh failed — is still ready and should keep serving. Gate the mirror read path on `await mirror.ready()`; fall back to the live API only when it is `false` (cold, never-completed init).

## Scheduling and bootstrap (server-owned)

The service owns `runSync` + state; it does not schedule. Wire "self-refreshing" yourself:

- **Refresh** — register `runSync({ mode: 'refresh' })` on a cron via `schedulerService` from `@cyanheads/mcp-ts-core/utils`, inside `setup()`. Gate on transport (HTTP) when stdio operators run it out-of-band. A refresh cut short by a time budget, a crash, or an upstream error resumes its cursor on the next refresh, so a budget smaller than the run of records sharing one checkpoint value still advances. A run its caller stops through `signal` (Ctrl-C on an init script, an abort in `teardown`) is recorded the same way, status `error` and resumable, but logs `Mirror sync stopped` at `info`, not `Mirror sync failed` at `error`.
- **Off the serving thread** — SQLite calls are synchronous, so each write transaction a sync runs blocks the event loop until it commits. A refresh whose pages or post-sync recomputes take seconds stalls every request, `/healthz` included, for that long. Run such a scheduled sync in a child process instead: spawn `process.execPath` with `process.execArgv` and a compiled job entry in `dist/`, relay its log lines, and in `teardown` stop it with SIGTERM, then SIGKILL after a grace period. In-process scheduling suits mirrors whose transactions stay short.
- **Init** — run out-of-band (a CLI script / one-shot), never on startup: a full init can take hours and must not block the server. It is idempotent and resumable — re-running after an interrupt continues from the persisted cursor.
- **One sync at a time per store** — the SQLite store carries a sync lease, so an init CLI, a scheduled refresh in a child process, and every stdio session on one store file never sync at once. A run that finds the lease held rejects `Conflict` with `data.reason: 'sync_locked'` before its generator runs, as does an overlapping run on the same instance. `schedulerService` logs every rejection of a job at `error`, so a scheduled job returns when its own controller stopped the run, skips on that reason, and rethrows anything else:

  ```ts
  const refresh = new AbortController(); // `teardown` calls refresh.abort()

  await mirror.runSync({ mode: 'refresh', signal: refresh.signal }).catch((err) => {
    if (refresh.signal.aborted) return; // stopped for shutdown; the runner logged it at info
    if (err.data?.reason !== 'sync_locked') throw err; // another process is syncing
  });
  ```

  A run renews its lease at each page commit and on a timer between pages. If it stops renewing for `syncLeaseTtlMs` (a `defineMirror` option, default 2 minutes; a crashed holder blocks other runs that long), another run may take the lease over, and the lapsed run writes nothing more and rejects `data.reason: 'sync_lease_lost'`. Raise the TTL when a generator spends longer than that on synchronous work between yields. Writes a server makes through `raw()` outside the page commit are not fenced.

  With the lease, each page and the run's state commit through it, not through the store's `applyBatch` and `writeState`. A store wrapper that overrides those two to check or rewrite sync writes must leave the lease out, or its overrides never run: build it from `rest` in `const { syncLease, ...rest } = store`. Such a store keeps only the per-instance guard, so one sync at a time per store becomes the server's to enforce.
- **CLI logging** — a lifecycle script runs outside `createApp()`, so nothing initializes the logger for it. Call `await logger.initialize(config.logLevel, 'stdio')` (`logger` from `@cyanheads/mcp-ts-core/utils`, `config` from `@cyanheads/mcp-ts-core/config`) before the first log line, in the shared context shim the scripts import. Records logged before `initialize()` wait in a bounded buffer that is discarded at exit, so an uninitialized CLI runs an hours-long init with no output, its errors included. The `'stdio'` transport writes JSON lines to stderr and leaves stdout empty.

### Shipping the mirror CLI in a production Docker image

The scaffold `Dockerfile` copies only `dist/` to the runtime stage. A mirror lifecycle script (`mirror:init`, `mirror:refresh`, `mirror:verify`) that imports through the `@/` path alias fails under `docker exec` — `@/` resolves to `src/` via the source `tsconfig.json`, and `src/` never reaches the image.

On the Bun runtime image (`oven/bun`), two stanzas fix it — no build change, no `rootDir` surgery, and the `mirror:*` package scripts stay identical between a dev checkout and the image.

Add the following to the runtime stage of `Dockerfile`, after the `COPY --from=build .../dist ./dist` line:

```dockerfile
# Copy mirror lifecycle scripts. The shared context shim (_mirror-context.ts)
# is imported by the three named scripts, so it must travel with them.
COPY --from=build /usr/src/app/scripts/<your>-mirror-init.ts \
                  /usr/src/app/scripts/<your>-mirror-refresh.ts \
                  /usr/src/app/scripts/<your>-mirror-verify.ts \
                  /usr/src/app/scripts/_mirror-context.ts \
                  ./scripts/

# Bun honors tsconfig `paths` at runtime — map `@/` to the compiled `./dist/`
# so the .ts scripts resolve their alias imports against the build output.
# In a dev checkout the source tsconfig.json maps @/* → ./src/*; in the image
# this emitted one maps @/* → ./dist/*. Same `bun run mirror:*` command, both
# environments — the only lever is which tsconfig.json is on disk.
RUN echo '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./dist/*"]}}}' > tsconfig.json
```

**Caveat:** this relies on Bun's runtime `paths` resolution. A Node runtime image (no native `.ts` execution) needs the scripts compiled into `dist/` instead — a separate tsconfig pass with a different `rootDir` is required in that case.

**`package.json` `files[]`:** add `scripts/_mirror-context.ts` and the three named lifecycle scripts so the npm tarball and `.mcpb` bundle carry them. They resolve `@/` only where a `tsconfig.json` maps it (a dev checkout, or the image above). An npm install ships no such mapping, so an npm-installed server cannot run them: document building the mirror from a checkout or the image.

## Checklist

- [ ] `defineMirror({ name, store, sync })`; the server holds the instance (one per mirror)
- [ ] `sqliteMirrorStore` spec declares `primaryKey`, `columns`, and (if searching) `fts`
- [ ] `sync` yields `{ records, tombstones?, cursor?, checkpoint? }` per page; checkpoint is lexicographically monotonic
- [ ] Every auxiliary table has an index led by the column its writes match on (`EXPLAIN QUERY PLAN` shows no `SCAN`)
- [ ] Read path gated on `await mirror.ready()` with a live fallback when not ready
- [ ] `better-sqlite3` added to the server's `dependencies` for Node deployments; mirror disabled on Workers
- [ ] Bun deployments run Bun 1.4.4 or later: `engines.bun`, `packageManager`, and the Dockerfile's `oven/bun` tags
- [ ] Refresh wired via `schedulerService` in `setup()`; init runs out-of-band
- [ ] A scheduled `runSync` takes its job's own `signal`, returns when that controller aborted, skips on `data.reason === 'sync_locked'`, and rethrows anything else
- [ ] Mirror CLI scripts call `logger.initialize(config.logLevel, 'stdio')` before logging
- [ ] `bun run devcheck` passes

---
name: api-mirror
description: >
  Stand up a persistent, self-refreshing local mirror of a bulk upstream dataset with the MirrorService (@cyanheads/mcp-ts-core/mirror). Use when a server wraps a large or slow API and should query a synced local index (embedded SQLite + FTS5) instead of paginating the live API per request.
metadata:
  author: cyanheads
  version: "1.2"
  audience: external
  type: reference
---

## Context

The MirrorService owns the source-agnostic half of a local mirror — the embedded store, the sync-state machine, the runner — so a server supplies only the two parts that are irreducibly per-source: the **ingester** (a `sync` generator) and the **schema**. It targets the embedded-SQLite tier (~10⁴–10⁷ rows). Node/Bun only: `bun:sqlite` is built-in on Bun, `better-sqlite3` is an optional peer dependency on Node; the store is unavailable on Workers (no SQLite, no persistent filesystem).

Import from `@cyanheads/mcp-ts-core/mirror`.

## The shape

```ts
import { defineMirror, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';

const papers = defineMirror({
  name: 'arxiv-papers',
  store: sqliteMirrorStore({
    path: config.mirrorPath,
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
| Lifetime | One run; may expire; **cleared on completion** | Persists; **advances monotonically, only on success** |
| Used for | Resuming an interrupted `init` | Seeding the next `refresh` |

Why they can't merge: during a from-scratch init the records aren't ordered by the high-water field, so the max-so-far is not a valid resume position — only the cursor is. After a completed init the cursor is meaningless, but the high-water mark is the correct refresh seed. The framework persists both per page and threads the right one back into `sync()` per mode. **The checkpoint must be lexicographically monotonic** (ISO 8601 works); the runner advances the stored checkpoint only when a page's value compares greater.

## What you own vs. what the framework owns

| Framework | Server |
|---|---|
| Cross-runtime SQLite handle, WAL + `busy_timeout` | The `sync` generator (the ingester) |
| `mirror_sync_state` + cursor/checkpoint state machine | Translating your query syntax → FTS5 `match` |
| `runSync({ init \| refresh })`, per-page persist, resume | Mapping upstream records → row objects |
| Schema gen (columns + FTS + tokenizer + triggers) | Migration *content* (the `up` functions) |
| `schema_version` + migration *runner* | Scheduling + init/refresh bootstrap (see below) |
| Generic `query()` + the raw-handle escape hatch | Server-specific access paths via the raw handle |

## Querying

`query({ match?, filters?, sort?, limit, offset })` covers the common case:

- `match` — an FTS5 `MATCH` expression (only when the store declares `fts` columns). Translate your own query grammar to FTS5 before calling.
- `filters` — `[{ column, op, value }]`, AND-combined, over declared columns. `op` ∈ `eq|ne|gt|gte|lt|lte|in` (`in` takes an array).
- `sort` — `{ column, direction }` or `'relevance'` (FTS bm25; requires `match`). Defaults to insertion order.

For access paths the generic query can't express — junction tables for index-backed multi-value filtering, denormalized counters, bespoke `bm25` weighting — use the **raw handle**: `const db = await mirror.raw();` then run prepared statements against your own auxiliary tables (declare them via a migration). Add the auxiliary DDL in a `migrations` step; maintain it from your `sync` mapping or SQL triggers.

A migration runs identically on first creation and on upgrade: a fresh database runs every migration up to `version` right after the declarative DDL, an existing one runs only those above its stored version. So `up()` must tolerate a database that already has the current declarative shape — `CREATE TABLE IF NOT EXISTS` for auxiliary objects, never an `ALTER` that assumes an older layout of a declared column.

## Readiness — key off the completion marker, not live status

`status().ready` is `true` once a full sync has **ever completed** (`completedAt != null`), not when `status === 'complete'`. The dataset stays transactionally queryable during a refresh, so a mirror mid-refresh — or one whose last refresh failed — is still ready and should keep serving. Gate the mirror read path on `await mirror.ready()`; fall back to the live API only when it is `false` (cold, never-completed init).

## Scheduling and bootstrap (server-owned)

The service owns `runSync` + state; it does not schedule. Wire "self-refreshing" yourself:

- **Refresh** — register `runSync({ mode: 'refresh' })` on a cron via `schedulerService` from `@cyanheads/mcp-ts-core/utils`, inside `setup()`. Gate on transport (HTTP) when stdio operators run it out-of-band.
- **Init** — run out-of-band (a CLI script / one-shot), never on startup: a full init can take hours and must not block the server. It is idempotent and resumable — re-running after an interrupt continues from the persisted cursor.

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

**`package.json` `files[]`:** add `scripts/_mirror-context.ts` and the three named lifecycle scripts so the npm tarball and `.mcpb` bundle carry them. Consumers installing from npm need them for `docker exec` access.

## Checklist

- [ ] `defineMirror({ name, store, sync })`; the server holds the instance (one per mirror)
- [ ] `sqliteMirrorStore` spec declares `primaryKey`, `columns`, and (if searching) `fts`
- [ ] `sync` yields `{ records, tombstones?, cursor?, checkpoint? }` per page; checkpoint is lexicographically monotonic
- [ ] Read path gated on `await mirror.ready()` with a live fallback when not ready
- [ ] `better-sqlite3` added as a peer dependency for Node deployments; mirror disabled on Workers
- [ ] Refresh wired via `schedulerService` in `setup()`; init runs out-of-band
- [ ] `bun run devcheck` passes

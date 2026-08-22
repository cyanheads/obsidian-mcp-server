/**
 * @fileoverview Obsidian Local REST API service. Wraps every upstream HTTP
 * endpoint we use, builds the right URL/headers/body for the consolidated
 * `target` discriminator, and classifies errors for the framework.
 * @module services/obsidian/obsidian-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  conflict,
  forbidden,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { httpStatusToErrorCode, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { Agent, type Dispatcher, type RequestInit, fetch as undiciFetch } from 'undici';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { PathPolicy } from './path-policy.js';
import type {
  DocumentMap,
  FileListing,
  NoteJson,
  NoteTarget,
  ObsidianCommand,
  ObsidianTag,
  OmnisearchHit,
  PatchHeaders,
  StructuredSearchHit,
  TextSearchHit,
  VaultStatus,
} from './types.js';

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

/**
 * The HTTP fetch contract this service depends on. Defaults to undici's
 * `fetch`; tests inject a stub here instead of mocking the `undici` module
 * (Bun's runtime treats `undici` as a builtin, so `vi.mock('undici')` has no
 * effect under `bunx vitest`).
 */
export type ObsidianFetch = (
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher; signal?: AbortSignal },
) => Promise<UndiciResponse>;

interface UpstreamErrorBody {
  errorCode?: number;
  message?: string;
  [k: string]: unknown;
}

/**
 * Upstream "list files" payload. The plugin returns a flat `files` array where
 * directory entries end with `/`. Callers split into files vs. directories.
 */
interface RawFileListing {
  files: string[];
}

interface RawTagsListing {
  tags: ObsidianTag[];
  totalDirectTags?: number;
  totalFileTags?: number;
}

interface RawSimpleSearchHit {
  filename: string;
  matches: Array<{ context: string; match: { start: number; end: number } }>;
  score?: number;
}

interface RawStructuredSearchHit {
  filename: string;
  result: unknown;
}

/**
 * Upstream Omnisearch payload. The plugin returns one of these per file; we
 * rename `path` to `filename` on the way out so `PathPolicy.filterReadable`
 * can match the shape, and drop `vault` since this server is single-vault.
 */
interface RawOmnisearchHit {
  basename: string;
  excerpt: string;
  foundWords: string[];
  matches: Array<{ match: string; offset: number }>;
  path: string;
  score: number;
  vault?: string;
}

/** Per-call timeout for the startup probe — covers the 4-tuple TCP handshake + a tiny GET. */
const OMNISEARCH_PROBE_TIMEOUT_MS = 500;

const OMNISEARCH_DEFAULT_PORT = '51361';

const NOTE_JSON_ACCEPT = 'application/vnd.olrapi.note+json';
const DOCUMENT_MAP_ACCEPT = 'application/vnd.olrapi.document-map+json';
const JSONLOGIC_CT = 'application/vnd.olrapi.jsonlogic+json';

/**
 * The markdown-patch wire format this client speaks, pinned explicitly on every
 * request whose shape depends on it: header-driven PATCH targeting and the
 * document map.
 *
 * Local REST API v5.0.0 made format 2.0 the default, rejects header-driven
 * PATCH targeting outright unless a version is pinned, and returns the document
 * map's `headings` as a nested tree instead of `::`-joined paths. Plugin v4.x
 * predates the header and only ever reads named headers it knows, so the pin is
 * inert there — one unconditional value covers the whole supported plugin
 * range, and no future default flip can move the format underneath this client.
 *
 * Format 1.x carries `Deprecation: true; sunset-version="6.0"` upstream; the
 * migration to 2.0 is tracked in #102.
 */
const MARKDOWN_PATCH_VERSION_HEADER = 'Markdown-Patch-Version';
const MARKDOWN_PATCH_VERSION = '1';

/** Delimiter joining ancestor headings into a single PATCH heading target. */
const HEADING_DELIMITER = '::';

/**
 * Methods safe to retry on transient errors. POST/PATCH are excluded — a
 * successful upstream write with a lost response would double-apply on retry
 * (duplicate `append`, re-run Obsidian command).
 */
const RETRY_SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'PUT', 'DELETE']);

export class ObsidianService {
  readonly #config: ServerConfig;
  readonly #dispatcher: Dispatcher;
  readonly #fetch: ObsidianFetch;
  readonly #policy: PathPolicy;
  readonly #omnisearchUrl: string;

  /**
   * @param config - Validated server config (api key, base URL, TLS, timeouts).
   * @param fetchImpl - Optional fetch override for tests. Defaults to undici's
   *   `fetch`, which honors the constructed TLS dispatcher in production.
   */
  constructor(config: ServerConfig, fetchImpl?: ObsidianFetch) {
    this.#config = config;
    this.#policy = new PathPolicy(config);
    this.#omnisearchUrl = deriveOmnisearchUrl(config);
    /**
     * Bun's runtime ignores undici's per-dispatcher `connect.rejectUnauthorized`
     * option, so the only reliable opt-out under Bun is the process-wide
     * `NODE_TLS_REJECT_UNAUTHORIZED=0` flag. Node honors the dispatcher option
     * (set below), so the env var fallback is scoped to Bun to avoid mutating
     * process-wide TLS behavior on Node. Default Obsidian Local REST API ships
     * a self-signed cert, so most users run with `OBSIDIAN_VERIFY_SSL=false`.
     */
    if (!config.verifySsl && typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    this.#dispatcher = new Agent({
      connect: { rejectUnauthorized: config.verifySsl },
      headersTimeout: config.requestTimeoutMs,
      bodyTimeout: config.requestTimeoutMs,
    });
    this.#fetch = fetchImpl ?? (undiciFetch as ObsidianFetch);
  }

  /** Path-policy accessor — used by `obsidian_search_notes` to filter hits. */
  get policy(): PathPolicy {
    return this.#policy;
  }

  /** Resolved Omnisearch URL (derived from baseUrl or OBSIDIAN_OMNISEARCH_URL override). */
  get omnisearchUrl(): string {
    return this.#omnisearchUrl;
  }

  // ── Status ───────────────────────────────────────────────────────────────

  async getStatus(ctx: Context): Promise<VaultStatus> {
    const res = await this.#request(ctx, '/', { method: 'GET', skipAuth: true });
    return (await res.json()) as VaultStatus;
  }

  /**
   * Probe whether the configured `OBSIDIAN_API_KEY` is accepted. Hits the
   * authenticated `/vault/` listing endpoint and reports `true` only on a 2xx
   * response. Network/auth errors yield `false` — the resource caller wants a
   * boolean, not an exception. Aborts are re-thrown so cancellation/timeout
   * doesn't masquerade as an auth failure.
   */
  async probeAuthenticated(ctx: Context): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#config.baseUrl}/vault/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.#config.apiKey}` },
        dispatcher: this.#dispatcher,
        signal: ctx.signal,
      });
      return res.ok;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      return false;
    }
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  async getNoteContent(ctx: Context, target: NoteTarget): Promise<string> {
    if (target.type === 'path') {
      this.#policy.assertReadable(target.path);
      const url = this.#targetToPath(target);
      const res = await this.#request(ctx, url, {
        method: 'GET',
        headers: { Accept: 'text/markdown' },
        noteRead: true,
      });
      return await res.text();
    }
    /**
     * Non-path target with restrictions: route via JSON to learn the resolved
     * path, gate it, then return the content. Costs a single JSON fetch
     * instead of the markdown one — only paid by users who configured a path
     * scope.
     */
    if (!this.#policy.isUnrestricted) {
      const note = await this.getNoteJson(ctx, target);
      return note.content;
    }
    const url = this.#targetToPath(target);
    const res = await this.#request(ctx, url, {
      method: 'GET',
      headers: { Accept: 'text/markdown' },
    });
    return await res.text();
  }

  async getNoteJson(ctx: Context, target: NoteTarget): Promise<NoteJson> {
    if (target.type === 'path') {
      this.#policy.assertReadable(target.path);
    }
    const note = await this.#rawGetNoteJson(ctx, target);
    if (target.type !== 'path') {
      this.#policy.assertReadable(note.path);
    }
    return note;
  }

  /**
   * Resolve `target` to a vault-relative path. For path targets this is a
   * no-op; for `active` and `periodic` targets we have to ask upstream which
   * concrete file is currently in play.
   */
  async resolvePath(ctx: Context, target: NoteTarget): Promise<string> {
    if (target.type === 'path') return target.path;
    return (await this.getNoteJson(ctx, target)).path;
  }

  async getDocumentMap(ctx: Context, target: NoteTarget): Promise<DocumentMap> {
    if (target.type === 'path') {
      this.#policy.assertReadable(target.path);
      return this.#rawGetDocumentMap(ctx, target);
    }
    if (this.#policy.isUnrestricted) {
      return this.#rawGetDocumentMap(ctx, target);
    }
    /**
     * Restricted + non-path: parallel-fetch the document map and resolve the
     * path so we can gate. If the gate denies, the parallel fetch result is
     * discarded — acceptable cost given the rarity of this configuration.
     */
    const [path, map] = await Promise.all([
      this.resolvePath(ctx, target),
      this.#rawGetDocumentMap(ctx, target),
    ]);
    this.#policy.assertReadable(path);
    return map;
  }

  async writeNote(
    ctx: Context,
    target: NoteTarget,
    content: string,
    contentType: 'markdown' | 'json' = 'markdown',
  ): Promise<void> {
    const safe = await this.#gateAsWrite(ctx, target);
    const url = this.#targetToPath(safe);
    await this.#request(ctx, url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType === 'json' ? 'application/json' : 'text/markdown' },
      body: content,
    });
  }

  async appendToNote(
    ctx: Context,
    target: NoteTarget,
    content: string,
    contentType: 'markdown' | 'json' = 'markdown',
  ): Promise<void> {
    const safe = await this.#gateAsWrite(ctx, target);
    const url = this.#targetToPath(safe);
    await this.#request(ctx, url, {
      method: 'POST',
      headers: { 'Content-Type': contentType === 'json' ? 'application/json' : 'text/markdown' },
      body: content,
    });
  }

  /**
   * Apply a header-targeted PATCH. Returns the section locator the edit was
   * actually applied to — identical to `headers.target` unless a bare heading
   * leaf was expanded to its full `Parent::Child` path (see
   * `#resolveHeadingTarget`), which callers echo back so an agent can see where
   * the write landed.
   */
  async patchNote(
    ctx: Context,
    target: NoteTarget,
    content: string,
    headers: PatchHeaders,
  ): Promise<string> {
    const safe = await this.#gateAsWrite(ctx, target);
    const resolvedTarget = await this.#resolveHeadingTarget(ctx, safe, headers);
    const url = this.#targetToPath(safe);
    await this.#request(ctx, url, {
      method: 'PATCH',
      headers: this.#buildPatchHeaders({ ...headers, target: resolvedTarget }),
      body: content,
    });
    return resolvedTarget;
  }

  async deleteNote(ctx: Context, target: NoteTarget): Promise<void> {
    const safe = await this.#gateAsWrite(ctx, target);
    const url = this.#targetToPath(safe);
    await this.#request(ctx, url, { method: 'DELETE' });
  }

  /**
   * Byte size of a note at `target`, derived from the HEAD `Content-Length`
   * header. Returns `null` on 404 — distinct from a 0-byte file.
   *
   * Source-of-truth rule for note byte sizes across mutating tools:
   *   1. HEAD `Content-Length` (this method)       — when no GET is in flight.
   *   2. `Buffer.byteLength(deliveredContent)`     — when a GET happens anyway (free).
   *   3. `note.stat.size` from the JSON envelope   — REJECTED: shares the upstream
   *      `getAbstractFileByPath` cache path with the rest of the envelope, so it
   *      can't act as an independent cross-check (cache-desync scenario in
   *      coddingtonbear/obsidian-local-rest-api#237). Always prefer delivered
   *      bytes or HEAD over the metadata field.
   *
   * Bypasses retries (a 404 is the answer, not a transient failure) and
   * gates readable on path targets before issuing the HEAD.
   */
  async tryGetSize(ctx: Context, target: NoteTarget): Promise<number | null> {
    if (target.type === 'path') {
      this.#policy.assertReadable(target.path);
    }
    const url = this.#targetToPath(target);
    const res = await this.#fetch(`${this.#config.baseUrl}${url}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${this.#config.apiKey}` },
      dispatcher: this.#dispatcher,
      signal: ctx.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) await this.#throwForStatus(res, url, ctx);
    this.#assertNotDirectory(res, url, ctx);
    return parseContentLength(res, url);
  }

  /**
   * Like `tryGetSize`, but throws `note_missing` on 404 — for verification
   * reads that come *after* a write where the file is expected to exist.
   */
  async getSize(ctx: Context, target: NoteTarget): Promise<number> {
    const size = await this.tryGetSize(ctx, target);
    if (size === null) {
      const display = target.type === 'path' ? target.path : '(target)';
      throw notFound(`Note not found: ${display}`, {
        path: display,
        reason: 'note_missing',
        ...ctx.recoveryFor('note_missing'),
      });
    }
    return size;
  }

  // ── Listings ─────────────────────────────────────────────────────────────

  async listFiles(ctx: Context, dirPath?: string): Promise<FileListing> {
    let url = '/vault/';
    let normalized = '';
    if (dirPath) {
      normalized = dirPath.replace(/^\/+|\/+$/g, '');
      if (normalized) url = `/vault/${encodeVaultPath(normalized)}/`;
    }
    /**
     * Gate the directory itself when it's non-empty — root listings always
     * pass so users can navigate into their scope. Children aren't filtered
     * here; the per-file read gate on `getNoteContent` etc. catches access to
     * out-of-scope individual notes.
     */
    if (normalized) {
      this.#policy.assertReadable(normalized);
    }
    const res = await this.#request(ctx, url, { method: 'GET' });
    return (await res.json()) as RawFileListing;
  }

  async listTags(ctx: Context): Promise<ObsidianTag[]> {
    const res = await this.#request(ctx, '/tags/', { method: 'GET' });
    const body = (await res.json()) as RawTagsListing;
    return body.tags ?? [];
  }

  async listCommands(ctx: Context): Promise<ObsidianCommand[]> {
    const res = await this.#request(ctx, '/commands/', { method: 'GET' });
    const body = (await res.json()) as { commands: ObsidianCommand[] };
    return body.commands ?? [];
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /**
   * Text search. The upstream materializes one context window per matching
   * note before it responds, so an oversized `contextLength` on a broad query
   * exhausts V8's string capacity and comes back as an opaque 500 — caught
   * here and re-thrown typed, the way `searchOmnisearch` re-throws its own
   * reachability failure.
   */
  async searchText(ctx: Context, query: string, contextLength = 100): Promise<TextSearchHit[]> {
    const params = new URLSearchParams({ query, contextLength: String(contextLength) });
    let res: UndiciResponse;
    try {
      res = await this.#request(ctx, `/search/simple/?${params}`, { method: 'POST' });
    } catch (err) {
      if (!isStringCapacityOverflow(err)) throw err;
      /**
       * Built fresh rather than decorated: `contextLength` is the actionable
       * fact and only this frame knows it. `cause` keeps the caught error —
       * and through it the upstream body `#throwForStatus` attached — on the
       * server side for the log record.
       */
      throw validationError(
        `The Local REST API ran out of string capacity assembling match contexts for this search (contextLength ${contextLength}). It builds a context window for every matching note before responding, so the ceiling tracks contextLength multiplied by the number of matches rather than either alone.`,
        {
          reason: 'context_length_too_large',
          contextLength,
          ...ctx.recoveryFor('context_length_too_large'),
        },
        { cause: err },
      );
    }
    const raw = (await res.json()) as RawSimpleSearchHit[];
    // Upstream returns a constant `score` that carries no ranking signal for
    // text mode — drop it on the way out so consumers don't mistake it for
    // relevance. Omnisearch is the source of real BM25 ranking.
    return raw.map((h) => ({
      filename: h.filename,
      matches: h.matches.map((m) => ({
        context: m.context,
        match: { ...m.match, ...contextRelativeSpan(m, h.filename, contextLength, query) },
      })),
    }));
  }

  async searchJsonLogic(
    ctx: Context,
    logic: Record<string, unknown>,
  ): Promise<StructuredSearchHit[]> {
    const res = await this.#request(ctx, '/search/', {
      method: 'POST',
      headers: { 'Content-Type': JSONLOGIC_CT },
      body: JSON.stringify(logic),
    });
    return (await res.json()) as RawStructuredSearchHit[];
  }

  /**
   * One-shot startup probe for the Omnisearch plugin's HTTP endpoint. Returns
   * `true` only when the response is `HTTP 200`, declares `application/json`,
   * and the body parses as a JSON array — unrouted paths on the Omnisearch
   * server also return `200` with an empty body, so status alone is
   * insufficient. The entry point passes the return value into the
   * `obsidian_search_notes` factory to decide whether to expose the
   * `omnisearch` mode.
   */
  async probeOmnisearch(signal?: AbortSignal): Promise<boolean> {
    const probeSignal = signal ?? AbortSignal.timeout(OMNISEARCH_PROBE_TIMEOUT_MS);
    try {
      const res = await this.#fetch(`${this.#omnisearchUrl}/search?q=`, {
        method: 'GET',
        dispatcher: this.#dispatcher,
        signal: probeSignal,
      });
      if (!res.ok) return false;
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) return false;
      const body = await res.json().catch(() => undefined);
      return Array.isArray(body);
    } catch {
      return false;
    }
  }

  /**
   * Query the Omnisearch HTTP endpoint. Normalizes the response on the way
   * out: decodes HTML entities + `<br>` → `\n` in `excerpt`, renames `path`
   * to `filename`, and drops `vault`. Throws `omnisearch_unreachable`
   * (ServiceUnavailable) on network failures or non-2xx responses — the
   * plugin can shut down mid-session (Obsidian quits, plugin disabled), and
   * the tool needs a distinct signal from the upstream's success cases.
   */
  async searchOmnisearch(ctx: Context, query: string): Promise<OmnisearchHit[]> {
    const url = `${this.#omnisearchUrl}/search?q=${encodeURIComponent(query)}`;
    let res: UndiciResponse;
    try {
      res = await this.#fetch(url, {
        method: 'GET',
        dispatcher: this.#dispatcher,
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      throw serviceUnavailable(
        `Omnisearch unreachable at ${this.#omnisearchUrl}. The plugin may have stopped (Obsidian quit, plugin disabled, or mobile session).`,
        {
          reason: 'omnisearch_unreachable',
          url: this.#omnisearchUrl,
          ...ctx.recoveryFor('omnisearch_unreachable'),
        },
        { cause: err },
      );
    }
    if (!res.ok) {
      throw serviceUnavailable(
        `Omnisearch returned HTTP ${res.status} at ${this.#omnisearchUrl}.`,
        {
          reason: 'omnisearch_unreachable',
          url: this.#omnisearchUrl,
          status: res.status,
          ...ctx.recoveryFor('omnisearch_unreachable'),
        },
      );
    }
    const body = (await res.json()) as RawOmnisearchHit[];
    return body.map(normalizeOmnisearchHit);
  }

  // ── UI / commands ────────────────────────────────────────────────────────

  async executeCommand(ctx: Context, commandId: string): Promise<void> {
    await this.#request(ctx, `/commands/${encodeURIComponent(commandId)}/`, { method: 'POST' });
  }

  /**
   * Open a file in the Obsidian UI.
   *
   * Obsidian materializes the file when the path does not exist, so the call
   * is only a read when the caller has established that the file is already
   * there. `createIfMissing` marks the create-capable variant and gates it as
   * a write, which is what makes `OBSIDIAN_READ_ONLY` and
   * `OBSIDIAN_WRITE_PATHS` constrain it — the creation happens inside Obsidian
   * and never passes through any other write check.
   */
  async openInUi(
    ctx: Context,
    path: string,
    opts?: { newLeaf?: boolean; createIfMissing?: boolean },
  ): Promise<void> {
    if (opts?.createIfMissing) {
      this.#policy.assertWritable(path);
    } else {
      this.#policy.assertReadable(path);
    }
    const params = new URLSearchParams();
    if (opts?.newLeaf) params.set('newLeaf', 'true');
    const qs = params.toString();
    await this.#request(ctx, `/open/${encodeVaultPath(path)}${qs ? `?${qs}` : ''}`, {
      method: 'POST',
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Resolve a write target to a gated path target. For path inputs, gates
   * `target.path` as a write before any upstream call. For non-path inputs
   * (`active` / `periodic`) when restrictions are active, a JSON resolution
   * fetch happens first (without gating, since the user has write authority
   * on the resolved path or fails here), then the resolved path is gated.
   */
  async #gateAsWrite(ctx: Context, target: NoteTarget): Promise<NoteTarget> {
    if (target.type === 'path') {
      this.#policy.assertWritable(target.path);
      return target;
    }
    if (this.#policy.isUnrestricted) {
      return target;
    }
    const note = await this.#rawGetNoteJson(ctx, target);
    this.#policy.assertWritable(note.path);
    return { type: 'path', path: note.path };
  }

  /** Raw NoteJson fetch — bypasses path-policy. Used by gate helpers to learn the resolved path. */
  async #rawGetNoteJson(ctx: Context, target: NoteTarget): Promise<NoteJson> {
    const url = this.#targetToPath(target);
    const res = await this.#request(ctx, url, {
      method: 'GET',
      headers: { Accept: NOTE_JSON_ACCEPT },
      noteRead: true,
    });
    return (await res.json()) as NoteJson;
  }

  /** Raw document-map fetch — bypasses path-policy. Caller must gate. */
  async #rawGetDocumentMap(ctx: Context, target: NoteTarget): Promise<DocumentMap> {
    const url = this.#targetToPath(target);
    const res = await this.#request(ctx, url, {
      method: 'GET',
      headers: {
        Accept: DOCUMENT_MAP_ACCEPT,
        [MARKDOWN_PATCH_VERSION_HEADER]: MARKDOWN_PATCH_VERSION,
      },
      noteRead: true,
    });
    return (await res.json()) as DocumentMap;
  }

  /**
   * Resolve a heading PATCH target against the note's document map so a bare
   * leaf name reaches the same section on writes that it already reaches on
   * reads. `extractSection` matches a heading at any depth, so an agent that
   * read `## Sibling` by its bare name carries that name to a write, where
   * upstream targeting wants the whole `Parent::Child` chain.
   *
   * Resolution order: an exact map entry wins (preserving upstream's own
   * interpretation), then a unique leaf match is expanded, then several leaf
   * matches are rejected as ambiguous rather than silently writing to the first.
   * A leaf absent from the map passes through untouched so
   * `Create-Target-If-Missing` still creates it and the upstream's own
   * target-miss error still surfaces. Non-heading targets and locators that
   * already carry the delimiter skip the lookup entirely.
   */
  async #resolveHeadingTarget(
    ctx: Context,
    target: NoteTarget,
    headers: PatchHeaders,
  ): Promise<string> {
    if (headers.targetType !== 'heading' || headers.target.includes(HEADING_DELIMITER)) {
      return headers.target;
    }
    const map = await this.#rawGetDocumentMap(ctx, target);
    if (map.headings.includes(headers.target)) return headers.target;

    const matches = map.headings.filter((h) => h.split(HEADING_DELIMITER).pop() === headers.target);
    const [first] = matches;
    if (first === undefined) return headers.target;
    if (matches.length === 1) return first;

    const display = displayPath(this.#targetToPath(target));
    throw conflict(
      `Heading '${headers.target}' is ambiguous in ${display} — ${matches.length} headings share that name: ${matches.join(', ')}.`,
      {
        path: display,
        reason: 'ambiguous_section',
        candidates: matches,
        recovery: {
          hint: `Re-issue the call with one of the full heading paths in \`candidates\` as \`section.target\` (e.g. "${first}"). obsidian_get_note with format "document-map" lists every heading path in this note.`,
        },
      },
    );
  }

  #targetToPath(target: NoteTarget): string {
    switch (target.type) {
      case 'path':
        return `/vault/${encodeVaultPath(target.path)}`;
      case 'active':
        return '/active/';
      case 'periodic': {
        if (target.date) {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(target.date);
          if (!m) {
            throw validationError(`Invalid date '${target.date}', expected YYYY-MM-DD.`);
          }
          const [, y, mo, d] = m;
          return `/periodic/${target.period}/${y}/${mo}/${d}/`;
        }
        return `/periodic/${target.period}/`;
      }
    }
  }

  #buildPatchHeaders(p: PatchHeaders): Record<string, string> {
    const headers: Record<string, string> = {
      [MARKDOWN_PATCH_VERSION_HEADER]: MARKDOWN_PATCH_VERSION,
      Operation: p.operation,
      'Target-Type': p.targetType,
      Target: encodeURIComponent(p.target),
      'Content-Type': p.contentType === 'json' ? 'application/json' : 'text/markdown',
    };
    if (p.targetDelimiter) headers['Target-Delimiter'] = p.targetDelimiter;
    if (p.createTargetIfMissing) headers['Create-Target-If-Missing'] = 'true';
    /**
     * Sense inversion: markdown-patch 1.0 (shipped with Local REST API v4.0.0)
     * renamed `Apply-If-Content-Preexists` to `Reject-If-Content-Preexists`
     * and flipped the default — patches now apply regardless of duplicates
     * unless the caller opts into rejection. We keep `applyIfContentPreexists`
     * on the public schema for caller stability and translate here: a falsy
     * value (the public default) sends the new Reject header to preserve the
     * historical idempotent-by-default behavior. Replace operations are
     * exempt at the plugin layer regardless of this flag.
     */
    if (!p.applyIfContentPreexists) headers['Reject-If-Content-Preexists'] = 'true';
    if (p.trimTargetWhitespace) headers['Trim-Target-Whitespace'] = 'true';
    return headers;
  }

  #request(
    ctx: Context,
    pathAndQuery: string,
    init: {
      method: string;
      headers?: Record<string, string>;
      body?: string;
      skipAuth?: boolean;
      /** Set on requests that expect a single note back — enables the directory guard. */
      noteRead?: boolean;
    },
  ): Promise<UndiciResponse> {
    const url = `${this.#config.baseUrl}${pathAndQuery}`;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (!init.skipAuth) {
      headers.Authorization = `Bearer ${this.#config.apiKey}`;
    }

    const exec = async (): Promise<UndiciResponse> => {
      const res = await this.#fetch(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        dispatcher: this.#dispatcher,
        signal: ctx.signal,
      });
      if (!res.ok) {
        await this.#throwForStatus(res, pathAndQuery, ctx);
      }
      if (init.noteRead) {
        this.#assertNotDirectory(res, pathAndQuery, ctx);
      }
      return res;
    };

    if (!RETRY_SAFE_METHODS.has(init.method.toUpperCase())) {
      return exec();
    }

    return withRetry(exec, {
      operation: `obsidian.${init.method} ${pathAndQuery}`,
      context: {
        requestId: ctx.requestId,
        timestamp: ctx.timestamp,
        ...(ctx.tenantId !== undefined ? { tenantId: ctx.tenantId } : {}),
        ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
        ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
      },
      baseDelayMs: 200,
      maxRetries: 3,
      signal: ctx.signal,
    });
  }

  /**
   * Reject a `2xx` note read that actually served a folder listing. The Local
   * REST API answers `GET`/`HEAD /vault/<dir>` with `200` and a JSON listing
   * for every `Accept` type, so status never distinguishes a directory from a
   * note and each read projection fails differently downstream — the markdown
   * one silently returns the listing as note body, the JSON ones fail schema
   * validation with no reason attached.
   *
   * The discriminator is a pair of response headers, verified against Local
   * REST API v5.0.3: a file read always carries `Content-Disposition:
   * attachment; filename="…"` (whatever its own media type — a vault `.json`
   * file reports `application/json` too, which is why content type alone can't
   * decide it), while the folder listing carries no such header and is always
   * `application/json`. Scoped to `/vault/` because that is the only route
   * where a path can name a directory; `/active/` and `/periodic/` always
   * resolve to one file.
   */
  #assertNotDirectory(res: UndiciResponse, path: string, ctx: Context): void {
    if (!path.startsWith('/vault/')) return;
    if (res.headers.get('content-disposition') !== null) return;
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return;
    const display = displayPath(path);
    throw validationError(`${display} is a directory, not a note.`, {
      path: display,
      reason: 'path_is_directory',
      ...ctx.recoveryFor('path_is_directory'),
    });
  }

  /**
   * Classify an upstream error response and throw.
   *
   * **Containment invariant.** Four things leave this method on the wire and
   * nothing else: a message authored in this file, the request path the caller
   * supplied (`data.path`), the HTTP status (`data.status`, default branch),
   * and the calling tool's own contract `reason` + `recovery`. The upstream's
   * response body never crosses, in any branch, under any key.
   *
   * That is stricter than redaction, deliberately. The Local REST API
   * interleaves genuine diagnostics with vault data in one string: a rejected
   * JSONLogic tree names the note the plugin was evaluating when it gave up
   * (`(while processing <path>)`) and, when `regexp`'s operands are reversed,
   * quotes that note's body back as the pattern it failed to compile; 5xx
   * bodies relay Node `fs` errors carrying the vault's absolute on-disk
   * location. `PathPolicy` gates the success path only, so none of that is
   * scoped to what the caller may read. The two halves cannot be separated
   * reliably — the pattern echo is delimited by characters the note body may
   * itself contain, so any parse that keeps "the diagnostic half" fails open
   * on exactly the input a caller controls, and failing open is the wrong
   * direction for a containment control. So containment wins: the upstream
   * text is read here only to *classify*, and what the caller receives is this
   * file's own account of the failure. A misclassification therefore costs
   * accuracy, never containment.
   *
   * The body is not discarded. It rides as `cause`, which the framework's
   * error handler walks into the log record and neither client surface
   * serializes — `ErrorOptions` makes `cause` non-enumerable, the tool error
   * envelope is built from `code`/`message`/`data` alone, and so is the
   * JSON-RPC error object the SDK emits for resources.
   *
   * Issues #104 and #116.
   */
  async #throwForStatus(res: UndiciResponse, path: string, ctx: Context): Promise<never> {
    const text = await this.#readBodySafe(res);
    const body = parseJsonObject(text);
    const display = displayPath(path);
    /** Classification input and log payload only — never a wire value. */
    const upstreamMsg = typeof body?.message === 'string' ? body.message : text.trim();
    const cause = new UpstreamErrorText(upstreamMsg);
    const data = (reason?: string) => ({
      path: display,
      ...(reason !== undefined ? { reason, ...ctx.recoveryFor(reason) } : {}),
    });

    switch (res.status) {
      case 401:
        throw unauthorized(
          'Obsidian Local REST API rejected the API key. Verify OBSIDIAN_API_KEY matches the value in Obsidian → Settings → Local REST API.',
          data(),
          { cause },
        );
      case 403:
        throw forbidden(
          'Obsidian Local REST API forbids this request. Check the plugin permissions.',
          data(),
          { cause },
        );
      case 404: {
        if (path.startsWith('/active/')) {
          throw notFound(
            'No file is currently active in Obsidian — open a file in the app first.',
            data('no_active_file'),
            { cause },
          );
        }
        if (path.startsWith('/periodic/')) {
          const dateMatch = /\/(\d{4})\/(\d{2})\/(\d{2})\/?$/.exec(path);
          const suffix = dateMatch ? ` for ${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '';
          throw notFound(
            `No ${periodOf(path)} note found${suffix}. Check that the Periodic Notes plugin is enabled and the note exists.`,
            data('periodic_not_found'),
            { cause },
          );
        }
        if (path.startsWith('/commands/')) {
          throw notFound(
            `Unknown Obsidian command: ${display}. Use \`obsidian_list_commands\` to discover valid command IDs.`,
            data('command_unknown'),
            { cause },
          );
        }
        throw notFound(`Not found: ${display}`, data('note_missing'), { cause });
      }
      case 405:
        throw validationError(
          `${display} cannot accept this method (often: the path is a directory, not a file).`,
          data('path_is_directory'),
          { cause },
        );
      case 400: {
        /**
         * A malformed JSONLogic tree is rejected by the plugin's query parser
         * with a bare 400. Keyed on the exact route rather than the message,
         * because the upstream wording varies with which parse stage failed
         * and `/search/simple/` (text mode) shares the `/search/` prefix
         * without sharing the cause.
         *
         * The uncompilable-`regexp` case is named separately: it is the
         * ordinary failure of a hand-written backlink query, and it is also
         * the one whose upstream text quotes a note body. Classifying it here
         * keeps the diagnostic a caller needs without relaying the pattern
         * that carries it. The `logic_invalid` contract recovery supplies the
         * operand order, and the framework mirrors it onto both surfaces.
         */
        if (routeOf(path) === '/search/') {
          throw validationError(
            /invalid regular expression/i.test(upstreamMsg)
              ? 'The Local REST API could not compile a `regexp` operand in the JSONLogic tree. `regexp` takes `[PATTERN, VALUE]` — with the operands reversed, the note field is compiled as the pattern.'
              : 'The Local REST API could not evaluate the JSONLogic tree.',
            data('logic_invalid'),
            { cause },
          );
        }
        // Content-preexists is a more specific case nested inside the broader
        // "could not be applied" family — branch on it first so retries with
        // identical content surface the right reason and recovery (toggle
        // `applyIfContentPreexists`) instead of misleading section-miss copy.
        if (/content-already-preexists-in-target/i.test(upstreamMsg)) {
          throw validationError(
            `The supplied content already appears at the target in ${display}. Pass \`applyIfContentPreexists: true\` to force-apply, or change the content.`,
            data('content_preexists'),
            { cause },
          );
        }
        // The Local REST API returns a "could not be applied to the target
        // content" / "invalid-target" message when a PATCH names a section that
        // doesn't exist. Translate to actionable guidance.
        const isTargetMiss = /\bcould not be applied\b|\binvalid-target\b/i.test(upstreamMsg);
        if (isTargetMiss) {
          throw validationError(
            `Section target not found in ${display}. Use \`obsidian_get_note\` with \`format: "document-map"\` to list available headings, blocks, and frontmatter fields, then retry with one of those locators.`,
            data('section_target_missing'),
            { cause },
          );
        }
        // Periodic Notes plugin returns 400 with "Specified period is not enabled"
        // when the requested period (daily/weekly/monthly/...) is disabled in the
        // user's plugin settings. Distinct from periodic_not_found (404) — caller
        // can enable it or fall back to an explicit path target.
        if (path.startsWith('/periodic/') && /\bnot enabled\b/i.test(upstreamMsg)) {
          throw validationError(
            `The ${periodOf(path)} period is not enabled in Obsidian's Periodic Notes plugin settings. Enable it there, or address the note by an explicit vault path instead.`,
            data('periodic_disabled'),
            { cause },
          );
        }
        throw validationError(
          `Obsidian Local REST API rejected the request to ${display} as malformed (HTTP 400).`,
          data(),
          { cause },
        );
      }
      default: {
        /**
         * Unhandled 4xx and all 5xx. `httpStatusToErrorCode` supplies the same
         * canonical mapping `httpErrorFromResponse` would (500/501 →
         * InternalError, 502/503 → ServiceUnavailable, 504 → Timeout) without
         * that helper's response-derived extras: it builds its message from
         * the upstream's reason phrase and mirrors the body onto
         * `data.body`/`data.responseBody`, which is the #104 leak.
         *
         * `Retry-After` is re-attached by hand: it is a duration, never vault
         * data, and `withRetry` reads `data.retryAfter` to pace its backoff, so
         * dropping it with the rest would quietly change retry timing.
         */
        const retryAfter = res.headers.get('retry-after');
        throw new McpError(
          httpStatusToErrorCode(res.status) ?? JsonRpcErrorCode.InternalError,
          `Obsidian Local REST API returned HTTP ${res.status}.`,
          {
            ...data(),
            status: res.status,
            ...(retryAfter !== null ? { retryAfter } : {}),
          },
          { cause },
        );
      }
    }
  }

  async #readBodySafe(res: UndiciResponse): Promise<string> {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }
}

/**
 * Encode a vault-relative path for the URL. Splits on `/` and `\` (so
 * Windows-style separators are honored), URL-encodes each segment, and
 * rejoins with `/` since the Local REST API plugin expects forward slashes.
 *
 * Rejects `.` and `..` segments here rather than relying on the upstream Local
 * REST API plugin to normalize them — `PathPolicy` short-circuits to "allow"
 * when `OBSIDIAN_READ_PATHS` is unset, and `..` is unreserved per RFC 3986 so
 * `encodeURIComponent` leaves it intact. This is the single chokepoint before
 * URL construction, so guard vault escape here. Backslash is treated as a
 * separator so `..\..\etc` traverses identically to `../../etc` and can't
 * sneak past as a single opaque segment.
 */
export function encodeVaultPath(path: string): string {
  const segments = path.split(/[/\\]/).filter((seg) => seg.length > 0);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      /**
       * Recovery is written inline rather than resolved from the calling
       * tool's contract: this is a free function with no `ctx` to hand to
       * `ctx.recoveryFor`, and the guidance is the same static sentence every
       * contract declares for `path_traversal`.
       */
      throw validationError(`Path traversal not allowed: '${path}'`, {
        path,
        reason: 'path_traversal',
        recovery: {
          hint: 'Supply a vault-relative path with no `.` or `..` segments, e.g. "Projects/Note.md". Use obsidian_list_notes to browse the vault.',
        },
      });
    }
  }
  return segments.map((seg) => encodeURIComponent(seg)).join('/');
}

/**
 * Locate the match span inside the `context` window the upstream ships with it.
 *
 * `start`/`end` are offsets into whichever subject the plugin matched, and
 * there are two. For a **body match** the subject is the note text and the
 * window is `body.slice(max(0, start - contextLength), min(len, end + contextLength))`,
 * so the span sits `min(start, contextLength)` characters into `context`. For a
 * **filename match** the subject is the note's basename and the plugin returns
 * that basename whole as `context`, so the span sits at `start` — which runs
 * past `min(start, contextLength)` as soon as the name is longer than the
 * window. A single hit's `matches[]` can carry both kinds. Verified against
 * Local REST API v5.0.3.
 *
 * `context === basename` is the cheap separator, but it is not decisive: a body
 * window whose left edge is trimmed can coincide with the basename (a note whose
 * own name is quoted in its body, matched so the window lands on that quote),
 * and then the two readings disagree and the filename one slices the wrong text
 * — often past the end of `context` entirely. Where they disagree, settle it on
 * the text rather than the coincidence: the plugin matches whole query tokens,
 * so the correct reading reproduces one. An inconclusive check keeps the
 * filename reading, which is what the coincidence test alone would have picked.
 */
function contextRelativeSpan(
  m: { context: string; match: { start: number; end: number } },
  filename: string,
  contextLength: number,
  query: string,
): { contextStart: number; contextEnd: number } {
  const span = m.match.end - m.match.start;
  const bodyStart = Math.min(m.match.start, contextLength);
  const basename = (filename.split('/').pop() ?? filename).replace(/\.[^./]+$/, '');

  const at = (i: number) => ({ contextStart: i, contextEnd: i + span });
  if (m.context !== basename || m.match.start === bodyStart) return at(bodyStart);

  const reproducesToken = (i: number) => {
    const slice = m.context.slice(i, i + span);
    return slice.length === span && query.toLowerCase().includes(slice.toLowerCase());
  };
  return reproducesToken(m.match.start) || !reproducesToken(bodyStart)
    ? at(m.match.start)
    : at(bodyStart);
}

/**
 * The upstream error body, carried as the `cause` of everything
 * `#throwForStatus` throws.
 *
 * `cause` is the one channel that reaches the server's logs without reaching
 * the client, which is what lets the containment invariant hold while the
 * text stays available for debugging and for the classifiers below. The body
 * is the `Error` message so the framework's cause-chain extractor records it.
 */
class UpstreamErrorText extends Error {
  constructor(text: string) {
    super(text);
    this.name = 'UpstreamErrorText';
  }
}

/**
 * The upstream body behind an error, when `#throwForStatus` raised it. Walks
 * the `cause` chain rather than reading one level: `withRetry` re-wraps an
 * exhausted error, so on a retry-safe method the carrier sits a level deeper
 * than the throw site left it.
 */
function upstreamTextOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4; depth++) {
    if (current instanceof UpstreamErrorText) return current.message;
    if (!(current instanceof Error)) return;
    current = current.cause;
  }
  return;
}

/**
 * True for the V8 `RangeError: Invalid string length` the Local REST API
 * surfaces (as an opaque HTTP 500) when it cannot concatenate the response.
 * Read off the `cause` carrier: since the containment invariant on
 * `#throwForStatus`, the upstream text appears on neither the message nor
 * `data`, and this is the only place it survives.
 */
function isStringCapacityOverflow(err: unknown): boolean {
  return /invalid string length/i.test(upstreamTextOf(err) ?? '');
}

/** The period segment of a `/periodic/…` request path, for message copy. */
function periodOf(urlPath: string): string {
  return /^\/periodic\/(daily|weekly|monthly|quarterly|yearly)\//.exec(urlPath)?.[1] ?? 'periodic';
}

/** The request path with its query string dropped — the route alone. */
function routeOf(urlPath: string): string {
  return urlPath.split('?')[0] ?? urlPath;
}

/**
 * Convert an internal URL path (e.g. `/vault/Projects/My%20Note.md`) to the
 * vault-relative form a caller would recognize. Used in error messages so the
 * user sees the same path they sent in.
 */
function displayPath(urlPath: string): string {
  if (urlPath.startsWith('/active/')) return '(active file)';
  const noQuery = routeOf(urlPath);
  let decoded: string;
  try {
    decoded = decodeURIComponent(noQuery);
  } catch {
    decoded = noQuery;
  }
  const periodic =
    /^\/periodic\/(daily|weekly|monthly|quarterly|yearly)\/(?:(\d{4})\/(\d{2})\/(\d{2})\/?)?$/.exec(
      decoded,
    );
  if (periodic) {
    const [, period, y, mo, d] = periodic;
    return y && mo && d
      ? `${period} note for ${y}-${mo}-${d}`
      : `${period} note for the current period`;
  }
  for (const prefix of ['/vault/', '/open/', '/commands/']) {
    if (decoded.startsWith(prefix)) {
      return decoded.slice(prefix.length).replace(/\/+$/, '') || decoded;
    }
  }
  return decoded;
}

/**
 * Read the `Content-Length` header from a HEAD response and parse it as a
 * non-negative integer byte count. Throws when the upstream omits the header
 * or returns a non-numeric value — the size helpers don't fall back to GET.
 */
function parseContentLength(res: UndiciResponse, url: string): number {
  const raw = res.headers.get('content-length');
  if (raw === null) {
    throw new Error(
      `Obsidian Local REST API HEAD response missing Content-Length header for ${url}.`,
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Obsidian Local REST API returned invalid Content-Length '${raw}' for ${url}.`);
  }
  return n;
}

/**
 * Resolve the Omnisearch URL. Override wins. Otherwise: take the host from
 * `OBSIDIAN_BASE_URL`, force `http:` (Omnisearch is HTTP-only), swap port
 * `27123/27124` → `51361`. `127.0.0.1` is mapped to `localhost` since
 * Omnisearch's current Node listener binds IPv4 only but the platform's
 * loopback resolver is flexible — `localhost` insulates us if a future
 * build switches binding. Falls back to `http://localhost:51361` on any
 * URL parse failure (config validation catches malformed `baseUrl`, so this
 * is belt-and-suspenders).
 */
function deriveOmnisearchUrl(config: ServerConfig): string {
  if (config.omnisearchUrl) return config.omnisearchUrl.replace(/\/+$/, '');
  try {
    const u = new URL(config.baseUrl);
    const host = u.hostname === '127.0.0.1' ? 'localhost' : u.hostname;
    return `http://${host}:${OMNISEARCH_DEFAULT_PORT}`;
  } catch {
    return `http://localhost:${OMNISEARCH_DEFAULT_PORT}`;
  }
}

function normalizeOmnisearchHit(raw: RawOmnisearchHit): OmnisearchHit {
  return {
    basename: raw.basename,
    excerpt: cleanExcerpt(raw.excerpt),
    filename: raw.path,
    foundWords: raw.foundWords,
    matches: raw.matches,
    score: raw.score,
  };
}

/**
 * Normalize Omnisearch's excerpt HTML: `<br>` → `\n`, decode the entities
 * the upstream actually emits (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#039;`,
 * `&apos;`, plus numeric `&#NNN;` / `&#xNN;`). `<mark>` tags are preserved —
 * they highlight the match span and are interpretable as emphasis.
 */
function cleanExcerpt(excerpt: string): string {
  return excerpt
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => safeCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeCodePoint(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return '';
  return String.fromCodePoint(cp);
}

function parseJsonObject(text: string): UpstreamErrorBody | undefined {
  if (!text) return;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as UpstreamErrorBody) : undefined;
  } catch {
    return;
  }
}

let _service: ObsidianService | undefined;

export function initObsidianService(
  config: ServerConfig = getServerConfig(),
  fetchImpl?: ObsidianFetch,
): void {
  _service = new ObsidianService(config, fetchImpl);
}

/** Test-only: directly install an instance (e.g., one backed by a stub fetch). */
export function setObsidianService(service: ObsidianService | undefined): void {
  _service = service;
}

export function getObsidianService(): ObsidianService {
  if (!_service) {
    throw new Error('ObsidianService not initialized — call initObsidianService() in setup().');
  }
  return _service;
}

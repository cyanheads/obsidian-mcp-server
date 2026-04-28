/**
 * @fileoverview Obsidian Local REST API service. Wraps every upstream HTTP
 * endpoint we use, builds the right URL/headers/body for the consolidated
 * `target` discriminator, and classifies errors for the framework.
 * @module services/obsidian/obsidian-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  forbidden,
  notFound,
  serviceUnavailable,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { Agent, type Dispatcher, type RequestInit, fetch as undiciFetch } from 'undici';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type {
  DocumentMap,
  FileListing,
  NoteJson,
  NoteTarget,
  ObsidianCommand,
  ObsidianTag,
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

const NOTE_JSON_ACCEPT = 'application/vnd.olrapi.note+json';
const DOCUMENT_MAP_ACCEPT = 'application/vnd.olrapi.document-map+json';
const DATAVIEW_DQL_CT = 'application/vnd.olrapi.dataview.dql+txt';
const JSONLOGIC_CT = 'application/vnd.olrapi.jsonlogic+json';

export class ObsidianService {
  readonly #config: ServerConfig;
  readonly #dispatcher: Dispatcher;
  readonly #fetch: ObsidianFetch;

  /**
   * @param config - Validated server config (api key, base URL, TLS, timeouts).
   * @param fetchImpl - Optional fetch override for tests. Defaults to undici's
   *   `fetch`, which honors the constructed TLS dispatcher in production.
   */
  constructor(config: ServerConfig, fetchImpl?: ObsidianFetch) {
    this.#config = config;
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
    const url = this.#targetToPath(target);
    const res = await this.#request(ctx, url, {
      method: 'GET',
      headers: { Accept: 'text/markdown' },
    });
    return await res.text();
  }

  async getNoteJson(ctx: Context, target: NoteTarget): Promise<NoteJson> {
    const url = this.#targetToPath(target);
    const res = await this.#request(ctx, url, {
      method: 'GET',
      headers: { Accept: NOTE_JSON_ACCEPT },
    });
    return (await res.json()) as NoteJson;
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
    const url = this.#targetToPath(target);
    const res = await this.#request(ctx, url, {
      method: 'GET',
      headers: { Accept: DOCUMENT_MAP_ACCEPT },
    });
    return (await res.json()) as DocumentMap;
  }

  async writeNote(
    ctx: Context,
    target: NoteTarget,
    content: string,
    contentType: 'markdown' | 'json' = 'markdown',
  ): Promise<void> {
    const url = this.#targetToPath(target);
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
    const url = this.#targetToPath(target);
    await this.#request(ctx, url, {
      method: 'POST',
      headers: { 'Content-Type': contentType === 'json' ? 'application/json' : 'text/markdown' },
      body: content,
    });
  }

  async patchNote(
    ctx: Context,
    target: NoteTarget,
    content: string,
    headers: PatchHeaders,
  ): Promise<void> {
    const url = this.#targetToPath(target);
    await this.#request(ctx, url, {
      method: 'PATCH',
      headers: this.#buildPatchHeaders(headers),
      body: content,
    });
  }

  async deleteNote(ctx: Context, target: NoteTarget): Promise<void> {
    const url = this.#targetToPath(target);
    await this.#request(ctx, url, { method: 'DELETE' });
  }

  // ── Listings ─────────────────────────────────────────────────────────────

  async listFiles(ctx: Context, dirPath?: string): Promise<FileListing> {
    let url = '/vault/';
    if (dirPath) {
      const normalized = dirPath.replace(/^\/+|\/+$/g, '');
      if (normalized) url = `/vault/${encodeVaultPath(normalized)}/`;
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

  async searchText(ctx: Context, query: string, contextLength = 100): Promise<TextSearchHit[]> {
    const params = new URLSearchParams({ query, contextLength: String(contextLength) });
    const res = await this.#request(ctx, `/search/simple/?${params}`, { method: 'POST' });
    return (await res.json()) as RawSimpleSearchHit[];
  }

  async searchDataview(ctx: Context, dql: string): Promise<StructuredSearchHit[]> {
    const res = await this.#request(ctx, '/search/', {
      method: 'POST',
      headers: { 'Content-Type': DATAVIEW_DQL_CT },
      body: dql,
    });
    return (await res.json()) as RawStructuredSearchHit[];
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

  // ── UI / commands ────────────────────────────────────────────────────────

  async executeCommand(ctx: Context, commandId: string): Promise<void> {
    await this.#request(ctx, `/commands/${encodeURIComponent(commandId)}/`, { method: 'POST' });
  }

  async openInUi(ctx: Context, path: string, opts?: { newLeaf?: boolean }): Promise<void> {
    const params = new URLSearchParams();
    if (opts?.newLeaf) params.set('newLeaf', 'true');
    const qs = params.toString();
    await this.#request(ctx, `/open/${encodeVaultPath(path)}${qs ? `?${qs}` : ''}`, {
      method: 'POST',
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

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
      Operation: p.operation,
      'Target-Type': p.targetType,
      Target: encodeURIComponent(p.target),
      'Content-Type': p.contentType === 'json' ? 'application/json' : 'text/markdown',
    };
    if (p.targetDelimiter) headers['Target-Delimiter'] = p.targetDelimiter;
    if (p.createTargetIfMissing) headers['Create-Target-If-Missing'] = 'true';
    if (p.applyIfContentPreexists) headers['Apply-If-Content-Preexists'] = 'true';
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
    },
  ): Promise<UndiciResponse> {
    const url = `${this.#config.baseUrl}${pathAndQuery}`;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (!init.skipAuth) {
      headers.Authorization = `Bearer ${this.#config.apiKey}`;
    }

    return withRetry(
      async () => {
        const res = await this.#fetch(url, {
          method: init.method,
          headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          dispatcher: this.#dispatcher,
          signal: ctx.signal,
        });
        if (!res.ok) {
          await this.#throwForStatus(res, pathAndQuery);
        }
        return res;
      },
      {
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
      },
    );
  }

  async #throwForStatus(res: UndiciResponse, path: string): Promise<never> {
    const text = await this.#readBodySafe(res);
    const body = parseJsonObject(text);
    const display = displayPath(path);
    const upstream = safeUpstream(body, text);
    const data = (extra?: Record<string, unknown>) => ({
      path: display,
      ...(extra ?? {}),
      ...(upstream ? { upstream } : {}),
    });

    switch (res.status) {
      case 401:
        throw unauthorized(
          'Obsidian Local REST API rejected the API key. Verify OBSIDIAN_API_KEY matches the value in Obsidian → Settings → Local REST API.',
          data(),
        );
      case 403:
        throw forbidden(
          'Obsidian Local REST API forbids this request. Check the plugin permissions.',
          data(),
        );
      case 404: {
        if (path.startsWith('/active/')) {
          throw notFound(
            'No file is currently active in Obsidian — open a file in the app first.',
            data({ reason: 'no_active_file' }),
          );
        }
        if (path.startsWith('/periodic/')) {
          const periodMatch = /^\/periodic\/(daily|weekly|monthly|quarterly|yearly)\//.exec(path);
          const period = periodMatch?.[1] ?? 'periodic';
          const dateMatch = /\/(\d{4})\/(\d{2})\/(\d{2})\/?$/.exec(path);
          const suffix = dateMatch ? ` for ${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '';
          throw notFound(
            `No ${period} note found${suffix}. Check that the Periodic Notes plugin is enabled and the note exists.`,
            data({ reason: 'periodic_not_found' }),
          );
        }
        if (path.startsWith('/commands/')) {
          throw notFound(
            `Unknown Obsidian command: ${display}. Use \`obsidian_list_commands\` to discover valid command IDs.`,
            data({ reason: 'command_unknown' }),
          );
        }
        throw notFound(`Not found: ${display}`, data({ reason: 'note_missing' }));
      }
      case 405:
        throw validationError(
          `${display} cannot accept this method (often: the path is a directory, not a file).`,
          data({ reason: 'path_is_directory' }),
        );
      case 400: {
        const upstreamMsg = body?.message ?? `Bad request to ${display}`;
        // The Local REST API returns a "could not be applied to the target
        // content" / "invalid-target" message when a PATCH names a section that
        // doesn't exist. Translate to actionable guidance.
        const isTargetMiss = /\bcould not be applied\b|\binvalid-target\b/i.test(upstreamMsg);
        if (isTargetMiss) {
          throw validationError(
            `Section target not found in ${display}. Use \`obsidian_get_note\` with \`format: "document-map"\` to list available headings, blocks, and frontmatter fields. Nested headings need \`Parent::Child\` syntax.`,
            data({ reason: 'section_target_missing' }),
          );
        }
        throw validationError(upstreamMsg, data());
      }
      default:
        if (res.status >= 500 && res.status < 600) {
          throw serviceUnavailable(
            `Obsidian Local REST API returned ${res.status}: ${body?.message ?? 'upstream error'}`,
            data({ status: res.status }),
          );
        }
        throw serviceUnavailable(
          `Unexpected status ${res.status} from Obsidian Local REST API`,
          data({ status: res.status }),
        );
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
 * Encode a vault-relative path for the URL. Each segment is URL-encoded so
 * folder slashes are preserved while spaces and unicode are escaped.
 */
export function encodeVaultPath(path: string): string {
  return path
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Convert an internal URL path (e.g. `/vault/Projects/My%20Note.md`) to the
 * vault-relative form a caller would recognize. Used in error messages so the
 * user sees the same path they sent in.
 */
function displayPath(urlPath: string): string {
  if (urlPath.startsWith('/active/')) return '(active file)';
  const noQuery = urlPath.split('?')[0] ?? urlPath;
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
 * Trim the upstream error body down to a safe, user-presentable shape — drops
 * `errorCode` and any other plugin-internal fields that would otherwise leak
 * into JSON-RPC `error.data`.
 */
function safeUpstream(
  body: UpstreamErrorBody | undefined,
  text: string,
): { message: string } | undefined {
  if (body?.message) return { message: body.message };
  const trimmed = text.trim();
  if (trimmed) return { message: trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed };
  return;
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

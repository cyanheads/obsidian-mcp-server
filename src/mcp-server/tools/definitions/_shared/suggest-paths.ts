/**
 * @fileoverview Vault path resolution helpers. Two layered behaviors:
 *
 * 1. **Case-insensitive fallback.** If a path lookup 404s, list the parent
 *    directory and look for a single case-insensitive filename match. If
 *    found, retry against the canonical filesystem path (matches v2.x
 *    behavior). This silently fixes "Readme.md" vs "README.md" on Linux; on
 *    Mac/Windows the OS already case-folds and the fallback is a no-op.
 *
 * 2. **"Did you mean" suggestions.** When no case match exists but the parent
 *    directory has near-matches (e.g., extension-stripped variants), re-throw
 *    NotFound enriched with the candidates in the message and
 *    `error.data.suggestions[]`.
 *
 * Read/open/delete tools wrap their service calls with `withCaseFallback`.
 * @module mcp-server/tools/definitions/_shared/suggest-paths
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { conflict, JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import type { ObsidianService } from '@/services/obsidian/obsidian-service.js';
import type { NoteTarget } from '@/services/obsidian/types.js';

const MAX_SUGGESTIONS = 5;

interface ProbeResult {
  /** Filenames that match basename case-insensitively (full vault path). */
  caseMatches: string[];
  /** Filenames matching modulo extension only (full vault path). */
  extInsensitive: string[];
}

/**
 * Wrap a service call with case-insensitive path fallback and "did you mean"
 * enrichment. Non-path targets pass through — their paths are resolved
 * upstream, so neither layer applies.
 *
 * For path targets:
 *   - **Exact match** → returns `{ result, resolvedPath: target.path }`.
 *   - **Single case match** → retries with the canonical path and returns
 *     `{ result, resolvedPath: <canonical> }`.
 *   - **Multiple case matches** → throws `Conflict` with the candidates so the
 *     agent can disambiguate.
 *   - **No case match, extension-stripped near-matches** → throws `NotFound`
 *     enriched with a "did you mean" hint and `suggestions[]`.
 *   - **No matches at all** → re-throws the original NotFound unchanged.
 *
 * `resolvedPath` is `undefined` for non-path targets — callers derive the
 * canonical path from the result itself (typically `NoteJson.path`).
 */
export async function withCaseFallback<T>(
  ctx: Context,
  svc: ObsidianService,
  target: NoteTarget,
  fn: (target: NoteTarget) => Promise<T>,
): Promise<{ result: T; resolvedPath: string | undefined }> {
  if (target.type !== 'path') {
    return { result: await fn(target), resolvedPath: undefined };
  }
  try {
    return { result: await fn(target), resolvedPath: target.path };
  } catch (err) {
    if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) {
      throw err;
    }
    const probe = await probeParentDir(ctx, svc, target.path);
    const sole = probe.caseMatches.length === 1 ? probe.caseMatches[0] : undefined;
    if (sole !== undefined) {
      const result = await fn({ type: 'path', path: sole });
      return { result, resolvedPath: sole };
    }
    if (probe.caseMatches.length > 1) {
      const list = probe.caseMatches.map((m) => `"${m}"`).join(', ');
      throw conflict(
        `Ambiguous case-insensitive matches for '${target.path}': ${list}.`,
        { path: target.path, matches: probe.caseMatches },
        { cause: err },
      );
    }
    if (probe.extInsensitive.length === 0) throw err;
    const suggestions = probe.extInsensitive.slice(0, MAX_SUGGESTIONS);
    const list = suggestions.map((s) => `"${s}"`).join(', ');
    const prefix = err.message.replace(/[.!?]?\s*$/, '');
    throw notFound(
      `${prefix}. Did you mean: ${list}?`,
      { ...(err.data ?? {}), suggestions },
      { cause: err },
    );
  }
}

/**
 * List the parent directory of `path` and return up to {@link MAX_SUGGESTIONS}
 * close-match candidates. Match order: case-insensitive equality first, then
 * extension-stripped equality. Returns `[]` on listing failure or empty
 * basename. Used by callers that need suggestions without performing the
 * underlying operation (e.g., `obsidian_open_in_ui`'s explicit messaging).
 */
export async function findSimilarPaths(
  ctx: Context,
  svc: ObsidianService,
  path: string,
): Promise<string[]> {
  const probe = await probeParentDir(ctx, svc, path);
  return [...probe.caseMatches, ...probe.extInsensitive].slice(0, MAX_SUGGESTIONS);
}

async function probeParentDir(
  ctx: Context,
  svc: ObsidianService,
  path: string,
): Promise<ProbeResult> {
  const empty: ProbeResult = { caseMatches: [], extInsensitive: [] };
  const normalized = path.replace(/^\/+|\/+$/g, '');
  if (!normalized) return empty;

  const slash = normalized.lastIndexOf('/');
  const dir = slash >= 0 ? normalized.slice(0, slash) : '';
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  if (!base) return empty;

  let entries: string[];
  try {
    const listing = await svc.listFiles(ctx, dir);
    entries = listing.files;
  } catch {
    return empty;
  }

  const baseLower = base.toLowerCase();
  const baseNoExt = stripExtension(baseLower);
  const caseMatches: string[] = [];
  const extInsensitive: string[] = [];

  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    const entryLower = entry.toLowerCase();
    if (entryLower === baseLower) {
      caseMatches.push(qualify(dir, entry));
    } else if (stripExtension(entryLower) === baseNoExt) {
      extInsensitive.push(qualify(dir, entry));
    }
  }
  return { caseMatches, extInsensitive };
}

function stripExtension(s: string): string {
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(0, dot) : s;
}

function qualify(dir: string, base: string): string {
  return dir ? `${dir}/${base}` : base;
}

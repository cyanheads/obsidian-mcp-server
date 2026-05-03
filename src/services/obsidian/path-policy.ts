/**
 * @fileoverview Path-policy enforcement for the Obsidian Local REST API service.
 * Single chokepoint for OBSIDIAN_READ_PATHS / OBSIDIAN_WRITE_PATHS / OBSIDIAN_READ_ONLY —
 * tools and resources call into the service, the service consults this policy
 * before every upstream HTTP call. See issue #40 for the spec.
 *
 * The policy carries the active scope so error data echoes back which paths
 * are allowed; the LLM (or operator) can self-correct without poking at logs.
 *
 * @module services/obsidian/path-policy
 */

import { forbidden } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';

export type PathOp = 'read' | 'write';

export type PathForbiddenSubreason =
  | 'outside_read_paths'
  | 'outside_write_paths'
  | 'read_only_mode';

/** Wire data shape thrown with `path_forbidden`. */
export interface PathForbiddenData {
  activeScope: string[];
  op: PathOp;
  path: string;
  reason: 'path_forbidden';
  recovery: { hint: string };
  subreason: PathForbiddenSubreason;
}

/**
 * Enforces folder-scoped read/write permissions on vault-relative paths.
 * Constructed once from validated `ServerConfig`; read paths and write paths
 * arrive already lower-cased, trimmed of trailing slashes, and deduplicated by
 * the config parser, so matching is a straight prefix-or-equal compare.
 */
export class PathPolicy {
  readonly #readPaths: readonly string[] | undefined;
  readonly #writePaths: readonly string[] | undefined;
  readonly #readOnly: boolean;

  constructor(config: ServerConfig) {
    this.#readPaths = config.readPaths;
    this.#writePaths = config.writePaths;
    this.#readOnly = config.readOnly;
  }

  /** True when no path policy is active — every op falls through to the upstream. */
  get isUnrestricted(): boolean {
    return !this.#readOnly && this.#readPaths === undefined && this.#writePaths === undefined;
  }

  /** Snapshot for startup-banner logging. */
  describe(): {
    readPaths: readonly string[] | 'full vault';
    writePaths: readonly string[] | 'full vault' | 'denied (read-only)';
    readOnly: boolean;
  } {
    return {
      readPaths: this.#readPaths ?? 'full vault',
      writePaths: this.#readOnly ? 'denied (read-only)' : (this.#writePaths ?? 'full vault'),
      readOnly: this.#readOnly,
    };
  }

  /** True when both READ_ONLY=true and WRITE_PATHS is non-empty (operator should know WRITE_PATHS is ignored). */
  get readOnlyShadowsWritePaths(): boolean {
    return this.#readOnly && this.#writePaths !== undefined && this.#writePaths.length > 0;
  }

  isReadable(path: string): boolean {
    const candidate = normalize(path);
    if (this.#readPaths === undefined) return true;
    if (matchesAny(candidate, this.#readPaths)) return true;
    /** Write paths are implicitly readable — you can't sanely edit what you can't see. */
    if (
      !this.#readOnly &&
      this.#writePaths !== undefined &&
      matchesAny(candidate, this.#writePaths)
    ) {
      return true;
    }
    return false;
  }

  isWritable(path: string): boolean {
    if (this.#readOnly) return false;
    const candidate = normalize(path);
    if (this.#writePaths === undefined) return true;
    return matchesAny(candidate, this.#writePaths);
  }

  /** Throws `path_forbidden` if the path is not readable. */
  assertReadable(path: string): void {
    if (this.isReadable(path)) return;
    throw this.#deny(path, 'read', 'outside_read_paths');
  }

  /** Throws `path_forbidden` if the path is not writable (write tools also implicitly need read access). */
  assertWritable(path: string): void {
    if (this.#readOnly) {
      throw this.#deny(path, 'write', 'read_only_mode');
    }
    if (this.isWritable(path)) return;
    throw this.#deny(path, 'write', 'outside_write_paths');
  }

  /** Drop reads outside scope. Used by `obsidian_search_notes` to silently filter. */
  filterReadable<T extends { filename: string }>(hits: readonly T[]): T[] {
    /** Reads unrestricted when readPaths is unset — `isReadable` short-circuits to true. */
    if (this.#readPaths === undefined) return [...hits];
    return hits.filter((h) => this.isReadable(h.filename));
  }

  #deny(path: string, op: PathOp, subreason: PathForbiddenSubreason): Error {
    const activeScope = this.#scopeFor(op);
    const { message, recovery } = renderDenial(path, op, subreason, activeScope);
    const data: PathForbiddenData = {
      reason: 'path_forbidden',
      path,
      op,
      subreason,
      activeScope,
      recovery: { hint: recovery },
    };
    return forbidden(message, { ...data });
  }

  #scopeFor(op: PathOp): string[] {
    if (op === 'write') {
      if (this.#readOnly) return [];
      return [...(this.#writePaths ?? [])];
    }
    const set = new Set<string>();
    if (this.#readPaths) for (const p of this.#readPaths) set.add(p);
    if (!this.#readOnly && this.#writePaths) for (const p of this.#writePaths) set.add(p);
    return [...set];
  }
}

function normalize(path: string): string {
  /**
   * Match the parser's normalization rules so the candidate compares apples to
   * apples against the configured prefixes.
   */
  return path.replace(/^[\\/]+|[\\/]+$/g, '').toLowerCase();
}

function matchesAny(candidate: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (candidate === prefix) return true;
    /** Prefix match only at a path boundary so `pub` doesn't match `public/`. */
    if (candidate.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * Split into `message` (the "what") and `recovery` (the "how to fix"). The
 * framework renders both in `content[]` as `Error: <message>` then
 * `Recovery: <recovery>`, so they need to carry distinct information.
 */
function renderDenial(
  path: string,
  op: PathOp,
  subreason: PathForbiddenSubreason,
  activeScope: readonly string[],
): { message: string; recovery: string } {
  if (subreason === 'read_only_mode') {
    return {
      message: `Path '${path}' is not writable: server is in read-only mode (OBSIDIAN_READ_ONLY=true).`,
      recovery: 'Unset OBSIDIAN_READ_ONLY (or set it to false) to enable writes.',
    };
  }
  const envVar =
    subreason === 'outside_write_paths' ? 'OBSIDIAN_WRITE_PATHS' : 'OBSIDIAN_READ_PATHS';
  const opLabel = op === 'write' ? 'writable' : 'readable';
  const scopeRender =
    activeScope.length > 0 ? activeScope.map((p) => `'${p}'`).join(', ') : '(empty)';
  return {
    message: `Path '${path}' is not ${opLabel}: outside ${envVar}.`,
    recovery: `Allowed prefixes: [${scopeRender}]. Use a path within scope, or update ${envVar} to include this path.`,
  };
}

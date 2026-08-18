/**
 * @fileoverview Path-policy enforcement for the Obsidian Local REST API service.
 * Single chokepoint for OBSIDIAN_READ_PATHS / OBSIDIAN_WRITE_PATHS /
 * OBSIDIAN_DENY_PATHS / OBSIDIAN_READ_ONLY — tools and resources call into
 * the service, the service consults this policy before every upstream HTTP
 * call. See issue #40 for the spec.
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
  | 'denied_path'
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
  readonly #denyPaths: readonly string[] | undefined;
  readonly #readOnly: boolean;

  constructor(config: ServerConfig) {
    this.#readPaths = config.readPaths;
    this.#writePaths = config.writePaths;
    this.#denyPaths = config.denyPaths;
    this.#readOnly = config.readOnly;
  }

  /** True when no path policy is active — every op falls through to the upstream. */
  get isUnrestricted(): boolean {
    return (
      !this.#readOnly &&
      this.#readPaths === undefined &&
      this.#writePaths === undefined &&
      this.#denyPaths === undefined
    );
  }

  /** Snapshot for startup-banner logging. */
  describe(): {
    denyPaths: readonly string[] | 'none';
    readPaths: readonly string[] | 'full vault';
    writePaths: readonly string[] | 'full vault' | 'denied (read-only)';
    readOnly: boolean;
  } {
    return {
      denyPaths: this.#denyPaths ?? 'none',
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
    if (this.#isDenied(candidate)) return false;
    const allowed = this.#isReadAllowed(candidate);
    return allowed;
  }

  isWritable(path: string): boolean {
    const candidate = normalize(path);
    if (this.#isDenied(candidate)) return false;
    if (this.#readOnly) return false;
    const allowed = this.#isWriteAllowed(candidate);
    return allowed;
  }

  /** Throws `path_forbidden` if the path is not readable. */
  assertReadable(path: string): void {
    const candidate = normalize(path);
    if (this.#isDenied(candidate)) {
      throw this.#deny(path, 'read', 'denied_path');
    }
    if (!this.#isReadAllowed(candidate)) {
      throw this.#deny(path, 'read', 'outside_read_paths');
    }
  }

  /** Throws `path_forbidden` if the path is not writable (write tools also implicitly need read access). */
  assertWritable(path: string): void {
    const candidate = normalize(path);
    if (this.#isDenied(candidate)) {
      throw this.#deny(path, 'write', 'denied_path');
    }
    if (this.#readOnly) {
      throw this.#deny(path, 'write', 'read_only_mode');
    }
    if (!this.#isWriteAllowed(candidate)) {
      throw this.#deny(path, 'write', 'outside_write_paths');
    }
  }

  /** Drop reads outside scope. Used by `obsidian_search_notes` to silently filter. */
  filterReadable<T extends { filename: string }>(hits: readonly T[]): T[] {
    if (this.isUnrestricted) return [...hits];
    return hits.filter((h) => this.isReadable(h.filename));
  }

  #deny(path: string, op: PathOp, subreason: PathForbiddenSubreason): Error {
    const activeScope = this.#scopeFor(op, subreason);
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

  #scopeFor(op: PathOp, subreason: PathForbiddenSubreason): string[] {
    if (subreason === 'denied_path') return [...(this.#denyPaths ?? [])];
    if (op === 'write') {
      if (this.#readOnly) return [];
      return [...(this.#writePaths ?? [])];
    }
    const set = new Set<string>();
    if (this.#readPaths) for (const p of this.#readPaths) set.add(p);
    if (!this.#readOnly && this.#writePaths) for (const p of this.#writePaths) set.add(p);
    return [...set];
  }

  #isReadAllowed(candidate: string): boolean {
    if (this.#readPaths === undefined) return true;
    if (matchesAny(candidate, this.#readPaths)) return true;
    /** Write paths are implicitly readable — you can't sanely edit what you can't see. */
    return (
      !this.#readOnly && this.#writePaths !== undefined && matchesAny(candidate, this.#writePaths)
    );
  }

  #isWriteAllowed(candidate: string): boolean {
    return this.#writePaths === undefined || matchesAny(candidate, this.#writePaths);
  }

  #isDenied(candidate: string): boolean {
    return this.#denyPaths !== undefined && matchesAny(candidate, this.#denyPaths);
  }
}

function normalize(path: string): string {
  /**
   * Match the parser's normalization rules so the candidate compares apples to
   * apples against the configured prefixes. Backslashes collapse to forward
   * slashes so Windows-style paths (`Public\sub\note.md`) match prefixes
   * configured with `/` separators.
   */
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
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
  if (subreason === 'denied_path') {
    const scopeRender =
      activeScope.length > 0
        ? activeScope.map((p) => `'${p}'`).join(', ')
        : 'full vault except denied prefixes';
    return {
      message: `Path '${path}' is not ${op === 'write' ? 'writable' : 'readable'}: matched OBSIDIAN_DENY_PATHS.`,
      recovery: `Denied prefixes: [${scopeRender}]. Use a path outside the denylist, or update OBSIDIAN_DENY_PATHS to remove this path.`,
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

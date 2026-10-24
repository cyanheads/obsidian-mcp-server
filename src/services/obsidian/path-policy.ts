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

  /**
   * True when OBSIDIAN_READ_PATHS gates reads. Write paths and read-only gate
   * writes only, so they leave this false and vault-wide reads stay vault-wide.
   */
  get restrictsReads(): boolean {
    return this.#readPaths !== undefined;
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

  /**
   * Throws `path_forbidden` if the path is not readable. `resolvedFrom` is the
   * label of the `active` / `periodic` target `path` was resolved from; the
   * denial names it in place of a path the caller never sent.
   */
  assertReadable(path: string, resolvedFrom?: string): void {
    if (this.isReadable(path)) return;
    throw this.#deny(path, 'read', 'outside_read_paths', resolvedFrom);
  }

  /**
   * Throws `path_forbidden` if the path is not writable (write tools also
   * implicitly need read access). `resolvedFrom` as for `assertReadable`.
   */
  assertWritable(path: string, resolvedFrom?: string): void {
    if (this.#readOnly) {
      throw this.#deny(path, 'write', 'read_only_mode', resolvedFrom);
    }
    if (this.isWritable(path)) return;
    throw this.#deny(path, 'write', 'outside_write_paths', resolvedFrom);
  }

  /** Drop hits outside the read scope, silently. Used by `obsidian_search_notes`, `listTags`, and the scoped JSONLogic context fetch. */
  filterReadable<T extends { filename: string }>(hits: readonly T[]): T[] {
    if (!this.restrictsReads) return [...hits];
    return hits.filter((h) => this.isReadable(h.filename));
  }

  /**
   * The scope `path_forbidden` enforces for each op, as prefixes: `undefined`
   * when the op reaches the full vault, `[]` when it reaches nothing. Readable
   * is the read paths plus the write paths (read paths alone under read-only).
   * Writable is the write paths, or the readable scope when only reads are
   * restricted, since a write also needs read access to its target.
   */
  effectiveScope(): {
    readable: readonly string[] | undefined;
    writable: readonly string[] | undefined;
  } {
    const readable = this.restrictsReads ? this.#scopeFor('read') : undefined;
    let writable: readonly string[] | undefined;
    if (this.#readOnly) writable = [];
    else if (this.#writePaths !== undefined) writable = this.#scopeFor('write');
    else writable = readable;
    return { readable, writable };
  }

  /**
   * Source of a regular expression that matches every path `isReadable`
   * accepts, and possibly more: the `regexp` guard that narrows a scoped
   * JSONLogic fetch upstream. It narrows the transfer only — callers still
   * gate the results with `filterReadable`. See `prefixPattern` for how it
   * stays a superset.
   */
  readScopePattern(): string {
    const alternatives = this.#scopeFor('read').map(prefixPattern);
    return `^[/\\\\]*(?:${alternatives.join('|')})`;
  }

  /** Keep the paths `isReadable` accepts — link targets and link text alike. */
  keepReadable(paths: readonly string[]): string[] {
    return paths.filter((p) => this.isReadable(p));
  }

  /**
   * True when `path` is a folder on the way to the read scope: some readable
   * prefix sits strictly below it, matched at segment boundaries and
   * case-insensitively. The vault root is an ancestor whenever reads are
   * restricted. Ancestors are listable so a nested scope can be browsed to;
   * their names leak nothing the scope itself (in `instructions` and every
   * `path_forbidden`) doesn't already state.
   */
  isScopeAncestor(path: string): boolean {
    if (!this.restrictsReads) return false;
    const candidate = normalize(path);
    if (candidate === '') return true;
    return this.#scopeFor('read').some((prefix) => prefix.startsWith(`${candidate}/`));
  }

  /** Throws `path_forbidden` unless `dir` is readable or a folder on the way to the read scope. */
  assertListable(dir: string): void {
    if (this.isReadable(dir) || this.isScopeAncestor(dir)) return;
    throw this.#deny(dir, 'read', 'outside_read_paths');
  }

  /**
   * Keep the entries of a listing of `dir` a caller may see: readable entries,
   * plus folders on the way to the read scope. Entries are names relative to
   * `dir`, folders ending in `/`, as the Local REST API lists them.
   */
  filterListing(dir: string, entries: readonly string[]): string[] {
    const base = normalize(dir);
    return entries.filter((entry) => {
      const isDir = entry.endsWith('/');
      const name = isDir ? entry.slice(0, -1) : entry;
      const path = base ? `${base}/${name}` : name;
      return this.isReadable(path) || (isDir && this.isScopeAncestor(path));
    });
  }

  /** `data.path` and the message carry `resolvedFrom` when set, so a resolved path never reaches the caller. */
  #deny(path: string, op: PathOp, subreason: PathForbiddenSubreason, resolvedFrom?: string): Error {
    const activeScope = this.#scopeFor(op);
    const { message, recovery } = renderDenial(path, resolvedFrom, op, subreason, activeScope);
    const data: PathForbiddenData = {
      reason: 'path_forbidden',
      path: resolvedFrom ?? path,
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
   * apples against the configured prefixes. Backslashes collapse to forward
   * slashes so Windows-style paths (`Public\sub\note.md`) match prefixes
   * configured with `/` separators.
   */
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

/** A single character that `prefixPattern` escapes with a backslash to match it literally. */
const REGEX_METACHARACTER = /^[\\^$.*+?()[\]{}|-]$/;

/**
 * A regex source matching every path whose `normalize()` form equals `prefix`
 * or sits under it, as `matchesAny` decides, and possibly more. Built for the
 * Local REST API's `regexp` operator, which compiles with no flags, so case is
 * folded by hand: each ASCII letter matches either case, plus the two non-ASCII
 * characters whose lower case starts with an ASCII letter (U+212A KELVIN SIGN
 * → `k`, U+0130 → `i` + U+0307). A slash matches either slash, since
 * `normalize()` turns backslashes into slashes. The first non-ASCII character
 * ends the pattern with no boundary: its case folds include multi-character
 * forms, so anything is accepted from there on rather than risk rejecting a
 * readable path.
 */
function prefixPattern(prefix: string): string {
  let pattern = '';
  for (const char of prefix) {
    if (char > '\u007f') return pattern;
    if (char === 'i') pattern += '[iIİ]';
    else if (char === 'k') pattern += '[kKK]';
    else if (char >= 'a' && char <= 'z') pattern += `[${char}${char.toUpperCase()}]`;
    else if (char === '/') pattern += '[/\\\\]';
    else if (REGEX_METACHARACTER.test(char)) pattern += `\\${char}`;
    else pattern += char;
  }
  return `${pattern}(?:[/\\\\]|$)`;
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
 * `Recovery: <recovery>`, so they need to carry distinct information. A denial
 * on a path resolved from a target names the target (`resolvedFrom`) instead.
 */
function renderDenial(
  path: string,
  resolvedFrom: string | undefined,
  op: PathOp,
  subreason: PathForbiddenSubreason,
  activeScope: readonly string[],
): { message: string; recovery: string } {
  const opLabel = op === 'write' ? 'writable' : 'readable';
  const subject =
    resolvedFrom === undefined
      ? `Path '${path}' is not ${opLabel}`
      : `Target '${resolvedFrom}' resolves to a note that is not ${opLabel}`;
  if (subreason === 'read_only_mode') {
    return {
      message: `${subject}: server is in read-only mode (OBSIDIAN_READ_ONLY=true).`,
      recovery: 'Unset OBSIDIAN_READ_ONLY (or set it to false) to enable writes.',
    };
  }
  const envVar =
    subreason === 'outside_write_paths' ? 'OBSIDIAN_WRITE_PATHS' : 'OBSIDIAN_READ_PATHS';
  const scopeRender =
    activeScope.length > 0 ? activeScope.map((p) => `'${p}'`).join(', ') : '(empty)';
  const fix =
    resolvedFrom === undefined
      ? `Use a path within scope, or update ${envVar} to include this path.`
      : `Pass a path target within scope, or update ${envVar} to cover the note this target resolves to.`;
  return {
    message: `${subject}: outside ${envVar}.`,
    recovery: `Allowed prefixes: [${scopeRender}]. ${fix}`,
  };
}

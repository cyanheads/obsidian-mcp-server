/**
 * @fileoverview Path-policy enforcement for the Obsidian Local REST API service.
 * Single chokepoint for OBSIDIAN_READ_PATHS / OBSIDIAN_WRITE_PATHS /
 * OBSIDIAN_DENY_PATHS / OBSIDIAN_READ_ONLY — tools and resources call into the
 * service, the service consults this policy before every upstream HTTP call.
 * See issues #40 and #76 for the spec.
 *
 * A denial outside the allowlists carries the active scope so error data
 * echoes back which paths are allowed; the LLM (or operator) can self-correct
 * without poking at logs. A denial by the deny list names no prefix: echoing
 * the list would name exactly what it hides.
 *
 * @module services/obsidian/path-policy
 */

import { forbidden } from '@cyanheads/mcp-ts-core/errors';
import type { ServerConfig } from '@/config/server-config.js';

export type PathOp = 'read' | 'write';

export type PathForbiddenSubreason =
  | 'outside_read_paths'
  | 'outside_write_paths'
  | 'read_only_mode'
  | 'denied_path';

/** Wire data shape thrown with `path_forbidden`. A `denied_path` denial carries no scope. */
export type PathForbiddenData = {
  op: PathOp;
  path: string;
  reason: 'path_forbidden';
  recovery: { hint: string };
} & (
  | { activeScope: string[]; subreason: Exclude<PathForbiddenSubreason, 'denied_path'> }
  | { subreason: 'denied_path' }
);

/** An allow prefix a deny prefix covers, which therefore grants nothing. */
export interface DenyShadowedPath {
  prefix: string;
  variable: 'OBSIDIAN_READ_PATHS' | 'OBSIDIAN_WRITE_PATHS';
}

/**
 * Enforces folder-scoped read/write permissions on vault-relative paths.
 * Constructed once from validated `ServerConfig`; the path lists arrive
 * already in `normalize()` form and deduplicated by the config parser, so
 * matching is a straight prefix-or-equal compare. The deny list wins over
 * every allow rule, write-implies-read included.
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

  /**
   * True when reads are gated: OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS is
   * set. Write paths and read-only gate writes only, so they leave this false
   * and vault-wide reads stay vault-wide.
   */
  get restrictsReads(): boolean {
    return this.#readPaths !== undefined || this.#denyPaths !== undefined;
  }

  /** True when OBSIDIAN_DENY_PATHS withholds paths inside the scopes `effectiveScope` names. */
  get withholdsPaths(): boolean {
    return this.#denyPaths !== undefined;
  }

  /** Snapshot for startup-banner logging: the configured lists, `denyPaths` only when set. */
  describe(): {
    readPaths: readonly string[] | 'full vault';
    writePaths: readonly string[] | 'full vault' | 'denied (read-only)';
    denyPaths?: readonly string[];
    readOnly: boolean;
  } {
    return {
      readPaths: this.#readPaths ?? 'full vault',
      writePaths: this.#readOnly ? 'denied (read-only)' : (this.#writePaths ?? 'full vault'),
      ...(this.#denyPaths ? { denyPaths: this.#denyPaths } : {}),
      readOnly: this.#readOnly,
    };
  }

  /** True when both READ_ONLY=true and WRITE_PATHS is non-empty (operator should know WRITE_PATHS is ignored). */
  get readOnlyShadowsWritePaths(): boolean {
    return this.#readOnly && this.#writePaths !== undefined && this.#writePaths.length > 0;
  }

  /**
   * Configured allow prefixes a deny prefix covers: they grant nothing, so the
   * startup log warns about each. Write paths are skipped under read-only,
   * which ignores them already (`readOnlyShadowsWritePaths`).
   */
  get denyShadowedPaths(): DenyShadowedPath[] {
    const shadowed = (paths: readonly string[] | undefined) =>
      (paths ?? []).filter((prefix) => this.#isDenied(prefix));
    return [
      ...shadowed(this.#readPaths).map((prefix) => ({
        variable: 'OBSIDIAN_READ_PATHS' as const,
        prefix,
      })),
      ...(this.#readOnly ? [] : shadowed(this.#writePaths)).map((prefix) => ({
        variable: 'OBSIDIAN_WRITE_PATHS' as const,
        prefix,
      })),
    ];
  }

  isReadable(path: string): boolean {
    const candidate = normalize(path);
    return !this.#isDenied(candidate) && this.#inReadAllowlist(candidate);
  }

  isWritable(path: string): boolean {
    if (this.#readOnly) return false;
    const candidate = normalize(path);
    return !this.#isDenied(candidate) && this.#inWriteAllowlist(candidate);
  }

  /**
   * Throws `path_forbidden` if the path is not readable. `resolvedFrom` is the
   * label of the `active` / `periodic` target `path` was resolved from; the
   * denial names it in place of a path the caller never sent. A path outside
   * the read allowlist is `outside_read_paths` whether or not it is also
   * denied, so `denied_path` never confirms deny-list membership of a path the
   * allowlist already refuses.
   */
  assertReadable(path: string, resolvedFrom?: string): void {
    if (this.isReadable(path)) return;
    throw this.#deny(path, 'read', this.#readSubreason(path), resolvedFrom);
  }

  /**
   * Throws `path_forbidden` if the path is not writable (write tools also
   * implicitly need read access). `resolvedFrom` as for `assertReadable`.
   * Subreason precedence: `read_only_mode`, then `outside_write_paths`, then
   * `denied_path`.
   */
  assertWritable(path: string, resolvedFrom?: string): void {
    if (this.#readOnly) {
      throw this.#deny(path, 'write', 'read_only_mode', resolvedFrom);
    }
    if (this.isWritable(path)) return;
    const subreason = this.#inWriteAllowlist(normalize(path))
      ? 'denied_path'
      : 'outside_write_paths';
    throw this.#deny(path, 'write', subreason, resolvedFrom);
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
   * restricted, since a write also needs read access to its target. An allow
   * prefix a deny prefix covers grants nothing and is left out; whatever else
   * the deny list withholds inside these scopes, `withholdsPaths` flags
   * without naming.
   */
  effectiveScope(): {
    readable: readonly string[] | undefined;
    writable: readonly string[] | undefined;
  } {
    const readable = this.#readPaths !== undefined ? this.#scopeFor('read') : undefined;
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
   * stays a superset. With no read allowlist it matches every path; deny
   * prefixes are never subtracted, since negating a superset would drop
   * readable notes. When no allow prefix survives the deny list it matches
   * no path — an empty alternation would match every one.
   */
  readScopePattern(): string {
    if (this.#readPaths === undefined) return '^';
    const alternatives = this.#scopeFor('read').map(prefixPattern);
    if (alternatives.length === 0) return '(?!)';
    return `^[/\\\\]*(?:${alternatives.join('|')})`;
  }

  /**
   * True when `path` is a folder on the way to the read scope: some readable
   * prefix sits strictly below it, matched at segment boundaries and
   * case-insensitively. The vault root is an ancestor whenever reads are
   * restricted. Ancestors are listable so a nested scope can be browsed to;
   * their names leak nothing the scope itself (in `instructions` and every
   * `path_forbidden`) doesn't already state. An ancestor is never denied: a
   * deny prefix covering it would cover the allow prefix below it too, and an
   * allow prefix a deny prefix covers is not part of the scope.
   */
  isScopeAncestor(path: string): boolean {
    if (!this.restrictsReads) return false;
    const candidate = normalize(path);
    if (candidate === '') return true;
    return this.#scopeFor('read').some((prefix) => prefix.startsWith(`${candidate}/`));
  }

  /**
   * Throws `path_forbidden` unless `dir` is readable or a folder on the way to
   * the read scope, with the subreason `assertReadable` would give.
   */
  assertListable(dir: string): void {
    if (this.isReadable(dir) || this.isScopeAncestor(dir)) return;
    throw this.#deny(dir, 'read', this.#readSubreason(dir));
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

  /**
   * `data.path` and the message carry `resolvedFrom` when set, so a resolved
   * path never reaches the caller. A `denied_path` denial carries no
   * `activeScope`.
   */
  #deny(path: string, op: PathOp, subreason: PathForbiddenSubreason, resolvedFrom?: string): Error {
    const base = { reason: 'path_forbidden' as const, path: resolvedFrom ?? path, op };
    if (subreason === 'denied_path') {
      const { message, recovery } = renderWithheld(path, resolvedFrom, op);
      const data: PathForbiddenData = { ...base, subreason, recovery: { hint: recovery } };
      return forbidden(message, { ...data });
    }
    const activeScope = this.#scopeFor(op);
    const { message, recovery } = renderDenial(path, resolvedFrom, op, subreason, activeScope);
    const data: PathForbiddenData = {
      ...base,
      subreason,
      activeScope,
      recovery: { hint: recovery },
    };
    return forbidden(message, { ...data });
  }

  /** Allow prefixes for `op` that no deny prefix covers. */
  #scopeFor(op: PathOp): string[] {
    const set = new Set<string>();
    if (op === 'read' && this.#readPaths) for (const p of this.#readPaths) set.add(p);
    if (!this.#readOnly && this.#writePaths) for (const p of this.#writePaths) set.add(p);
    return [...set].filter((p) => !this.#isDenied(p));
  }

  #isDenied(candidate: string): boolean {
    return this.#denyPaths !== undefined && matchesAny(candidate, this.#denyPaths);
  }

  /** In the configured read allowlist: everywhere without one, write paths included unless read-only. */
  #inReadAllowlist(candidate: string): boolean {
    if (this.#readPaths === undefined) return true;
    if (matchesAny(candidate, this.#readPaths)) return true;
    /** Write paths are implicitly readable — you can't sanely edit what you can't see. */
    return (
      !this.#readOnly && this.#writePaths !== undefined && matchesAny(candidate, this.#writePaths)
    );
  }

  #inWriteAllowlist(candidate: string): boolean {
    return this.#writePaths === undefined || matchesAny(candidate, this.#writePaths);
  }

  /** The subreason for an unreadable path: `denied_path` only inside the read allowlist. */
  #readSubreason(path: string): 'outside_read_paths' | 'denied_path' {
    return this.#inReadAllowlist(normalize(path)) ? 'denied_path' : 'outside_read_paths';
  }
}

/**
 * A path in the form it reaches the plugin, which the config parser stores
 * prefixes in: forward slashes (Windows-style `Public\sub\note.md` matches a
 * `/`-configured prefix), no empty segments (`encodeVaultPath` drops them, so
 * `a//b` is requested as `a/b`), lower case, NFC (the vault's filesystem
 * resolves NFC and NFD spellings of a name to one file).
 */
function normalize(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
    .normalize('NFC');
}

/** A single character that `foldedChar` escapes with a backslash to match it literally. */
const REGEX_METACHARACTER = /^[\\^$.*+?()[\]{}|-]$/;

/**
 * A regex source for one ASCII character of lower-cased text, matching every
 * character whose lower case is or starts with it. Built for the Local REST
 * API's `regexp` operator, which compiles with no flags, so case is folded by
 * hand: each ASCII letter matches either case, plus the two non-ASCII
 * characters whose lower case starts with an ASCII letter (U+212A KELVIN SIGN
 * → `k`, U+0130 → `i` + U+0307). No other character lower-cases to ASCII.
 */
function foldedChar(char: string): string {
  if (char === 'i') return '[iIİ]';
  if (char === 'k') return '[kKK]';
  if (char >= 'a' && char <= 'z') return `[${char}${char.toUpperCase()}]`;
  if (REGEX_METACHARACTER.test(char)) return `\\${char}`;
  return char;
}

/**
 * A regex source matching every string whose `toLowerCase()` contains `text`,
 * and possibly more, for lower-cased `text` (`foldedChar`). `undefined` when
 * `text` holds a non-ASCII character, whose case folds include
 * multi-character forms. The scoped text search's candidate guard builds one
 * per query token.
 */
export function caseFoldedPattern(text: string): string | undefined {
  let pattern = '';
  for (const char of text) {
    if (char > '\u007f') return;
    pattern += foldedChar(char);
  }
  return pattern;
}

/**
 * A regex source matching every path whose `normalize()` form equals `prefix`
 * or sits under it, as `matchesAny` decides, and possibly more. Case is
 * folded by `foldedChar`, and a slash matches either slash, since
 * `normalize()` turns backslashes into slashes. The first non-ASCII character
 * ends the pattern with no boundary: its case folds include multi-character
 * forms, so anything is accepted from there on rather than risk rejecting a
 * readable path.
 */
function prefixPattern(prefix: string): string {
  let pattern = '';
  for (const char of prefix) {
    if (char > '\u007f') return pattern;
    pattern += char === '/' ? '[/\\\\]' : foldedChar(char);
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
  subreason: Exclude<PathForbiddenSubreason, 'denied_path'>,
  activeScope: readonly string[],
): { message: string; recovery: string } {
  const subject = denialSubject(path, resolvedFrom, op);
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

/**
 * `renderDenial` for `denied_path`: names the variable, never a deny prefix.
 * The message names the subreason too, since `content[]` renders the message
 * and recovery but not `data.subreason`.
 */
function renderWithheld(
  path: string,
  resolvedFrom: string | undefined,
  op: PathOp,
): { message: string; recovery: string } {
  return {
    message: `${denialSubject(path, resolvedFrom, op)}: withheld by OBSIDIAN_DENY_PATHS (subreason denied_path).`,
    recovery:
      resolvedFrom === undefined
        ? 'The operator withholds this path. Use a different path, or ask the operator to change OBSIDIAN_DENY_PATHS.'
        : 'The operator withholds the note this target resolves to. Pass a path target to a different note, or ask the operator to change OBSIDIAN_DENY_PATHS.',
  };
}

function denialSubject(path: string, resolvedFrom: string | undefined, op: PathOp): string {
  const opLabel = op === 'write' ? 'writable' : 'readable';
  return resolvedFrom === undefined
    ? `Path '${path}' is not ${opLabel}`
    : `Target '${resolvedFrom}' resolves to a note that is not ${opLabel}`;
}

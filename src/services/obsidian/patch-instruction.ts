/**
 * @fileoverview The two markdown-patch wire formats a section write and a
 * document-map read speak, and the one negotiation rule between them. Local
 * REST API 5.x and later speak markdown-patch 2.0 — a JSON instruction body
 * with an array heading target, and a nested document map. Plugin 4.x speaks
 * only 1.x — `Operation` / `Target-Type` / `Target` request headers and a flat
 * `::`-joined map. Plugin 6.0 removes 1.x.
 * @module services/obsidian/patch-instruction
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { AtxHeadingFragment } from './section-extractor.js';
import type { DocumentMap, PatchInstruction } from './types.js';

/** A markdown-patch format, spelled as its `Markdown-Patch-Version` header value. */
export type PatchFormat = '1' | '2';

/** First Local REST API major that speaks markdown-patch 2.0. */
const FIRST_V2_MAJOR = 5;

/** Delimiter joining ancestor headings into one heading locator. */
const HEADING_DELIMITER = '::';

/**
 * The suffix markdown-patch 2.0 appends to the key of the second and later
 * occurrences of a sibling heading or block id: U+FC750, then the occurrence
 * index minus one in hex, each digit written as one of U+F6440–U+F644F. The
 * plugin refuses a note whose own heading text ends this way, so stripping it
 * is exact.
 */
const DUPLICATE_SUFFIX = /\u{FC750}[\u{F6440}-\u{F644F}]+$/u;

/**
 * The markdown-patch format a plugin at `version` (`GET /`'s `versions.self`)
 * speaks. A version whose major does not parse reads as 2.0, the only format
 * plugin 6.0 and later accept.
 */
export function patchFormatFor(version: string | undefined): PatchFormat {
  const major = Number.parseInt(version ?? '', 10);
  return Number.isNaN(major) || major >= FIRST_V2_MAJOR ? '2' : '1';
}

/**
 * Request headers for a 1.x header-driven PATCH. `Markdown-Patch-Version: 1`
 * is what plugin 5.x needs to accept header targeting; plugin 4.x predates the
 * header and ignores it.
 */
export function v1PatchHeaders(p: PatchInstruction): Record<string, string> {
  const headers: Record<string, string> = {
    'Markdown-Patch-Version': '1',
    Operation: p.operation,
    'Target-Type': p.targetType,
    Target: encodeURIComponent(p.target),
    'Content-Type': p.contentType === 'json' ? 'application/json' : 'text/markdown',
  };
  if (p.targetType === 'heading') headers['Target-Delimiter'] = HEADING_DELIMITER;
  if (p.createTargetIfMissing) headers['Create-Target-If-Missing'] = 'true';
  /**
   * Sense inversion: markdown-patch 1.0 (shipped with Local REST API v4.0.0)
   * renamed `Apply-If-Content-Preexists` to `Reject-If-Content-Preexists`
   * and flipped the default — patches now apply regardless of duplicates
   * unless the caller opts into rejection. `applyIfContentPreexists` stays on
   * the public schema for caller stability and is translated here: a falsy
   * value (the public default) sends the Reject header, preserving the
   * idempotent-by-default behavior. Replace operations are exempt upstream.
   */
  if (!p.applyIfContentPreexists) headers['Reject-If-Content-Preexists'] = 'true';
  if (p.trimTargetWhitespace) headers['Trim-Target-Whitespace'] = 'true';
  return headers;
}

/** A markdown-patch 2.0 write instruction, as this server sends one. */
export interface V2Instruction {
  content?: string;
  createTargetIfMissing?: true;
  operation: PatchInstruction['operation'];
  rejectIfContentPreexists?: true;
  scope?: 'content';
  target: string | string[];
  targetType: PatchInstruction['targetType'];
  value?: unknown;
  within?: Within;
}

/**
 * A heading's direct-body block, by position: `0` the first, `-1` the last.
 * markdown-patch 2.0 resolves it afresh on every write; nothing is written to
 * the note to address it.
 */
export type Within = 0 | -1;

/**
 * The markdown-patch 2.0 instruction for a section write. `content` is the
 * payload as it should reach the engine: for a heading target, already carrying
 * section-relative heading levels (see `relativeHeadingLevels`).
 *
 * The payload rides in the carrier the target reads. Frontmatter takes a JSON
 * `value` — the parsed literal under `contentType: "json"`, the text itself
 * otherwise, which is what the 1.x format made of a markdown body. A block
 * under `json` takes table rows as a `value`; a single row is wrapped, as 1.x
 * accepted it bare. Everything else is literal `content`. (Rows under a
 * heading have no 2.0 form and go out as 1.x — see the service's
 * `#wireFormat`.)
 *
 * With `within`, a heading append or prepend addresses that one body block at
 * `content` scope instead of the section, and 2.0 splices the content at the
 * block's edge exactly as given — no blank line, no heading re-levelling. The
 * line break on the side facing the block is added here, so `content` is the
 * reduced text of `canonicalContent`. 2.0 refuses `createTargetIfMissing`
 * beside `within`, which addresses a block that already exists.
 *
 * There is no `trimTargetWhitespace`: 2.0 owns the whitespace around inserted
 * content, and has no such field.
 */
export function v2Instruction(
  p: PatchInstruction,
  content: string,
  within?: Within,
): V2Instruction {
  const json = p.contentType === 'json';
  const payload =
    p.targetType === 'frontmatter'
      ? { value: json ? parseJsonContent(content) : content }
      : json
        ? { value: asTableRows(parseJsonContent(content)) }
        : within === undefined
          ? { content }
          : {
              scope: 'content' as const,
              within,
              content: within === 0 ? `${content}\n` : `\n${content}`,
            };
  return {
    targetType: p.targetType,
    target: p.targetType === 'heading' ? p.target.split(HEADING_DELIMITER) : p.target,
    operation: p.operation,
    ...payload,
    ...(p.createTargetIfMissing && within === undefined ? { createTargetIfMissing: true } : {}),
    ...(p.applyIfContentPreexists ? {} : { rejectIfContentPreexists: true }),
  };
}

/**
 * `content` reduced as markdown-patch 2.0 reduces a plain heading write before
 * placing it: line endings read as `\n`, leading blank lines and all trailing
 * whitespace dropped, first-line indentation kept (`canonicalFragment` in
 * markdown-patch 2.0.0, less the one line ending it then adds).
 */
export function canonicalContent(content: string): string {
  return content
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[^\S\n]*\n)+/, '')
    .replace(/\s+$/, '');
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw validationError(
      '`content` is not valid JSON. With `contentType: "json"`, `content` must be a JSON literal — quote a string (`"\\"draft\\""`, not `"draft"`); numbers, booleans, arrays, and objects pass as written.',
      {},
      { cause },
    );
  }
}

function asTableRows(value: unknown): unknown {
  return Array.isArray(value) && value.every((cell) => typeof cell === 'string') ? [value] : value;
}

/** Heading content rewritten to 2.0's section-relative levels, or the heading that cannot be. */
export type RelativeLevels =
  | { ok: true; content: string }
  | { ok: false; heading: string; level: number };

/**
 * Rewrite heading content from the absolute `#` levels a caller writes to the
 * relative ones markdown-patch 2.0 reads. 2.0 adds the target section's level
 * (`baseline`) to every top-level ATX heading in written content, where 1.x
 * wrote it as given; subtracting it first lands the levels the caller wrote.
 *
 * A heading at or above `baseline` has no relative form — 2.0 keeps written
 * content inside its section, and such a heading would close it — so it is
 * returned instead. Line endings come back as `\n`, which 2.0 normalizes to
 * the note's own anyway.
 */
export function relativeHeadingLevels(
  fragment: AtxHeadingFragment,
  baseline: number,
): RelativeLevels {
  let content = '';
  let cursor = 0;
  for (const marker of fragment.markers) {
    const level = marker.hashes - baseline;
    if (level < 1) return { ok: false, heading: marker.line, level: marker.hashes };
    content += `${fragment.normalized.slice(cursor, marker.start)}${'#'.repeat(level)}`;
    cursor = marker.start + marker.hashes;
  }
  return { ok: true, content: content + fragment.normalized.slice(cursor) };
}

/** A markdown-patch 2.0 heading tree: each key a heading, each value its child headings. */
export interface HeadingTree {
  [text: string]: HeadingTree;
}

/** The markdown-patch 2.0 document map, as plugin 5.x serves it. */
export interface RawDocumentMapV2 {
  blocks: string[];
  frontmatterFields: string[];
  headings: HeadingTree;
  version: string;
}

/**
 * Every heading in a markdown-patch 2.0 heading tree as its `::`-joined full
 * path, in tree order, one entry per occurrence. A top-level untitled heading
 * is `""`, and its children read `::Child`, as the 1.x map writes them.
 */
export function flattenHeadingTree(tree: HeadingTree, parent?: string): string[] {
  return Object.entries(tree).flatMap(([key, children]) => {
    const text = key.replace(DUPLICATE_SUFFIX, '');
    const path = parent === undefined ? text : `${parent}${HEADING_DELIMITER}${text}`;
    return [path, ...flattenHeadingTree(children, path)];
  });
}

/**
 * The 2.0 document map in the flat 1.x shape this server's document map has
 * always carried. The 2.0 map keeps an entry per repeated heading and block id;
 * the 1.x map keyed both by name, so repeats collapse to the first and a
 * top-level untitled heading's own `""` entry drops, as it did there.
 *
 * Blocks and frontmatter fields take the order the 1.x map gave them: it
 * listed each as the keys of a plain object, so JavaScript's key order
 * applied — integer-like names first, ascending. Headings keep the tree's
 * order, which is the note's unless a heading name is integer-like (see
 * `hasIntegerKey`); the service restores note order in that case.
 */
export function flattenDocumentMap(map: RawDocumentMapV2): DocumentMap {
  return {
    headings: [...new Set(flattenHeadingTree(map.headings))].filter(Boolean),
    blocks: objectKeyOrder(map.blocks.map((id) => id.replace(DUPLICATE_SUFFIX, ''))),
    frontmatterFields: objectKeyOrder(map.frontmatterFields),
  };
}

/** `names` deduplicated and ordered as the keys of an object built from them. */
function objectKeyOrder(names: readonly string[]): string[] {
  return Object.keys(Object.fromEntries(names.map((name) => [name, true])));
}

/**
 * True when `name` is an integer-like object key — a canonical array index —
 * which JavaScript lists ahead of every other key. A heading named `2025` is
 * one, so a map built from object keys (the 2.0 tree, and the 1.x map's keys)
 * lists it out of note order.
 */
export function isIntegerKey(name: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/.test(name) && Number(name) < 2 ** 32 - 1;
}

/** True when any heading in the tree, at any depth, is named with an integer-like key. */
export function hasIntegerKey(tree: HeadingTree): boolean {
  return Object.entries(tree).some(
    ([key, children]) => isIntegerKey(key) || hasIntegerKey(children),
  );
}

/**
 * `paths` reordered to the note: by where each first occurs in `notePaths`
 * (the note's heading paths in document order), ties and unknown paths keeping
 * their relative order.
 */
export function inNoteOrder(paths: readonly string[], notePaths: readonly string[]): string[] {
  const rank = new Map<string, number>();
  notePaths.forEach((path, i) => {
    if (!rank.has(path)) rank.set(path, i);
  });
  const at = (path: string) => rank.get(path) ?? Number.POSITIVE_INFINITY;
  return [...paths].sort((a, b) => at(a) - at(b));
}

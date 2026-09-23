/**
 * @fileoverview Client-side section extraction from a NoteJson body.
 * The upstream Local REST API exposes section *targeting* for PATCH but not
 * section-extracted GET, so we slice the markdown ourselves for `format: 'section'`.
 * @module services/obsidian/section-extractor
 */

import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { splice } from './frontmatter-ops.js';
import type { NoteJson, SectionTarget } from './types.js';

/** Delimiter joining a heading path, matching upstream's PATCH `Target-Delimiter`. */
const HEADING_DELIMITER = '::';

/** An extracted section value plus, for heading targets, how the locator resolved. */
export interface SectionExtraction {
  /**
   * Every full heading path the target could name, in document order: each
   * heading sharing a bare-leaf target, or each repeat of a delimited target's
   * resolved path. Present only when more than one heading matched — the read
   * still returns the first, so this is disclosure, not a new failure mode.
   */
  candidates?: string[];
  /**
   * Full `::`-joined heading path, root included, that the read resolved to.
   * Heading sections only.
   */
  sectionTarget?: string;
  /** Raw markdown (heading/block) or the JSON-typed frontmatter value. */
  value: unknown;
}

/**
 * Extract a section's raw markdown (heading/block) or JSON value (frontmatter).
 * Throws `NotFound` if the target does not exist in the note.
 */
export function extractSection(note: NoteJson, section: SectionTarget): SectionExtraction {
  switch (section.type) {
    case 'frontmatter':
      return { value: extractFrontmatterField(note, section.target) };
    case 'heading':
      return extractHeading(note.content, section.target);
    case 'block':
      return { value: extractBlock(note.content, section.target) };
  }
}

function extractFrontmatterField(note: NoteJson, key: string): unknown {
  if (!(key in note.frontmatter)) {
    throw notFound(`Frontmatter key '${key}' not found in ${note.path}.`, {
      path: note.path,
      key,
    });
  }
  return note.frontmatter[key];
}

/** An ATX heading line's level and text. */
export interface AtxHeading {
  /** Number of leading `#` characters. */
  level: number;
  /** Heading text with the closing `#` run and surrounding whitespace removed. Empty for an untitled heading. */
  text: string;
}

/** One ATX heading found in the note body. */
interface HeadingLine extends AtxHeading {
  /** Zero-based index of the heading's line in the note. */
  index: number;
}

/**
 * Up to three spaces of indent, one to six `#`, then whitespace or the end of
 * the line. The `s` flag lets `.` take the `\r` a CRLF line keeps after the
 * split on `\n`, so `##\r` is an untitled heading and `## Foo\r` reads `Foo`.
 */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s(.*))?$/s;

/**
 * Parse one line as an ATX heading, or return `undefined` when it is not one.
 *
 * This is the ATX heading test the plugin's document map applies (its markdown
 * parser, `marked`), so every ATX locator the map emits names a heading this
 * scan finds under the same text. It follows CommonMark's ATX rules with the
 * parser's two measured differences: any whitespace separates the `#` run
 * from the text, and a closing `#` run is stripped only when a space — not a
 * tab — precedes it (`## Foo\t##` keeps `Foo\t##`). A bare `##`, `## ##`, and
 * `##   ` are untitled headings; `#hashtag`, seven `#`, and a four-space
 * indent are not headings.
 */
export function parseAtxHeading(line: string): AtxHeading | undefined {
  const m = ATX_HEADING.exec(line);
  if (!m) return;
  let text = (m[2] ?? '').trim();
  if (text.endsWith('#')) {
    const open = text.replace(/#+$/, '');
    if (open === '' || open.endsWith(' ')) text = open.trim();
  }
  return { level: (m[1] ?? '').length, text };
}

/**
 * Collect every ATX heading in the note body, in document order. Setext
 * headings are not markdown this extractor recognizes, and lines inside a
 * fenced code block or a frontmatter block are excluded.
 */
function scanHeadings(lines: string[], bodyStart: number): HeadingLine[] {
  const inFence = computeFenceMask(lines, bodyStart);
  const headings: HeadingLine[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    if (inFence[i]) continue;
    const heading = parseAtxHeading(lines[i] ?? '');
    if (heading) headings.push({ index: i, ...heading });
  }
  return headings;
}

/**
 * Build the full `Parent::Child` path of every heading, in document order. A
 * heading's parent is the nearest preceding heading strictly shallower than it,
 * and its path is the parent's path plus its own text — the serialization the
 * document map emits, so a path built here is a locator the write path resolves
 * as an exact map entry. Untitled headings contribute an empty segment
 * (`::Request body`, `Top::::Child`), and a top-level untitled heading's own
 * path is `""`, which the map omits.
 */
function headingPaths(headings: readonly HeadingLine[]): string[] {
  const stack: Array<{ level: number; path: string }> = [];
  return headings.map(({ level, text }) => {
    while ((stack.at(-1)?.level ?? 0) >= level) stack.pop();
    const parent = stack.at(-1);
    const path = parent ? `${parent.path}${HEADING_DELIMITER}${text}` : text;
    stack.push({ level, path });
    return path;
  });
}

/**
 * Full `::`-joined path of every ATX heading in `content`, in document order,
 * repeats included. Deduplicated and with the `""` entry dropped, this is the
 * document map's `headings` array for a note whose headings are all top-level
 * ATX lines. The plugin's parser also reads setext headings, and reads no
 * heading in a line that continues a list item or sits inside an HTML block;
 * this line scan does neither.
 */
export function listHeadingPaths(content: string): string[] {
  return headingPaths(scanHeadings(content.split('\n'), frontmatterEndLine(content)));
}

/**
 * Walk a `::`-split target one segment at a time: each segment matches the
 * first heading with that text below the previous match, at any depth, before
 * the walk leaves the previous match's subtree. Returns the index of the heading
 * the last segment matched, or -1.
 */
function walkSegments(headings: readonly HeadingLine[], parts: readonly string[]): number {
  let cursor = 0;
  let parentLevel = 0;
  let matched = -1;
  for (const part of parts) {
    let found = -1;
    for (let i = cursor; i < headings.length; i++) {
      const heading = headings[i];
      if (!heading) continue;
      if (parentLevel > 0 && heading.level <= parentLevel) break;
      if (heading.text === part) {
        found = i;
        break;
      }
    }
    const hit = headings[found];
    if (!hit) return -1;
    matched = found;
    cursor = found + 1;
    parentLevel = hit.level;
  }
  return matched;
}

/**
 * Match a heading by "::"-delimited hierarchy. A target carrying the delimiter
 * resolves by exact full path first, so every document-map locator reads back
 * as itself; failing that, the segments walk the hierarchy, which lets a path
 * that skips a level (`Top::Child` for `Top::::Child`) still resolve. Empty
 * segments are kept — they name untitled headings. A single-segment target
 * matches a leaf at any depth and resolves to the first such heading.
 *
 * The resolution is reported back in `sectionTarget`. When the read could have
 * meant another heading, `candidates` lists every full path it could name: for
 * a bare leaf, each heading sharing that text; for a delimited target, each
 * occurrence of the resolved path when that path repeats in the note. Which
 * heading wins never changes.
 */
function extractHeading(content: string, target: string): SectionExtraction {
  const parts = target.split(HEADING_DELIMITER).map((p) => p.trim());
  const [leaf] = parts;
  const qualified = parts.length > 1;
  if (!qualified && !leaf) {
    throw notFound('Empty heading target.', { target });
  }

  const lines = content.split('\n');
  const headings = scanHeadings(lines, frontmatterEndLine(content));
  const paths = headingPaths(headings);

  const exact = qualified ? paths.indexOf(parts.join(HEADING_DELIMITER)) : -1;
  const matched = exact >= 0 ? exact : walkSegments(headings, parts);
  const hit = headings[matched];
  const resolved = paths[matched];
  if (!hit || resolved === undefined) {
    throw notFound(`Heading '${target}' not found.`, { target });
  }

  // Slice from the matched heading line to the next heading at the same or shallower level.
  const end = headings.find((h, i) => i > matched && h.level <= hit.level);
  const candidates = qualified
    ? paths.filter((p) => p === resolved)
    : paths.filter((_, i) => headings[i]?.text === leaf);

  return {
    value: lines
      .slice(hit.index, end?.index ?? lines.length)
      .join('\n')
      .replace(/\n+$/, ''),
    sectionTarget: resolved,
    ...(candidates.length > 1 ? { candidates } : {}),
  };
}

/**
 * Match a block by its `^blockId` reference. Returns the line containing the
 * reference plus any preceding lines belonging to the same paragraph (until a
 * blank line or an ATX heading, untitled ones included).
 */
function extractBlock(content: string, blockId: string): string {
  const lines = content.split('\n');
  const bodyStart = frontmatterEndLine(content);
  const inFence = computeFenceMask(lines, bodyStart);
  const escaped = blockId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const ref = new RegExp(`(^|\\s)\\^${escaped}\\s*$`);
  for (let i = bodyStart; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (ref.test(lines[i] ?? '')) {
      let start = i;
      while (start > bodyStart) {
        const prev = lines[start - 1] ?? '';
        if (prev.trim() === '' || parseAtxHeading(prev)) break;
        start--;
      }
      return lines.slice(start, i + 1).join('\n');
    }
  }
  throw notFound(`Block reference '^${blockId}' not found.`, { blockId });
}

/**
 * Return the line index where the document body starts, skipping a leading YAML
 * frontmatter block. Returns 0 when no frontmatter is present. Without this
 * guard, heading and block extraction would scan inside the frontmatter and
 * falsely match YAML comment lines or include the fence in a paragraph
 * walk-back.
 *
 * The boundary comes from `splice` rather than a second line scan, so the read
 * path and every body-scoped write path agree on where the body starts —
 * notably on an opening fence carrying trailing whitespace, which Obsidian
 * reads as body and a lenient `/^---\s*$/` scan hid behind a fence that isn't
 * one.
 */
function frontmatterEndLine(content: string): number {
  const { hasFrontmatter, raw } = splice(content);
  if (!hasFrontmatter) return 0;
  /**
   * `content === raw + body`, so the newlines inside `raw` count the lines it
   * owns. A `raw` that ends mid-line shares that line with the body's first
   * bytes; skip it rather than scan a line the fence starts.
   */
  const consumed = raw.split('\n').length - 1;
  return raw.endsWith('\n') ? consumed : consumed + 1;
}

/**
 * Mark line indices that fall inside fenced code blocks (` ``` ` or `~~~`) so
 * downstream scanning doesn't false-match on markdown-about-markdown notes.
 * The closer must match the opener's fence char, have at least as many fence
 * chars, and carry no info string (per CommonMark). An unclosed fence extends
 * to EOF. Pass `from` to skip a leading frontmatter block.
 */
export function computeFenceMask(lines: string[], from = 0): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let openChar: '`' | '~' | null = null;
  let openLen = 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^\s{0,3}([`~]{3,})/.exec(line);
    if (openChar === null) {
      if (m) {
        const fence = m[1] ?? '';
        openChar = fence[0] as '`' | '~';
        openLen = fence.length;
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (m && /^\s{0,3}[`~]{3,}\s*$/.test(line)) {
      const fence = m[1] ?? '';
      if (fence[0] === openChar && fence.length >= openLen) {
        openChar = null;
        openLen = 0;
      }
    }
  }
  return mask;
}

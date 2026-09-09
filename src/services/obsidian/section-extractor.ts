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
   * Every full heading path sharing the bare-leaf target, in document order.
   * Present only when more than one heading matched — the read still returns
   * the first, so this is disclosure, not a new failure mode.
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

/** One ATX heading found in the note body. */
interface HeadingLine {
  /** Zero-based index of the heading's line in the note. */
  index: number;
  /** Number of leading `#` characters. */
  level: number;
  /** Heading text with surrounding whitespace trimmed. */
  text: string;
}

/**
 * Collect every ATX heading in the note body, in document order. Setext
 * headings are not markdown this extractor recognizes, and lines inside a
 * fenced code block or a frontmatter block are excluded.
 */
function scanHeadings(lines: string[], bodyStart: number, inFence: boolean[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  for (let i = bodyStart; i < lines.length; i++) {
    if (inFence[i]) continue;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i] ?? '');
    if (!m) continue;
    headings.push({ index: i, level: (m[1] ?? '').length, text: (m[2] ?? '').trim() });
  }
  return headings;
}

/**
 * Build the full `Parent::Child` path of one heading by walking backward
 * through the enclosing headings — each ancestor is the nearest preceding
 * heading strictly shallower than the level reached so far. This is the same
 * serialization upstream's document map emits (trimmed heading text, joined by
 * the PATCH target delimiter), so a path built here is a locator the write path
 * resolves as an exact map entry.
 */
function headingPath(headings: HeadingLine[], idx: number): string {
  const matched = headings[idx];
  if (!matched) return '';
  const segments = [matched.text];
  let level = matched.level;
  for (let i = idx - 1; i >= 0 && level > 1; i--) {
    const ancestor = headings[i];
    if (ancestor && ancestor.level < level) {
      segments.unshift(ancestor.text);
      level = ancestor.level;
    }
  }
  return segments.join(HEADING_DELIMITER);
}

/**
 * Match a heading by "::"-delimited hierarchy. "Top::Sub" walks to a level-N
 * heading "Top" and then a deeper heading "Sub" beneath it. A single-segment
 * target matches a leaf at any depth and resolves to the first such heading —
 * the resolution is reported back in `sectionTarget`, and competing headings in
 * `candidates`, rather than changing which one wins.
 *
 * A target that already carries the delimiter is left out of collision
 * detection, mirroring the write-side resolver's own short-circuit: the walk is
 * scoped to the first matching ancestor and never inspects a repeat of it.
 */
function extractHeading(content: string, target: string): SectionExtraction {
  const parts = target
    .split(HEADING_DELIMITER)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw notFound('Empty heading target.', { target });
  }

  const lines = content.split('\n');
  const bodyStart = frontmatterEndLine(content);
  const inFence = computeFenceMask(lines, bodyStart);
  const headings = scanHeadings(lines, bodyStart, inFence);

  let cursor = 0;
  let parentLevel = 0;
  let matched = -1;

  for (const part of parts) {
    let found = -1;
    for (let i = cursor; i < headings.length; i++) {
      const heading = headings[i];
      if (!heading) continue;
      if (parentLevel > 0 && heading.level <= parentLevel) {
        // exited the parent; stop searching deeper for this part
        break;
      }
      if (heading.text === part) {
        found = i;
        break;
      }
    }
    const hit = headings[found];
    if (!hit) {
      throw notFound(`Heading '${target}' not found.`, { target });
    }
    matched = found;
    cursor = found + 1;
    parentLevel = hit.level;
  }

  // Slice from the matched heading line to the next heading at the same or shallower level.
  const startLine = headings[matched]?.index ?? 0;
  let endLine = lines.length;
  for (let i = matched + 1; i < headings.length; i++) {
    const heading = headings[i];
    if (heading && heading.level <= parentLevel) {
      endLine = heading.index;
      break;
    }
  }

  const leaf = parts.length === 1 ? parts[0] : undefined;
  const collisions: number[] = [];
  if (leaf !== undefined) {
    headings.forEach((h, i) => {
      if (h.text === leaf) collisions.push(i);
    });
  }

  return {
    value: lines.slice(startLine, endLine).join('\n').replace(/\n+$/, ''),
    sectionTarget: headingPath(headings, matched),
    ...(collisions.length > 1
      ? { candidates: collisions.map((i) => headingPath(headings, i)) }
      : {}),
  };
}

/**
 * Match a block by its `^blockId` reference. Returns the line containing the
 * reference plus any preceding lines belonging to the same paragraph (until a
 * blank line or heading).
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
        if (prev.trim() === '' || /^#{1,6}\s+/.test(prev)) break;
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

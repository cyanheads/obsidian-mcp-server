/**
 * @fileoverview Client-side section extraction from a NoteJson body.
 * The upstream Local REST API exposes section *targeting* for PATCH but not
 * section-extracted GET, so we slice the markdown ourselves for `format: 'section'`.
 * @module services/obsidian/section-extractor
 */

import { notFound } from '@cyanheads/mcp-ts-core/errors';
import type { NoteJson, SectionTarget } from './types.js';

/**
 * Extract a section's raw markdown (heading/block) or JSON value (frontmatter).
 * Throws `NotFound` if the target does not exist in the note.
 */
export function extractSection(note: NoteJson, section: SectionTarget): string | unknown {
  switch (section.type) {
    case 'frontmatter':
      return extractFrontmatterField(note, section.target);
    case 'heading':
      return extractHeading(note.content, section.target);
    case 'block':
      return extractBlock(note.content, section.target);
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

/**
 * Match a heading by "::"-delimited hierarchy. "Top::Sub" walks to a level-N
 * heading "Top" and then a deeper heading "Sub" beneath it.
 */
function extractHeading(content: string, target: string): string {
  const parts = target
    .split('::')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw notFound('Empty heading target.', { target });
  }

  const lines = content.split('\n');
  const bodyStart = frontmatterEndLine(lines);
  let cursor = bodyStart;
  let parentLevel = 0;

  for (const part of parts) {
    let found = -1;
    let foundLevel = 0;
    for (let i = cursor; i < lines.length; i++) {
      const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i] ?? '');
      if (!m) continue;
      const level = (m[1] ?? '').length;
      const text = (m[2] ?? '').trim();
      if (parentLevel > 0 && level <= parentLevel) {
        // exited the parent; stop searching deeper for this part
        break;
      }
      if (text === part && (parentLevel === 0 || level > parentLevel)) {
        found = i;
        foundLevel = level;
        break;
      }
    }
    if (found === -1) {
      throw notFound(`Heading '${target}' not found.`, { target });
    }
    cursor = found + 1;
    parentLevel = foundLevel;
  }

  // Slice from the matched heading line to the next heading at the same or shallower level.
  const startLine = cursor - 1;
  let endLine = lines.length;
  for (let i = cursor; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i] ?? '');
    if (m && (m[1] ?? '').length <= parentLevel) {
      endLine = i;
      break;
    }
  }
  return lines.slice(startLine, endLine).join('\n').replace(/\n+$/, '');
}

/**
 * Match a block by its `^blockId` reference. Returns the line containing the
 * reference plus any preceding lines belonging to the same paragraph (until a
 * blank line or heading).
 */
function extractBlock(content: string, blockId: string): string {
  const lines = content.split('\n');
  const bodyStart = frontmatterEndLine(lines);
  const escaped = blockId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const ref = new RegExp(`(^|\\s)\\^${escaped}\\s*$`);
  for (let i = bodyStart; i < lines.length; i++) {
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
 * Return the line index where the document body starts, skipping a leading
 * `---`/`---` YAML frontmatter block. Returns 0 when no frontmatter is present.
 * Without this guard, heading and block extraction would scan inside the
 * frontmatter and falsely match YAML comment lines or include the fence in a
 * paragraph walk-back.
 */
function frontmatterEndLine(lines: string[]): number {
  if (!/^---\s*$/.test(lines[0] ?? '')) return 0;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i] ?? '')) return i + 1;
  }
  return 0;
}

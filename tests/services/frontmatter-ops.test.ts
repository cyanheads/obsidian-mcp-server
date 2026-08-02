/**
 * @fileoverview Unit tests for the YAML frontmatter helpers used by the
 * composed manage-frontmatter and manage-tags tools.
 * @module tests/services/frontmatter-ops.test
 */

import { load as yamlLoad } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  deleteFrontmatterKey,
  listTagsFromContent,
  reconcileTags,
} from '@/services/obsidian/frontmatter-ops.js';

const FM_BLOCK_RE = /^---\n([\s\S]*?)\n---\n?/;
/** Mirrors `FM_RE` in the module under test — consumes the block and its fence terminator, nothing more. */
const FM_SPLICE_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function readFrontmatter(content: string): Record<string, unknown> {
  const m = FM_BLOCK_RE.exec(content);
  if (!m) return {};
  const parsed = yamlLoad(m[1] ?? '');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** Everything after the frontmatter block — the bytes a frontmatter edit must leave alone. */
function bodyOf(content: string): string {
  const m = FM_SPLICE_RE.exec(content);
  return m ? content.slice(m[0].length) : content;
}

describe('deleteFrontmatterKey', () => {
  it('removes a single root key and preserves the body', () => {
    const input = ['---', 'title: Hello', 'author: casey', '---', '', 'Body line.'].join('\n');
    const out = deleteFrontmatterKey(input, 'title');
    const fm = readFrontmatter(out);
    expect(fm).toEqual({ author: 'casey' });
    expect(out).toContain('Body line.');
  });

  it('returns content unchanged when the key is absent', () => {
    const input = ['---', 'title: Hello', '---', 'body'].join('\n');
    expect(deleteFrontmatterKey(input, 'missing')).toBe(input);
  });

  it('returns content unchanged when there is no frontmatter', () => {
    const input = '# Just a heading\nbody';
    expect(deleteFrontmatterKey(input, 'title')).toBe(input);
  });

  it('strips the entire frontmatter block when the last key is removed', () => {
    const input = ['---', 'tags: [a]', '---', '', 'Body.'].join('\n');
    const out = deleteFrontmatterKey(input, 'tags');
    expect(out.startsWith('---')).toBe(false);
    expect(out).toContain('Body.');
  });
});

describe('reconcileTags / add', () => {
  it('adds a tag to frontmatter when location is "frontmatter"', () => {
    const input = ['---', 'tags: [a]', '---', 'body'].join('\n');
    const r = reconcileTags(input, ['b'], 'add', 'frontmatter');
    expect(r.applied).toEqual(['b']);
    expect(r.skipped).toEqual([]);
    expect(readFrontmatter(r.content).tags).toEqual(['a', 'b']);
  });

  it('marks an already-present frontmatter tag as skipped', () => {
    const input = ['---', 'tags: [foo]', '---', 'body'].join('\n');
    const r = reconcileTags(input, ['foo'], 'add', 'frontmatter');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['foo']);
    expect(r.content).toBe(input);
  });

  it('appends an inline #tag when location is "inline"', () => {
    const input = 'Line of body.\n';
    const r = reconcileTags(input, ['new'], 'add', 'inline');
    expect(r.applied).toEqual(['new']);
    expect(r.content).toContain('#new');
  });

  it('skips an inline tag that already exists', () => {
    const input = 'Talking about #foo here.';
    const r = reconcileTags(input, ['foo'], 'add', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['foo']);
    expect(r.content).toBe(input);
  });

  it('reconciles both representations when location is "both"', () => {
    const input = ['---', 'tags: [present]', '---', 'Body without inline.'].join('\n');
    const r = reconcileTags(input, ['present', 'fresh'], 'add', 'both');
    // 'present' was in frontmatter but not inline → applied for the inline side
    expect(r.applied.sort()).toEqual(['fresh', 'present']);
    expect(r.skipped).toEqual([]);
    expect(readFrontmatter(r.content).tags).toEqual(['present', 'fresh']);
    expect(r.content).toContain('#present');
    expect(r.content).toContain('#fresh');
  });

  it('does not consider tags inside fenced code blocks as present', () => {
    const input = '```\n#fake\n```\nBody';
    const r = reconcileTags(input, ['fake'], 'add', 'inline');
    expect(r.applied).toEqual(['fake']);
    expect(r.content).toContain('#fake\n```'); // original code block intact
  });
});

describe('reconcileTags / remove', () => {
  it('removes a tag from the frontmatter array', () => {
    const input = ['---', 'tags: [a, b, c]', '---', 'body'].join('\n');
    const r = reconcileTags(input, ['b'], 'remove', 'frontmatter');
    expect(r.applied).toEqual(['b']);
    expect(readFrontmatter(r.content).tags).toEqual(['a', 'c']);
  });

  it('reports an absent tag as skipped', () => {
    const input = ['---', 'tags: [a]', '---', 'body'].join('\n');
    const r = reconcileTags(input, ['z'], 'remove', 'frontmatter');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['z']);
  });

  it('removes inline #tags when location is "inline"', () => {
    const input = 'Mentions #drop and continues.';
    const r = reconcileTags(input, ['drop'], 'remove', 'inline');
    expect(r.applied).toEqual(['drop']);
    expect(r.content).not.toContain('#drop');
    expect(r.content).toContain('Mentions');
  });

  it('leaves #tags inside fenced code blocks untouched', () => {
    const input = '```\n#keep\n```\nBody #keep here.';
    const r = reconcileTags(input, ['keep'], 'remove', 'inline');
    expect(r.applied).toEqual(['keep']);
    // Inline outside the fence is gone:
    expect(r.content.replace(/```[\s\S]*?```/, '<<FENCE>>')).not.toContain('#keep');
    // The fenced version is preserved:
    expect(r.content).toContain('```\n#keep\n```');
  });
});

describe('frontmatter round-trip fidelity (surgical edits)', () => {
  const handAuthored = [
    '---',
    '# status explainer',
    'status: draft   # flip to published when ready',
    'priority: 1',
    'aliases:',
    '  - "My Note"',
    '  - "MN"',
    'tags:',
    '  - work',
    'date: 2026-06-29',
    '---',
    '',
    '# Body',
  ].join('\n');

  it('adds a tag without dropping comments, unquoting aliases, or reformatting a plain date', () => {
    const r = reconcileTags(handAuthored, ['urgent'], 'add', 'frontmatter');
    // Only the targeted field changed.
    expect(r.applied).toEqual(['urgent']);
    expect(readFrontmatter(r.content).tags).toEqual(['work', 'urgent']);
    // Untouched fields survive verbatim.
    expect(r.content).toContain('# status explainer');
    expect(r.content).toContain('# flip to published when ready');
    expect(r.content).toContain('date: 2026-06-29');
    expect(r.content).not.toContain('2026-06-29T00:00:00');
    expect(r.content).toContain('"My Note"');
    expect(r.content).toContain('# Body');
  });

  it('deletes an unrelated key without reformatting the surviving date or dropping comments', () => {
    const out = deleteFrontmatterKey(handAuthored, 'priority');
    expect(readFrontmatter(out).priority).toBeUndefined();
    expect(out).not.toContain('priority:');
    // Surviving fields keep their hand-authored form.
    expect(out).toContain('# status explainer');
    expect(out).toContain('date: 2026-06-29');
    expect(out).not.toContain('2026-06-29T00:00:00');
    expect(out).toContain('"My Note"');
  });
});

describe('body byte-fidelity across a frontmatter rewrite', () => {
  it('keeps the blank line separating the block from the body', () => {
    const input = '---\ntitle: a\nkeep: b\n---\n\nBody line one.\n';
    const out = deleteFrontmatterKey(input, 'title');
    expect(out).toBe('---\nkeep: b\n---\n\nBody line one.\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('does not invent a separator when the body starts on the line after the fence', () => {
    const input = '---\ntitle: a\nkeep: b\n---\nBody line one.\n';
    const out = deleteFrontmatterKey(input, 'title');
    expect(out).toBe('---\nkeep: b\n---\nBody line one.\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('preserves every blank line when the body is separated by several', () => {
    const input = '---\ntitle: a\nkeep: b\n---\n\n\n\nBody line one.\n';
    const out = deleteFrontmatterKey(input, 'title');
    expect(bodyOf(out)).toBe('\n\n\nBody line one.\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('preserves a CRLF body verbatim', () => {
    const input = '---\r\ntitle: a\r\nkeep: b\r\n---\r\n\r\nBody line one.\r\n';
    const out = deleteFrontmatterKey(input, 'title');
    expect(bodyOf(out)).toBe('\r\nBody line one.\r\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('leaves an empty body empty', () => {
    const input = '---\ntitle: a\nkeep: b\n---\n';
    const out = deleteFrontmatterKey(input, 'title');
    expect(out).toBe('---\nkeep: b\n---\n');
    expect(bodyOf(out)).toBe('');
  });

  it('keeps the separator when a tag is added at the frontmatter location', () => {
    const input = '---\ntags:\n  - a\n---\n\nBody line one.\n';
    const r = reconcileTags(input, ['b'], 'add', 'frontmatter');
    expect(readFrontmatter(r.content).tags).toEqual(['a', 'b']);
    expect(bodyOf(r.content)).toBe(bodyOf(input));
  });

  it('keeps the separator when a tag is removed at the frontmatter location', () => {
    const input = '---\ntags:\n  - a\n  - b\n---\n\nBody line one.\n';
    const r = reconcileTags(input, ['b'], 'remove', 'frontmatter');
    expect(readFrontmatter(r.content).tags).toEqual(['a']);
    expect(bodyOf(r.content)).toBe(bodyOf(input));
  });

  it('preserves a leading blank line when frontmatter is created on a note that had none', () => {
    const input = '\n# Heading\n\nBody line one.\n';
    const r = reconcileTags(input, ['x'], 'add', 'frontmatter');
    expect(readFrontmatter(r.content).tags).toEqual(['x']);
    expect(bodyOf(r.content)).toBe(input);
  });
});

describe('listTagsFromContent', () => {
  it('splits frontmatter and inline tags, deduplicating', () => {
    const content = ['Body with #foo and #bar.', 'Another #foo.'].join('\n');
    const r = listTagsFromContent(content, { tags: ['baz', 'foo'] });
    expect(r.frontmatter).toEqual(['baz', 'foo']);
    expect(r.inline).toEqual(['foo', 'bar']);
  });

  it('ignores #tags inside fenced code blocks', () => {
    const content = '```\n#hidden\n```\nBody #shown';
    const r = listTagsFromContent(content, {});
    expect(r.inline).toEqual(['shown']);
  });

  it('tolerates missing/non-array frontmatter tags', () => {
    const r = listTagsFromContent('body', { tags: undefined });
    expect(r.frontmatter).toEqual([]);
    expect(r.inline).toEqual([]);
  });
});

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

function readFrontmatter(content: string): Record<string, unknown> {
  const m = FM_BLOCK_RE.exec(content);
  if (!m) return {};
  const parsed = yamlLoad(m[1] ?? '');
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
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

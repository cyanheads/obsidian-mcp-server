/**
 * @fileoverview Unit tests for the client-side section extractor used by
 * obsidian_get_note when `format: "section"`.
 * @module tests/services/section-extractor.test
 */

import { describe, expect, it } from 'vitest';
import { extractSection } from '@/services/obsidian/section-extractor.js';
import type { NoteJson } from '@/services/obsidian/types.js';

const baseStat = { ctime: 0, mtime: 0, size: 0 };

function note(content: string, frontmatter: Record<string, unknown> = {}): NoteJson {
  return {
    path: 'Test/Note.md',
    content,
    frontmatter,
    tags: [],
    stat: baseStat,
  };
}

describe('extractSection / heading', () => {
  it('returns a top-level heading and its body up to the next sibling', () => {
    const md = ['# Top', 'Top body', '', '## Sub', 'Sub body', '', '# Other', 'Other body'].join(
      '\n',
    );

    const value = extractSection(note(md), { type: 'heading', target: 'Top' });
    expect(value).toBe(['# Top', 'Top body', '', '## Sub', 'Sub body'].join('\n'));
  });

  it('walks the "::" hierarchy for nested headings', () => {
    const md = ['# Root', '## Child A', 'A body', '## Child B', 'B body', '', '# Other'].join('\n');

    const value = extractSection(note(md), {
      type: 'heading',
      target: 'Root::Child B',
    });
    expect(value).toBe(['## Child B', 'B body'].join('\n'));
  });

  it('throws NotFound when the heading does not exist', () => {
    expect(() => extractSection(note('# Foo\nbody'), { type: 'heading', target: 'Bar' })).toThrow(
      /not found/i,
    );
  });

  it('throws on an empty heading target', () => {
    expect(() => extractSection(note('# Foo'), { type: 'heading', target: '   ' })).toThrow(
      /empty heading/i,
    );
  });

  it('stops at headings of the same level (not deeper ones)', () => {
    const md = ['## A', 'a body', '### sub', 'sub body', '## B', 'b body'].join('\n');
    const value = extractSection(note(md), { type: 'heading', target: 'A' });
    expect(value).toBe(['## A', 'a body', '### sub', 'sub body'].join('\n'));
  });

  it('treats setext (underline) headings as plain text — not supported', () => {
    const md = ['Heading', '=======', 'body'].join('\n');
    expect(() => extractSection(note(md), { type: 'heading', target: 'Heading' })).toThrow(
      /not found/i,
    );
  });

  it('throws when the parent heading exists but the child does not', () => {
    const md = ['# Root', '## Child A', 'a body'].join('\n');
    expect(() => extractSection(note(md), { type: 'heading', target: 'Root::Ghost' })).toThrow(
      /not found/i,
    );
  });

  it('does not match a child that lives under a different parent', () => {
    const md = ['# Top', 'top body', '# Other', '## Foo', 'foo body'].join('\n');
    expect(() => extractSection(note(md), { type: 'heading', target: 'Top::Foo' })).toThrow(
      /not found/i,
    );
  });

  it('returns the first occurrence when the same heading appears twice at the same level', () => {
    const md = ['# Dup', 'first body', '# Dup', 'second body'].join('\n');
    const value = extractSection(note(md), { type: 'heading', target: 'Dup' });
    expect(value).toBe(['# Dup', 'first body'].join('\n'));
  });

  it('matches a heading on the first line when no frontmatter is present', () => {
    const md = ['# Top', 'body'].join('\n');
    const value = extractSection(note(md), { type: 'heading', target: 'Top' });
    expect(value).toBe(['# Top', 'body'].join('\n'));
  });
});

describe('extractSection / block', () => {
  it('returns the line that owns a block reference', () => {
    const md = ['Some intro.', '', 'A claim worth citing. ^abc-123', '', '# Other'].join('\n');
    const value = extractSection(note(md), { type: 'block', target: 'abc-123' });
    expect(value).toBe('A claim worth citing. ^abc-123');
  });

  it('walks back through the paragraph that ends in the reference', () => {
    const md = ['Line 1', 'Line 2', 'Line 3 ^xyz', '', 'Next paragraph.'].join('\n');
    const value = extractSection(note(md), { type: 'block', target: 'xyz' });
    expect(value).toBe(['Line 1', 'Line 2', 'Line 3 ^xyz'].join('\n'));
  });

  it('throws NotFound when the block reference is missing', () => {
    expect(() =>
      extractSection(note('Some text without a block ref.'), {
        type: 'block',
        target: 'missing',
      }),
    ).toThrow(/not found/i);
  });

  it('does not pull frontmatter into the block when no blank line follows the closing fence', () => {
    const md = ['---', 'title: Foo', '---', 'A paragraph ^abc'].join('\n');
    const value = extractSection(note(md), { type: 'block', target: 'abc' });
    expect(value).toBe('A paragraph ^abc');
  });

  it('matches block IDs containing regex special characters', () => {
    const md = 'paragraph ^a.b+c';
    const value = extractSection(note(md), { type: 'block', target: 'a.b+c' });
    expect(value).toBe('paragraph ^a.b+c');
  });
});

describe('extractSection / fenced code blocks', () => {
  it('does not match a # heading inside a fenced code block', () => {
    const md = [
      '# Real',
      'body',
      '',
      '```markdown',
      '# Fake',
      'fake body',
      '```',
      '',
      '# Other',
    ].join('\n');
    expect(() => extractSection(note(md), { type: 'heading', target: 'Fake' })).toThrow(
      /not found/i,
    );
  });

  it('does not stop slicing at a # heading inside a fenced code block', () => {
    const md = [
      '# Real',
      'before fence',
      '',
      '```markdown',
      '# Fake',
      '```',
      'after fence',
      '',
      '# Other',
    ].join('\n');
    const value = extractSection(note(md), { type: 'heading', target: 'Real' });
    expect(value).toBe(
      ['# Real', 'before fence', '', '```markdown', '# Fake', '```', 'after fence'].join('\n'),
    );
  });

  it('respects tilde-fenced code blocks too', () => {
    const md = ['# Real', 'body', '', '~~~markdown', '# Fake', '~~~'].join('\n');
    expect(() => extractSection(note(md), { type: 'heading', target: 'Fake' })).toThrow(
      /not found/i,
    );
  });

  it('does not match a ^blockId inside a fenced code block', () => {
    const md = ['real paragraph ^abc', '', '```markdown', 'fake paragraph ^xyz', '```'].join('\n');
    expect(() => extractSection(note(md), { type: 'block', target: 'xyz' })).toThrow(/not found/i);
    expect(extractSection(note(md), { type: 'block', target: 'abc' })).toBe('real paragraph ^abc');
  });
});

describe('extractSection / frontmatter boundary', () => {
  it('does not match a YAML comment line as a heading', () => {
    const md = [
      '---',
      '# this is a yaml comment',
      'title: Foo',
      '---',
      '',
      '# Real Heading',
      'body',
    ].join('\n');
    const value = extractSection(note(md), { type: 'heading', target: 'Real Heading' });
    expect(value).toBe(['# Real Heading', 'body'].join('\n'));
  });
});

describe('extractSection / frontmatter', () => {
  it('returns the JSON-typed frontmatter value', () => {
    const value = extractSection(note('body', { author: 'casey', priority: 3 }), {
      type: 'frontmatter',
      target: 'priority',
    });
    expect(value).toBe(3);
  });

  it('throws NotFound when the frontmatter key is absent', () => {
    expect(() =>
      extractSection(note('body', { author: 'casey' }), {
        type: 'frontmatter',
        target: 'priority',
      }),
    ).toThrow(/not found/i);
  });

  it('returns array values', () => {
    const value = extractSection(note('body', { tags: ['a', 'b'] }), {
      type: 'frontmatter',
      target: 'tags',
    });
    expect(value).toEqual(['a', 'b']);
  });

  it('returns nested object values', () => {
    const value = extractSection(note('body', { meta: { author: 'casey' } }), {
      type: 'frontmatter',
      target: 'meta',
    });
    expect(value).toEqual({ author: 'casey' });
  });

  it('returns boolean values', () => {
    const value = extractSection(note('body', { archived: false }), {
      type: 'frontmatter',
      target: 'archived',
    });
    expect(value).toBe(false);
  });

  it('returns null values', () => {
    const value = extractSection(note('body', { reviewer: null }), {
      type: 'frontmatter',
      target: 'reviewer',
    });
    expect(value).toBe(null);
  });
});

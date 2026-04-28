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
});

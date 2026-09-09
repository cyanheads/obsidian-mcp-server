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

    const { value } = extractSection(note(md), { type: 'heading', target: 'Top' });
    expect(value).toBe(['# Top', 'Top body', '', '## Sub', 'Sub body'].join('\n'));
  });

  it('walks the "::" hierarchy for nested headings', () => {
    const md = ['# Root', '## Child A', 'A body', '## Child B', 'B body', '', '# Other'].join('\n');

    const { value } = extractSection(note(md), {
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
    const { value } = extractSection(note(md), { type: 'heading', target: 'A' });
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
    const { value } = extractSection(note(md), { type: 'heading', target: 'Dup' });
    expect(value).toBe(['# Dup', 'first body'].join('\n'));
  });

  it('matches a heading on the first line when no frontmatter is present', () => {
    const md = ['# Top', 'body'].join('\n');
    const { value } = extractSection(note(md), { type: 'heading', target: 'Top' });
    expect(value).toBe(['# Top', 'body'].join('\n'));
  });
});

describe('extractSection / heading resolution', () => {
  it('reports the full path for a bare leaf matched below the root', () => {
    const md = ['# Root', 'root body', '## Nested', 'nested body'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'Nested' });
    expect(out.sectionTarget).toBe('Root::Nested');
    expect(out.candidates).toBeUndefined();
  });

  it('reports every colliding path for an ambiguous leaf nested three deep', () => {
    const md = [
      '# Overview',
      '## Alpha',
      '### Shared',
      '',
      'Nested under Alpha.',
      '',
      '## Beta',
      '### Shared',
      '',
      'Nested under Beta.',
    ].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'Shared' });
    expect(out.value).toBe('### Shared\n\nNested under Alpha.');
    expect(out.sectionTarget).toBe('Overview::Alpha::Shared');
    expect(out.candidates).toEqual(['Overview::Alpha::Shared', 'Overview::Beta::Shared']);
  });

  it('echoes a fully-qualified target unchanged and reports no candidates', () => {
    const md = ['# Root', '## Child', 'body'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'Root::Child' });
    expect(out.sectionTarget).toBe('Root::Child');
    expect(out.candidates).toBeUndefined();
  });

  it('leaves a "::"-qualified target out of ambiguity detection when the parent repeats', () => {
    const md = ['# A', '## B', 'b body', '# A', '## C', 'c body'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'A::B' });
    expect(out.value).toBe(['## B', 'b body'].join('\n'));
    expect(out.sectionTarget).toBe('A::B');
    expect(out.candidates).toBeUndefined();
  });

  it('repeats an identical string in candidates for same-level root duplicates', () => {
    const md = ['# Dup', 'first body', '# Dup', 'second body'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'Dup' });
    expect(out.value).toBe(['# Dup', 'first body'].join('\n'));
    expect(out.sectionTarget).toBe('Dup');
    expect(out.candidates).toEqual(['Dup', 'Dup']);
  });

  it('repeats an identical string in candidates for same-level nested duplicates', () => {
    const md = ['# Root', '## Dup', 'first body', '## Dup', 'second body'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'Dup' });
    expect(out.sectionTarget).toBe('Root::Dup');
    expect(out.candidates).toEqual(['Root::Dup', 'Root::Dup']);
  });

  it('builds the path from the body start when the note carries frontmatter', () => {
    const md = ['---', 'title: Foo', '---', '', '# Root', '## Nested', 'nested body'].join('\n');
    const out = extractSection(note(md, { title: 'Foo' }), {
      type: 'heading',
      target: 'Nested',
    });
    expect(out.value).toBe(['## Nested', 'nested body'].join('\n'));
    expect(out.sectionTarget).toBe('Root::Nested');
  });

  it('trims trailing whitespace out of every heading text in the path', () => {
    const md = ['# Root  ', '## Child  ', 'body', '## Child  ', 'other'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'Child' });
    expect(out.sectionTarget).toBe('Root::Child');
    expect(out.candidates).toEqual(['Root::Child', 'Root::Child']);
  });

  /**
   * The write path (`ObsidianService#resolveHeadingTarget`) resolves a locator
   * against upstream's flat `::`-joined `map.headings`: an exact member is used
   * as-is, and a bare leaf is matched with `h.split('::').pop() === target`.
   * `upstreamHeadings` is written out by hand here — an independent
   * serialization of the same fixture — so agreement is measured, not shared.
   */
  describe('byte-compatibility with the write-side resolver', () => {
    const md = [
      '# Overview',
      '## Alpha',
      '### Shared',
      'alpha body',
      '## Beta',
      '### Shared',
      'beta body',
    ].join('\n');
    const upstreamHeadings = [
      'Overview',
      'Overview::Alpha',
      'Overview::Alpha::Shared',
      'Overview::Beta',
      'Overview::Beta::Shared',
    ];

    it.each(['Overview', 'Alpha', 'Beta', 'Shared', 'Overview::Alpha::Shared'])(
      'resolves %s to an exact `map.headings` entry',
      (target) => {
        const out = extractSection(note(md), { type: 'heading', target });
        expect(upstreamHeadings).toContain(out.sectionTarget);
      },
    );

    it('matches the write-side leaf filter for the ambiguous leaf', () => {
      const out = extractSection(note(md), { type: 'heading', target: 'Shared' });
      const writeSideMatches = upstreamHeadings.filter((h) => h.split('::').pop() === 'Shared');
      expect(out.candidates).toEqual(writeSideMatches);
    });
  });
});

describe('extractSection / block', () => {
  it('returns the line that owns a block reference', () => {
    const md = ['Some intro.', '', 'A claim worth citing. ^abc-123', '', '# Other'].join('\n');
    const { value } = extractSection(note(md), { type: 'block', target: 'abc-123' });
    expect(value).toBe('A claim worth citing. ^abc-123');
  });

  it('walks back through the paragraph that ends in the reference', () => {
    const md = ['Line 1', 'Line 2', 'Line 3 ^xyz', '', 'Next paragraph.'].join('\n');
    const { value } = extractSection(note(md), { type: 'block', target: 'xyz' });
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
    const { value } = extractSection(note(md), { type: 'block', target: 'abc' });
    expect(value).toBe('A paragraph ^abc');
  });

  it('matches block IDs containing regex special characters', () => {
    const md = 'paragraph ^a.b+c';
    const { value } = extractSection(note(md), { type: 'block', target: 'a.b+c' });
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
    const { value } = extractSection(note(md), { type: 'heading', target: 'Real' });
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
    expect(extractSection(note(md), { type: 'block', target: 'abc' }).value).toBe(
      'real paragraph ^abc',
    );
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
    const { value } = extractSection(note(md), { type: 'heading', target: 'Real Heading' });
    expect(value).toBe(['# Real Heading', 'body'].join('\n'));
  });

  /**
   * Trailing whitespace after the opening `---` is a YAML syntax error in
   * Obsidian: no properties are parsed and the whole file is body. Reading it
   * as a fence hid every heading and block above the second `---`.
   */
  it('scans from the first line when the opening fence carries trailing whitespace', () => {
    const md = '--- \n# Real Heading\n\nBody text.\n---\n';
    const { value } = extractSection(note(md), { type: 'heading', target: 'Real Heading' });
    expect(value).toBe('# Real Heading\n\nBody text.\n---');
  });

  it('scans from the first line for a CRLF trailing-whitespace fence too', () => {
    const md = '--- \r\n# Real Heading\r\n\r\nBody text.\r\n---\r\n';
    const { value } = extractSection(note(md), { type: 'heading', target: 'Real Heading' });
    expect(value).toBe('# Real Heading\r\n\r\nBody text.\r\n---\r');
  });

  it('finds a block reference below a trailing-whitespace opening fence', () => {
    const md = '--- \n\nA claim worth citing. ^abc\n---\n';
    const { value } = extractSection(note(md), { type: 'block', target: 'abc' });
    expect(value).toBe('A claim worth citing. ^abc');
  });

  it('skips an empty properties block when scanning for a heading', () => {
    const md = '---\n---\n# Heading\nbody ^blk';
    expect(extractSection(note(md), { type: 'heading', target: 'Heading' }).value).toBe(
      '# Heading\nbody ^blk',
    );
    expect(extractSection(note(md), { type: 'block', target: 'blk' }).value).toBe('body ^blk');
  });

  it('leaves a YAML comment unreachable when the block runs to end of file', () => {
    const md = '---\n# Foo\ntitle: a\n---';
    expect(() => extractSection(note(md), { type: 'heading', target: 'Foo' })).toThrow(
      /not found/i,
    );
  });
});

describe('extractSection / frontmatter', () => {
  it('returns the JSON-typed frontmatter value', () => {
    const { value } = extractSection(note('body', { author: 'casey', priority: 3 }), {
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
    const { value } = extractSection(note('body', { tags: ['a', 'b'] }), {
      type: 'frontmatter',
      target: 'tags',
    });
    expect(value).toEqual(['a', 'b']);
  });

  it('returns nested object values', () => {
    const { value } = extractSection(note('body', { meta: { author: 'casey' } }), {
      type: 'frontmatter',
      target: 'meta',
    });
    expect(value).toEqual({ author: 'casey' });
  });

  it('returns boolean values', () => {
    const { value } = extractSection(note('body', { archived: false }), {
      type: 'frontmatter',
      target: 'archived',
    });
    expect(value).toBe(false);
  });

  it('returns null values', () => {
    const { value } = extractSection(note('body', { reviewer: null }), {
      type: 'frontmatter',
      target: 'reviewer',
    });
    expect(value).toBe(null);
  });
});

/**
 * @fileoverview Unit tests for the client-side section extractor used by
 * obsidian_get_note when `format: "section"`.
 * @module tests/services/section-extractor.test
 */

import { describe, expect, it } from 'vitest';
import { extractSection, listHeadingPaths } from '@/services/obsidian/section-extractor.js';
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

/**
 * Every heading locator the plugin's document map emits must read back to that
 * heading. Each `headings` array below was captured from the live Local REST API
 * document-map endpoint (markdown-patch format 1) for the fixture beside it.
 */
describe('extractSection / document-map locators round-trip', () => {
  const FIXTURES: Array<[name: string, md: string, headings: string[]]> = [
    [
      'untitled top-level heading',
      '##\n\n### Request body\n\nbody text\n\n### Returns\n\nreturns text\n',
      ['::Request body', '::Returns'],
    ],
    [
      'untitled heading under a titled one',
      '# Top\n\n##\n\n### Child\n\ntext\n',
      ['Top', 'Top::', 'Top::::Child'],
    ],
    [
      'two untitled top-level headings',
      '#\n\n## Child A\n\na\n\n#\n\n## Child B\n\nb\n',
      ['::Child A', '::Child B'],
    ],
    [
      'tab, closing sequence, indent, and trailing-space untitled heading',
      '#\tTab Title\n\n## Closed ##\n\n   ## Indented\n\n##   \n### After trailing-space empty\n\nx\n',
      [
        'Tab Title',
        'Tab Title::Closed',
        'Tab Title::Indented',
        'Tab Title::',
        'Tab Title::::After trailing-space empty',
      ],
    ],
    [
      'untitled tab heading and an all-hash heading',
      '#\t\n## After tab empty\n\n### ###\n#### After closing-seq empty\n\ny\n',
      ['::After tab empty', '::After tab empty::', '::After tab empty::::After closing-seq empty'],
    ],
    ['repeated root heading', '# Dup\nfirst body\n# Dup\nsecond body\n', ['Dup']],
    ['repeated nested heading', '# Root\n## Dup\nfirst\n## Dup\nsecond\n', ['Root', 'Root::Dup']],
    ['nested untitled headings', '#\n##\n### X\n\nx\n', ['::', '::::X']],
    [
      'leaf shared across levels',
      '# A\n## B\n### C\nbc body\n## C\nac body\n',
      ['A', 'A::B', 'A::B::C', 'A::C'],
    ],
    ['repeated parent', '# A\n## B\nb\n# A\n## C\nc\n', ['A', 'A::B', 'A::C']],
    [
      'closing sequences the plugin keeps or strips',
      '# T\n## Foo\t##\n### Bar ##  \n## Baz#\n## #\n',
      ['T', 'T::Foo\t##', 'T::Foo\t##::Bar', 'T::Baz#', 'T::'],
    ],
    [
      'CRLF line endings',
      '##\r\n\r\n### Request body\r\n\r\nbody text\r\n\r\n### Returns\r\n\r\nreturns text\r\n',
      ['::Request body', '::Returns'],
    ],
    ['untitled CRLF heading', '# T\n##\r\n### Sub\r\n', ['T', 'T::', 'T::::Sub']],
  ];

  describe.each(FIXTURES)('%s', (_name, md, headings) => {
    it.each(headings)('reads %j back as its own locator', (locator) => {
      const out = extractSection(note(md), { type: 'heading', target: locator });
      expect(out.sectionTarget).toBe(locator);
    });

    it('lists the same paths the document map does, repeats collapsed', () => {
      expect([...new Set(listHeadingPaths(md).filter((p) => p !== ''))]).toEqual(headings);
    });
  });

  it('reads the issue repro by its map locator and by its bare leaf alike', () => {
    const md = '##\n\n### Request body\n\nbody text\n\n### Returns\n\nreturns text\n';
    const qualified = extractSection(note(md), { type: 'heading', target: '::Request body' });
    expect(qualified).toEqual({
      value: '### Request body\n\nbody text',
      sectionTarget: '::Request body',
    });
    expect(extractSection(note(md), { type: 'heading', target: 'Request body' })).toEqual(
      qualified,
    );
  });

  it.each([
    ['# Top\n##\n### Child\ntext', 'Top::', '##\n### Child\ntext'],
    ['#\n## Child A\na\n#\n## Child B\nb', '::Child B', '## Child B\nb'],
    ['# T\n## Closed ##\nclosed\n   ## Indented\nindented', 'T::Closed', '## Closed ##\nclosed'],
    [
      '# T\n## Closed ##\nclosed\n   ## Indented\nindented',
      'T::Indented',
      '   ## Indented\nindented',
    ],
    ['#\t\n## After\n### ###\n#### Deep\ny', '::After::', '### ###\n#### Deep\ny'],
    ['# A\n## B\nb\n# A\n## C\nc', 'A::C', '## C\nc'],
    ['# A\n## B\n### C\nbc\n## C\nac', 'A::C', '## C\nac'],
  ])('reads the heading a map locator names in %j (%s)', (md, locator, value) => {
    expect(extractSection(note(md), { type: 'heading', target: locator })).toEqual({
      value,
      sectionTarget: locator,
    });
  });

  it('falls back to the segment walk for a path that skips an untitled level', () => {
    const md = '# Top\n\n##\n\n### Child\n\ntext\n';
    const out = extractSection(note(md), { type: 'heading', target: 'Top::Child' });
    expect(out.value).toBe('### Child\n\ntext');
    expect(out.sectionTarget).toBe('Top::::Child');
  });

  it.each([
    ['a bare ##', '##'],
    ['trailing spaces', '##   '],
    ['a tab', '##\t'],
    ['a carriage return', '##\r'],
    ['a closing sequence', '## ##'],
    ['a lone closing hash', '## #'],
  ])('ends the section above at an untitled heading with %s', (_label, line) => {
    const md = ['## X', 'x body', line, '### Sub', 'sub body'].join('\n');
    expect(extractSection(note(md), { type: 'heading', target: 'X' }).value).toBe('## X\nx body');
  });

  it.each([
    ['### ###', 'T::'],
    ['#\t', ''],
    ['##\r', 'T::'],
    ['   ## Indented', 'T::Indented'],
    ['## Closed ##', 'T::Closed'],
    ['# foo#', 'foo#'],
    ['#hashtag', undefined],
    ['####### x', undefined],
    ['    # x', undefined],
  ])('scans %j as heading path %j', (line, path) => {
    const paths = listHeadingPaths(`# T\n${line}`);
    expect(paths).toEqual(path === undefined ? ['T'] : ['T', path]);
  });

  it('skips heading lines inside a fenced block', () => {
    expect(listHeadingPaths('# T\n```\n## Fenced\n```\n## Real\n')).toEqual(['T', 'T::Real']);
  });

  it('returns only its paragraph for a block reference directly under an untitled heading', () => {
    const md = ['##', 'paragraph ^b'].join('\n');
    expect(extractSection(note(md), { type: 'block', target: 'b' }).value).toBe('paragraph ^b');
  });

  it.each(['Root::::Child', 'Root::'])(
    'throws NotFound for %j, which names an untitled heading the note does not have',
    (target) => {
      const md = ['# Root', '## Child', 'child body'].join('\n');
      expect(() => extractSection(note(md), { type: 'heading', target })).toThrow(/not found/i);
    },
  );

  it('discloses every occurrence of a full path that repeats and reads the first', () => {
    const md = ['# Root', '## Dup', 'first', '## Dup', 'second'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'Root::Dup' });
    expect(out.value).toBe('## Dup\nfirst');
    expect(out.sectionTarget).toBe('Root::Dup');
    expect(out.candidates).toEqual(['Root::Dup', 'Root::Dup']);
  });
});

/**
 * Lines that are not ATX headings under CommonMark or the plugin's parser,
 * and CRLF bodies. Pinned so a wider heading scan cannot start matching them.
 */
describe('extractSection / heading lines the scan leaves alone', () => {
  it.each([
    ['a hashtag with no space', '#hashtag line'],
    ['seven hashes', '####### seven'],
    ['a four-space-indented line (indented code)', '    # indented code'],
  ])('does not end a section at %s', (_label, line) => {
    const md = ['# Top', line, 'top body', '# Next', 'next body'].join('\n');
    const { value } = extractSection(note(md), { type: 'heading', target: 'Top' });
    expect(value).toBe(['# Top', line, 'top body'].join('\n'));
  });

  it('keeps a trailing hash that has no space before it as heading text', () => {
    const md = ['# foo#', 'body'].join('\n');
    const out = extractSection(note(md), { type: 'heading', target: 'foo#' });
    expect(out.value).toBe(['# foo#', 'body'].join('\n'));
    expect(out.sectionTarget).toBe('foo#');
  });

  it('resolves nested paths in a CRLF body, keeping the carriage returns in the value', () => {
    const md = '# Root\r\n## Child\r\nbody\r\n# Other\r\n';
    const qualified = extractSection(note(md), { type: 'heading', target: 'Root::Child' });
    expect(qualified.value).toBe('## Child\r\nbody\r');
    expect(qualified.sectionTarget).toBe('Root::Child');
    const leaf = extractSection(note(md), { type: 'heading', target: 'Child' });
    expect(leaf.sectionTarget).toBe('Root::Child');
    expect(leaf.candidates).toBeUndefined();
  });

  it('stops a block walk-back at a titled heading line', () => {
    const md = ['## Title', 'paragraph ^b'].join('\n');
    expect(extractSection(note(md), { type: 'block', target: 'b' }).value).toBe('paragraph ^b');
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

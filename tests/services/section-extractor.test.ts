/**
 * @fileoverview Unit tests for the client-side section extractor used by
 * obsidian_get_note when `format: "section"`.
 * @module tests/services/section-extractor.test
 */

import { Lexer, type Tokens } from 'marked';
import { describe, expect, it } from 'vitest';
import {
  blockKinds,
  extractSection,
  listHeadingPaths,
  sectionBody,
} from '@/services/obsidian/section-extractor.js';
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

  it('reads a setext (underline) heading, which the document map lists', () => {
    const md = ['Heading', '=======', 'body'].join('\n');
    expect(extractSection(note(md), { type: 'heading', target: 'Heading' })).toEqual({
      value: md,
      sectionTarget: 'Heading',
    });
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
 * A note and the document maps captured for it from the live Local REST API
 * 5.2.0 on Obsidian 1.13.7: `v1` is the markdown-patch format-1 `headings`
 * array, `v2` the format-2 heading tree flattened in document order with one
 * entry per heading — repeats and top-level untitled (`""`) entries kept.
 */
type CapturedMap = [name: string, md: string, v1: string[], v2: string[]];

/** Every map path is scanned as the plugin scans it, and reads back as itself. */
function expectMapParity(md: string, v1: string[], v2: string[]): void {
  const paths = listHeadingPaths(md);
  expect(paths).toEqual(v2);
  expect([...new Set(paths.filter((p) => p !== ''))]).toEqual(v1);
  for (const locator of v1) {
    expect(extractSection(note(md), { type: 'heading', target: locator }).sectionTarget).toBe(
      locator,
    );
  }
}

/** Shapes where a line scan and the plugin's parser already agree. Pinned so the token scan keeps them. */
describe('extractSection / shapes the plugin reads as a line scan does', () => {
  const MAPS: CapturedMap[] = [
    [
      'list-unindented',
      '# Root\n- item\n## After\nmore\n',
      ['Root', 'Root::After'],
      ['Root', 'Root::After'],
    ],
    [
      'list-deep',
      '# Root\n- a\n  - b\n    - c\n      ## Deep\n## Real\nx\n',
      ['Root', 'Root::Real'],
      ['Root', 'Root::Real'],
    ],
    ['fence-backtick', '# T\n```\n## Fenced\n```\n## Real\n', ['T', 'T::Real'], ['T', 'T::Real']],
    [
      'fence-tilde-long',
      '# T\n~~~~\n## A\n~~~\n## B\n~~~~\n## Real\n',
      ['T', 'T::Real'],
      ['T', 'T::Real'],
    ],
    ['fence-unclosed', '# T\n```\n## Never\n', ['T'], ['T']],
    ['fence-indented', '# T\n   ```\n## In\n   ```\n## Real\n', ['T', 'T::Real'], ['T', 'T::Real']],
    [
      'fence-in-list',
      '# T\n- item\n  ```\n  ## In\n  ```\n## Real\n',
      ['T', 'T::Real'],
      ['T', 'T::Real'],
    ],
    ['blockquote', '# T\n> ## Quoted\n> text\n\n## Real\n', ['T', 'T::Real'], ['T', 'T::Real']],
    ['indented-code-lazy', '# T\npara\n    ## lazy\n## Real\n', ['T', 'T::Real'], ['T', 'T::Real']],
    ['hr-vs-setext', '# T\npara\n\n---\n## X\nx\n', ['T', 'T::X'], ['T', 'T::X']],
    [
      'table-then-heading',
      '# T\n| a | b |\n| - | - |\n| 1 | 2 |\n## X\nx\n',
      ['T', 'T::X'],
      ['T', 'T::X'],
    ],
    ['table-valid', 'a|b\n-|-\n1|2\n# H\nh\n', ['H'], ['H']],
    [
      'inline-markup',
      '# T\n## **Bold** [l](x) `c`\nbody\n## Foo \\#\n',
      ['T', 'T::**Bold** [l](x) `c`', 'T::Foo \\#'],
      ['T', 'T::**Bold** [l](x) `c`', 'T::Foo \\#'],
    ],
    ['fm-close-suffix', '---\ntitle: a\n---x\n# H\nbody\n', ['H'], ['H']],
    ['fm-crlf', '---\r\ntitle: a\r\n---\r\n# H\r\n## S\r\ns\r\n', ['H', 'H::S'], ['H', 'H::S']],
    [
      'children-append',
      '# Top\ntop body\n\n## Child\nchild body\n\n\n# Next\nnext\n',
      ['Top', 'Top::Child', 'Next'],
      ['Top', 'Top::Child', 'Next'],
    ],
    ['empty', '', [], []],
    ['fm-only', '---\na: 1\n---\n', [], []],
  ];

  it.each(MAPS)('%s: scans the paths the document map lists', (_name, md, v1, v2) => {
    expectMapParity(md, v1, v2);
  });

  it('reads a section through its children up to the next heading at its level', () => {
    const md = '# Top\ntop body\n\n## Child\nchild body\n\n\n# Next\nnext\n';
    expect(extractSection(note(md), { type: 'heading', target: 'Top' }).value).toBe(
      '# Top\ntop body\n\n## Child\nchild body',
    );
  });

  it('keeps a whitespace-only last line and drops only the trailing newlines', () => {
    const md = '# A\nbody\n   \n\n# B\nb';
    expect(extractSection(note(md), { type: 'heading', target: 'A' }).value).toBe('# A\nbody\n   ');
  });

  it('reads a CRLF section below frontmatter byte for byte', () => {
    const md = '---\r\ntitle: a\r\n---\r\n# H\r\n## S\r\ns\r\n';
    expect(extractSection(note(md), { type: 'heading', target: 'H::S' })).toEqual({
      value: '## S\r\ns\r',
      sectionTarget: 'H::S',
    });
  });

  it('runs a section to the end of an unclosed fence', () => {
    const md = '# T\n```\n## Never\n';
    expect(extractSection(note(md), { type: 'heading', target: 'T' }).value).toBe(
      '# T\n```\n## Never',
    );
    expect(() => extractSection(note(md), { type: 'heading', target: 'Never' })).toThrow(
      /not found/i,
    );
  });

  it('throws NotFound for a heading target in a note with no headings', () => {
    for (const md of ['', '---\na: 1\n---\n', 'plain text\n']) {
      expect(() => extractSection(note(md), { type: 'heading', target: 'X' })).toThrow(
        /not found/i,
      );
    }
  });
});

/**
 * Shapes a line scan misreads: setext headings, `#` lines that continue a
 * list item or sit inside an HTML block, and CRLF or lone-CR notes carrying
 * either. The plugin reads headings as top-level `marked` heading tokens.
 */
describe('extractSection / headings the plugin parser reads', () => {
  const MAPS: CapturedMap[] = [
    [
      '#128 F4 with its setext heading',
      '#\tTab Title\n\n## Closed ##\n\n   ## Indented\n\nSetext\n======\n\n##   \n### After trailing-space empty\n\nx\n',
      [
        'Tab Title',
        'Tab Title::Closed',
        'Tab Title::Indented',
        'Setext',
        'Setext::',
        'Setext::::After trailing-space empty',
      ],
      [
        'Tab Title',
        'Tab Title::Closed',
        'Tab Title::Indented',
        'Setext',
        'Setext::',
        'Setext::::After trailing-space empty',
      ],
    ],
    [
      'repro-br',
      '# Root\n## Dup\nfirst\n\n<br>\n## Dup\nnot a heading\n',
      ['Root', 'Root::Dup'],
      ['Root', 'Root::Dup'],
    ],
    ['setext-h2', '# Root\nDup\n---\nbody\n', ['Root', 'Root::Dup'], ['Root', 'Root::Dup']],
    [
      'setext-h1',
      'Title\n=====\n\n## Child\nchild body\n',
      ['Title', 'Title::Child'],
      ['Title', 'Title::Child'],
    ],
    [
      'setext-multiline',
      '# Root\nLine one\nLine two\n---\nafter\n',
      ['Root', 'Root::Line one\nLine two'],
      ['Root', 'Root::Line one\nLine two'],
    ],
    [
      'setext-after-para',
      '# Root\n\npara\nDup\n---\nbody\n',
      ['Root', 'Root::para\nDup'],
      ['Root', 'Root::para\nDup'],
    ],
    [
      'setext-trailing-ws',
      '# Root\nDup  \n---   \nbody\n',
      ['Root', 'Root::Dup'],
      ['Root', 'Root::Dup'],
    ],
    [
      'setext-nested',
      'A\n===\nB\n---\n### C\nc\n',
      ['A', 'A::B', 'A::B::C'],
      ['A', 'A::B', 'A::B::C'],
    ],
    [
      'setext-repeat',
      '# Root\n## Dup\na\n\nDup\n---\n',
      ['Root', 'Root::Dup'],
      ['Root', 'Root::Dup', 'Root::Dup'],
    ],
    ['setext-dash-pairs', 't\n-\nu\n-\n', ['t', 'u'], ['t', 'u']],
    ['pipe-dash', 'a|b\n-\nbody\n', ['a|b'], ['a|b']],
    ['list-indented', '# Root\n- item\n  ## Nested\nmore\n', ['Root'], ['Root']],
    [
      'list-ordered-blank',
      '# Root\n1. item\n\n   ## Sub\n\n   text\n## Real\n',
      ['Root', 'Root::Real'],
      ['Root', 'Root::Real'],
    ],
    [
      'html-comment',
      '# Root\n## Dup\na\n\n<!--\n## Dup\n\nold\n-->\n## Next\nn\n',
      ['Root', 'Root::Dup', 'Root::Next'],
      ['Root', 'Root::Dup', 'Root::Next'],
    ],
    [
      'html-details',
      '# Root\n<details>\n## Inside\n</details>\n\n## After\nafter\n',
      ['Root', 'Root::After'],
      ['Root', 'Root::After'],
    ],
    [
      'html-pre',
      '# Root\n<pre>\n## Inside\n\n## Still\n</pre>\n## After\nx\n',
      ['Root', 'Root::After'],
      ['Root', 'Root::After'],
    ],
    [
      'html-div-blank',
      '# Root\n<div>\n## In div\n\n## Out\nx\n',
      ['Root', 'Root::Out'],
      ['Root', 'Root::Out'],
    ],
    [
      'crlf-repro',
      '# Root\r\n## Dup\r\nfirst\r\n\r\n<br>\r\n## Dup\r\nnot a heading\r\n',
      ['Root', 'Root::Dup'],
      ['Root', 'Root::Dup'],
    ],
    [
      'crlf-setext',
      '# Root\r\nDup\r\n---\r\nbody\r\n\r\n## Next\r\nnext\r\n',
      ['Root', 'Root::Dup', 'Root::Next'],
      ['Root', 'Root::Dup', 'Root::Next'],
    ],
    [
      'crlf-many',
      '# A\r\n\r\ntext\r\n\r\n## B\r\nb\r\n\r\n<!--\r\n## Hidden\r\n-->\r\n\r\n## C\r\nc\r\n# D\r\n',
      ['A', 'A::B', 'A::C', 'D'],
      ['A', 'A::B', 'A::C', 'D'],
    ],
    [
      'html-then-atx-crlf',
      '# R\r\n<details>\r\n## In\r\n</details>\r\n\r\n## Out\r\no\r\n',
      ['R', 'R::Out'],
      ['R', 'R::Out'],
    ],
    [
      'fm-setext',
      '---\ntitle: x\n---\nTop\n===\n## Child\nc\n',
      ['Top', 'Top::Child'],
      ['Top', 'Top::Child'],
    ],
    ['lone-cr', '# A\r## B\rtext\r', ['A', 'A::B'], ['A', 'A::B']],
    /**
     * `---x` closes no frontmatter block for the plugin, so the `# Comment`
     * line after the opening `---` is a heading.
     */
    ['fm-close-suffix-heading', '---\n# Comment\n---x\n# H\n', ['Comment', 'H'], ['Comment', 'H']],
  ];

  it.each(MAPS)('%s: scans the paths the document map lists', (_name, md, v1, v2) => {
    expectMapParity(md, v1, v2);
  });

  it('reads the issue repro through the line the map does not count, with no candidates', () => {
    const md = '# Root\n## Dup\nfirst\n\n<br>\n## Dup\nnot a heading';
    expect(extractSection(note(md), { type: 'heading', target: 'Root::Dup' })).toEqual({
      value: '## Dup\nfirst\n\n<br>\n## Dup\nnot a heading',
      sectionTarget: 'Root::Dup',
    });
  });

  it('reads a setext heading as its text line, underline, and body', () => {
    const md = '# Root\nDup\n---\nbody';
    expect(extractSection(note(md), { type: 'heading', target: 'Root::Dup' })).toEqual({
      value: 'Dup\n---\nbody',
      sectionTarget: 'Root::Dup',
    });
  });

  it('keeps every carriage return of a CRLF setext section', () => {
    const md = '# Root\r\nDup\r\n---\r\nbody';
    expect(extractSection(note(md), { type: 'heading', target: 'Dup' })).toEqual({
      value: 'Dup\r\n---\r\nbody',
      sectionTarget: 'Root::Dup',
    });
  });

  it('reads a level-1 setext section through its ATX child', () => {
    const md = 'Title\n=====\n\n## Child\nchild body\n';
    expect(extractSection(note(md), { type: 'heading', target: 'Title' }).value).toBe(
      'Title\n=====\n\n## Child\nchild body',
    );
  });

  it('walks a path through two setext levels to an ATX heading', () => {
    const md = 'A\n===\nB\n---\n### C\nc\n';
    expect(extractSection(note(md), { type: 'heading', target: 'A::B::C' })).toEqual({
      value: '### C\nc',
      sectionTarget: 'A::B::C',
    });
    expect(extractSection(note(md), { type: 'heading', target: 'C' }).sectionTarget).toBe(
      'A::B::C',
    );
    expect(extractSection(note(md), { type: 'heading', target: 'A::B' }).value).toBe(
      'B\n---\n### C\nc',
    );
  });

  it.each(['Root::Nested', 'Nested'])(
    'throws NotFound for %j, a heading line that continues a list item',
    (target) => {
      const md = '# Root\n- item\n  ## Nested\nmore';
      expect(() => extractSection(note(md), { type: 'heading', target })).toThrow(/not found/i);
      expect(extractSection(note(md), { type: 'heading', target: 'Root' }).value).toBe(md);
    },
  );

  it.each([
    [
      'an HTML comment',
      '# Root\n## Dup\na\n\n<!--\n## Dup\n\nold\n-->\n## Next\nn',
      '## Dup\na\n\n<!--\n## Dup\n\nold\n-->',
    ],
    [
      'a details block',
      '# Root\n## Dup\na\n<details>\n## Dup\n</details>\n\n## Next\nn',
      '## Dup\na\n<details>\n## Dup\n</details>',
    ],
    [
      'a pre block',
      '# Root\n## Dup\na\n<pre>\n## Dup\n\n## Dup\n</pre>\n## Next\nn',
      '## Dup\na\n<pre>\n## Dup\n\n## Dup\n</pre>',
    ],
  ])(
    'reads a section through %s whose heading lines the map does not count',
    (_label, md, value) => {
      expect(extractSection(note(md), { type: 'heading', target: 'Root::Dup' })).toEqual({
        value,
        sectionTarget: 'Root::Dup',
      });
    },
  );

  it('discloses a path that repeats through a setext heading and reads the first', () => {
    const md = '# Root\n## Dup\na\n\nDup\n---\n';
    expect(extractSection(note(md), { type: 'heading', target: 'Root::Dup' })).toEqual({
      value: '## Dup\na',
      sectionTarget: 'Root::Dup',
      candidates: ['Root::Dup', 'Root::Dup'],
    });
  });

  it('stops a block walk-back at a setext underline', () => {
    const md = 'Title\n---\nparagraph ^b';
    expect(extractSection(note(md), { type: 'block', target: 'b' }).value).toBe('paragraph ^b');
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

/**
 * markdown-patch 2.0's heading paths, computed from stock `marked` the way
 * the plugin computes them: its frontmatter strip (`preProcess`), then the
 * top-level heading tokens (`findHeadings`), joined into `::` paths.
 */
function pluginPaths(md: string): string[] {
  const frontmatter =
    /^---(?:\r\n|\r|\n)(?:---(?:\r\n|\r|\n|$)|([\s\S]*?)(?:\r\n|\r|\n)---(?:\r\n|\r|\n|$))/.exec(
      md,
    );
  const stack: Array<{ level: number; path: string }> = [];
  const paths: string[] = [];
  for (const token of new Lexer().lex(md.slice(frontmatter?.[0].length ?? 0))) {
    if (token.type !== 'heading') continue;
    const { depth, text } = token as Tokens.Heading;
    while ((stack.at(-1)?.level ?? 0) >= depth) stack.pop();
    const parent = stack.at(-1);
    const path = parent ? `${parent.path}::${text.trim()}` : text.trim();
    stack.push({ level: depth, path });
    paths.push(path);
  }
  return paths;
}

describe('listHeadingPaths / the plugin parser', () => {
  it.each([
    ['a table', 'a|b\n-|-\n1|2\n# H\n'],
    ['an aligned table', '| a |\n|:-:|\n| 1 |\n## H\nh\n'],
    ['a table with too few delimiter cells', '| a | b |\n| - |\nx\n## H\n'],
    ['a pipe line over one dash', 'a|b\n-\nc|d\n--\n'],
    ['an escaped pipe', 'a\\|b|c\n-|-\n## H\n'],
    ['a table interrupting a paragraph', 'para\n| a | b |\n| - | - |\n## H\n'],
    ['a table under a heading line', '# T\n|a|\n|-|\n## H\n'],
    ['repeated one-dash setext headings', 't\n-\n'.repeat(50)],
    ['repeated mismatched tables', '| a | b |\n| - |\n'.repeat(50)],
    ['repeated pipe lines over one dash', 'a|b\n-\n'.repeat(50)],
    ['a table ending a paragraph at the end of the note', 'para\n| a | b |\n| - | - |'],
    ['a nested blockquote run ending the note', `${'>'.repeat(30)} x\n${'> ## q\n'.repeat(5)}`],
    [
      'a nested blockquote run meeting an empty line',
      `${'>'.repeat(30)} x\n> y\n\nAfter\n===\n## H\n`,
    ],
    ['a blockquote with lazy lines', `${'>'.repeat(5)} x\nlazy\nText\n===\n\n## H\n`],
    ['a blockquote whose code block stops a lazy line', '>     code\nText\n===\n'],
    ['a blockquote run over a tab-only line', '> a\n\t\nText\n---\n'],
    [
      'setext, lists, HTML, and fences together',
      '# R\nA\n===\n- x\n  ## no\n<div>\n## no\n</div>\n\n```\n## no\n```\nB\n-\n',
    ],
  ])('lists the paths stock marked yields for %s', (_label, md) => {
    expect(listHeadingPaths(md)).toEqual(pluginPaths(md));
  });
});

/**
 * The scan is linear in note length: an 80k-character note of each shape —
 * including ones built to stress the lexer — scans well inside the budget. A
 * quadratic scan takes seconds on these.
 */
describe('listHeadingPaths / cost', () => {
  const SIZE = 80_000;
  const BUDGET_MS = 1_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

  it.each<[string, () => string]>([
    ['ATX headings', () => fill('## h\n')],
    ['untitled headings', () => fill('#\n')],
    [
      'headings over prose',
      () => fill('# H\n\nSome *text* with **bold**, `code`, and [a link](x).\n\n'),
    ],
    ['setext headings with a one-dash underline', () => fill('t\n-\n')],
    ['pipe lines over one dash', () => fill('a|b\n-\n')],
    ['pipe lines over a delimiter with too few cells', () => fill('| a | b |\n| - |\n')],
    ['a blockquote nested a thousand deep', () => `${'>'.repeat(1_000)} x\n${fill('> x\n')}`],
    ['setext headings with a three-dash underline', () => fill('t\n---\n')],
    ['heading lines in list items', () => fill('- item\n  ## Nested\n')],
    [
      'a deeply nested list',
      () => {
        let md = '';
        for (let depth = 0; md.length < SIZE; depth++) md += `${'  '.repeat(depth % 40)}- x\n`;
        return md;
      },
    ],
    ['one long HTML block', () => `<div>\n${fill('## not a heading\n')}</div>\n`],
    ['an unclosed HTML comment', () => `<!--\n${fill('## not a heading\n')}`],
    ['HTML lines between headings', () => fill('<br>\n## x\n\n')],
    ['an unclosed fence', () => `\`\`\`\n${fill('## not a heading\n')}`],
    ['one long table', () => `| a |\n| - |\n${fill('| x |\n')}`],
    ['CRLF headings', () => fill('## h\r\ntext\r\n\r\n')],
  ])('scans an 80k-character note of %s inside the budget', (_label, build) => {
    const md = build();
    const started = performance.now();
    listHeadingPaths(md);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

/**
 * markdown-patch 2.0's direct-body blocks of the section at `path`, computed
 * from stock `marked` the way the plugin computes `bodyChildren`: the
 * frontmatter-stripped body lexed whole, and every top-level token between
 * the section's heading and the next heading of any level, `space` excepted.
 */
function pluginBody(md: string, path: string): { blocks: string[]; subsections: boolean } {
  const frontmatter =
    /^---(?:\r\n|\r|\n)(?:---(?:\r\n|\r|\n|$)|([\s\S]*?)(?:\r\n|\r|\n)---(?:\r\n|\r|\n|$))/.exec(
      md,
    );
  const tokens = new Lexer().lex(md.slice(frontmatter?.[0].length ?? 0));
  const stack: Array<{ level: number; path: string }> = [];
  let level = 0;
  let inSection = false;
  const blocks: string[] = [];
  for (const token of tokens) {
    if (token.type === 'heading') {
      const { depth, text } = token as Tokens.Heading;
      if (inSection) return { blocks, subsections: depth > level };
      while ((stack.at(-1)?.level ?? 0) >= depth) stack.pop();
      const parent = stack.at(-1);
      const own = parent ? `${parent.path}::${text.trim()}` : text.trim();
      stack.push({ level: depth, path: own });
      if (own === path) {
        inSection = true;
        level = depth;
      }
    } else if (inSection && token.type !== 'space') {
      blocks.push(token.type);
    }
  }
  return { blocks, subsections: false };
}

describe('sectionBody', () => {
  it('lists the top-level blocks of the section’s own body, in order', () => {
    const md = '# T\n## A\nIntro.\n\n- one\n- two\n\n| a |\n| - |\n\n```\nx\n```\n## B\n';
    expect(sectionBody(md, 'T::A')).toEqual({
      blocks: ['paragraph', 'list', 'table', 'code'],
      subsections: false,
      content: 'Intro.\n\n- one\n- two\n\n| a |\n| - |\n\n```\nx\n```\n',
    });
  });

  it('stops the body at the first sub-heading and keeps the subsections in `content`', () => {
    const md = '# T\n## A\n- one\n### Sub\ntext\n#### Deeper\n- two\n## B\nafter\n';
    expect(sectionBody(md, 'T::A')).toEqual({
      blocks: ['list'],
      subsections: true,
      content: '- one\n### Sub\ntext\n#### Deeper\n- two\n',
    });
  });

  it('reads a nested list as one list, and a list item’s indented lines as part of it', () => {
    expect(sectionBody('# A\n- one\n  - nested\n\n\n    more\n', 'A')?.blocks).toEqual(['list']);
  });

  it('reads an empty section as no blocks', () => {
    expect(sectionBody('# T\n## A\n\n\n## B\n', 'T::A')).toEqual({
      blocks: [],
      subsections: false,
      content: '\n\n',
    });
  });

  it('keeps a CRLF note’s own bytes in `content`', () => {
    expect(sectionBody('# A\r\n- one\r\n- two\r\n# B\r\n', 'A')).toEqual({
      blocks: ['list'],
      subsections: false,
      content: '- one\r\n- two\r\n',
    });
  });

  it('skips frontmatter and resolves a setext heading and an untitled parent', () => {
    const md = '---\na: 1\n---\n#\nSetext\n------\n- one\n';
    expect(sectionBody(md, '::Setext')?.blocks).toEqual(['list']);
  });

  it('returns `undefined` for a path the note does not have', () => {
    expect(sectionBody('# T\n## A\n- one\n', 'T::Nope')).toBeUndefined();
    expect(sectionBody('# T\n## A\n- one\n', 'A')).toBeUndefined();
  });

  it.each([
    ['a list', '# T\n## A\n- one\n- two\n'],
    ['a list, then a paragraph', '# T\n## A\n- one\n\ntext\n'],
    ['a lazy paragraph line', '# T\n## A\n- one\nlazy\n'],
    ['a list and its isolated block id', '# T\n## A\n- one\n\n^id\n'],
    ['a blockquote list', '# T\n## A\n> - one\n'],
    ['an HTML block', '# T\n## A\n<div>\n- one\n</div>\n'],
    ['a thematic break', '# T\n## A\n- one\n\n---\n'],
    ['a table interrupting a paragraph', '# T\n## A\npara\n| a | b |\n| - | - |\n'],
    ['a list with a heading line inside an item', '# T\n## A\n- one\n  ## no\n'],
    ['a sub-heading', '# T\n## A\n- one\n### S\n- two\n'],
    ['a sibling heading', '# T\n## A\n- one\n## B\n- two\n'],
    ['a setext underline over a list', '# T\n## A\n- one\n---\n'],
    ['a fence holding a heading line', '# T\n## A\n```\n## no\n```\n- one\n'],
    ['a nested blockquote run', `# T\n## A\n${'>'.repeat(30)} x\n> y\n\n- one\n`],
    ['CRLF line endings', '# T\r\n## A\r\n- one\r\n\r\ntext\r\n'],
  ])('reads the blocks stock marked yields for %s', (_label, md) => {
    const body = sectionBody(md, 'T::A');
    expect(body && { blocks: body.blocks, subsections: body.subsections }).toEqual(
      pluginBody(md, 'T::A'),
    );
  });
});

describe('blockKinds', () => {
  it.each([
    ['a bullet item', '- a', ['list']],
    ['an ordered item', '3. a', ['list']],
    ['a task item after blank lines', '\n\n- [ ] a', ['list']],
    ['a paragraph a list interrupts', 'text\n- a', ['paragraph', 'list']],
    ['a list, then a paragraph', '- a\n\ntext\n', ['list', 'paragraph']],
    ['a list, then an HTML block', '- a\n\n<div>x</div>', ['list', 'html']],
    ['a thematic break', '---', ['hr']],
    ['a fence', '```\n- a\n```', ['code']],
    ['a heading', '## H\n- a', ['heading', 'list']],
    ['nothing', '', []],
  ])('reads %s', (_label, md, kinds) => {
    expect(blockKinds(md)).toEqual(kinds);
  });
});

/**
 * Both scans lex the whole input once, so their cost grows linearly with it:
 * each shape at 5k, 20k, and 80k characters, including the ones built to
 * stress the lexer, stays inside the budget.
 */
describe('sectionBody and blockKinds / cost', () => {
  const BUDGET_MS = 1_000;
  const fill = (unit: string, size: number) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const SHAPES: Array<[string, (size: number) => string]> = [
    ['list items', (n) => fill('- item\n', n)],
    ['nested list items', (n) => fill('- a\n  - b\n    - c\n', n)],
    ['headings over prose', (n) => fill('## H\n\nSome *text* with `code`.\n\n', n)],
    ['setext headings with a one-dash underline', (n) => fill('t\n-\n', n)],
    ['pipe lines over one dash', (n) => fill('a|b\n-\n', n)],
    ['pipe lines over a delimiter with too few cells', (n) => fill('| a | b |\n| - |\n', n)],
    ['a blockquote nested a thousand deep', (n) => `${'>'.repeat(1_000)} x\n${fill('> x\n', n)}`],
    ['heading lines in list items', (n) => fill('- item\n  ## Nested\n', n)],
    ['an unclosed fence', (n) => `\`\`\`\n${fill('- not a list\n', n)}`],
    ['one long table', (n) => `| a |\n| - |\n${fill('| x |\n', n)}`],
    ['CRLF list items', (n) => fill('- item\r\n', n)],
  ];

  it.each(
    SHAPES.flatMap(([label, build]) =>
      [5_000, 20_000, 80_000].map((size) => [label, size, build] as const),
    ),
  )('scans %s at %i characters inside the budget', (_label, size, build) => {
    const md = `# T\n## A\n${build(size)}`;
    const started = performance.now();
    sectionBody(md, 'T::A');
    blockKinds(md);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

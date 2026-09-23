/**
 * @fileoverview Unit tests for the markdown-patch wire-format helpers: format
 * negotiation, the 1.x headers and 2.0 instruction a section write becomes,
 * heading content re-levelled for 2.0, and the 2.0 document map flattened to
 * the 1.x shape.
 * @module tests/services/patch-instruction.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import {
  canonicalContent,
  flattenDocumentMap,
  hasIntegerKey,
  inNoteOrder,
  isIntegerKey,
  patchFormatFor,
  relativeHeadingLevels,
  v1PatchHeaders,
  v2Instruction,
} from '@/services/obsidian/patch-instruction.js';
import {
  atxHeadingMarkers,
  isIsolatedBlockId,
  sectionLevel,
} from '@/services/obsidian/section-extractor.js';
import type { PatchInstruction } from '@/services/obsidian/types.js';
import { repeatKey } from '../helpers.js';

describe('patchFormatFor', () => {
  it.each([
    ['4.0.0', '1'],
    ['4.9.12', '1'],
    ['3.2.0', '1'],
    ['5.0.0', '2'],
    ['5.2.0', '2'],
    ['6.0.0', '2'],
    ['10.1.0', '2'],
    ['5.3.0-beta.1', '2'],
    ['v5.2.0', '2'],
    ['', '2'],
    [undefined, '2'],
  ])('reads plugin version %j as markdown-patch %s', (version, format) => {
    expect(patchFormatFor(version)).toBe(format);
  });
});

const write = (extra: Partial<PatchInstruction> = {}): PatchInstruction => ({
  operation: 'append',
  targetType: 'heading',
  target: 'Top::Child',
  contentType: 'markdown',
  ...extra,
});

describe('v1PatchHeaders', () => {
  it('carries a heading target with its delimiter and the protective reject flag', () => {
    expect(v1PatchHeaders(write())).toEqual({
      'Markdown-Patch-Version': '1',
      Operation: 'append',
      'Target-Type': 'heading',
      Target: 'Top%3A%3AChild',
      'Target-Delimiter': '::',
      'Content-Type': 'text/markdown',
      'Reject-If-Content-Preexists': 'true',
    });
  });

  it('omits the delimiter for a block and forwards every opt-in flag', () => {
    expect(
      v1PatchHeaders(
        write({
          targetType: 'block',
          target: 'abc',
          createTargetIfMissing: true,
          applyIfContentPreexists: true,
          trimTargetWhitespace: true,
          contentType: 'json',
        }),
      ),
    ).toEqual({
      'Markdown-Patch-Version': '1',
      Operation: 'append',
      'Target-Type': 'block',
      Target: 'abc',
      'Content-Type': 'application/json',
      'Create-Target-If-Missing': 'true',
      'Trim-Target-Whitespace': 'true',
    });
  });
});

describe('v2Instruction', () => {
  it('splits a heading path into its array target, untitled and nested segments kept', () => {
    expect(v2Instruction(write({ target: '::A::B::C' }), 'x').target).toEqual(['', 'A', 'B', 'C']);
  });

  it('keeps a block or frontmatter target as a string', () => {
    expect(v2Instruction(write({ targetType: 'block', target: 'a::b' }), 'x').target).toBe('a::b');
  });

  it('parses a JSON frontmatter value and keeps a markdown one as text', () => {
    const fm = write({ targetType: 'frontmatter', target: 'k', operation: 'replace' });
    expect(v2Instruction({ ...fm, contentType: 'json' }, '[1,"a",null]').value).toEqual([
      1,
      'a',
      null,
    ]);
    expect(v2Instruction(fm, '[1]').value).toBe('[1]');
  });

  it('leaves a non-string JSON array for table rows as the caller wrote it', () => {
    const rows = write({ targetType: 'block', target: 't', contentType: 'json' });
    expect(v2Instruction(rows, '[["a","b"]]').value).toEqual([['a', 'b']]);
    expect(v2Instruction(rows, '[]').value).toEqual([[]]);
    expect(v2Instruction(rows, '[1,2]').value).toEqual([1, 2]);
  });

  it('rejects `json` content that does not parse', () => {
    expect(() =>
      v2Instruction(write({ targetType: 'frontmatter', contentType: 'json' }), '{nope'),
    ).toThrow(expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }));
  });

  /** A `within` splice is literal: the builder supplies the line break on the side facing the list. */
  describe('addressing a body block `within` the section', () => {
    it('appends after the last block, the line break first', () => {
      expect(v2Instruction(write(), '- c', -1)).toEqual({
        targetType: 'heading',
        target: ['Top', 'Child'],
        operation: 'append',
        scope: 'content',
        within: -1,
        content: '\n- c',
        rejectIfContentPreexists: true,
      });
    });

    it('prepends before the first block, the line break last', () => {
      expect(v2Instruction(write({ operation: 'prepend' }), '- a\n- b', 0)).toEqual({
        targetType: 'heading',
        target: ['Top', 'Child'],
        operation: 'prepend',
        scope: 'content',
        within: 0,
        content: '- a\n- b\n',
        rejectIfContentPreexists: true,
      });
    });

    it('drops `createTargetIfMissing`, which 2.0 refuses beside `within`', () => {
      const out = v2Instruction(
        write({ createTargetIfMissing: true, applyIfContentPreexists: true }),
        '- c',
        -1,
      );
      expect(out).not.toHaveProperty('createTargetIfMissing');
      expect(out).not.toHaveProperty('rejectIfContentPreexists');
    });
  });
});

describe('canonicalContent', () => {
  it.each([
    ['plain text', '- a', '- a'],
    ['a trailing line break', '- a\n', '- a'],
    ['leading blank and spaces-only lines', '\n  \n\t\n- a', '- a'],
    ['trailing whitespace of every kind', '- a  \n\t\n\n', '- a'],
    ['first-line indentation', '  - a', '  - a'],
    ['CRLF and lone CR line endings', '- a\r\n- b\r- c\r\n', '- a\n- b\n- c'],
    ['interior blank lines', '- a\n\n\npara', '- a\n\n\npara'],
    ['only whitespace', ' \n\t\n', ''],
  ])('reduces %s as markdown-patch 2.0 reduces a plain write', (_l, content, expected) => {
    expect(canonicalContent(content)).toBe(expected);
  });
});

describe('relativeHeadingLevels', () => {
  const relative = (markdown: string, baseline: number) =>
    relativeHeadingLevels(atxHeadingMarkers(markdown), baseline);

  it('subtracts the section level from every top-level ATX heading', () => {
    expect(relative('### A\ntext\n#### B ####\n  ### C\n', 2)).toEqual({
      ok: true,
      content: '# A\ntext\n## B ####\n  # C\n',
    });
  });

  it('reads CRLF and lone-CR content as LF, the line ending 2.0 re-applies itself', () => {
    expect(relative('### A\r\ntext\rmore\r\n', 1)).toEqual({
      ok: true,
      content: '## A\ntext\nmore\n',
    });
  });

  it('leaves setext headings, fenced and indented `#` lines, and hashtags alone', () => {
    const content = 'Sub\n---\n\n```\n## fenced\n```\n\n    ## indented code\n\n#tag text\n';
    expect(atxHeadingMarkers(content).markers).toEqual([]);
    expect(relative(content, 3)).toEqual({ ok: true, content });
  });

  it('ignores a `#` line inside a list item or an HTML block', () => {
    expect(atxHeadingMarkers('- item\n  ## nested\n\n<div>\n## html\n</div>\n').markers).toEqual(
      [],
    );
  });

  it('keeps level 6 reachable under a level-5 section', () => {
    expect(relative('###### Six\n', 5)).toEqual({ ok: true, content: '# Six\n' });
  });

  it('returns the first heading at or above the section level instead of rewriting', () => {
    expect(relative('### Fine\n## Peer\n# Top\n', 2)).toEqual({
      ok: false,
      heading: '## Peer',
      level: 2,
    });
  });
});

describe('sectionLevel', () => {
  const note = '---\ntitle: t\n---\n# A\n### C\nbody\n\nSetext\n------\n\n#### Deep\n# B\n';

  it.each([
    ['a top-level heading', 'A', 1],
    ['a heading below a skipped level', 'A::C', 3],
    ['a setext heading', 'A::Setext', 2],
    ['a heading three segments down', 'A::Setext::Deep', 4],
  ])('reads %s from the note', (_label, path, level) => {
    expect(sectionLevel(note, path, false)).toBe(level);
    expect(sectionLevel(note, path, true)).toBe(level);
  });

  it.each([
    ['one missing segment under an existing heading', 'A::C::New', 4],
    ['two missing segments', 'B::X::Y', 3],
    ['a missing top-level path', 'Nowhere', 1],
    ['a missing path with no existing ancestor', 'Q::R', 2],
  ])('counts %s from the deepest existing ancestor when it is created', (_label, path, level) => {
    expect(sectionLevel(note, path, true)).toBe(level);
  });

  it('has no level for a missing path the write will not create', () => {
    expect(sectionLevel(note, 'A::C::New', false)).toBeUndefined();
    expect(sectionLevel(note, 'Nowhere', false)).toBeUndefined();
  });
});

describe('flattenDocumentMap', () => {
  it('flattens nested headings past the first level, repeats collapsed', () => {
    expect(
      flattenDocumentMap({
        version: 'v',
        frontmatterFields: [],
        headings: {
          A: { B: { C: { D: {} } }, [repeatKey('B', 1)]: { E: {} } },
          [repeatKey('A', 1)]: {},
        },
        blocks: [],
      }).headings,
    ).toEqual(['A', 'A::B', 'A::B::C', 'A::B::C::D', 'A::B::E']);
  });

  it('strips repeat suffixes past sixteen occurrences', () => {
    const blocks = Array.from({ length: 18 }, (_, i) => (i === 0 ? 'id' : repeatKey('id', i)));
    expect(
      flattenDocumentMap({ version: 'v', frontmatterFields: [], headings: {}, blocks }).blocks,
    ).toEqual(['id']);
  });

  it('keeps a heading literally named __proto__', () => {
    const headings = JSON.parse('{"__proto__":{"x":{}}}');
    expect(
      flattenDocumentMap({ version: 'v', frontmatterFields: [], headings, blocks: [] }).headings,
    ).toEqual(['__proto__', '__proto__::x']);
  });
});

describe('isIntegerKey', () => {
  it.each([
    ['0', true],
    ['2025', true],
    ['4294967294', true],
    ['4294967295', false],
    ['01', false],
    ['-1', false],
    ['1.5', false],
    ['2025 recap', false],
    ['', false],
  ])('reads %j as integer-like: %s', (name, expected) => {
    expect(isIntegerKey(name)).toBe(expected);
  });

  it('agrees with the order JavaScript gives object keys', () => {
    const names = ['b', '4294967295', '01', '10', 'a', '2'];
    const jsFirst = Object.keys(Object.fromEntries(names.map((n) => [n, 0])));
    expect(jsFirst.slice(0, 2)).toEqual(
      names.filter(isIntegerKey).sort((x, y) => Number(x) - Number(y)),
    );
  });
});

describe('hasIntegerKey', () => {
  it('finds an integer-like name past the first level', () => {
    expect(hasIntegerKey({ A: { B: { '2024': {} } } })).toBe(true);
    expect(hasIntegerKey({ A: { B: { '2024 notes': {} } } })).toBe(false);
  });
});

describe('inNoteOrder', () => {
  it('orders by first occurrence in the note, repeats together, unknown paths last in place', () => {
    expect(
      inNoteOrder(
        ['J', 'J::2024', 'J::2024', 'J::2025', 'Missing', 'Other'],
        ['J', 'J::2025', 'J::2024', 'Other', 'J::2024'],
      ),
    ).toEqual(['J', 'J::2025', 'J::2024', 'J::2024', 'Other', 'Missing']);
  });
});

describe('isIsolatedBlockId', () => {
  it.each([
    ['after a blank line', '| a |\n| - |\n| b |\n\n^tbl\n', true],
    ['after a blank line with CRLF', '| a |\r\n| - |\r\n\r\n^tbl\r\n', true],
    ['directly under a table row', '| a |\n| - |\n| b |\n^tbl\n', false],
    ['inline on a line', 'para ^tbl\n', false],
    ['only inside a fence', '```\n\n^tbl\n```\n', false],
    ['indented as code', 'x\n\n    ^tbl\n', false],
    ['a different id', 'x\n\n^tbl2\n', false],
  ])('reads an id %s as isolated: %s', (_l, content, expected) => {
    expect(isIsolatedBlockId(content, 'tbl')).toBe(expected);
  });
});

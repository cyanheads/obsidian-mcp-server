/**
 * @fileoverview Unit tests for the YAML frontmatter helpers used by the
 * composed manage-frontmatter and manage-tags tools.
 * @module tests/services/frontmatter-ops.test
 */

import { load as yamlLoad } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  deleteFrontmatterKey,
  frontmatterParseError,
  listTagsFromContent,
  reconcileTags,
  splice,
} from '@/services/obsidian/frontmatter-ops.js';

const FM_BLOCK_RE = /^---\n([\s\S]*?)\n---\n?/;
/** Mirrors `FM_RE` in the module under test — consumes the block and its fence terminator, nothing more. */
const FM_SPLICE_RE = /^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/;

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

describe('splice', () => {
  it('separates the frontmatter prefix from the body and reassembles byte-identically', () => {
    const input = '---\ntitle: a\nnested:\n  key: v\n---\n\nBody line.\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.yamlText).toBe('title: a\nnested:\n  key: v');
    expect(s.body).toBe('\nBody line.\n');
    expect(s.raw).toBe('---\ntitle: a\nnested:\n  key: v\n---\n');
    expect(s.open + s.yamlText + s.close).toBe(s.raw);
    expect(s.raw + s.body).toBe(input);
  });

  it('reports no frontmatter for a note that has none', () => {
    const input = '# Heading\n\nBody.\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(false);
    expect(s.raw).toBe('');
    expect(s.yamlText).toBe('');
    expect(s.body).toBe(input);
  });

  it('leaves a `---` sequence inside the body in the body', () => {
    const input = 'Intro paragraph.\n\n---\n\nAfter a horizontal rule.\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(false);
    expect(s.body).toBe(input);
  });

  it('treats an unterminated fence as body text', () => {
    const input = '---\ntitle: a\n\nNo closing fence.\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(false);
    expect(s.body).toBe(input);
  });

  it('splits a CRLF file and reassembles it byte-identically', () => {
    const input = '---\r\ntitle: a\r\n---\r\n\r\nBody.\r\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.yamlText).toBe('title: a');
    expect(s.body).toBe('\r\nBody.\r\n');
    expect(s.raw + s.body).toBe(input);
  });

  it('yields an empty body for a frontmatter-only note', () => {
    const input = '---\ntitle: a\n---\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.body).toBe('');
    expect(s.raw + s.body).toBe(input);
  });

  it('spans the separator newline with the closing fence', () => {
    const s = splice('---\ntitle: Foo\n---\n# Heading Right After\nbody');
    expect(s.open).toBe('---\n');
    expect(s.yamlText).toBe('title: Foo');
    expect(s.close).toBe('\n---\n');
    expect(s.body).toBe('# Heading Right After\nbody');
  });

  it('spans the CRLF separator with the closing fence', () => {
    const s = splice('---\r\ntitle: a\r\n---\r\n\r\nBody.\r\n');
    expect(s.open).toBe('---\r\n');
    expect(s.yamlText).toBe('title: a');
    expect(s.close).toBe('\r\n---\r\n');
  });
});

/**
 * One boundary, shared with the read path in `section-extractor.ts`, matching
 * what Obsidian parses: an opening `---` alone on the first line, a closing
 * `---` starting its own line, and an empty block recognized as a block.
 */
describe('splice / frontmatter boundary', () => {
  it('treats an opening fence carrying trailing whitespace as body', () => {
    const input = '--- \n# Real Heading\n\nBody text.\n---\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(false);
    expect(s.body).toBe(input);
  });

  it('treats a CRLF opening fence carrying trailing whitespace as body', () => {
    const input = '--- \r\n# Real Heading\r\n\r\nBody text.\r\n---\r\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(false);
    expect(s.body).toBe(input);
  });

  it('recognizes an empty properties block', () => {
    const input = '---\n---\n# Heading\nbody ^blk';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.open).toBe('---\n');
    expect(s.yamlText).toBe('');
    expect(s.close).toBe('---\n');
    expect(s.raw).toBe('---\n---\n');
    expect(s.body).toBe('# Heading\nbody ^blk');
    expect(s.open + s.yamlText + s.close).toBe(s.raw);
    expect(s.raw + s.body).toBe(input);
  });

  it('recognizes an empty properties block with CRLF line endings', () => {
    const input = '---\r\n---\r\n# Heading\r\nbody ^blk';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.yamlText).toBe('');
    expect(s.raw).toBe('---\r\n---\r\n');
    expect(s.body).toBe('# Heading\r\nbody ^blk');
    expect(s.open + s.yamlText + s.close).toBe(s.raw);
    expect(s.raw + s.body).toBe(input);
  });

  it('yields an empty body for a note that is nothing but an empty block', () => {
    const input = '---\n---\n';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.yamlText).toBe('');
    expect(s.body).toBe('');
    expect(s.raw + s.body).toBe(input);
  });

  /**
   * Admitting a zero-length YAML span must not make the closing fence's own
   * newline optional — that would let a `---` inside a scalar close the block.
   */
  it('does not close the block at a `---` inside a scalar', () => {
    const input = '---\nkey: a---b\nmore\n---\nbody';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.yamlText).toBe('key: a---b\nmore');
    expect(s.body).toBe('body');
    expect(s.open + s.yamlText + s.close).toBe(s.raw);
  });

  it('keeps a blank first YAML line inside the block rather than closing on it', () => {
    const input = '---\n\ntitle: a\n---\nbody';
    const s = splice(input);
    expect(s.hasFrontmatter).toBe(true);
    expect(s.yamlText).toBe('\ntitle: a');
    expect(s.body).toBe('body');
  });

  it('still treats an unclosed fence as body text', () => {
    const input = '---\n# Heading\nno closing fence here\nbody';
    expect(splice(input).hasFrontmatter).toBe(false);
  });
});

describe('frontmatterParseError', () => {
  it('returns undefined for a well-formed mapping', () => {
    expect(frontmatterParseError('title: a\ntags:\n  - x')).toBeUndefined();
  });

  it('returns undefined for empty YAML', () => {
    expect(frontmatterParseError('')).toBeUndefined();
  });

  it('reports an unquoted colon that breaks a scalar', () => {
    expect(frontmatterParseError('title: MCP Review: v2')).toBeDefined();
  });

  it('reports an unresolvable alias left by a rewritten list marker', () => {
    expect(frontmatterParseError('tags:\n  * alpha')).toBeDefined();
  });

  it('reports YAML that parses to something other than a mapping', () => {
    expect(frontmatterParseError('- a\n- b')).toBeDefined();
  });

  it('reports a truncated scalar left by a stray quote', () => {
    expect(frontmatterParseError('title: "unterminated\nstatus: draft')).toBeDefined();
  });
});

/**
 * The removal site is the only thing an inline tag removal may rewrite. Each
 * construct in the fixture is one the pre-fix segment-wide collapse destroyed:
 * nested list indentation, a four-space indented code block, a trailing
 * two-space hard break, table cell padding, and nested YAML indentation.
 */
describe('reconcileTags / remove inline — byte fidelity', () => {
  const RICH = [
    '---',
    'title: Q3 #wip planning',
    'tags:',
    '  - keepme',
    'nested:',
    '  level1:',
    '    level2: deep',
    '---',
    '',
    '# Plan #wip',
    '',
    'Line with a hard break at the end.  ',
    'Continuation line.',
    '',
    '- Top level',
    '    - Nested child',
    '        - Deeper child',
    '',
    '    indented code block line',
    '    second code line',
    '',
    '| col A | col B |',
    '| ----- | ----- |',
    '| x     | y     |',
    '',
    '```',
    '#wip inside a fence',
    '```',
    '',
    'Trailing #wip mention here.',
    '',
  ].join('\n');

  const EXPECTED = [
    '---',
    'title: Q3 #wip planning',
    'tags:',
    '  - keepme',
    'nested:',
    '  level1:',
    '    level2: deep',
    '---',
    '',
    '# Plan',
    '',
    'Line with a hard break at the end.  ',
    'Continuation line.',
    '',
    '- Top level',
    '    - Nested child',
    '        - Deeper child',
    '',
    '    indented code block line',
    '    second code line',
    '',
    '| col A | col B |',
    '| ----- | ----- |',
    '| x     | y     |',
    '',
    '```',
    '#wip inside a fence',
    '```',
    '',
    'Trailing mention here.',
    '',
  ].join('\n');

  it('rewrites only the removal sites and leaves every other byte alone', () => {
    const r = reconcileTags(RICH, ['wip'], 'remove', 'inline');
    expect(r.applied).toEqual(['wip']);
    expect(r.content).toBe(EXPECTED);
  });

  it('never reaches into the frontmatter block', () => {
    const input = '---\ntitle: Q3 #wip planning\n---\n\nBody #wip here.\n';
    const r = reconcileTags(input, ['wip'], 'remove', 'inline');
    expect(r.content).toBe('---\ntitle: Q3 #wip planning\n---\n\nBody here.\n');
  });

  it('drops the space that preceded the tag rather than the one that followed', () => {
    expect(
      reconcileTags('Mentions #drop and continues.', ['drop'], 'remove', 'inline').content,
    ).toBe('Mentions and continues.');
  });

  it('keeps a hard line break that followed the removed tag', () => {
    expect(reconcileTags('Note #drop  \nnext line\n', ['drop'], 'remove', 'inline').content).toBe(
      'Note  \nnext line\n',
    );
  });

  it('drops the following space when the tag opens the line', () => {
    expect(reconcileTags('#drop leads the line.\n', ['drop'], 'remove', 'inline').content).toBe(
      'leads the line.\n',
    );
  });

  it('keeps the boundary that makes an immediately adjacent tag a tag', () => {
    const r = reconcileTags('Body #drop#keep end', ['drop'], 'remove', 'inline');
    expect(r.content).toBe('Body #keep end');
  });

  /**
   * Taking the space after the tag consumes the left boundary the next
   * occurrence needs to match, so a single scanning pass leaves every second
   * one behind while still reporting the tag as applied.
   */
  it.each([
    ['separated by one space', 'foo #drop #drop bar', 'foo bar'],
    ['separated by one space, three times', '#drop #drop #drop', ''],
    ['immediately adjacent to itself', 'Body #drop#drop end', 'Body end'],
    ['separated by two spaces', 'foo #drop  #drop bar', 'foo  bar'],
  ])('removes every occurrence when %s', (_label, input, expected) => {
    const r = reconcileTags(input, ['drop'], 'remove', 'inline');
    expect(r.content).toBe(expected);
    expect(r.applied).toEqual(['drop']);
  });

  it('leaves the note alone when the only occurrence is inside a fence', () => {
    const input = '```\n#only\n```\n';
    const r = reconcileTags(input, ['only'], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['only']);
    expect(r.content).toBe(input);
  });
});

describe('reconcileTags / add inline — byte fidelity', () => {
  it('appends the tag after the body and leaves the frontmatter alone', () => {
    const input = '---\ntitle: a\nnested:\n  level1:\n    level2: deep\n---\n\nBody line.\n';
    const r = reconcileTags(input, ['fresh'], 'add', 'inline');
    expect(r.content).toBe(
      '---\ntitle: a\nnested:\n  level1:\n    level2: deep\n---\n\nBody line.\n#fresh\n',
    );
  });

  it('does not treat a #tag inside a frontmatter scalar as already present', () => {
    const input = '---\ntitle: Q3 #wip planning\n---\n\nBody.\n';
    const r = reconcileTags(input, ['wip'], 'add', 'inline');
    expect(r.applied).toEqual(['wip']);
    expect(r.content).toBe('---\ntitle: Q3 #wip planning\n---\n\nBody.\n#wip\n');
  });
});

describe('reconcileTags / add inline — separator placement', () => {
  /**
   * Splicing the frontmatter off moved the insertion point, and the separator
   * has to be measured against what precedes it in the finished note rather
   * than against the body alone. Each case pins the exact bytes produced before
   * the splice landed, so a future change to the boundary cannot quietly
   * reformat a note while adding a tag.
   */
  it.each([
    [
      'a note that is nothing but frontmatter',
      '---\nfoo: bar\n---\n',
      '---\nfoo: bar\n---\n#wip\n',
    ],
    ['a wholly empty note', '', '\n#wip\n'],
    [
      'frontmatter followed by a body',
      '---\nfoo: bar\n---\nHello\n',
      '---\nfoo: bar\n---\nHello\n#wip\n',
    ],
    ['a body with no trailing newline', 'Hello', 'Hello\n#wip\n'],
    [
      'a body ending at a closing code fence',
      '---\nfoo: bar\n---\n\nText\n\n```\ncode\n```',
      '---\nfoo: bar\n---\n\nText\n\n```\ncode\n```\n#wip\n',
    ],
    ['a body that is only a fenced block', '```\ncode\n```', '```\ncode\n```\n#wip\n'],
  ])('appends without inserting a blank line: %s', (_label, input, expected) => {
    expect(reconcileTags(input, ['wip'], 'add', 'inline').content).toBe(expected);
  });
});

/**
 * An empty properties block is a block. Reading it as body text made a
 * frontmatter tag add prepend a second block in front of the orphaned fences.
 */
describe('reconcileTags / empty properties block', () => {
  it('adds the tag inside the existing empty block instead of prepending a second one', () => {
    const input = '---\n---\n# Heading\nBody with #atag here.';
    const r = reconcileTags(input, ['newtag'], 'add', 'frontmatter');
    expect(r.applied).toEqual(['newtag']);
    expect(r.content).toBe('---\ntags:\n  - newtag\n---\n# Heading\nBody with #atag here.');
  });

  it('does not read the fences of an empty block as inline body text', () => {
    const r = listTagsFromContent('---\n---\n# Heading\nBody with #atag here.', {});
    expect(r.inline).toEqual(['atag']);
  });

  it('leaves an empty block alone when an inline tag is removed', () => {
    const input = '---\n---\n# Heading\nBody with #atag here.';
    const r = reconcileTags(input, ['atag'], 'remove', 'inline');
    expect(r.content).toBe('---\n---\n# Heading\nBody with here.');
  });
});

describe('listTagsFromContent / frontmatter is not body', () => {
  it('does not report a #token inside a frontmatter scalar as an inline tag', () => {
    const content = '---\ntitle: Q3 #wip planning\ntags:\n  - keepme\n---\n\nBody #real here.\n';
    const r = listTagsFromContent(content, { tags: ['keepme'] });
    expect(r.frontmatter).toEqual(['keepme']);
    expect(r.inline).toEqual(['real']);
  });
});

/**
 * `#` inside a link is link syntax, not a tag: a heading anchor, an alias, or
 * link text. Reading one as a tag makes `list` wrong and `remove` destructive —
 * stripping `Overview` from `[[#Overview & Notes]]` leaves `[[& Notes]]`, with
 * nothing in the file to reconstruct the target from. The whole `[[…]]` /
 * `[…](…)` span is protected, so the result does not depend on what the linked
 * note happens to be named.
 */
describe('listTagsFromContent / link spans are not inline tags', () => {
  it.each([
    ['same-note heading anchor', 'see [[#Overview]] here'],
    ['same-note heading anchor with punctuation', 'see [[#Overview & Notes]] here'],
    ['heading anchor in another note', 'see [[Note#Overview]] here'],
    ['note name ending in punctuation', 'see [[Note (Draft)#Overview]] here'],
    ['note name ending in a non-ASCII character', 'see [[Note✅#Overview]] here'],
    ['wikilink alias text', 'see [[Note#Heading|see #alias]] here'],
    ['embedded wikilink', 'see ![[Note#Overview]] here'],
    ['markdown link text', 'see [Chat #support](https://example.dev) here'],
    ['markdown link text on an angle-bracketed URL', 'see [Chat #support](<a b.md>) here'],
    ['reference-style link text', 'see [Chat #support][chat] here\n\n[chat]: https://example.dev'],
    ['collapsed reference-style link text', 'see [Chat #support][] here'],
    ['block anchor', 'see [[Note#^blockid]] here'],
  ])('reports no inline tag for a %s', (_label, input) => {
    expect(listTagsFromContent(input, {}).inline).toEqual([]);
  });

  it.each([
    ['a tag immediately before a link', '#work [[Note#Heading]] end', ['work']],
    ['a tag immediately after a link', '[[Note#Heading]] #work end', ['work']],
    ['a tag between two links', '[[A#x]] #work [B #y](u) end', ['work']],
    ['a nested tag and a trailing comma', '#a/b and #tag, end', ['a/b', 'tag']],
    ['an unclosed wikilink', 'see [[Note and #work here', ['work']],
    ['a bracketed span that is not a link', 'see [note #work] (not a link)', ['work']],
    ['a bracketed span followed by a spaced label', 'see [note #work] [ref] here', ['work']],
    ['a task list item', '- [ ] #todo item', ['todo']],
  ])('still reports %s', (_label, input, expected) => {
    expect(listTagsFromContent(input, {}).inline).toEqual(expected);
  });

  /**
   * Obsidian documents `\#` as an escaped hashtag — a literal `#` that carries
   * no formatting. A backslash immediately before the `#` is what marks it.
   */
  it.each([
    ['mid-sentence', 'text \\#escaped here'],
    ['at the start of a line', '\\#escaped leads the line'],
  ])('reports no inline tag for an escaped hash %s', (_label, input) => {
    expect(listTagsFromContent(input, {}).inline).toEqual([]);
  });

  /**
   * Obsidian's help documents HTML comments and math spans without claiming its
   * tag index skips them, so a `#tag` in either is still reported. Excluding
   * them would risk a false negative — and a `$…$` span detector would read the
   * gap between two prices as math.
   */
  it.each([
    ['an HTML comment', '<!-- #hidden -->', ['hidden']],
    ['an inline math span', 'value $#x$ end', ['x']],
    ['prose between two dollar amounts', 'costs $5 and $10 for #work', ['work']],
  ])('still reports a tag inside %s', (_label, input, expected) => {
    expect(listTagsFromContent(input, {}).inline).toEqual(expected);
  });

  it.each([
    ['an all-numeric token', '#123'],
    ['a mid-word hash', 'a#b'],
    ['an ATX heading', '# Heading'],
    ['an angle-bracketed URL fragment', '<https://x.dev/#frag>'],
    ['a bare URL fragment', 'see https://x.dev/#frag end'],
  ])('still reports nothing for %s', (_label, input) => {
    expect(listTagsFromContent(input, {}).inline).toEqual([]);
  });
});

describe('reconcileTags / remove inline — link spans', () => {
  it('leaves the note byte-identical and reports the tag skipped', () => {
    const input = 'see [[#Overview & Notes]] here';
    const r = reconcileTags(input, ['Overview'], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['Overview']);
    expect(r.content).toBe(input);
  });

  it.each([
    ['[[#Overview]]', 'see [[#Overview]] here'],
    ['[[Note (Draft)#Overview]]', 'see [[Note (Draft)#Overview]] here'],
    ['[[Note#Heading|see #Overview]]', 'see [[Note#Heading|see #Overview]] here'],
    ['[Chat #Overview](https://example.dev)', 'see [Chat #Overview](https://example.dev) here'],
    ['[Chat #Overview][chat]', 'see [Chat #Overview][chat] here\n\n[chat]: https://example.dev'],
  ])('leaves %s untouched', (_label, input) => {
    const r = reconcileTags(input, ['Overview'], 'remove', 'inline');
    expect(r.content).toBe(input);
    expect(r.skipped).toEqual(['Overview']);
  });

  it('removes a real tag that sits immediately before a link', () => {
    const r = reconcileTags('#work [[Note#Heading]] end', ['work'], 'remove', 'inline');
    expect(r.applied).toEqual(['work']);
    expect(r.content).toBe('[[Note#Heading]] end');
  });

  it('removes a real tag that sits immediately after a link', () => {
    const r = reconcileTags('[[Note#Heading]] #work end', ['work'], 'remove', 'inline');
    expect(r.applied).toEqual(['work']);
    expect(r.content).toBe('[[Note#Heading]] end');
  });

  it('leaves an escaped hash in place and reports the tag skipped', () => {
    const input = 'text \\#drop here';
    const r = reconcileTags(input, ['drop'], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['drop']);
    expect(r.content).toBe(input);
  });

  it('removes a real occurrence while leaving the linked and escaped ones alone', () => {
    const input = 'see [[#drop]] and \\#drop and #drop end';
    const r = reconcileTags(input, ['drop'], 'remove', 'inline');
    expect(r.applied).toEqual(['drop']);
    expect(r.content).toBe('see [[#drop]] and \\#drop and end');
  });
});

describe('reconcileTags / add inline — link spans', () => {
  it('does not treat a heading anchor as the tag already being present', () => {
    const r = reconcileTags('see [[#Overview]] here', ['Overview'], 'add', 'inline');
    expect(r.applied).toEqual(['Overview']);
    expect(r.content).toBe('see [[#Overview]] here\n#Overview\n');
  });

  it('appends after a body that ends at a wikilink without gluing the tag to it', () => {
    expect(reconcileTags('See [[Note]]', ['wip'], 'add', 'inline').content).toBe(
      'See [[Note]]\n#wip\n',
    );
  });
});

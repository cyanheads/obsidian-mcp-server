/**
 * @fileoverview Unit tests for the YAML frontmatter helpers used by the
 * composed manage-frontmatter and manage-tags tools.
 * @module tests/services/frontmatter-ops.test
 */

import { load as yamlLoad } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  deleteFrontmatterKey,
  type FrontmatterEdit,
  frontmatterParseError,
  listTagsFromContent,
  reconcileTags,
  splice,
  type TagLocation,
  type TagOperation,
  type TagReconcileResult,
} from '@/services/obsidian/frontmatter-ops.js';

/**
 * Both mutation helpers return either an edit or the reason they refused. Most
 * cases here are about the edit, so these unwrap it and turn an unexpected
 * refusal into a named failure; the refusals have their own describe below.
 */
function deleteKey(content: string, key: string): string {
  const edit = deleteFrontmatterKey(content, key);
  if (!edit.ok) throw new Error(`expected an edit, got a refusal: ${edit.problem}`);
  return edit.content;
}

function reconcile(
  content: string,
  tags: string[],
  operation: TagOperation,
  location: TagLocation,
): TagReconcileResult {
  const outcome = reconcileTags(content, tags, operation, location);
  if (!outcome.ok) throw new Error(`expected a reconciliation, got a refusal: ${outcome.problem}`);
  return outcome;
}

/** The refusal an unsafe block produces; fails the test when the helper edited instead. */
function refusalOf(edit: FrontmatterEdit): string {
  if (edit.ok) throw new Error(`expected a refusal, got an edit: ${edit.content}`);
  return edit.problem;
}

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
    const out = deleteKey(input, 'title');
    const fm = readFrontmatter(out);
    expect(fm).toEqual({ author: 'casey' });
    expect(out).toContain('Body line.');
  });

  it('returns content unchanged when the key is absent', () => {
    const input = ['---', 'title: Hello', '---', 'body'].join('\n');
    expect(deleteKey(input, 'missing')).toBe(input);
  });

  it('returns content unchanged when there is no frontmatter', () => {
    const input = '# Just a heading\nbody';
    expect(deleteKey(input, 'title')).toBe(input);
  });

  it('strips the entire frontmatter block when the last key is removed', () => {
    const input = ['---', 'tags: [a]', '---', '', 'Body.'].join('\n');
    const out = deleteKey(input, 'tags');
    expect(out.startsWith('---')).toBe(false);
    expect(out).toContain('Body.');
  });
});

describe('reconcileTags / add', () => {
  it('adds a tag to frontmatter when location is "frontmatter"', () => {
    const input = ['---', 'tags: [a]', '---', 'body'].join('\n');
    const r = reconcile(input, ['b'], 'add', 'frontmatter');
    expect(r.applied).toEqual(['b']);
    expect(r.skipped).toEqual([]);
    expect(readFrontmatter(r.content).tags).toEqual(['a', 'b']);
  });

  it('marks an already-present frontmatter tag as skipped', () => {
    const input = ['---', 'tags: [foo]', '---', 'body'].join('\n');
    const r = reconcile(input, ['foo'], 'add', 'frontmatter');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['foo']);
    expect(r.content).toBe(input);
  });

  it('appends an inline #tag when location is "inline"', () => {
    const input = 'Line of body.\n';
    const r = reconcile(input, ['new'], 'add', 'inline');
    expect(r.applied).toEqual(['new']);
    expect(r.content).toContain('#new');
  });

  it('skips an inline tag that already exists', () => {
    const input = 'Talking about #foo here.';
    const r = reconcile(input, ['foo'], 'add', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['foo']);
    expect(r.content).toBe(input);
  });

  it('reconciles both representations when location is "both"', () => {
    const input = ['---', 'tags: [present]', '---', 'Body without inline.'].join('\n');
    const r = reconcile(input, ['present', 'fresh'], 'add', 'both');
    // 'present' was in frontmatter but not inline → applied for the inline side
    expect(r.applied.sort()).toEqual(['fresh', 'present']);
    expect(r.skipped).toEqual([]);
    expect(readFrontmatter(r.content).tags).toEqual(['present', 'fresh']);
    expect(r.content).toContain('#present');
    expect(r.content).toContain('#fresh');
  });

  it('does not consider tags inside fenced code blocks as present', () => {
    const input = '```\n#fake\n```\nBody';
    const r = reconcile(input, ['fake'], 'add', 'inline');
    expect(r.applied).toEqual(['fake']);
    expect(r.content).toContain('#fake\n```'); // original code block intact
  });
});

describe('reconcileTags / remove', () => {
  it('removes a tag from the frontmatter array', () => {
    const input = ['---', 'tags: [a, b, c]', '---', 'body'].join('\n');
    const r = reconcile(input, ['b'], 'remove', 'frontmatter');
    expect(r.applied).toEqual(['b']);
    expect(readFrontmatter(r.content).tags).toEqual(['a', 'c']);
  });

  it('reports an absent tag as skipped', () => {
    const input = ['---', 'tags: [a]', '---', 'body'].join('\n');
    const r = reconcile(input, ['z'], 'remove', 'frontmatter');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['z']);
  });

  it('removes inline #tags when location is "inline"', () => {
    const input = 'Mentions #drop and continues.';
    const r = reconcile(input, ['drop'], 'remove', 'inline');
    expect(r.applied).toEqual(['drop']);
    expect(r.content).not.toContain('#drop');
    expect(r.content).toContain('Mentions');
  });

  it('leaves #tags inside fenced code blocks untouched', () => {
    const input = '```\n#keep\n```\nBody #keep here.';
    const r = reconcile(input, ['keep'], 'remove', 'inline');
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
    const r = reconcile(handAuthored, ['urgent'], 'add', 'frontmatter');
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
    const out = deleteKey(handAuthored, 'priority');
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
    const out = deleteKey(input, 'title');
    expect(out).toBe('---\nkeep: b\n---\n\nBody line one.\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('does not invent a separator when the body starts on the line after the fence', () => {
    const input = '---\ntitle: a\nkeep: b\n---\nBody line one.\n';
    const out = deleteKey(input, 'title');
    expect(out).toBe('---\nkeep: b\n---\nBody line one.\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('preserves every blank line when the body is separated by several', () => {
    const input = '---\ntitle: a\nkeep: b\n---\n\n\n\nBody line one.\n';
    const out = deleteKey(input, 'title');
    expect(bodyOf(out)).toBe('\n\n\nBody line one.\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('preserves a CRLF body verbatim', () => {
    const input = '---\r\ntitle: a\r\nkeep: b\r\n---\r\n\r\nBody line one.\r\n';
    const out = deleteKey(input, 'title');
    expect(bodyOf(out)).toBe('\r\nBody line one.\r\n');
    expect(bodyOf(out)).toBe(bodyOf(input));
  });

  it('leaves an empty body empty', () => {
    const input = '---\ntitle: a\nkeep: b\n---\n';
    const out = deleteKey(input, 'title');
    expect(out).toBe('---\nkeep: b\n---\n');
    expect(bodyOf(out)).toBe('');
  });

  it('keeps the separator when a tag is added at the frontmatter location', () => {
    const input = '---\ntags:\n  - a\n---\n\nBody line one.\n';
    const r = reconcile(input, ['b'], 'add', 'frontmatter');
    expect(readFrontmatter(r.content).tags).toEqual(['a', 'b']);
    expect(bodyOf(r.content)).toBe(bodyOf(input));
  });

  it('keeps the separator when a tag is removed at the frontmatter location', () => {
    const input = '---\ntags:\n  - a\n  - b\n---\n\nBody line one.\n';
    const r = reconcile(input, ['b'], 'remove', 'frontmatter');
    expect(readFrontmatter(r.content).tags).toEqual(['a']);
    expect(bodyOf(r.content)).toBe(bodyOf(input));
  });

  it('preserves a leading blank line when frontmatter is created on a note that had none', () => {
    const input = '\n# Heading\n\nBody line one.\n';
    const r = reconcile(input, ['x'], 'add', 'frontmatter');
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
    const r = reconcile(RICH, ['wip'], 'remove', 'inline');
    expect(r.applied).toEqual(['wip']);
    expect(r.content).toBe(EXPECTED);
  });

  it('never reaches into the frontmatter block', () => {
    const input = '---\ntitle: Q3 #wip planning\n---\n\nBody #wip here.\n';
    const r = reconcile(input, ['wip'], 'remove', 'inline');
    expect(r.content).toBe('---\ntitle: Q3 #wip planning\n---\n\nBody here.\n');
  });

  it('drops the space that preceded the tag rather than the one that followed', () => {
    expect(reconcile('Mentions #drop and continues.', ['drop'], 'remove', 'inline').content).toBe(
      'Mentions and continues.',
    );
  });

  it('keeps a hard line break that followed the removed tag', () => {
    expect(reconcile('Note #drop  \nnext line\n', ['drop'], 'remove', 'inline').content).toBe(
      'Note  \nnext line\n',
    );
  });

  it('drops the following space when the tag opens the line', () => {
    expect(reconcile('#drop leads the line.\n', ['drop'], 'remove', 'inline').content).toBe(
      'leads the line.\n',
    );
  });

  it('keeps the boundary that makes an immediately adjacent tag a tag', () => {
    const r = reconcile('Body #drop#keep end', ['drop'], 'remove', 'inline');
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
    const r = reconcile(input, ['drop'], 'remove', 'inline');
    expect(r.content).toBe(expected);
    expect(r.applied).toEqual(['drop']);
  });

  it('leaves the note alone when the only occurrence is inside a fence', () => {
    const input = '```\n#only\n```\n';
    const r = reconcile(input, ['only'], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['only']);
    expect(r.content).toBe(input);
  });
});

describe('reconcileTags / add inline — byte fidelity', () => {
  it('appends the tag after the body and leaves the frontmatter alone', () => {
    const input = '---\ntitle: a\nnested:\n  level1:\n    level2: deep\n---\n\nBody line.\n';
    const r = reconcile(input, ['fresh'], 'add', 'inline');
    expect(r.content).toBe(
      '---\ntitle: a\nnested:\n  level1:\n    level2: deep\n---\n\nBody line.\n#fresh\n',
    );
  });

  it('does not treat a #tag inside a frontmatter scalar as already present', () => {
    const input = '---\ntitle: Q3 #wip planning\n---\n\nBody.\n';
    const r = reconcile(input, ['wip'], 'add', 'inline');
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
    expect(reconcile(input, ['wip'], 'add', 'inline').content).toBe(expected);
  });
});

/**
 * An empty properties block is a block. Reading it as body text made a
 * frontmatter tag add prepend a second block in front of the orphaned fences.
 */
describe('reconcileTags / empty properties block', () => {
  it('adds the tag inside the existing empty block instead of prepending a second one', () => {
    const input = '---\n---\n# Heading\nBody with #atag here.';
    const r = reconcile(input, ['newtag'], 'add', 'frontmatter');
    expect(r.applied).toEqual(['newtag']);
    expect(r.content).toBe('---\ntags:\n  - newtag\n---\n# Heading\nBody with #atag here.');
  });

  it('does not read the fences of an empty block as inline body text', () => {
    const r = listTagsFromContent('---\n---\n# Heading\nBody with #atag here.', {});
    expect(r.inline).toEqual(['atag']);
  });

  it('leaves an empty block alone when an inline tag is removed', () => {
    const input = '---\n---\n# Heading\nBody with #atag here.';
    const r = reconcile(input, ['atag'], 'remove', 'inline');
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
 * `#` inside a wikilink is link syntax, not a tag: a heading anchor or an
 * alias. Reading one as a tag makes `list` wrong and `remove` destructive —
 * stripping `Overview` from `[[#Overview & Notes]]` leaves `[[& Notes]]`, with
 * nothing in the file to reconstruct the target from. The whole `[[…]]` span
 * is protected, so the result does not depend on what the linked note happens
 * to be named. A markdown link is different: Obsidian reads a tag in its text,
 * and only its destination or label is link syntax (issue #140).
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
    ['block anchor', 'see [[Note#^blockid]] here'],
  ])('reports no inline tag for a %s', (_label, input) => {
    expect(listTagsFromContent(input, {}).inline).toEqual([]);
  });

  it.each([
    ['markdown link text', 'see [Chat #support](https://example.dev) here'],
    ['markdown link text on an angle-bracketed URL', 'see [Chat #support](<a b.md>) here'],
    ['reference-style link text', 'see [Chat #support][chat] here\n\n[chat]: https://example.dev'],
    ['collapsed reference-style link text', 'see [Chat #support][] here'],
  ])('reads the tag in %s', (_label, input) => {
    expect(listTagsFromContent(input, {}).inline).toEqual(['support']);
  });

  it.each([
    ['a tag immediately before a link', '#work [[Note#Heading]] end', ['work']],
    ['a tag immediately after a link', '[[Note#Heading]] #work end', ['work']],
    ['a tag between two links', '[[A#x]] #work [B #y](u) end', ['work', 'y']],
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
   * Obsidian's metadata cache reads no tag inside an HTML comment or a math
   * span. A `$` delimits math only under Obsidian's inline-math rule, so prose
   * between two prices is not math and its tag still counts. Issue #138.
   */
  it.each([
    ['an HTML comment', '<!-- #hidden -->', []],
    ['an inline math span', 'value $#x$ end', []],
    ['prose between two dollar amounts', 'costs $5 and $10 for #work', ['work']],
  ])('reads a tag around %s the way Obsidian does', (_label, input, expected) => {
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

/**
 * Obsidian's inline tag grammar, each expectation read back from Obsidian's own
 * metadata cache (note-JSON `tags`, Obsidian 1.13.7 / Local REST API 5.2.0): a
 * tag runs until whitespace, ASCII punctuation other than `_` `-` `/`, or a
 * character from the General (U+2000–U+206F) or Supplemental (U+2E00–U+2E7F)
 * Punctuation blocks, and needs one character that is not an ASCII digit.
 * Issue #127.
 */
describe("listTagsFromContent / Obsidian's tag grammar", () => {
  it.each([
    [
      'leading digits, non-ASCII letters, CJK, and emoji',
      '#1990s #2024-goals #3d #1984 #café #日本語 #✅done #y1984',
      ['1990s', '2024-goals', '3d', 'café', '日本語', '✅done', 'y1984'],
    ],
    ['the issue repro', 'Plans for #1990s and #café.', ['1990s', 'café']],
    [
      'emoji, CJK, and accents on either side of ASCII',
      '#tag🎉emoji #tag日本語 #日本語tag #café2',
      ['tag🎉emoji', 'tag日本語', '日本語tag', 'café2'],
    ],
    ['digits made valid by - _ /', '#123-456 #12_34 #123/456', ['123-456', '12_34', '123/456']],
    ['a nested tag with a Unicode segment', '#wörk/日本語 end', ['wörk/日本語']],
    [
      'digits outside ASCII, which are not "numeric" to Obsidian',
      '#١٢٣ #１２３ #½ #²³',
      ['١٢٣', '１２３', '½', '²³'],
    ],
    [
      'Latin-1 and symbol characters that continue a tag',
      '#a¡b #c¿d #e─f #g©h #i«j #k§l #m¶n #o°p #q·r #sΩt #u€v #w™x #y→z #aa♥bb #cc×dd',
      [
        'a¡b',
        'c¿d',
        'e─f',
        'g©h',
        'i«j',
        'k§l',
        'm¶n',
        'o°p',
        'q·r',
        'sΩt',
        'u€v',
        'w™x',
        'y→z',
        'aa♥bb',
        'cc×dd',
      ],
    ],
    [
      'combining marks, variation selectors, and a soft hyphen',
      '#ne\u0301e #love❤\ufe0fx #vs\ufe0fy #soft\u00adhy',
      ['ne\u0301e', 'love❤\ufe0fx', 'vs\ufe0fy', 'soft\u00adhy'],
    ],
    [
      'CJK and fullwidth punctuation',
      '#a、b #c。d #e「f #g！h #i～j',
      ['a、b', 'c。d', 'e「f', 'g！h', 'i～j'],
    ],
  ])('reports exactly the tags Obsidian reports: %s', (_label, input, expected) => {
    expect(listTagsFromContent(input, {}).inline).toEqual(expected);
  });

  it.each([
    ['an apostrophe', "#tag' x"],
    ['a bang', '#tag! x'],
    ['an opening paren', '#tag( x'],
    ['a double quote', '#tag" x'],
    ['a semicolon', '#tag; x'],
    ['a tilde', '#tag~ x'],
    ['a period', '#tag. x'],
    ['an em dash', '#tag—dash x'],
    ['an en dash', '#tag–endash x'],
    ['an ellipsis', '#tag…more x'],
    ['a Unicode hyphen (U+2010)', '#tag‐more x'],
    ['a prime (U+2032)', '#tag′more x'],
    ['an undertie (U+203F)', '#tag‿more x'],
    ['a zero-width space', '#tag\u200bmore x'],
    ['a zero-width joiner', '#tag\u200dmore x'],
    ['a supplemental-punctuation mark (U+2E2E)', '#tag⸮more x'],
    ['a no-break space', '#tag\u00a0more x'],
    ['a byte-order mark', '#tag\ufeffmore x'],
    ['an ideographic space', '#tag\u3000more x'],
  ])('ends a tag at %s', (_label, input) => {
    expect(listTagsFromContent(input, {}).inline).toEqual(['tag']);
  });

  it('ends a tag inside a ZWJ emoji sequence, at the joiner', () => {
    expect(listTagsFromContent('#x👨\u200d👩\u200d👧 end', {}).inline).toEqual(['x👨']);
  });

  it.each([
    ['an all-digit tag', '#123 and #1984'],
    ['a non-ASCII letter before the hash', 'café#tag'],
    ['a CJK letter before the hash', '日本#tag'],
    ['an emoji before the hash', '✅#tag'],
    ['a digit before the hash', '1#tag'],
    ['an underscore before the hash', '_#tag'],
    ['a hyphen before the hash', 'a -#tag b'],
    ['a slash before the hash', 'a /#tag b'],
  ])('reports nothing for %s', (_label, input) => {
    expect(listTagsFromContent(input, {}).inline).toEqual([]);
  });
});

describe("reconcileTags / inline — Obsidian's tag grammar", () => {
  it('removes a non-ASCII tag and only that tag', () => {
    const r = reconcile('Plans for #café.', ['café'], 'remove', 'inline');
    expect(r.applied).toEqual(['café']);
    expect(r.skipped).toEqual([]);
    // #111's rule: the tag goes with exactly one adjacent space.
    expect(r.content).toBe('Plans for.');
  });

  it.each([
    ['a leading-digit tag', 'Plans for #1990s and #café.', '1990s', 'Plans for and #café.'],
    ['a CJK tag', 'a #日本語 b #日本語tag', '日本語', 'a b #日本語tag'],
    ['an emoji tag', 'done: #✅done, next', '✅done', 'done:, next'],
    ['a digits-plus-separator tag', 'see #123-456 end', '123-456', 'see end'],
  ])('removes %s without touching its neighbours', (_label, input, tag, expected) => {
    const r = reconcile(input, [tag], 'remove', 'inline');
    expect(r.applied).toEqual([tag]);
    expect(r.content).toBe(expected);
  });

  it.each([
    ['a prefix ending before a non-ASCII letter', '#café here', 'caf'],
    ['a prefix ending before a CJK letter', '#tag日本語 here', 'tag'],
    ['a prefix ending before an emoji', '#tag🎉emoji here', 'tag'],
    ['a prefix ending before a combining mark', '#ne\u0301e here', 'ne'],
  ])('leaves a longer tag alone when removing %s', (_label, input, tag) => {
    const r = reconcile(input, [tag], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual([tag]);
    expect(r.content).toBe(input);
  });

  it('leaves an all-digit hash in place on a removal, as list does not report it', () => {
    const input = 'year #1984 here and #1984s\n';
    const r = reconcile(input, ['1984'], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['1984']);
    expect(r.content).toBe(input);
  });

  it('removes a tag that Unicode punctuation ends', () => {
    const r = reconcile('#tag— dash and #tag… trail', ['tag'], 'remove', 'inline');
    expect(r.content).toBe('— dash and… trail');
  });

  it('adds a tag whose longer relative is the only one present', () => {
    const r = reconcile('Body #café\n', ['caf'], 'add', 'inline');
    expect(r.applied).toEqual(['caf']);
    expect(r.content).toBe('Body #café\n#caf\n');
  });

  it('skips adding a non-ASCII tag that is already present', () => {
    const r = reconcile('Body #café.\n', ['café'], 'add', 'inline');
    expect(r.skipped).toEqual(['café']);
    expect(r.content).toBe('Body #café.\n');
  });
});

/**
 * Where Obsidian reads an inline tag at all: after line start, whitespace, or
 * markup it parses as a node of its own, and never inside an HTML comment or
 * math. Every expectation is
 * Obsidian's own metadata-cache readback (Obsidian 1.13.7, Local REST API
 * 5.2.0) for the exact input; each `#xx` in an input is a distinct probe tag.
 * Issue #138.
 */
describe('inline tags — boundary, HTML comments, and math (Obsidian readback)', () => {
  const NBSP = String.fromCodePoint(0xa0);
  const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
  const EM_SPACE = String.fromCodePoint(0x2003);
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

  /** The #138 table, row by row. */
  const TABLE: Array<[string, string, string[]]> = [
    ['punctuation before the hash', '(#pa) $#pb$ "#pc" .#pd x—#pe', []],
    ['a tab before the hash', 'a\n\t#pf', ['pf']],
    ['a space inside brackets', '[x #ph]', ['ph']],
    ['a no-break space before the hash', `a${NBSP}#qi`, ['qi']],
    ['an ideographic space before the hash', `a${IDEOGRAPHIC_SPACE}#qj`, ['qj']],
    ['an inline HTML comment', 'a <!-- #qa --> b', []],
    ['a multi-line HTML block', '<!--\n#qb\n-->', []],
    ['an inline comment spanning lines', 'z #qe <!-- #qf\nstill #qg -->\nafter #qh', ['qe', 'qh']],
    ['the rest of a line that opens an HTML block', '<!-- a --> #rd', []],
    ['inline math', 'm $a #ra b$ n', []],
    ['inline display-style math', 'x $$ #rb $$ y', []],
    ['a display math block', '$$\n#qd\n$$', []],
    ['a space after the opening dollar', 'm $ #qc $ n', ['qc']],
    ['prose between two prices', 'cost $5 and #rc for $10', ['rc']],
    ['an Obsidian comment', '%% #rf %%', ['rf']],
  ];

  /** Obsidian's inline-math delimiter rule, pinned by further live probes. */
  const MATH: Array<[string, string, string[]]> = [
    ['a closing dollar after a space', 'a $b #mb c $ d', ['mb']],
    ['a closing dollar after a tab', 'a $b #tb c\t$ d', ['tb']],
    ['a closing dollar before a digit', 'a $b #mc c$5 d', ['mc']],
    ['a later closer past a digit-followed one', 'a $b #tj c$1 d$ e', []],
    ['a closing dollar before a letter', 'a $b #md c$x d', []],
    ['a closing dollar before punctuation', 'a $b #nc c$, d', []],
    ['an escaped opening dollar', 'a \\$b #me c$ d', ['me']],
    ['an escaped backslash before the opener', 'a \\\\$b #tk c$ d', []],
    ['an escaped dollar inside the span', 'a $b #mf c\\$ d$ e', []],
    ['an opening dollar before a tab', 'a $\t#ta c$ d', ['ta']],
    ['an opening dollar before a newline', 'a $\n#tc c$ d', []],
    ['an opening dollar before a no-break space', `a $${NBSP}#tt c$ d`, []],
    ['a closing dollar after a newline', 'a $b #td\n$ d', []],
    ['an opener glued to a word', 'a$b #mx c$ d', []],
    ['a closer skipped because a space precedes it', 'a $b $c #th d$ e', []],
    ['a tag between two math spans', 'a $b$c #ti d$ e', ['ti']],
    ['a line break inside the span', 'a $b\n#mg c$ d', []],
    ['an empty line inside the span', 'a $b\n\n#mh c$ d', ['mh']],
    ['a spaces-only line inside the span', 'a $b\n  \n#sa c$ d', ['sa']],
    ['a tab-only line inside the span', 'a $b\n\t\n#uc c$ d', []],
    ['an unclosed dollar', 'a $b #mq c', ['mq']],
    ['two prices', 'a $5 and $6 #ml', ['ml']],
    ['inline double dollars', 'a $$b #mi c$$ d', []],
    ['double dollars before a digit', 'a $$b #ud c$$5 d', []],
    ['double dollars across an empty line', 'a $$b\n\n#te c$$ d', ['te']],
    ['double dollars across a line break', 'a $$b\n#sg c$$ d #sh', ['sh']],
    ['a tag between double-dollar pairs', 'a $$ b $$ #sz $$ c', ['sz']],
    ['unclosed inline double dollars', 'a $$b #mr c\n\nlater #ms', ['mr', 'ms']],
    ['a display block across an empty line', '$$\nb\n\n#tf\n$$\nafter #tg', ['tg']],
    ['an unclosed display block', '$$ #na\n\nlater #nb', []],
    ['an indented unclosed display block', '  $$ #tl\n\nlater #tm', []],
    ['double dollars closed on their own line', '$$a$$ #tn', ['tn']],
    ['pairs on a line that opens with double dollars', '$$ a $$ b $$ #ra\nnext #rb', ['ra', 'rb']],
    ['a display block whose closer is not alone on its line', '$$\na\nb$$ #tq\nnext #tr', []],
    ['a display closer followed by text', '$$\na\n$$ #sd\nnext #se', []],
    ['an indented display closer', '$$\na\n  $$\nafter #sf', ['sf']],
    ['a tab-indented display closer', '$$\na\n\t$$\nafter #st', ['st']],
    ['a single dollar opening after unclosed double dollars', 'a $$b #xa c$ d', []],
    ['a closer followed by more dollars', 'a $b #xb c$$$ d', []],
    ['a CRLF line break after the span', 'a $b #xc c$\r\nd #xd', ['xd']],
    ['a CRLF empty line inside the span', 'a $b\r\n\r\n#xh c$ d', ['xh']],
    ['a CRLF display block', '$$\r\n#xf\r\n$$\r\nafter #xg', ['xg']],
  ];

  const HTML: Array<[string, string, string[]]> = [
    ['a tag after an inline comment', 'a <!-- x --> #hj', ['hj']],
    ['a tag before an inline comment', 'x #hn <!-- y -->', ['hn']],
    ['an inline comment across an empty line', 'a <!-- x\n\n#he --> b', ['he']],
    ['an inline comment across a spaces-only line', 'a <!-- x\n  \n#ui --> b', ['ui']],
    ['an inline comment across a tab-only line', 'a <!-- x\n\t\n#sb --> b', []],
    ['an unclosed inline comment', 'a <!-- #hf unclosed\n\nlater #hg', ['hf', 'hg']],
    ['a comment opened by <!-->', 'a <!--> #hk --> b', ['hk']],
    ['a comment opened by <!--->', 'a <!---> #hl --> b', ['hl']],
    ['a comment containing a double hyphen', 'a <!-- x -- y #hm --> b', ['hm']],
    ['text after the first closer', 'a <!-- b --> c --> #um', ['um']],
    ['comments with leading hyphens', 'a <!-- -x --> #up <!--- x --> #uq', ['up', 'uq']],
    ['an indented HTML block', '   <!-- a --> #ha', []],
    ['an HTML block interrupting a paragraph', 'para\n<!-- a --> #hb', []],
    ['the rest of the line that closes an HTML block', '<!--\nx\n--> #hc', []],
    ['the line after an HTML block', '<!--\nx\n-->\n#hd', ['hd']],
    ['an unclosed HTML block', '<!-- #hh unclosed block\n\nlater #hi', []],
    ['the line after a one-line HTML block', '<!-- a --> b\nc #ho', ['ho']],
    ['an HTML block in a list item', '- <!-- a --> #hq', []],
    ['an HTML block in a blockquote', '> <!-- a --> #hr', []],
    ['an HTML block in an ordered list item', '1. <!-- a --> #uk', []],
    ['an HTML block in a quoted list item', '* > <!-- a --> #ul', []],
    ['an unspaced HTML block', '<!--a--> #ht', []],
    ['an HTML block across an empty line', '<!--\n#uf\n\n#ug\n-->\nafter #uh', ['uh']],
    ['two consecutive HTML blocks', '<!-- a\n--> b\n<!-- c --> #un', []],
    ['an inline comment across a CRLF empty line', 'a <!-- b\r\n\r\n#xe --> c', ['xe']],
  ];

  const MIXED: Array<[string, string, string[]]> = [
    ['math that opens before a comment', 'a $b <!-- #sl c$ d --> #sm', ['sm']],
    ['a comment that opens before math', 'a <!-- $b --> #sn c$', ['sn']],
    ['math whose closer sits inside a comment', 'a $b <!-- c$ #so -->', ['so']],
    ['dollars inside code spans', 'a `$` #mt `$` b', ['mt']],
    ['a tag glued to a wikilink', '[[x]]#ba', ['ba']],
    ['a tag glued to a code span', '`c`#bb', ['bb']],
    ['a tag glued to a comment', 'a <!-- x -->#bc', ['bc']],
    ['a tag glued to math', 'a $x$#bd', ['bd']],
    ['an Obsidian comment block', '%%\n#be\n%%', ['be']],
    ['an em space before the hash', `a${EM_SPACE}#bf`, ['bf']],
    ['a zero-width space before the hash', `a${ZERO_WIDTH_SPACE}#bg`, []],
  ];

  /**
   * Markup Obsidian parses as its own node, after which a `#` opens a tag even
   * with no whitespace before it — and the same characters as plain text,
   * after which it does not.
   */
  const MARKUP: Array<[string, string, string[]]> = [
    ['bold', 'x **#ua** y', ['ua']],
    ['italic', 'x *#ub* y', ['ub']],
    ['bold italic', 'x ***#ug*** y', ['ug']],
    ['strikethrough', 'x ~~#ue~~ y', ['ue']],
    ['a highlight', 'x ==#uf== y', ['uf']],
    ['bold glued to a word', 'a**#uh**', ['uh']],
    ['a tag right after closing bold', '**x**#ui y', ['ui']],
    ['italic that closes later on the line', 'a *#wj b* c', ['wj']],
    ['italic that opened earlier on the line', '*a b*#wk c', ['wk']],
    ['emphasis inside a word', 'foo*#wy*bar', ['wy']],
    ['an unpartnered star', 'a *#wb b', []],
    ['an unpartnered double star', 'a **#ww b', []],
    ['a single tilde pair', 'a ~#wf~ b', []],
    ['unpartnered tildes', 'a ~~#wg b', []],
    ['unpartnered equals signs', 'a ==#wh b', []],
    ['intraword underscores', 'a_#wd_b', []],
    ['a blockquote marker', '>#uk', ['uk']],
    ['nested blockquote markers', '> >#wl', ['wl']],
    ['an indented blockquote marker', '  >#wm', ['wm']],
    ['a greater-than sign mid-line', 'x >#yb y', []],
    ['a pipe outside a table', '|not a table #wx and |#wp', ['wx']],
    ['a padded table cell', '| a | b |\n|---|---|\n| #up | x |', ['up']],
    ['an escaped bracket', 'a \\]#ta b', ['ta']],
    ['an escaped star', 'a \\*#tb b', ['tb']],
    ['an escaped parenthesis', 'a \\(#tc b', ['tc']],
    ['an escaped backslash', 'a \\\\#td b', ['td']],
    ['an escaped underscore', 'x\\_#te', ['te']],
    ['escaped brackets around emphasis', 'must return a \\[ _transform_\\]#tz) given', ['tz']],
    ['an escaped hash', 'x \\#vb', []],
    ['an escaped backslash, then an escaped hash', 'x \\\\\\#vc', []],
    ['a backslash before a non-ASCII mark', 'x \\—#va', []],
    ['a line break element', 'line<br>#uw', ['uw']],
    ['a self-closing line break', 'a <br/>#uy', ['uy']],
    ['an inline span', 'text <span>#tq</span> more', ['tq']],
    ['a closing span', '<span>x</span>#ux', ['ux']],
    ['a bold element', 'x <b>#wq</b> y', ['wq']],
    ['an anchor element with an attribute', 'x <a href="u">#wr</a> y', ['wr']],
    ['a quoted attribute value holding a hash', '<a href="u #ea">y</a>', []],
    ['an unquoted attribute value holding a hash', '<a href=u#eb>y</a>', []],
    ['a tag right after an element with an attribute', '<a href=x>#ec y', ['ec']],
    ['a self-closing element with an attribute', '<b class="x" />#ee', ['ee']],
    ['a word in angle brackets before a hash', 'x <a b #ta> y', ['ta']],
    ['a sentence in angle brackets', '<Real occurrence Complements #tc.>', ['tc']],
    ['a hash after an attribute value', 'x <a b=c #tf> y', ['tf']],
    ['attribute-like text in a closing tag', 'x </a #ed> y', ['ed']],
    [
      'the four paragraphs of issue #144',
      'x <a b #ta> y\n\n<Real occurrence Complements #tc.>\n\nx <a b=c #tf> y\n\nx <span>#td</span> y',
      ['ta', 'tc', 'tf', 'td'],
    ],
    ['an attribute glued to a quoted value', 'x <a b="c"d>#tg y', []],
    ['a single-quoted attribute value holding a hash', "x <a b='#th'>y</a>", []],
    ['spaces around an attribute equals sign', 'x <a b = "c">#ti y', ['ti']],
    ['attribute names opening with a colon and an underscore', 'x <a :b _c>#tj y', ['tj']],
    ['an open tag across a line ending', 'x <a\nb="c">#tk y', ['tk']],
    ['a closing tag across a line ending', 'x </a\n>#tl y', ['tl']],
    ['a quoted attribute value across a line ending', 'x <a b="c\nd">#tm y', ['tm']],
    ['a backtick-quoted attribute value', 'x <a b=`c`>#tn y', []],
    ['an equals sign with no value', 'x <a b= >#to y', []],
    ['a tag name with digits and a hyphen', 'x <a1-b>#tp y', ['tp']],
    ['a self-closing tag glued to its attribute', 'x <a b/>#tq y', ['tq']],
    ['a closing tag with a space before the bracket', 'x </a >#tr y', ['tr']],
    ['a self-closing tag glued to a quoted value', 'x <a b="c"/>#ts y', ['ts']],
    ['a less-than heart', 'i <3#wt', []],
    ['a character entity', 'a &amp;#uz', []],
  ];

  const ROWS = [...TABLE, ...MATH, ...HTML, ...MIXED, ...MARKUP];
  const probeTags = (input: string) =>
    [...input.matchAll(/#([a-z]{2})(?![a-z])/g)].map((m) => m[1] ?? '');

  it.each(ROWS)('list reads %s as Obsidian does', (_label, input, expected) => {
    expect(listTagsFromContent(input, {}).inline).toEqual(expected);
  });

  it.each(ROWS)('remove reaches exactly the tags Obsidian reads: %s', (_label, input, expected) => {
    for (const tag of probeTags(input)) {
      const r = reconcile(input, [tag], 'remove', 'inline');
      if (expected.includes(tag)) {
        expect(r.applied, tag).toEqual([tag]);
        expect(
          [` #${tag}`, `#${tag} `, `\t#${tag}`, `#${tag}`].map((s) => input.replace(s, '')),
          tag,
        ).toContain(r.content);
        expect(listTagsFromContent(r.content, {}).inline, tag).toEqual(
          expected.filter((t) => t !== tag),
        );
      } else {
        expect(r.applied, tag).toEqual([]);
        expect(r.skipped, tag).toEqual([tag]);
        expect(r.content, tag).toBe(input);
      }
    }
  });

  it('adds a tag whose only occurrence is inside a comment or math', () => {
    const input = 'a <!-- #wip --> b $#wip$ c\n';
    const r = reconcile(input, ['wip'], 'add', 'inline');
    expect(r.applied).toEqual(['wip']);
    expect(r.content).toBe(`${input}#wip\n`);
  });

  it('removes a real tag beside a comment and math without touching either', () => {
    const input = 'keep <!-- #wip --> and $#wip$ but #wip goes\n';
    const r = reconcile(input, ['wip'], 'remove', 'inline');
    expect(r.applied).toEqual(['wip']);
    expect(r.content).toBe('keep <!-- #wip --> and $#wip$ but goes\n');
  });

  /**
   * The HTML-block prefix test walks back over quote and list markers before
   * `<!--`. Whitespace after a marker must belong to exactly one marker, or a
   * line of markers that fails to reach line start backtracks exponentially.
   */
  it.each([
    ['blockquote markers', '\t>'],
    ['list markers', '\t-\t'],
    ['tab-separated list markers', '\t\t*'],
  ])('scans a long run of %s before a comment in linear time', (_label, marker) => {
    const input = `a${marker.repeat(30)}\t<!-- #xy --> #xz`;
    expect(listTagsFromContent(input, {}).inline).toEqual(['xz']);
  });

  /**
   * A `$` that opens inline math takes the first valid closer after it, and
   * which `$` signs are valid closers does not depend on the opener, so a
   * paragraph whose `$` signs never close must not be rescanned from each one.
   */
  it.each([
    ['unclosed openers', 'x $a ', []],
    ['prices', 'cost $5 and #rc for $10 ', ['rc']],
  ])('scans a paragraph of %s in linear time', (_label, unit, expected) => {
    expect(listTagsFromContent(unit.repeat(40_000), {}).inline).toEqual(expected);
  });
});

describe('reconcileTags / remove inline — link spans', () => {
  it('leaves the note byte-identical and reports the tag skipped', () => {
    const input = 'see [[#Overview & Notes]] here';
    const r = reconcile(input, ['Overview'], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['Overview']);
    expect(r.content).toBe(input);
  });

  it.each([
    ['[[#Overview]]', 'see [[#Overview]] here'],
    ['[[Note (Draft)#Overview]]', 'see [[Note (Draft)#Overview]] here'],
    ['[[Note#Heading|see #Overview]]', 'see [[Note#Heading|see #Overview]] here'],
  ])('leaves %s untouched', (_label, input) => {
    const r = reconcile(input, ['Overview'], 'remove', 'inline');
    expect(r.content).toBe(input);
    expect(r.skipped).toEqual(['Overview']);
  });

  it.each([
    [
      '[Chat #Overview](https://example.dev)',
      'see [Chat #Overview](https://example.dev) here',
      'see [Chat](https://example.dev) here',
    ],
    [
      '[Chat #Overview][chat]',
      'see [Chat #Overview][chat] here\n\n[chat]: https://example.dev',
      'see [Chat][chat] here\n\n[chat]: https://example.dev',
    ],
  ])('removes the tag in the text of %s and leaves the link intact', (_label, input, expected) => {
    const r = reconcile(input, ['Overview'], 'remove', 'inline');
    expect(r.content).toBe(expected);
    expect(r.applied).toEqual(['Overview']);
  });

  it('removes a real tag that sits immediately before a link', () => {
    const r = reconcile('#work [[Note#Heading]] end', ['work'], 'remove', 'inline');
    expect(r.applied).toEqual(['work']);
    expect(r.content).toBe('[[Note#Heading]] end');
  });

  it('removes a real tag that sits immediately after a link', () => {
    const r = reconcile('[[Note#Heading]] #work end', ['work'], 'remove', 'inline');
    expect(r.applied).toEqual(['work']);
    expect(r.content).toBe('[[Note#Heading]] end');
  });

  it('leaves an escaped hash in place and reports the tag skipped', () => {
    const input = 'text \\#drop here';
    const r = reconcile(input, ['drop'], 'remove', 'inline');
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['drop']);
    expect(r.content).toBe(input);
  });

  it('removes a real occurrence while leaving the linked and escaped ones alone', () => {
    const input = 'see [[#drop]] and \\#drop and #drop end';
    const r = reconcile(input, ['drop'], 'remove', 'inline');
    expect(r.applied).toEqual(['drop']);
    expect(r.content).toBe('see [[#drop]] and \\#drop and end');
  });
});

describe('reconcileTags / add inline — link spans', () => {
  it('does not treat a heading anchor as the tag already being present', () => {
    const r = reconcile('see [[#Overview]] here', ['Overview'], 'add', 'inline');
    expect(r.applied).toEqual(['Overview']);
    expect(r.content).toBe('see [[#Overview]] here\n#Overview\n');
  });

  it('appends after a body that ends at a wikilink without gluing the tag to it', () => {
    expect(reconcile('See [[Note]]', ['wip'], 'add', 'inline').content).toBe(
      'See [[Note]]\n#wip\n',
    );
  });
});

/**
 * Issues #123 and #124. Both helpers back a read-modify-write, so a block they
 * cannot re-emit faithfully has to come back as a refusal rather than a
 * best-effort rewrite: the alternative is a PUT that drops properties the
 * caller never named, or a bare `-32603` from the emitter.
 */
describe('mutation helpers refuse a block they cannot re-emit', () => {
  const UNPARSEABLE = '---\na: "unterminated\nkeep: yes\n---\nBody\n';
  const SCALAR_ROOT = '---\nParagraph between rules\n---\nBody after';
  const DANGLING_ALIAS = '---\nbad: *missing\nvictim: delete-me\n---\nbody';
  const ANCHOR_OWNER = '---\nbase: &base\n  kept: yes\nconsumer: *base\n---\nbody';

  it.each([
    ['YAML that does not parse', UNPARSEABLE, 'a'],
    ['a non-mapping YAML root', SCALAR_ROOT, 'anything'],
    ['an alias with no anchor', DANGLING_ALIAS, 'victim'],
    ['a delete that would orphan an alias', ANCHOR_OWNER, 'base'],
  ])('deleteFrontmatterKey refuses on %s', (_label, content, key) => {
    expect(refusalOf(deleteFrontmatterKey(content, key)).length).toBeGreaterThan(0);
  });

  it.each([
    ['YAML that does not parse', UNPARSEABLE],
    ['a non-mapping YAML root', SCALAR_ROOT],
    ['an alias with no anchor', DANGLING_ALIAS],
  ])('reconcileTags refuses a frontmatter add on %s', (_label, content) => {
    const outcome = reconcileTags(content, ['added'], 'add', 'frontmatter');
    expect(outcome.ok).toBe(false);
  });

  /**
   * The frontmatter half runs first, so refusing there is what keeps the body
   * from being tagged on its own — a `both` call is one operation, not two.
   */
  it('refuses the whole "both" operation rather than applying the inline half', () => {
    const outcome = reconcileTags(SCALAR_ROOT, ['added'], 'add', 'both');
    expect(outcome.ok).toBe(false);
  });

  it('still edits a block that parses, alias and all, when nothing is orphaned', () => {
    const anchored = '---\nbase: &base\n  kept: yes\nconsumer: *base\nspare: drop-me\n---\nbody';
    expect(deleteKey(anchored, 'spare')).not.toContain('spare');
  });

  it('frontmatterParseError reports an alias the emitter cannot resolve', () => {
    expect(frontmatterParseError('bad: *missing\nkeep: yes')).toBeDefined();
  });
});

/**
 * Issue #123 1b. `tags:` is free-form YAML. Replacing the node wholesale
 * discarded every entry the normalizer did not recognize as a string tag —
 * silently, on a write. The sequence is edited in place instead.
 */
describe('reconcileTags / frontmatter — a tags sequence is edited in place', () => {
  const MIXED = [
    '---',
    'tags:',
    '  - keep # trailing comment',
    "  - 'quoted'",
    '  - 42',
    '  - { meta: preserved }',
    'other: yes',
    '---',
    'body',
  ].join('\n');

  it('appends a new tag and leaves every other entry byte-identical', () => {
    const r = reconcile(MIXED, ['added'], 'add', 'frontmatter');

    expect(r.applied).toEqual(['added']);
    expect(r.content).toContain('- keep # trailing comment');
    expect(r.content).toContain("- 'quoted'");
    expect(r.content).toContain('- 42');
    expect(r.content).toContain('- { meta: preserved }');
    expect(r.content).toContain('- added');
    expect(r.content).toContain('other: yes');
  });

  it('removes only the matching string item', () => {
    const r = reconcile(MIXED, ['keep'], 'remove', 'frontmatter');

    expect(r.applied).toEqual(['keep']);
    expect(r.content).not.toContain('- keep');
    expect(r.content).toContain('- 42');
    expect(r.content).toContain('- { meta: preserved }');
  });

  it('keeps the key when a removal leaves only entries that are not string tags', () => {
    const r = reconcile(
      '---\ntags:\n  - keep\n  - 42\n---\nbody',
      ['keep'],
      'remove',
      'frontmatter',
    );

    expect(r.content).toContain('tags:');
    expect(r.content).toContain('- 42');
  });

  it('drops the key when the removal empties the sequence', () => {
    const r = reconcile(
      '---\ntags:\n  - only\nkeep: yes\n---\nbody',
      ['only'],
      'remove',
      'frontmatter',
    );

    expect(r.content).not.toContain('tags:');
    expect(r.content).toContain('keep: yes');
  });

  it('reports a tag already in the sequence as skipped and writes nothing new', () => {
    const input = '---\ntags:\n  - keep\n  - 42\n---\nbody';
    const r = reconcile(input, ['keep'], 'add', 'frontmatter');

    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(['keep']);
    expect(r.content).toBe(input);
  });
});

/**
 * The two shapes with no sequence node to edit. Pinned as they behaved before
 * the in-place path existed: both are rewritten as a fresh block sequence.
 */
describe('reconcileTags / frontmatter — the shapes with no sequence to edit', () => {
  it('converts a space-separated string value to a block sequence on add', () => {
    expect(
      reconcile('---\ntags: alpha beta\n---\nbody', ['gamma'], 'add', 'frontmatter').content,
    ).toBe('---\ntags:\n  - alpha\n  - beta\n  - gamma\n---\nbody');
  });

  it('converts a comma-separated string value the same way', () => {
    expect(reconcile('---\ntags: a, b\n---\nbody', ['c'], 'add', 'frontmatter').content).toBe(
      '---\ntags:\n  - a\n  - b\n  - c\n---\nbody',
    );
  });

  it('removes from a string value, keeping the survivors as a sequence', () => {
    expect(
      reconcile('---\ntags: alpha beta\n---\nbody', ['alpha'], 'remove', 'frontmatter').content,
    ).toBe('---\ntags:\n  - beta\n---\nbody');
  });

  it('drops the whole block when a string value loses its only tag', () => {
    expect(
      reconcile('---\ntags: alpha\n---\nbody', ['alpha'], 'remove', 'frontmatter').content,
    ).toBe('body');
  });

  it('creates the key on a note that has frontmatter but no tags', () => {
    expect(reconcile('---\ntitle: x\n---\nbody', ['n'], 'add', 'frontmatter').content).toBe(
      '---\ntitle: x\ntags:\n  - n\n---\nbody',
    );
  });
});

/**
 * Issue #125 3a. `doc.toString()` emits LF whatever it parsed, and the fences
 * were hard-coded to LF, so a CRLF note came back with an LF block above a
 * CRLF body.
 */
describe('serializeFrontmatter / the block keeps its own line ending', () => {
  it('re-emits an existing CRLF block as CRLF, fences included', () => {
    const input = '---\r\ntitle: a\r\ntags:\r\n  - x\r\n---\r\n\r\nBody.\r\n';
    const out = reconcile(input, ['y'], 'add', 'frontmatter').content;

    expect(out).toBe('---\r\ntitle: a\r\ntags:\r\n  - x\r\n  - y\r\n---\r\n\r\nBody.\r\n');
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it('re-emits an existing CRLF block as CRLF on a delete', () => {
    const input = '---\r\ntitle: a\r\nkeep: b\r\n---\r\n\r\nBody line one.\r\n';
    expect(deleteKey(input, 'title')).toBe('---\r\nkeep: b\r\n---\r\n\r\nBody line one.\r\n');
  });

  it('follows the body when creating a block on a CRLF note that had none', () => {
    const out = reconcile('# Heading\r\n\r\nBody.\r\n', ['x'], 'add', 'frontmatter').content;

    expect(out).toBe('---\r\ntags:\r\n  - x\r\n---\r\n# Heading\r\n\r\nBody.\r\n');
  });

  it('stays LF on an LF note that had no block', () => {
    const out = reconcile('# Heading\n\nBody.\n', ['x'], 'add', 'frontmatter').content;

    expect(out).toBe('---\ntags:\n  - x\n---\n# Heading\n\nBody.\n');
  });
});

/**
 * Issue #125 3b. Dropping the block takes the whitespace-only separator lines
 * with it and nothing else — the first content line's own indentation is
 * content.
 */
describe('serializeFrontmatter / dropping the block spares body indentation', () => {
  it.each([
    [
      'an indented code block',
      '---\ntags: [a]\n---\n\n    indented code line\n    second line\n',
      '    indented code line\n    second line\n',
    ],
    ['a nested list item', '---\ntags: [a]\n---\n\n\n  - nested item\n', '  - nested item\n'],
    ['no separator at all', '---\ntags: [a]\n---\n    keep me\n', '    keep me\n'],
    ['CRLF separators', '---\r\ntags: [a]\r\n---\r\n\r\n    indented\r\n', '    indented\r\n'],
  ])('keeps the leading whitespace of the first content line — %s', (_label, input, expected) => {
    expect(deleteKey(input, 'tags')).toBe(expected);
  });
});

/** Rows of `[label, note body, the tags Obsidian reads]`. */
type Readback = Array<[string, string, string[]]>;

/**
 * Pin rows of Obsidian's own metadata-cache readback (note-JSON `tags`,
 * Obsidian 1.13.7 / Local REST API 5.2.0) through both paths: `list` reports
 * exactly the tags Obsidian reads, and `remove` reaches exactly those — each
 * goes with at most one adjacent space and is gone from a second `list`, while
 * every other `#xx` probe leaves the note byte-identical.
 */
function describeReadback(title: string, rows: Readback): void {
  describe(title, () => {
    it.each(rows)('list reads %s as Obsidian does', (_label, input, expected) => {
      expect(listTagsFromContent(input, {}).inline).toEqual(expected);
    });

    it.each(rows)(
      'remove reaches exactly the tags Obsidian reads: %s',
      (_label, input, expected) => {
        const probes = [...input.matchAll(/#([a-z]{2})(?![a-z])/g)].map((m) => m[1] ?? '');
        for (const tag of new Set([...expected, ...probes])) {
          const r = reconcile(input, [tag], 'remove', 'inline');
          if (expected.includes(tag)) {
            expect(r.applied, tag).toEqual([tag]);
            expect(
              [` #${tag}`, `#${tag} `, `\t#${tag}`, `#${tag}`].map((s) => input.replace(s, '')),
              tag,
            ).toContain(r.content);
            expect(listTagsFromContent(r.content, {}).inline, tag).toEqual(
              expected.filter((t) => t !== tag),
            );
          } else {
            expect(r.applied, tag).toEqual([]);
            expect(r.skipped, tag).toEqual([tag]);
            expect(r.content, tag).toBe(input);
          }
        }
      },
    );
  });
}

const FENCE = '```';

/**
 * Issue #140, and the neighbours probed alongside it. Each table holds the
 * shapes the scan read differently from Obsidian before; the `already` tables
 * hold neighbouring shapes it already read the same way, pinned so the fix
 * cannot move them.
 */
describe('inline tags — issue #140 shapes (Obsidian readback)', () => {
  describeReadback('link text', [
    ['markdown link text', '[Discord #tf](https://x.y)', ['tf']],
    ['reference link text', '[a #tg][ref]\n\n[ref]: https://x.y', ['tg']],
    ['reference link text with an undefined label', '[a #tg][nope]', ['tg']],
    ['collapsed reference link text', '[a #tg][]', ['tg']],
    ['a tag opening link text', '[#ta](u)', ['ta']],
    ['a tag closing link text', '[a #tg](u)', ['tg']],
    ['link text and a tag glued after the link', 'x [a #bi](u)#bj', ['bi', 'bj']],
    ['bold link text', '[**#bk**](u)', ['bk']],
  ]);
  describeReadback('link syntax, already read as Obsidian does', [
    ['a URL fragment in a destination', '[x](https://example.dev/#frag)', []],
    ['a hash in an angle-bracketed destination', '[x](<a #tb.md>)', []],
    ['a hash in a link title', '[x](u "t #tc")', []],
    ['a hash in a reference label', '[x][#td]\n\n[#td]: u', []],
    ['image alt text', '![a #te](x.png)', []],
    ['reference image alt text', '![a #bh][ref]\n\n[ref]: u', []],
    ['a tag opening image alt text', 'x ![#bf](u)', []],
    ['a destination that is only a fragment', 'x [a](#bg)', []],
    ['a code span in link text', '[a `#th` b](u)', []],
    ['math in link text', '[a $#bl$ b](u)', []],
    ['wikilink alias text', '[[N#H|see #ti]]', []],
    ['a tag glued after a link', '[x](u)#tf', ['tf']],
    ['a tag glued after an image', 'x ![a](u)#bn', ['bn']],
    ['link text holding a bracketed phrase', '[a [b] #tj](u)', ['tj']],
    ['link text holding an escaped bracket', '[a \\] #bm](u)', ['bm']],
    ['a closing bracket with no opener', 'a](b #tk)', ['tk']],
  ]);

  describeReadback('bracketed spans', [
    ['a tag opening a bracketed span', '[#ta] x', ['ta']],
    ['a bracketed span mid-line', 'x [#ta] y', ['ta']],
    ['a tag glued after a bracketed span', 'x [a]#bb', ['bb']],
    ['a bracketed span glued to a word', 'a[#yl] x', ['yl']],
    ['a bracketed span nested in another', 'x [a [#yn] b] y', ['yn']],
    ['a bracketed span closed on the next line', 'x [#yr\nb] y', ['yr']],
    ['a tag glued after a space-only span', 'x [ ]#yn', ['yn']],
    ['a bracketed tag before a link', 'x [#yo](u) y', ['yo']],
    ['a bracketed span after an image', 'x ![a](u) [#yp] y', ['yp']],
  ]);
  describeReadback('brackets, already read as Obsidian does', [
    ['an unclosed bracket', 'x [#ba', []],
    ['a lone closing bracket', 'x ]#bc', []],
    ['an unclosed wikilink', 'x [[#bd', []],
    ['an unclosed bracket glued to a word', 'a[#be', []],
    ['a parenthesis inside brackets', 'x [(#bo)](u)', []],
    ['a footnote reference', 'x [^#bp] y', []],
    ['a footnote definition', '[^1]: a #bq', ['bq']],
    ['a bracket inside a wikilink alias', '[[a|[#br]]', []],
    ['empty brackets', 'x []#yo', []],
    ['a reference definition label', '[#yp]: u', []],
    ['an indented reference definition label', '   [#yq]: u', []],
    ['an outer bracket around a nested span', 'x [#zd [b] c] y', []],
    ['a space before the hash inside brackets', 'x [ #ym] y', ['ym']],
  ]);

  describeReadback('fenced code', [
    [
      "the issue's fence sequence",
      [
        `${FENCE}markdown`,
        `${FENCE}typescript`,
        'x #tu',
        FENCE,
        'prose #tv',
        FENCE,
        'code #tw',
        FENCE,
      ].join('\n'),
      ['tv'],
    ],
    [
      'a longer fence wrapping a shorter one',
      ['````', FENCE, 'x #fc', FENCE, '````', 'after #fd'].join('\n'),
      ['fd'],
    ],
    ['an unclosed fence', `${FENCE}\nx #fg\n\ny #fh`, []],
    ['a closer indented four columns', `${FENCE}\nx #fp\n    ${FENCE}\ny #fq`, []],
    ['a backtick info string holding a backtick', `${FENCE} a\`b\nx #fs\n${FENCE}\ny #ft`, ['fs']],
    ['a list-item fence, then an unindented line', `- ${FENCE}\n  x #fu\ny #fv`, []],
    ['a list-item fence, then an unindented fence', `- ${FENCE}\nx #ch\n${FENCE}\ny #ci`, []],
    [
      'a list-item fence, indented content, then an unindented fence',
      `- ${FENCE}\n  x #or\n${FENCE}\ny #os`,
      [],
    ],
    ['a list-item fence ended by a blank line', `- ${FENCE}\nx #oo\n\ny #op`, ['op']],
    [
      'a longer list-item fence, a blank line, then a fence',
      `- ${FENCE}\`\nx #yc\n\n${FENCE}\nafter #yd`,
      [],
    ],
    ['a blockquote fence, then an unquoted line', `> ${FENCE}\n> x #cc\ny #cd`, []],
    ['a blockquote fence, then an unquoted fence', `> ${FENCE}\n> x #ck\n${FENCE}\nafter #cl`, []],
    ['a blockquote tilde fence, then unquoted lines', '> ~~~\nx #ya\n~~~\nafter #yb', []],
    [
      'a paragraph continuing past an indented fence',
      `para\n    ${FENCE}\nx #fa\n${FENCE}\nafter #fb`,
      ['fa'],
    ],
  ]);
  describeReadback('fenced code, already read as Obsidian does', [
    ['a tilde fence holding a backtick fence', `~~~\nx #fi\n${FENCE}\ny #fj\n~~~\nz #fk`, ['fk']],
    ['a closer followed by spaces', `${FENCE}\nx #fl\n${FENCE}   \ny #fm`, ['fm']],
    ['a closer indented three columns', `${FENCE}\nx #fn\n   ${FENCE}\ny #fo`, ['fo']],
    ['a fence interrupting a paragraph', `para #fw\n${FENCE}\nx #fx\n${FENCE}`, ['fw']],
    ['a closed list-item fence', `- ${FENCE}\n  x #ca\n  ${FENCE}\ny #cb`, ['cb']],
    ['a list-item fence, a blank line, then a paragraph', `- ${FENCE}\n  x\n\ny #ce`, ['ce']],
    ['a blockquote fence ended by a blank line', `> ${FENCE}\n> a\n\nafter #zo`, ['zo']],
    ['a fence after a blockquote paragraph', `> a\n${FENCE}\n#cj\n${FENCE}`, []],
    [
      'a list-item fence across a blank line',
      `- a\n\n  ${FENCE}\n  #ot\n\n  #ou\n  ${FENCE}\nafter #ov`,
      ['ov'],
    ],
    ['a new list item after a lazy fence line', `- ${FENCE}\nx\n- b #xv`, ['xv']],
    ['a heading after a lazy fence line', `> ${FENCE}\nx\n# H #xw`, ['xw']],
  ]);

  describeReadback('code spans', [
    ['a code span across a line break', 'a `b\nc #ca` d #cb', ['cb']],
    ['a double-backtick code span', 'a ``b ` #cc`` d #cd', ['cd']],
    ['backtick runs of different lengths', 'a `` #cl ``` #cm', ['cl', 'cm']],
  ]);
  describeReadback('code spans, already read as Obsidian does', [
    ['a code span opened inside a longer run', 'a ``b #ce` d #cf', ['cf']],
    ['a three-backtick span opened inside a four-backtick run', 'a ```` #cj ``` #ck', ['ck']],
    ['a code span that cannot cross an empty line', 'a `b\n\n#ci` d', ['ci']],
    ['a tag glued after a space-only code span', 'a `` `#cn` #co', ['cn', 'co']],
    ['an escaped backtick', 'a \\`#cp` #cq', ['cp', 'cq']],
    ['a code span in a heading', '# a `#cr` #cs', ['cs']],
    ['a triple-backtick code span across lines', 'a ```b\n#cg\nc``` #ch', ['ch']],
    [
      'a triple-backtick span between indented lines',
      `para\n    ${FENCE}\nx #fr\n    ${FENCE}`,
      [],
    ],
    ['a triple-backtick span on one line', 'a ```#fy``` b #fz', ['fz']],
  ]);

  describeReadback('HTML blocks', [
    ['a div block', '<div>\nhello #tp\n</div>', []],
    ['a one-line paragraph element', '<p>x #tr</p>', []],
    ['a one-line pre element', '<pre>x #tq</pre>', []],
    ['a div block ended by a blank line', '<div>\n#ha\n\n#hb\n</div>', ['hb']],
    ['a pre block across a blank line', '<pre>\n#hc\n\n#hd\n</pre>\n#he', ['he']],
    ['a lone inline tag on its line', '<span>\n#hf\n</span>', []],
    ['a div interrupting a paragraph', 'para #hh\n<div>\n#hi', ['hh']],
    ['an uppercase tag name', '<DIV>\n#hj', []],
    ['a closing block tag', '</div>\n#hk', []],
    ['a horizontal rule element', '<hr>#hl', []],
    ['a div in a blockquote', '> <div>\n> #ho', []],
    ['a script block', '<script>\n#hp\n</script>\nafter #hq', ['hq']],
    ['a processing instruction', '<?php\n#hr\n?>\nafter #hs', ['hs']],
    ['a declaration', '<!DOCTYPE html\n#ht>\nafter #hu', ['hu']],
    ['a CDATA section', '<![CDATA[\n#hv\n]]>\nafter #hw', ['hw']],
    ['a custom element ended by a blank line', '<my-el attr="x">\n#hx\n\n#hy', ['hy']],
    ['a div continued past a tab-only line', '<div>\n#ok\n\t\n#ol', []],
    ['a div in a list item', '- <div>\n  #pf\n\nafter #pg', ['pg']],
    ['a div holding an indented line', '<div>\n    #ph\n</div>', []],
    ['a blockquote div continued lazily', '> <div>\n#pi', []],
    ['a list-item div continued lazily', '- <div>\n#yi\n\nafter #yj', ['yj']],
    ['a blockquote comment ended with the blockquote', '> <!-- a\n\nafter #zm', ['zm']],
    ['a list-item comment ended with the item', '- <!-- a\n\nafter #zw', ['zw']],
  ]);
  describeReadback('HTML, already read as Obsidian does', [
    ['an inline element with text', '<span>x #ts</span>', ['ts']],
    ['an inline element that cannot interrupt a paragraph', 'para\n<span>\n#hg', ['hg']],
    ['a line break element opening a line', '<br>#hm', ['hm']],
    ['a div indented four columns', '    <div>\n#hn', ['hn']],
    ['a div indented four columns after a paragraph', 'para\n    <div>\n#fi', ['fi']],
    ['a blockquote comment closed lazily', '> <!-- a\nb --> #zk\nafter #zl', ['zl']],
    ['a blockquote pre block ended with the blockquote', '> <pre>\n> a\n\nafter #zx', ['zx']],
  ]);

  describeReadback('display math', [
    ['a four-column-indented dollar pair', '    $$\n#tu\n    $$\nafter #tv', ['tu', 'tv']],
    ['a blockquote math block continued lazily', '> $$\n#xt\n$$\nafter #xu', []],
  ]);
  describeReadback('display math, already read as Obsidian does', [
    ['a math block interrupting a paragraph', 'para\n$$\n#ow\n$$\nafter #ox', ['ox']],
    ['a math block in a blockquote', '> $$\n> #oy\n> $$\nafter #oz', ['oz']],
    ['a math block in a list item', '- $$\n  #pa\n  $$\nafter #pb', ['pb']],
    ['a math block indented three columns', '   $$\n#pc\n$$', []],
    ['an indented line inside a math block', '$$\n    #pd\n$$\nafter #pe', ['pe']],
    ['a math block across an empty line', '$$\na\n\n#ye\n$$\nafter #yf', ['yf']],
    ['a blockquote math block ended with the blockquote', '> $$\n> a\n\nafter #zn', ['zn']],
    [
      'a math block after a paragraph, across an empty line',
      'para\n$$\n#ma\n\n#mb\n$$\nafter #mc',
      ['mc'],
    ],
    ['a math block after an empty line', 'para\n\n$$\n#md\n\n#me\n$$\nafter #mf', ['mf']],
    ['indented double dollars inside a paragraph', 'para\n    $$\n#mg\n    $$\nafter #mh', ['mh']],
    ['a math block opened with text on its line', 'para\n$$ x\n#mi\n$$\nafter #mj', ['mj']],
    ['an unclosed math block interrupting a paragraph', 'para\n$$\n#mk\n\nlater #ml', []],
    ['indented double dollars closed at line start', 'para\n    $$\n#fh\n$$', []],
    ['inline double dollars closing on a line of their own', 'a $$\n#mm\n$$ b #mn', ['mn']],
  ]);

  describeReadback('glued tags', [
    ['two glued tags', '#tl#tm', ['tl', 'tm']],
    ['a glued tag after a nested tag', '#tn/#to', ['tn/', 'to']],
    ['a glued tag before text', '#tag#more x', ['tag', 'more']],
    ['a glued tag after an underscore', '#gq_#gr', ['gq_', 'gr']],
    ['three glued tags', '#gs#gt#gu', ['gs', 'gt', 'gu']],
    ['a trailing lone hash', '#ab#cd# x', ['ab', 'cd']],
    ['glued tags inside emphasis', 'x _#rd#re_ y', ['rd', 're']],
  ]);
  describeReadback('glued hashes, already read as Obsidian does', [
    ['a glued tag after an all-digit run', '#1984#gm', []],
    ['a doubled hash', 'x ##gn', []],
    ['glued tags after punctuation', '(#go#gp', []],
    ['glued tags after a word', 'a#gv#gw', []],
    ['a hash followed by a space', '#gx# gy', ['gx']],
    ['a chain broken by an all-digit run', '#ab#12#cd', ['ab']],
  ]);

  describeReadback('underscores', [
    ['emphasis around a tag', 'x _#uc_ y', ['uc']],
    ['a tag after snake_case', 'snake_case_#wc', ['wc']],
    ['a tag with an inner underscore after snake_case', 'snake_case_#ug_x', ['ug_x']],
    ['a tag after closing emphasis', 'a _b_#uh', ['uh']],
    ['a tag after emphasis at line start', '_a_#ui', ['ui']],
    ['strong emphasis around a tag', 'x __#uj__ y', ['uj']],
    ['a whole line of emphasis', '_#uk_', ['uk']],
    ['a tag closing emphasis', 'x _a #um_ y', ['um']],
    ['a tag closing emphasis opened mid-word', 'a_b #un_ y', ['un']],
    ['a tag after two intraword underscores', 'a_b_c_#up', ['up']],
    ['emphasis opened after a word', 'word_ #ur_', ['ur']],
    ['emphasis opened on a word', 'x snake_#us_ y', ['us']],
    ['emphasis closed before the hash', 'foo_bar _#ut', ['ut']],
    ['emphasis opened after a digit', 'x 1_#uv_ y', ['uv']],
    ['a closer before punctuation', 'x _#pb_. y', ['pb']],
    ['a closer before a non-ASCII letter', 'x _#pd_é y', ['pd']],
    ['a pair after one that failed', 'a_ _#pg b_', ['pg']],
    ['a pair after a failed opener', 'x_ y _#ph z_', ['ph']],
    ['emphasis around a tag and a word', 'a_#pi b_', ['pi']],
    ['a double opener closed by a single run', 'x __a_#pj', ['pj']],
    ['emphasis across a line break', 'x _a\nb_#pl', ['pl']],
    ['a closer on the next line', 'x _#pm\nb_ y', ['pm']],
    ['a tag keeping its inner underscore', 'x _#qa_name_ y', ['qa_name']],
    ['an opener followed by a space', 'x _ #pe_ y', ['pe']],
    ['a pair after a failed pair of spaces', 'a _ _#po_ b', ['po']],
    ['a closer after a space', 'x _a _#pp', ['pp']],
    ['a tag right after emphasis', 'x _a_#pq', ['pq']],
    ['an intraword opener and a spaced closer', 'x_a _#pr', ['pr']],
    ['an intraword opener across words', 'a_b c_#pt', ['pt']],
    ['an intraword opener and a closer after a space', 'a_b c _#pu', ['pu']],
    ['a double opener around a tag', 'x __#py_ y', ['py']],
    ['a trailing underscore that no longer closes', 'x _a_#rb_ y', ['rb_']],
    ['an all-digit tag that lost its closer', 'x _#rc #1984_ y', ['rc']],
    ['a pair skipping a longer run', 'x _a__ _#qg', ['qg']],
    ['a pair skipping an intraword run', 'x _#qh b_c d_ e', ['qh']],
    ['a pair across a code span', 'x _a `b` c_#qd', ['qd']],
    ['a pair across math', 'x _a $b$ c_#qj', ['qj']],
    ['a pair across a wikilink', 'x _a [[l]] c_#qk', ['qk']],
    ['a pair across a comment', 'x _a <!-- c --> d_#ql', ['ql']],
    ['a pair across bold', 'x _a **b** c_#qm', ['qm']],
    ['emphasis in a heading', '# x _a_#qp', ['qp']],
    ['emphasis in a table cell', '|x _a_#qq|b|\n|-|-|', ['qq']],
    ['emphasis in a list item', '- _a_#qr', ['qr']],
    ['content ending at a line break', 'x _a\n_#qt', ['qt']],
    ['a pair across a link destination', 'x _a [l](u_v) _#qv', ['qv']],
    ['a pair across a bare URL', 'x _a https://x.y/a_b _#qw', ['qw']],
    ['a pair then an all-digit-led tag', 'x _#qy_ #1984_z', ['qy', '1984_z']],
    ['emphasis after a link', '[x](u)_a_#ys', ['ys']],
    ['a pair across math holding an underscore', 'x _a $b_c$ d_#ra', ['ra']],
    ['a pair across a wikilink holding an underscore', 'x _a [[b_c]] d_#rb', ['rb']],
    ['a pair across a comment holding an underscore', 'x _a <!-- b_c --> d_#rc', ['rc']],
    ['a pair across an image holding an underscore', 'x _a ![b_c](u) d_#rd', ['rd']],
    ['a pair across an HTML attribute', 'x _a <a href="u_v"> d_#re', ['re']],
    ['a pair across a code span holding an underscore', 'x _a `b_c` d_#rh', ['rh']],
    ['emphasis inside link text', '[x _a_#ri](u)', ['ri']],
    ['a pair across link text', 'x _a [b](u) c_#rj', ['rj']],
    ['a closer inside a tag before a non-ASCII letter', 'x _#rk_日本 y', ['rk']],
    ['an escaped underscore between a pair', 'x _a \\_ d_#rf', ['rf']],
  ]);
  describeReadback('underscores, already read as Obsidian does', [
    ['a trailing underscore', '#tag_ x', ['tag_']],
    ['intraword underscores', 'a_#wd_b', []],
    ['an unpaired underscore at line start', '_#ua', []],
    ['an unpaired underscore after a word', 'snake_#ub', []],
    ['an unpaired opener', 'x _#ud', []],
    ['an unpaired underscore glued to a word', 'x_#ue y', []],
    ['a closer before a letter', 'x _#uf_b y', []],
    ['a closer before a letter, at word end', 'x _#ul_y', []],
    ['a trailing underscore that opens nothing', '#uo_ and _x_', ['uo_']],
    ['a third, unpaired underscore', 'x _a_ b_#uq', []],
    ['a pair of spaces', 'a_ _#uu', []],
    ['a closer before a digit', 'x _#pc_1 y', []],
    ['a closer longer than its opener', 'x _a__#pk', []],
    ['underscores inside a tag', '#qb_name_ x', ['qb_name_']],
    ['underscores inside a tag, mid-word', '#qc_a_b', ['qc_a_b']],
    ['a code-span closer', 'x _a `c_` _#qn', []],
    ['a code-span closer, then an unpaired run', 'x _a `_` _#pw', []],
    ['a code-span underscore that cannot open', 'x `a_` b_#zf', []],
    ['a code-span underscore that closes', 'x _a `_` b_#zg', []],
    ['interleaved stars', 'x _a *b_ c* d_#qo', []],
    ['stars around a failed pair', 'x *a_ _#px* y', []],
    ['a tab between the runs', 'x _\t_#qs', []],
    ['a line break between the runs', 'x_\n_#qu', []],
    ['an escaped opener', 'x \\_a_#qx', []],
    ['a trailing underscore that cannot open', '#qe_ x_', ['qe_']],
    ['a pair, then a new opener', 'x _a b_ c _#ps', []],
    ['emphasis across an empty line', 'x _a\n\nb_#pv', []],
    ['a closer run longer than its opener', 'x _#pz__ y', []],
    ['underscores through a tag', 'x #ra_b_c_ y', ['ra_b_c_']],
    ['a trailing underscore before a tag', '#rl_ a_ #rm', ['rl_', 'rm']],
    ['a comment underscore that cannot open', '<!-- _ --> a_#zh', []],
    ['a comment underscore, then a failed pair', '<!-- a_ --> _#yw', []],
    ['a destination underscore that cannot open', '[x](u_v) _#zi', []],
    ['a destination underscore that closes', 'x _a [l](u_) d_#rg', []],
    ['link text that cannot reach past the link', '[a_](u) b_#zj', []],
    ['a wikilink underscore', '[[my_note]] and _#yt', []],
    ['a math underscore', '$x_1$ and _#yu', []],
    ['a math underscore before a brace', '$x_{1}$ and _#yv', []],
  ]);

  describeReadback('table cells', [
    ['an unpadded table cell', '|a|b|\n|-|-|\n|#uo|x|', ['uo']],
    ['a header cell', '|#ta|b|\n|-|-|', ['ta']],
    ['a table without leading pipes', 'a|b\n-|-\nx|#tb', ['tb']],
    ['a last cell', '|a|b|\n|-|-|\n|x|#tc|', ['tc']],
    ['fewer delimiter cells than header cells', '|a|b|\n|-|\n|#td|x|', ['td']],
    ['a table in a blockquote', '> |a|b|\n> |-|-|\n> |#ti|x|', ['ti']],
    ['aligned delimiter cells', '|a|b|\n|:-|-:|\n|#tj|x|', ['tj']],
    ['a row without a closing pipe', '|a|b|\n|-|-|\n|x|#tb', ['tb']],
    ['a row with an extra cell', '|a|b|\n|-|-|\n|a|b|#ti|', ['ti']],
    ['a one-column table', '|a|\n|-|\n|#tj|', ['tj']],
    ['a cell after a padded one', '|a|b|\n|--|--|\n| x |#tl|', ['tl']],
    ['spaced delimiter cells', '| a | b |\n| --- | --- |\n|#tn|x|', ['tn']],
    ['a table in a list item', '- |a|b|\n  |-|-|\n  |#tp|x|', ['tp']],
    ['a cell after a code span holding a pipe', '|a|b|\n|-|-|\n|`x|y`|#tr|', ['tr']],
    ['a table after an empty line', 'para\n\n|a|b|\n|-|-|\n|#ts|x|', ['ts']],
    ['a table after a heading', '# H\n|a|b|\n|-|-|\n|#ty|x|', ['ty']],
    ['trailing pipes without leading ones', 'a|b|\n-|-|\nx|#yb|', ['yb']],
    ['a row with a trailing pipe in a table without them', 'a|b\n-|-\nx|#yc|', ['yc']],
    ['leading pipes without trailing ones', '|a|b\n|-|-\n|#yd|x', ['yd']],
  ]);
  describeReadback('pipes, already read as Obsidian does', [
    ['pipes on one line', 'a|b|#uq|c', []],
    ['a table ended by an empty line', '|a|b|\n|-|-|\n\n|#te|x|', []],
    ['a line without a leading pipe after a table', '|a|b|\n|-|-|\nx #tf|#tg', ['tf']],
    ['a pipe in prose', 'a |#th', []],
    ['a table that would interrupt a paragraph', 'para\n|a|b|\n|-|-|\n|#tk|x|', []],
    ["a row without the header's leading pipe", '|a|b|\n|-|-|\nx|#ta', []],
    ['a row with a leading pipe the header lacks', 'a|b\n-|-\n|x|#tc|', []],
    ['a row ending in a tag after a pipe', '|a|b|\n|-|-|\nx|y #tf|#tg', ['tf']],
    ['a row opening with a tag', '|a|b|\n|-|-|\n#th|x', ['th']],
    ['a setext heading, not a table', 'a\n-\n#tk', ['tk']],
    ['a delimiter row with a leading pipe the header lacks', 'a|b\n|-|-|\n|#tm|x|', []],
    ['an invalid delimiter row', '|a|b|\n|x|-|\n|#to|x|', []],
    ['an escaped pipe', '|a|b|\n|-|-|\n|x\\|#tq|y|', ['tq']],
    ['a line without a leading pipe ending the table', '|a|b|\n|-|-|\n|x|y|\nx #tt|#tu', ['tt']],
    ['a plain line ending the table', '|a|b|\n|-|-|\nplain\n|#tv|x|', []],
    ['a header with a single pipe', '|a\n|-\n|#tw', []],
    ['a setext heading holding a pipe', 'a|b\n---\n|#tx|', []],
    ['a row indented four columns', '|a|b|\n|-|-|\n    |#tz|x|', []],
    ["a delimiter row without the header's leading pipe", '|a|b|\n-|-\n|#ya|x|', []],
    ['a row indented two columns', '| a | b |\n|---|---|\n  |#ye|x|', []],
    ['a delimiter row indented one column', '|a|b|\n |-|-|\n|#yf|x|', []],
    ['a header indented one column', ' |a|b|\n|-|-|\n|#yg|x|', []],
    ['a row indented one column', '|a|b|\n|-|-|\n |#yh|x|', []],
    ['a padded cell in a table without leading pipes', 'a | b\n--|--\n| #yi | x', ['yi']],
    ['rows after a line that ends the table', '|a|b|\n|-|-|\n|x|y|\nz|#yj\n|#yk|w|', []],
    ['a plain line ending a table without leading pipes', 'a|b\n-|-\nplain\nx|#zb', []],
  ]);
});

/**
 * Issue #139: an indented code block hides its tags, but only where the line
 * cannot continue something else — a paragraph line above it, or a list item
 * whose content it belongs to. Measured from where each line's content starts
 * inside its blockquotes and list items.
 */
describe('inline tags — issue #139 indented code (Obsidian readback)', () => {
  describeReadback('indented code', [
    [
      "the issue's note",
      [
        '    #sa at top',
        '',
        '    #sb indented after blank',
        'para',
        '    #sc lazy continuation',
        '- item',
        '',
        '    #sd list continuation',
        '- item2',
        '    #se nested',
        '',
        '\t#sf tab after blank',
      ].join('\n'),
      ['sc', 'sd', 'se', 'sf'],
    ],
    ['the first line of the body', '    #sa at top', []],
    ['a tab opening the first line', '\t#zs', []],
    ['a tab opening the first line, with text after', '\t#zt at top', []],
    ['right after the frontmatter', '---\nx: 1\n---\n    #sr', []],
    ['after an empty line', 'para\n\n\t#st', []],
    ['after a spaces-only line', 'para\n  \n    #sv', []],
    ['after a heading and an empty line', '# H\n\n    #so', []],
    ['right after a heading', '# H\n    #sp', []],
    ['after a heading and a tab-only line', '# H\n\t\n    #on', []],
    ['after a tab-only first line', '\t\n    #pq', []],
    ['after a list has ended', '- a\n\nb\n\n    #sq', []],
    ['inside a blockquote', '>     #sm', []],
    ['after a tab in a blockquote', '>\t#tn', []],
    ['after two tabs in a blockquote', '>\t\t#to', []],
    ['after a blockquote paragraph and an empty quoted line', '> para\n>\n>     #sx', []],
    ['after a blockquote and an empty line', '> a\n\n    #tt', []],
    ['an indented line after a blockquote paragraph', '> para\n    #sw', []],
    ['a tab-indented line after a blockquote paragraph', '> para\n\tx #xx', []],
    ['an indented line after a lazy blockquote line', '> para\n  b\n    #xy', []],
    ['an indented line after a nested blockquote', '> > a\n    #yg', []],
    ['an indented line after a list in a blockquote', '> - a\n    #yh', []],
    ["four columns past a list item's content", '- item\n\n      #sg', []],
    ["four columns past a wide list item's content", '-   item\n\n        #sj', []],
    ['text five spaces after a list marker', '-     #sl', []],
    ["four columns past a nested item's content", '- a\n  - b\n\n        #sy', []],
    ["four columns past a tab-separated item's content", '-\ta\n\n\t\t#tm', []],
    ["four columns past a two-space item's content", '-  item\n\n       #og', []],
    ['eight columns into an ordered item', '1. item\n\n        #oa', []],
    ['eight columns into a wide ordered item', '1.  item\n\n        #ob', []],
    ['eight columns into a two-digit ordered item', '10. item\n\n        #oc', []],
    ['nine columns into a three-digit ordered item', '100. item\n\n         #xi', []],
    ['seven columns into a parenthesis item', '1) item\n\n       #od', []],
    ['seven columns into a second parenthesis item', '2) item\n\n       #xd', []],
    [
      'seven columns into an ordered item with a three-column line',
      '1. item\n   b\n\n       #xl',
      [],
    ],
    ["after an ordered item's aligned paragraph", '1. item\n\n   b\n\n       #py', []],
    ["after an empty ordered item's aligned line", '1. \n   a\n\n       #oj', []],
    [
      'seven columns into an ordered item with a later aligned line',
      '1. item\n\n       #om\n   b #on',
      ['on'],
    ],
    ['six columns into a star item', '* item\n\n      #xn', []],
    ['six columns into a plus item', '+ item\n\n      #xo', []],
    ['six columns into a dash item', '- item\n\n      #xm', []],
    ['four columns after a five-column item ends', '-    a\n\n    #xq', []],
    ['after a heading in a list item', '- # H\n      #ym', []],
    ['code in a list item between paragraphs', '- a\n\n      code #yk\n\n  b #yl', ['yl']],
    ['after a fenced block', `${FENCE}\nx\n${FENCE}\n    #ta`, []],
    ['after an HTML block', '<div>\n\n    #tb', []],
    ['after a comment block', '<!-- x -->\n    #tw', []],
    ['after a thematic break', '***\n    #tc', []],
    ['continued across an empty line', '    code\n\n    #te', []],
    ['after a table', '|a|b|\n|-|-|\n    #tg', []],
    ['between paragraphs', 'para\n\n    #th\npara2 #ti', ['ti']],
    ['after a setext heading', 'para\n---\n    #tj', []],
    ['after a double-underlined setext heading', 'para\n===\n    #tx', []],
    ['after a math block', '$$\nx\n$$\n    #tk', []],
    ['after a link reference definition', '[a]: u\n    #ty', []],
  ]);
  describeReadback('indentation, already read as Obsidian does', [
    ['a lazy continuation line', 'para\n    #sc', ['sc']],
    ['list content after an empty line', '- item\n\n    #sd', ['sd']],
    ['list content right after the item', '- item2\n    #se', ['se']],
    ['tab-indented list content', '- item\n\n\t#sf', ['sf']],
    ['six columns into an ordered item', '1. item\n\n      #si', ['si']],
    ['three spaces', '   #ss', ['ss']],
    ['a paragraph continued past a tab-only line', 'para\n\t\n    #su', ['su']],
    ['nested list content', '- a\n  - b\n\n      #sz', ['sz']],
    ['a paragraph after indented code', '    code\npara #td', ['td']],
    ["a list item's second paragraph", '- a\n\n  b #tl', ['tl']],
    ['deep paragraph continuation in a list item', '- a\n      #tp', ['tp']],
    ['content under an empty list item', '-\n    #tq', ['tq']],
    ['an indented line continuing a lazy paragraph', '- a\nb\n\n    #tr', ['tr']],
    ['a line after an ordered item that cannot interrupt', 'para\n2. x\n    #ts', ['ts']],
    ['a lazy line then list content', '- a\nb\n    #tz', ['tz']],
    ['a lazy line indented four columns into a wide item', '10.  a\n    #xp', ['xp']],
    ['a line after blockquote code', '>     code\n#xr', ['xr']],
    ['a line after list-item code', '-     code\n#xs', ['xs']],
    ['a lazy line under a five-column item', '-    a\n    #zz', ['zz']],
    ['a lazy blockquote line indented two columns', '> a\n  #oi', ['oi']],
    ['list content after a tab-only line', '- a\n\t\n    #om', ['om']],
    ['a tab mid-line', 'a\t#zu', ['zu']],
    ['a tab-indented lazy line', 'a\n\t#zv', ['zv']],
    ['five columns into a two-space item', '-  item\n\n      #of', ['of']],
    ['six columns into an ordered item, again', '1. item\n\n      #xf', ['xf']],
    ['six columns into a parenthesis item', '1) item\n\n      #xg', ['xg']],
    ['seven columns into a two-digit ordered item', '10. item\n\n       #xh', ['xh']],
    ['seven columns into a wide ordered item', '1.  item\n\n       #xj', ['xj']],
    ['a lazy line then an empty line and list content', '- a\nb\n\n    #xz', ['xz']],
    ['seven columns into a tab-separated ordered item', '1.\titem\n\n       #oh', ['oh']],
    ['six columns into an ordered item, once more', '1. item\n\n      #ol', ['ol']],
  ]);

  it('removes a tag beside indented code without touching the code', () => {
    const input = '    #keep in code\n\npara #keep here\n';
    const r = reconcile(input, ['keep'], 'remove', 'inline');
    expect(r.applied).toEqual(['keep']);
    expect(r.content).toBe('    #keep in code\n\npara here\n');
  });

  it('adds a tag whose only occurrence is indented code', () => {
    const input = '    #keep in code\n';
    const r = reconcile(input, ['keep'], 'add', 'inline');
    expect(r.applied).toEqual(['keep']);
    expect(r.content).toBe(`${input}#keep\n`);
  });
});

/**
 * Every scanner added for #139 and #140, fed its own worst case at 80,000
 * characters: openers with no closer, and runs of markers that each start a
 * construct. A scan that rescanned the rest of a line or paragraph from each
 * one would be quadratic here and run past the test timeout.
 */
describe('inline tag scan stays linear in note length', () => {
  it.each([
    ['nested list markers on one line', `${'* '.repeat(40_000)}x #t`, ['t']],
    ['nested ordered markers on one line', `${'1. '.repeat(26_000)}x #t`, ['t']],
    ['tab-separated list markers', `${'-\t'.repeat(40_000)}x #t`, ['t']],
    ['list markers before a thematic-break-like tail', `- ${'* '.repeat(40_000)}x #t`, ['t']],
    ['nested items, then empty lines', `${'- '.repeat(20_000)}a #t${'\n'.repeat(40_000)}`, ['t']],
    ['blockquote markers on one line', `${'> '.repeat(40_000)}#t`, ['t']],
    ['blockquote and list markers on one line', `${'> - '.repeat(20_000)}#t`, ['t']],
    ['unclosed fences', '```\n'.repeat(20_000), []],
    ['lazy fence lines', `- ${FENCE}\n${'x #t\n'.repeat(16_000)}`, []],
    ['HTML attributes with no closing bracket', `<a${' b'.repeat(40_000)}\n#t`, ['t']],
    ['HTML attributes across line endings', `<a${' b\n'.repeat(26_000)}\n#t`, ['t']],
    ['unquoted HTML attribute values', `<a${' b=c'.repeat(20_000)}\n#t`, ['t']],
    ['a quoted HTML attribute value that never closes', `<a b='${' c'.repeat(40_000)}\n#t`, ['t']],
    [
      'open tags whose quoted values close on the next tag',
      `${'x <a b="c '.repeat(8_000)}#t`,
      ['t'],
    ],
    ['closing tags carrying attributes', `${'x </a b '.repeat(10_000)}#t`, ['t']],
    ['comment openers', '<!--\n'.repeat(16_000), []],
    ['display math openers', '$$\n'.repeat(26_000), []],
    ['unpaired inline double dollars', 'a $$\n'.repeat(16_000), []],
    ['a delimiter row with trailing spaces', `|a|b|\n|-${' '.repeat(80_000)}x #t`, ['t']],
    ['delimiter cells without an end', `|a|b|\n${'|-'.repeat(40_000)}x #t`, ['t']],
    ['table rows', `|a|b|\n|-|-|\n${'|#t|x|\n'.repeat(11_000)}`, ['t']],
    ['a backtick run in prose', `a ${'`'.repeat(80_000)} #t`, ['t']],
    [
      'backtick runs of growing length',
      Array.from({ length: 400 }, (_, k) => '`'.repeat(k + 1)).join(' '),
      [],
    ],
    ['unclosed brackets', '[#t '.repeat(20_000), []],
    ['link tails with no opener', 'x](u) #t '.repeat(9_000), ['t']],
    ['image openers', '![a #t '.repeat(11_000), ['t']],
    ['underscore openers', '_#t '.repeat(20_000), ['t']],
    ['intraword underscores', 'a_b '.repeat(20_000), []],
    ['underscores in code spans', '`_` _a '.repeat(11_000), []],
    ['a glued tag chain', '#a'.repeat(40_000), ['a']],
    ['a tag full of underscores', `#${'a_'.repeat(40_000)}`, [`${'a_'.repeat(40_000)}`]],
  ])('scans %s in linear time', (_label, input, expected) => {
    expect(listTagsFromContent(input, {}).inline).toEqual(expected);
  });
});

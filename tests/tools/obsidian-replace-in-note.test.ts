/**
 * @fileoverview Handler tests for obsidian_replace_in_note (read → mutate → write).
 * @module tests/tools/obsidian-replace-in-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianReplaceInNote } from '@/mcp-server/tools/definitions/obsidian-replace-in-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

const noteJson = (content: string) => ({
  path: 'N.md',
  content,
  frontmatter: {},
  tags: [],
  stat: { ctime: 0, mtime: 0, size: content.length },
});

/** Stubs the GET → PUT → HEAD round-trip for a successful replace. */
function stubReplaceFlow(beforeContent: string, afterSize: number) {
  const pool = harness.current().pool;
  let putBody = '';
  pool
    .intercept({ path: '/vault/N.md', method: 'GET' })
    .reply(200, noteJson(beforeContent), { headers: { 'content-type': 'application/json' } });
  pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
    putBody = String(opts.body ?? '');
    return { statusCode: 200, data: '' };
  });
  pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(afterSize));
  return () => putBody;
}

describe('obsidian_replace_in_note', () => {
  it('applies replacements sequentially and writes the result back', async () => {
    const before = 'Hello world. Hello there.';
    const after = 'Hi earth. Hi there.';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [
          { search: 'Hello', replace: 'Hi' },
          { search: 'Hi world', replace: 'Hi earth' },
        ],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(3);
    expect(out.perReplacement).toEqual([
      { search: 'Hello', count: 2, bodyCount: 2, frontmatterCount: 0 },
      { search: 'Hi world', count: 1, bodyCount: 1, frontmatterCount: 0 },
    ]);
    expect(out.previousSizeInBytes).toBe(Buffer.byteLength(before, 'utf8'));
    expect(out.currentSizeInBytes).toBe(Buffer.byteLength(after, 'utf8'));
  });

  it('skips the write when no replacement matched and currentSize equals previousSize', async () => {
    let putCalls = 0;
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('untouched'), { headers: { 'content-type': 'application/json' } });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply(() => {
        putCalls++;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'absent', replace: 'present' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(out.totalReplacements).toBe(0);
    expect(putCalls).toBe(0);
    expect(out.previousSizeInBytes).toBe(out.currentSizeInBytes);
  });

  it('honors useRegex and caseSensitive flags', async () => {
    const before = 'Foo foo FOO';
    const after = 'bar bar bar';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'foo', replace: 'bar', useRegex: true, caseSensitive: false }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(out.totalReplacements).toBe(3);
    expect(getBody()).toBe(after);
  });

  it('honors $1/$2 capture-group references in regex replacements', async () => {
    const before = 'The quick brown fox.';
    const after = 'The brown quick fox.';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: '(quick) (brown)', replace: '$2 $1', useRegex: true }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(1);
  });

  it('honors wholeWord in literal mode (avoids substring matches)', async () => {
    const before = 'cat scatter category cat.';
    const after = 'dog scatter category dog.';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'cat', replace: 'dog', wholeWord: true }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(2);
  });

  it('honors wholeWord in regex mode (wraps the pattern in \\b…\\b)', async () => {
    const before = 'foo foobar foo';
    const after = 'X foobar X';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'fo+', replace: 'X', useRegex: true, wholeWord: true }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(2);
  });

  it('honors flexibleWhitespace in literal mode (collapses runs of whitespace)', async () => {
    const before = 'the  quick\tbrown\nfox  jumps';
    const after = 'the  slow red\nfox  jumps';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'quick brown', replace: 'slow red', flexibleWhitespace: true }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(1);
  });

  it('keeps `$1` literal in literal mode with wholeWord (no capture-group expansion)', async () => {
    const before = 'cat sat';
    const after = 'dog$1 sat';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'cat', replace: 'dog$1', wholeWord: true }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(after);
  });

  it('throws regex_invalid (ValidationError) on a malformed regex', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('body'), { headers: { 'content-type': 'application/json' } });

    await expect(
      obsidianReplaceInNote.handler(
        obsidianReplaceInNote.input.parse({
          target: { type: 'path', path: 'N.md' },
          replacements: [{ search: '(', replace: 'x', useRegex: true }],
        }),
        createMockContext({ errors: obsidianReplaceInNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_invalid' },
    });
  });

  it('throws regex_unsafe (ValidationError) for a catastrophic-backtracking useRegex pattern', async () => {
    // The note is read first, but the guard must reject before the pattern is
    // compiled and run over the body. No PUT intercept is registered, so any
    // write attempt would fail the test.
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'), {
        headers: { 'content-type': 'application/json' },
      });

    await expect(
      obsidianReplaceInNote.handler(
        obsidianReplaceInNote.input.parse({
          target: { type: 'path', path: 'N.md' },
          replacements: [{ search: '(a+)+$', useRegex: true, replace: 'x' }],
        }),
        createMockContext({ errors: obsidianReplaceInNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_unsafe' },
    });
  });
});

const FM_NOTE = [
  '---',
  'title: MCP Review Scratch',
  'status: draft',
  'tags:',
  '  - alpha',
  '  - beta',
  '---',
  '',
  '# MCP Review Scratch',
  '',
  'Body text mentioning draft.',
  '',
].join('\n');

/** The frontmatter prefix of `FM_NOTE`, fences included — the bytes a body-scoped edit may not touch. */
const FM_PREFIX = FM_NOTE.slice(0, FM_NOTE.indexOf('\n# MCP Review Scratch'));

/** GET only — for cases that must not reach the PUT at all. */
function stubReadOnly(content: string): () => number {
  let puts = 0;
  const pool = harness.current().pool;
  pool
    .intercept({ path: '/vault/N.md', method: 'GET' })
    .reply(200, noteJson(content), { headers: { 'content-type': 'application/json' } });
  pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
    puts++;
    return { statusCode: 200, data: '' };
  });
  return () => puts;
}

describe('obsidian_replace_in_note / scope', () => {
  it('defaults to the body and leaves the frontmatter block byte-identical', async () => {
    const getBody = stubReplaceFlow(FM_NOTE, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'MCP Review Scratch', replace: 'MCP Review Scratch: v2' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(FM_NOTE.replace('# MCP Review Scratch', '# MCP Review Scratch: v2'));
    expect(getBody().startsWith(FM_PREFIX)).toBe(true);
    expect(out.totalReplacements).toBe(1);
    expect(out.perReplacement).toEqual([
      { search: 'MCP Review Scratch', count: 1, bodyCount: 1, frontmatterCount: 0 },
    ]);
  });

  it('does not count or rewrite a frontmatter-only match under the default scope', async () => {
    const puts = stubReadOnly(FM_NOTE);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'status: draft', replace: 'status: published' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(out.totalReplacements).toBe(0);
    expect(puts()).toBe(0);
  });

  it('rewrites only the YAML when scope is "frontmatter"', async () => {
    const getBody = stubReplaceFlow(FM_NOTE, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        scope: 'frontmatter',
        replacements: [{ search: 'draft', replace: 'published' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(FM_NOTE.replace('status: draft', 'status: published'));
    expect(out.perReplacement).toEqual([
      { search: 'draft', count: 1, bodyCount: 0, frontmatterCount: 1 },
    ]);
  });

  it('counts body and frontmatter hits separately when scope is "both"', async () => {
    const getBody = stubReplaceFlow(FM_NOTE, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        scope: 'both',
        replacements: [{ search: 'draft', replace: 'published' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(
      FM_NOTE.replace('status: draft', 'status: published').replace(
        'mentioning draft.',
        'mentioning published.',
      ),
    );
    expect(out.totalReplacements).toBe(2);
    expect(out.perReplacement).toEqual([
      { search: 'draft', count: 2, bodyCount: 1, frontmatterCount: 1 },
    ]);
  });

  it('reports zero matches for scope "frontmatter" on a note that has none', async () => {
    const puts = stubReadOnly('# Heading\n\ntitle here\n');

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        scope: 'frontmatter',
        replacements: [{ search: 'title', replace: 'heading' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(out.totalReplacements).toBe(0);
    expect(puts()).toBe(0);
  });

  it('leaves a frontmatter-only note with an empty body untouched under the default scope', async () => {
    const puts = stubReadOnly('---\ntitle: a\n---\n');

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'title', replace: 'heading' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(out.totalReplacements).toBe(0);
    expect(puts()).toBe(0);
  });

  it('treats a `---` rule inside the body as body text and keeps the real fence', async () => {
    const before = '---\ntitle: a\n---\n\nIntro\n\n---\n\nOutro\n';
    const getBody = stubReplaceFlow(before, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: '---', replace: '===' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe('---\ntitle: a\n---\n\nIntro\n\n===\n\nOutro\n');
    expect(out.perReplacement).toEqual([
      { search: '---', count: 1, bodyCount: 1, frontmatterCount: 0 },
    ]);
  });

  it('treats an unterminated fence as body text', async () => {
    const before = '---\ntitle: a\n\nNo closing fence.\n';
    const getBody = stubReplaceFlow(before, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'title', replace: 'heading' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe('---\nheading: a\n\nNo closing fence.\n');
    expect(out.perReplacement).toEqual([
      { search: 'title', count: 1, bodyCount: 1, frontmatterCount: 0 },
    ]);
  });

  it('preserves a CRLF frontmatter block byte-for-byte under the default scope', async () => {
    const before = '---\r\ntitle: a\r\n---\r\n\r\nBody title here.\r\n';
    const getBody = stubReplaceFlow(before, 0);

    await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'title', replace: 'heading' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe('---\r\ntitle: a\r\n---\r\n\r\nBody heading here.\r\n');
  });

  it('rewrites nested YAML past the first level without disturbing its siblings', async () => {
    const before = '---\nmeta:\n  inner:\n    deep: draft\nstatus: draft\n---\n\nBody.\n';
    const getBody = stubReplaceFlow(before, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        scope: 'frontmatter',
        replacements: [{ search: 'deep: draft', replace: 'deep: published' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(
      '---\nmeta:\n  inner:\n    deep: published\nstatus: draft\n---\n\nBody.\n',
    );
    expect(out.perReplacement).toEqual([
      { search: 'deep: draft', count: 1, bodyCount: 0, frontmatterCount: 1 },
    ]);
  });
});

describe('obsidian_replace_in_note / frontmatter validation', () => {
  const invalidCases: Array<[string, string, string]> = [
    ['an unquoted colon breaking a scalar', 'MCP Review Scratch', 'MCP Review Scratch: v2'],
    ['a rewritten list marker becoming a YAML alias', '  - ', '  * '],
    ['a stray quote truncating a scalar', 'status: draft', 'status: "draft'],
  ];

  it.each(invalidCases)(
    'fails closed on %s and writes nothing',
    async (_label, search, replace) => {
      const puts = stubReadOnly(FM_NOTE);

      await expect(
        obsidianReplaceInNote.handler(
          obsidianReplaceInNote.input.parse({
            target: { type: 'path', path: 'N.md' },
            scope: 'both',
            replacements: [{ search, replace }],
          }),
          createMockContext({ errors: obsidianReplaceInNote.errors }),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'frontmatter_invalid',
          recovery: {
            hint: obsidianReplaceInNote.errors?.find((e) => e.reason === 'frontmatter_invalid')
              ?.recovery,
          },
        },
      });
      expect(puts()).toBe(0);
    },
  );

  it('does not run the check when the frontmatter is out of scope', async () => {
    const before = '---\ntitle: a\n---\n\nRename Foo here.\n';
    const getBody = stubReplaceFlow(before, 0);

    await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'Foo', replace: 'Foo: bar' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe('---\ntitle: a\n---\n\nRename Foo: bar here.\n');
  });

  it('does not catch a rewrite that renames a key but still parses', async () => {
    const getBody = stubReplaceFlow(FM_NOTE, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        scope: 'frontmatter',
        replacements: [{ search: 'status:', replace: 'state:' }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(FM_NOTE.replace('status: draft', 'state: draft'));
    expect(out.totalReplacements).toBe(1);
  });
});

describe('obsidian_replace_in_note / format()', () => {
  it('renders the per-scope counts alongside the total', () => {
    const render = obsidianReplaceInNote.format;
    if (!render) throw new Error('obsidian_replace_in_note declares no format()');
    const text = render({
      path: 'N.md',
      totalReplacements: 3,
      perReplacement: [{ search: 'draft', count: 3, bodyCount: 2, frontmatterCount: 1 }],
      previousSizeInBytes: 10,
      currentSizeInBytes: 12,
    })
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');

    expect(text).toContain('N.md');
    expect(text).toContain('3');
    expect(text).toContain('body 2');
    expect(text).toContain('frontmatter 1');
    expect(text).toContain('10');
    expect(text).toContain('12');
  });
});

describe('obsidian_replace_in_note / replaceAll false across scopes', () => {
  it('spends its single substitution on the frontmatter when both are in scope', async () => {
    const getBody = stubReplaceFlow(FM_NOTE, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        scope: 'both',
        replacements: [{ search: 'draft', replace: 'published', replaceAll: false }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(FM_NOTE.replace('status: draft', 'status: published'));
    expect(out.perReplacement).toEqual([
      { search: 'draft', count: 1, bodyCount: 0, frontmatterCount: 1 },
    ]);
  });

  it('falls through to the body when the frontmatter has no match', async () => {
    const getBody = stubReplaceFlow(FM_NOTE, 0);

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        scope: 'both',
        replacements: [{ search: 'Body text', replace: 'Prose', replaceAll: false }],
      }),
      createMockContext({ errors: obsidianReplaceInNote.errors }),
    );

    expect(getBody()).toBe(FM_NOTE.replace('Body text', 'Prose'));
    expect(out.perReplacement).toEqual([
      { search: 'Body text', count: 1, bodyCount: 1, frontmatterCount: 0 },
    ]);
  });
});

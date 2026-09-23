/**
 * @fileoverview Handler tests for obsidian_manage_tags (list/add/remove).
 * @module tests/tools/obsidian-manage-tags.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianManageTags } from '@/mcp-server/tools/definitions/obsidian-manage-tags.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

/** The recovery hint the tool's own contract declares, so the test cannot drift from it. */
function declaredRecovery(reason: string): string {
  const entry = obsidianManageTags.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`obsidian_manage_tags declares no '${reason}' contract entry`);
  return entry.recovery;
}

const noteJson = (
  content: string,
  frontmatter: Record<string, unknown> = {},
  tags: string[] = [],
) => ({
  path: 'N.md',
  content,
  frontmatter,
  tags,
  stat: { ctime: 0, mtime: 0, size: content.length },
});

describe('obsidian_manage_tags / list', () => {
  it('splits frontmatter and inline tags and reports the union', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(
        200,
        noteJson('Body has #foo and #bar.', { tags: ['foo', 'baz'] }, ['foo', 'bar', 'baz']),
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'list',
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    if (out.result.operation !== 'list') throw new Error('expected list branch');
    expect(out.result.tags.frontmatter).toEqual(['foo', 'baz']);
    expect(out.result.tags.inline).toEqual(['foo', 'bar']);
    expect(out.result.tags.all.sort()).toEqual(['bar', 'baz', 'foo']);
  });
});

describe('obsidian_manage_tags / add', () => {
  it('writes back when applied is non-empty and reports the post-state tag set', async () => {
    let putCalls = 0;
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('Body without inline tags.', { tags: ['existing'] }, ['existing']), {
        headers: { 'content-type': 'application/json' },
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putCalls++;
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(
        200,
        noteJson(putBody || 'body', { tags: ['existing', 'fresh'] }, ['existing', 'fresh']),
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'add',
        tags: ['fresh'],
        location: 'frontmatter',
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    expect(putCalls).toBe(1);
    if (out.result.operation !== 'add') throw new Error('expected add branch');
    expect(out.result.applied).toEqual(['fresh']);
    expect(out.result.tags).toEqual(['existing', 'fresh']);
    expect(out.result.previousSizeInBytes).toBe(
      Buffer.byteLength('Body without inline tags.', 'utf8'),
    );
    /** Post-write GET already happens for the tag list echo — currentSize derives
     * from Buffer.byteLength of that upstream-returned body (mock returns 'body'). */
    expect(out.result.currentSizeInBytes).toBe(4);
  });

  it('skips both the write and the post-fetch when no tag changed', async () => {
    const body = ['---', 'tags: [existing]', '---', '', 'body'].join('\n');
    let putCalls = 0;
    let getCalls = 0;
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(() => {
        getCalls++;
        return {
          statusCode: 200,
          data: noteJson(body, { tags: ['existing'] }, ['existing']),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply(() => {
        putCalls++;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'add',
        tags: ['existing'],
        location: 'frontmatter',
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    expect(putCalls).toBe(0);
    expect(getCalls).toBe(1);
    if (out.result.operation !== 'add') throw new Error('expected add branch');
    expect(out.result.applied).toEqual([]);
    expect(out.result.skipped).toEqual(['existing']);
  });
});

describe('obsidian_manage_tags / remove', () => {
  it('throws tags_required (ValidationError) when tags is empty/missing', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('body', { tags: ['a'] }, ['a']), {
        headers: { 'content-type': 'application/json' },
      });

    await expect(
      obsidianManageTags.handler(
        obsidianManageTags.input.parse({
          target: { type: 'path', path: 'N.md' },
          operation: 'remove',
        }),
        createMockContext({ errors: obsidianManageTags.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'tags_required' },
    });
  });
});

/**
 * Issue #123 1b. `tags:` is a free-form YAML sequence and a vault may well
 * carry entries this server has no opinion about. Replacing the whole node
 * with the normalized string set silently dropped every one of them — a
 * write, so unrecoverable. The sequence is edited in place instead: new
 * scalars are appended, only matching string items are removed, and anything
 * else survives byte for byte alongside its comments and quoting.
 */
describe('obsidian_manage_tags / a mixed-type tags sequence keeps its non-string entries', () => {
  const MIXED = [
    '---',
    'tags:',
    '  - keep # a trailing comment',
    '  - 42',
    '  - { meta: preserved }',
    'other: yes',
    '---',
    'body',
  ].join('\n');

  async function run(operation: 'add' | 'remove', tags: string[]): Promise<string> {
    let putBody = '';
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(MIXED, { tags: ['keep'] }, ['keep']), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('after', {}, []), { headers: { 'content-type': 'application/json' } });

    await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation,
        tags,
        location: 'frontmatter',
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );
    return putBody;
  }

  it('appends without rewriting the entries it does not recognize', async () => {
    const putBody = await run('add', ['added']);

    expect(putBody).toContain('- 42');
    expect(putBody).toContain('{ meta: preserved }');
    expect(putBody).toContain('- added');
    expect(putBody).toContain('# a trailing comment');
    expect(putBody).toContain('other: yes');
  });

  it('removes only the matching string item', async () => {
    const putBody = await run('remove', ['keep']);

    expect(putBody).not.toContain('- keep');
    expect(putBody).toContain('- 42');
    expect(putBody).toContain('{ meta: preserved }');
  });
});

/**
 * Issue #125 3a. `doc.toString()` emits LF, and the fences were hard-coded to
 * LF too, so re-serializing a CRLF note's block left an LF block sitting above
 * a CRLF body. The block is emitted with the line ending it already had.
 */
describe('obsidian_manage_tags / a CRLF note stays CRLF through a frontmatter rewrite', () => {
  it('emits the block and both fences with CRLF', async () => {
    const before = '---\r\ntitle: a\r\ntags:\r\n  - x\r\n---\r\n\r\nBody.\r\n';
    let putBody = '';
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(before, { tags: ['x'] }, ['x']), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('after', {}, []), { headers: { 'content-type': 'application/json' } });

    await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'add',
        tags: ['y'],
        location: 'frontmatter',
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    expect(putBody).toBe('---\r\ntitle: a\r\ntags:\r\n  - x\r\n  - y\r\n---\r\n\r\nBody.\r\n');
    expect(/[^\r]\n/.test(putBody)).toBe(false);
  });
});

/**
 * Issue #124: a block that cannot be mutated safely fails as the declared,
 * typed error rather than escaping as an undeclared `-32603`, and the note is
 * left byte-identical — asserted as the absence of any PUT. Under
 * `location: "both"` the refusal covers the inline half too: the note is not
 * half-tagged on the strength of a frontmatter edit that never landed.
 */
describe('obsidian_manage_tags / refuses an unsafe frontmatter block', () => {
  async function addTag(content: string, location: 'frontmatter' | 'both'): Promise<number> {
    const pool = harness.current().pool;
    let puts = 0;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(content, {}, []), { headers: { 'content-type': 'application/json' } });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
      puts++;
      return { statusCode: 200, data: '' };
    });

    await expect(
      obsidianManageTags.handler(
        obsidianManageTags.input.parse({
          target: { type: 'path', path: 'N.md' },
          operation: 'add',
          tags: ['added'],
          location,
        }),
        createMockContext({ errors: obsidianManageTags.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'frontmatter_invalid', path: 'N.md' },
    });

    return puts;
  }

  it('carries frontmatter_invalid to both wire surfaces', async () => {
    const pool = harness.current().pool;
    let puts = 0;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('---\nParagraph between rules\n---\nBody after', {}, []), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
      puts++;
      return { statusCode: 200, data: '' };
    });

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'add',
      tags: ['added'],
      location: 'both',
    });

    expect(res.isError).toBe(true);
    const error = (res.structuredContent as { error: { code: number; data: { reason: string } } })
      .error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('frontmatter_invalid');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('not safely editable');
    expect(text).toContain(declaredRecovery('frontmatter_invalid'));
    expect(puts).toBe(0);
  });

  it.each([
    ['a scalar YAML root (#124 r3)', '---\nParagraph between rules\n---\nBody after'],
    ['YAML that does not parse', '---\na: "unterminated\nkeep: yes\n---\nBody\n'],
    ['an unresolved alias', '---\nbad: *missing\nkeep: yes\n---\nbody'],
  ])('refuses and writes nothing for %s', async (_label, content) => {
    expect(await addTag(content, 'frontmatter')).toBe(0);
  });

  it('makes no partial inline edit under location "both"', async () => {
    expect(await addTag('---\nParagraph between rules\n---\nBody after', 'both')).toBe(0);
  });
});

describe('obsidian_manage_tags / remove inline — byte fidelity through the handler', () => {
  const RICH = [
    '---',
    'title: Q3 #wip planning',
    'tags:',
    '  - keepme',
    '---',
    '',
    '# Plan #wip',
    '',
    'Hard break here.  ',
    'Continuation.',
    '',
    '- Top level',
    '    - Nested child',
    '',
    '| a | b     |',
    '| - | ----- |',
    '| x | y     |',
    '',
  ].join('\n');

  const EXPECTED = RICH.replace('# Plan #wip', '# Plan');

  it('writes back only the removal site and reports it on both consumption surfaces', async () => {
    let putBody = '';
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(RICH, { tags: ['keepme'] }, ['keepme', 'wip']), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(EXPECTED, { tags: ['keepme'] }, ['keepme']), {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'remove',
        location: 'inline',
        tags: ['wip'],
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    expect(putBody).toBe(EXPECTED);
    if (out.result.operation !== 'remove') throw new Error('expected remove branch');
    expect(out.result.applied).toEqual(['wip']);

    const render = obsidianManageTags.format;
    if (!render) throw new Error('obsidian_manage_tags declares no format()');
    const text = render(out)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toContain('wip');
    expect(text).toContain('N.md');
  });

  it('does not treat a #tag inside a frontmatter scalar as an inline tag', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(RICH, { tags: ['keepme'] }, ['keepme', 'wip']), {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'list',
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    if (out.result.operation !== 'list') throw new Error('expected list branch');
    expect(out.result.tags.inline).toEqual(['wip']);
    expect(out.result.tags.frontmatter).toEqual(['keepme']);
  });
});

/**
 * A heading anchor is a link, not a tag. `remove` used to rewrite the link and
 * report the anchor as applied, leaving nothing in the file to reconstruct the
 * target from.
 */
describe('obsidian_manage_tags / link spans are not inline tags', () => {
  const LINKED = 'see [[#Overview & Notes]] here\nand [Chat #support](https://example.dev)\n';

  it('reports no inline tag for a heading anchor, and reads markdown link text', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(LINKED, { tags: ['keepme'] }, ['keepme']), {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'list',
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    if (out.result.operation !== 'list') throw new Error('expected list branch');
    expect(out.result.tags.inline).toEqual(['support']);
    expect(out.result.tags.all).toEqual(['keepme', 'support']);

    const render = obsidianManageTags.format;
    if (!render) throw new Error('obsidian_manage_tags declares no format()');
    const text = render(out)
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('\n');
    expect(text).toContain('*Inline (1):* `#support`');
    expect(text).toContain('`#keepme`');
  });

  it('skips the removal and issues no write when the only match is inside a link', async () => {
    let putCalls = 0;
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(LINKED, { tags: ['keepme'] }, ['keepme']), {
        headers: { 'content-type': 'application/json' },
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply(() => {
        putCalls++;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'remove',
        location: 'inline',
        tags: ['Overview'],
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    expect(putCalls).toBe(0);
    if (out.result.operation !== 'remove') throw new Error('expected remove branch');
    expect(out.result.applied).toEqual([]);
    expect(out.result.skipped).toEqual(['Overview']);
    expect(out.result.currentSizeInBytes).toBe(out.result.previousSizeInBytes);
  });

  it('still removes a real tag sitting immediately beside a link', async () => {
    const before = '#work [[Note#Heading]] end\n';
    const after = '[[Note#Heading]] end\n';
    let putBody = '';
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(before, {}, ['work']), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(after, {}, []), { headers: { 'content-type': 'application/json' } });

    const out = await obsidianManageTags.handler(
      obsidianManageTags.input.parse({
        target: { type: 'path', path: 'N.md' },
        operation: 'remove',
        location: 'inline',
        tags: ['work'],
      }),
      createMockContext({ errors: obsidianManageTags.errors }),
    );

    expect(putBody).toBe(after);
    if (out.result.operation !== 'remove') throw new Error('expected remove branch');
    expect(out.result.applied).toEqual(['work']);
  });
});

/**
 * Obsidian's tag grammar at the handler: a leading digit and non-ASCII
 * characters are tags, an all-digit run and a hash glued to a preceding letter
 * are not. Issue #127.
 */
describe("obsidian_manage_tags / Obsidian's tag grammar", () => {
  const BODY = 'Plans for #1990s, #café, #日本語 and #✅done. Not tags: #1984 café#tag\n';

  it('lists exactly the inline tags Obsidian reports, on both surfaces', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(
        200,
        noteJson(BODY, { tags: ['keepme'] }, ['keepme', '1990s', 'café', '日本語', '✅done']),
        {
          headers: { 'content-type': 'application/json' },
        },
      );

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'list',
    });

    expect(res.isError).toBeFalsy();
    const { result } = obsidianManageTags.output.parse(res.structuredContent);
    if (result.operation !== 'list') throw new Error('expected list branch');
    expect(result.tags.inline).toEqual(['1990s', 'café', '日本語', '✅done']);
    expect(result.tags.all).toEqual(['keepme', '1990s', 'café', '日本語', '✅done']);
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Inline (4):* `#1990s` `#café` `#日本語` `#✅done`');
    expect(text).not.toContain('#1984`');
  });

  it('removes a leading-digit and a non-ASCII tag and writes back only those sites', async () => {
    // Each tag goes with the space before it; the commas that followed stay.
    const after = 'Plans for,, #日本語 and #✅done. Not tags: #1984 café#tag\n';
    let putBody = '';
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(BODY, {}, ['1990s', 'café', '日本語', '✅done']), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(after, {}, ['日本語', '✅done']), {
        headers: { 'content-type': 'application/json' },
      });

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'remove',
      location: 'inline',
      tags: ['1990s', 'café'],
    });

    expect(res.isError).toBeFalsy();
    expect(putBody).toBe(after);
    const { result } = obsidianManageTags.output.parse(res.structuredContent);
    if (result.operation !== 'remove') throw new Error('expected remove branch');
    expect(result.applied).toEqual(['1990s', 'café']);
    expect(result.skipped).toEqual([]);
    expect(result.tags).toEqual(['日本語', '✅done']);
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Applied (2):* `#1990s` `#café`');
  });

  it('skips a prefix of a non-ASCII tag and issues no write', async () => {
    let puts = 0;
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(BODY, {}, ['1990s', 'café', '日本語', '✅done']), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
      puts++;
      return { statusCode: 200, data: '' };
    });

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'remove',
      location: 'inline',
      tags: ['caf'],
    });

    expect(puts).toBe(0);
    const { result } = obsidianManageTags.output.parse(res.structuredContent);
    if (result.operation !== 'remove') throw new Error('expected remove branch');
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['caf']);
  });
});

/**
 * Block and inline structure at the handler: code (fenced and indented), HTML
 * blocks, and a link's destination hide their tags, while link text, a table
 * cell, emphasis, and a glued tag expose theirs — on both consumption
 * surfaces. Issues #139 and #140.
 */
describe('obsidian_manage_tags / tags Obsidian hides in blocks and reads in markup', () => {
  const BODY = [
    '```typescript',
    'x #tu',
    '```',
    'prose #tv',
    '',
    '    #sa indented code',
    '',
    '<div>',
    '#tp',
    '</div>',
    '',
    '[Discord #tf](https://x.y/#frag), x _#uc_ y, #tl#tm',
    '',
    '|a|b|',
    '|-|-|',
    '|#uo|x|',
    '',
  ].join('\n');
  const READ = ['tv', 'tf', 'uc', 'tl', 'tm', 'uo'];

  it('lists exactly the tags Obsidian reads, on both surfaces', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(BODY, {}, READ), { headers: { 'content-type': 'application/json' } });

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'list',
    });

    expect(res.isError).toBeFalsy();
    const { result } = obsidianManageTags.output.parse(res.structuredContent);
    if (result.operation !== 'list') throw new Error('expected list branch');
    expect(result.tags.inline).toEqual(READ);
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Inline (6):* `#tv` `#tf` `#uc` `#tl` `#tm` `#uo`');
  });

  it('lists no inline tag for a note whose every hash is hidden', async () => {
    const hidden = '```\n#tu\n```\n\n    #sa\n\n<div>\n#tp\n</div>\n';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(hidden, {}, []), { headers: { 'content-type': 'application/json' } });

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'list',
    });

    const { result } = obsidianManageTags.output.parse(res.structuredContent);
    if (result.operation !== 'list') throw new Error('expected list branch');
    expect(result.tags.inline).toEqual([]);
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Inline (0):* _(none)_');
  });

  it('skips hidden tags and issues no write', async () => {
    let puts = 0;
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(BODY, {}, READ), { headers: { 'content-type': 'application/json' } });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
      puts++;
      return { statusCode: 200, data: '' };
    });

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'remove',
      location: 'inline',
      tags: ['tu', 'sa', 'tp', 'frag'],
    });

    expect(puts).toBe(0);
    const { result } = obsidianManageTags.output.parse(res.structuredContent);
    if (result.operation !== 'remove') throw new Error('expected remove branch');
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['tu', 'sa', 'tp', 'frag']);
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Skipped (4):*');
  });

  it('removes read tags and writes back only those sites', async () => {
    const after = BODY.replace('prose #tv', 'prose')
      .replace('x _#uc_ y', 'x __ y')
      .replace('#tl#tm', '#tm')
      .replace('[Discord #tf]', '[Discord]')
      .replace('|#uo|x|', '||x|');
    let putBody = '';
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(BODY, {}, READ), { headers: { 'content-type': 'application/json' } });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(after, {}, ['tm']), { headers: { 'content-type': 'application/json' } });

    const res = await runToolContract(obsidianManageTags, {
      target: { type: 'path', path: 'N.md' },
      operation: 'remove',
      location: 'inline',
      tags: ['tv', 'tf', 'uc', 'tl', 'uo'],
    });

    expect(res.isError).toBeFalsy();
    expect(putBody).toBe(after);
    const { result } = obsidianManageTags.output.parse(res.structuredContent);
    if (result.operation !== 'remove') throw new Error('expected remove branch');
    expect(result.applied).toEqual(['tv', 'tf', 'uc', 'tl', 'uo']);
    expect(result.tags).toEqual(['tm']);
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Applied (5):* `#tv` `#tf` `#uc` `#tl` `#uo`');
  });
});

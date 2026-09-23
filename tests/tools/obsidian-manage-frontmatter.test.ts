/**
 * @fileoverview Handler tests for obsidian_manage_frontmatter (get/set/delete).
 * @module tests/tools/obsidian-manage-frontmatter.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianManageFrontmatter } from '@/mcp-server/tools/definitions/obsidian-manage-frontmatter.tool.js';
import { instructionOf, servePluginVersion, setupHarness } from '../helpers.js';

const harness = setupHarness();

/** The recovery hint the tool's own contract declares, so the test cannot drift from it. */
function declaredRecovery(reason: string): string {
  const entry = obsidianManageFrontmatter.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`obsidian_manage_frontmatter declares no '${reason}' contract entry`);
  return entry.recovery;
}

const noteJson = (content: string, frontmatter: Record<string, unknown>) => ({
  path: 'N.md',
  content,
  frontmatter,
  tags: [],
  stat: { ctime: 0, mtime: 0, size: content.length },
});

describe('obsidian_manage_frontmatter / get', () => {
  it('returns the value when the key exists', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('body', { priority: 5 }), {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianManageFrontmatter.handler(
      obsidianManageFrontmatter.input.parse({
        operation: 'get',
        target: { type: 'path', path: 'N.md' },
        key: 'priority',
      }),
      createMockContext({ errors: obsidianManageFrontmatter.errors }),
    );

    if (out.result.operation !== 'get') throw new Error('expected get branch');
    expect(out.result.exists).toBe(true);
    expect(out.result.value).toBe(5);
  });

  it('reports exists=false when the key is absent', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('body', {}), { headers: { 'content-type': 'application/json' } });

    const out = await obsidianManageFrontmatter.handler(
      obsidianManageFrontmatter.input.parse({
        operation: 'get',
        target: { type: 'path', path: 'N.md' },
        key: 'priority',
      }),
      createMockContext({ errors: obsidianManageFrontmatter.errors }),
    );
    if (out.result.operation !== 'get') throw new Error('expected get branch');
    expect(out.result.exists).toBe(false);
    expect(out.result.value).toBeNull();
  });
});

describe('obsidian_manage_frontmatter / set', () => {
  it('PATCHes a 2.0 frontmatter instruction on plugin v5.x and reports it on both surfaces', async () => {
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': '50' } });
    servePluginVersion(pool, '5.2.0');

    let instruction: Record<string, unknown> = {};
    let contentType = '';
    pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply((opts) => {
      instruction = instructionOf(opts);
      contentType = opts.headers['Content-Type'] ?? opts.headers['content-type'] ?? '';
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('---\ntags:\n  - a\n---\nbody', { tags: ['a'] }), {
        headers: { 'content-type': 'application/json' },
      });

    const res = await runToolContract(obsidianManageFrontmatter, {
      operation: 'set',
      target: { type: 'path', path: 'N.md' },
      key: 'tags',
      value: ['a'],
    });

    expect(res.isError).toBeFalsy();
    expect(contentType).toBe('application/vnd.olrapi.patch-instruction+json');
    expect(instruction).toEqual({
      targetType: 'frontmatter',
      target: 'tags',
      operation: 'replace',
      value: ['a'],
      createTargetIfMissing: true,
      rejectIfContentPreexists: true,
    });
    expect(res.structuredContent).toMatchObject({
      result: { operation: 'set', path: 'N.md', key: 'tags', frontmatter: { tags: ['a'] } },
    });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('tags');
  });

  it('PATCHes the frontmatter field with JSON content type and refetches (plugin v4.x)', async () => {
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': '50' } });
    servePluginVersion(pool, '4.2.0');

    let seenHeaders: Record<string, string> = {};
    let seenBody = '';
    pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('body', { priority: 9 }), {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianManageFrontmatter.handler(
      obsidianManageFrontmatter.input.parse({
        operation: 'set',
        target: { type: 'path', path: 'N.md' },
        key: 'priority',
        value: 9,
      }),
      createMockContext({ errors: obsidianManageFrontmatter.errors }),
    );

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('replace');
    expect(seenHeaders['target-type'] ?? seenHeaders['Target-Type']).toBe('frontmatter');
    expect(seenHeaders['content-type'] ?? seenHeaders['Content-Type']).toBe('application/json');
    expect(seenBody).toBe('9');
    if (out.result.operation !== 'set') throw new Error('expected set branch');
    expect(out.result.frontmatter).toEqual({ priority: 9 });
    expect(out.result.previousSizeInBytes).toBe(50);
    /** Post-state read from the post-PATCH GET — currentSize derives from
     * Buffer.byteLength of the upstream-returned body. */
    expect(out.result.currentSizeInBytes).toBe(Buffer.byteLength('body', 'utf8'));
  });

  it('throws value_required (ValidationError) when value is missing for set', async () => {
    await expect(
      obsidianManageFrontmatter.handler(
        obsidianManageFrontmatter.input.parse({
          operation: 'set',
          target: { type: 'path', path: 'N.md' },
          key: 'priority',
        }),
        createMockContext({ errors: obsidianManageFrontmatter.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'value_required' },
    });
  });
});

describe('obsidian_manage_frontmatter / delete', () => {
  it('reads, strips the key, writes the file, and projects the post-state frontmatter without a refetch', async () => {
    const before = ['---', 'priority: 5', 'author: casey', '---', '', 'body'].join('\n');
    let putBody = '';
    let getCount = 0;
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(() => {
      getCount++;
      return {
        statusCode: 200,
        data: noteJson(before, { priority: 5, author: 'casey' }),
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    /** Post-write HEAD — currentSizeInBytes is read from upstream after the write. */
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': '20' } });

    const out = await obsidianManageFrontmatter.handler(
      obsidianManageFrontmatter.input.parse({
        operation: 'delete',
        target: { type: 'path', path: 'N.md' },
        key: 'priority',
      }),
      createMockContext({ errors: obsidianManageFrontmatter.errors }),
    );

    expect(getCount).toBe(1);
    expect(putBody).not.toContain('priority:');
    if (out.result.operation !== 'delete') throw new Error('expected delete branch');
    expect(out.result.frontmatter).toEqual({ author: 'casey' });
    expect(out.result.previousSizeInBytes).toBe(Buffer.byteLength(before, 'utf8'));
    expect(out.result.currentSizeInBytes).toBe(20);
  });
});

/**
 * A delete is a read-modify-write, so a frontmatter block the helper cannot
 * re-emit faithfully is a block it must refuse to rewrite at all. Issues #123
 * and #124: each of these either silently destroyed the block (the whole of
 * it, keys the caller never named included) or escaped as an undeclared
 * `-32603`. The note must come out byte-identical, which is asserted as the
 * absence of any PUT, and the failure must be the typed, declared one.
 */
describe('obsidian_manage_frontmatter / delete refuses an unsafe frontmatter block', () => {
  /** Runs a delete against `content`, counting writes. */
  async function deleteKey(content: string, key: string): Promise<{ puts: number }> {
    const pool = harness.current().pool;
    let puts = 0;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(content, {}), { headers: { 'content-type': 'application/json' } });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
      puts++;
      return { statusCode: 200, data: '' };
    });

    await expect(
      obsidianManageFrontmatter.handler(
        obsidianManageFrontmatter.input.parse({
          operation: 'delete',
          target: { type: 'path', path: 'N.md' },
          key,
        }),
        createMockContext({ errors: obsidianManageFrontmatter.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'frontmatter_invalid', path: 'N.md' },
    });

    return { puts };
  }

  it('carries frontmatter_invalid to both wire surfaces', async () => {
    const pool = harness.current().pool;
    let puts = 0;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('---\na: "unterminated\nkeep: yes\n---\nBody\n', {}), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
      puts++;
      return { statusCode: 200, data: '' };
    });

    const res = await runToolContract(obsidianManageFrontmatter, {
      operation: 'delete',
      target: { type: 'path', path: 'N.md' },
      key: 'a',
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
    ['the YAML does not parse (#123 1a)', '---\na: "unterminated\nkeep: yes\n---\nBody\n', 'a'],
    [
      'an unresolved alias makes the block unserializable (#124 r1)',
      '---\nbad: *missing\nvictim: delete-me\n---\nbody',
      'victim',
    ],
    [
      'deleting the anchor owner would leave a dangling alias (#124 r2)',
      '---\nbase: &base\n  kept: yes\nconsumer: *base\n---\nbody',
      'base',
    ],
    ['the YAML root is not a mapping', '---\nParagraph between rules\n---\nBody after', 'anything'],
  ])('refuses and writes nothing when %s', async (_label, content, key) => {
    const { puts } = await deleteKey(content, key);
    expect(puts).toBe(0);
  });
});

/**
 * Issue #125 3b: when the last key goes, the block goes with it — but only the
 * whitespace-only separator lines between the fence and the body. The first
 * content line keeps its own indentation, which an indented code block is made
 * of.
 */
describe('obsidian_manage_frontmatter / dropping the block keeps body indentation', () => {
  it('strips only the separator lines, not the code block that follows', async () => {
    const before = '---\ntags: [a]\n---\n\n    indented code line\n    second line\n';
    let putBody = '';
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson(before, { tags: ['a'] }), {
        headers: { 'content-type': 'application/json' },
      });
    pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
      putBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': '40' } });

    await obsidianManageFrontmatter.handler(
      obsidianManageFrontmatter.input.parse({
        operation: 'delete',
        target: { type: 'path', path: 'N.md' },
        key: 'tags',
      }),
      createMockContext({ errors: obsidianManageFrontmatter.errors }),
    );

    expect(putBody).toBe('    indented code line\n    second line\n');
  });
});

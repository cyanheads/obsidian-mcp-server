/**
 * @fileoverview Handler tests for obsidian_manage_frontmatter (get/set/delete).
 * @module tests/tools/obsidian-manage-frontmatter.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianManageFrontmatter } from '@/mcp-server/tools/definitions/obsidian-manage-frontmatter.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

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
      createMockContext(),
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
      createMockContext(),
    );
    if (out.result.operation !== 'get') throw new Error('expected get branch');
    expect(out.result.exists).toBe(false);
    expect(out.result.value).toBeNull();
  });
});

describe('obsidian_manage_frontmatter / set', () => {
  it('PATCHes the frontmatter field with JSON content type and refetches', async () => {
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': '50' } });

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
      createMockContext(),
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
      createMockContext(),
    );

    expect(getCount).toBe(1);
    expect(putBody).not.toContain('priority:');
    if (out.result.operation !== 'delete') throw new Error('expected delete branch');
    expect(out.result.frontmatter).toEqual({ author: 'casey' });
    expect(out.result.previousSizeInBytes).toBe(Buffer.byteLength(before, 'utf8'));
    expect(out.result.currentSizeInBytes).toBe(20);
  });
});

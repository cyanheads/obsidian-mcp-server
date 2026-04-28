/**
 * @fileoverview Handler tests for obsidian_manage_tags (list/add/remove).
 * @module tests/tools/obsidian-manage-tags.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianManageTags } from '@/mcp-server/tools/definitions/obsidian-manage-tags.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

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
      createMockContext(),
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
      createMockContext(),
    );

    expect(putCalls).toBe(1);
    if (out.result.operation !== 'add') throw new Error('expected add branch');
    expect(out.result.applied).toEqual(['fresh']);
    expect(out.result.tags).toEqual(['existing', 'fresh']);
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
      createMockContext(),
    );

    expect(putCalls).toBe(0);
    expect(getCalls).toBe(1);
    if (out.result.operation !== 'add') throw new Error('expected add branch');
    expect(out.result.applied).toEqual([]);
    expect(out.result.skipped).toEqual(['existing']);
  });
});

describe('obsidian_manage_tags / remove', () => {
  it('throws InvalidParams when tags is empty/missing', async () => {
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
        createMockContext(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
  });
});

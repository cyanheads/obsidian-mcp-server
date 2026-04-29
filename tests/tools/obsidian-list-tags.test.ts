/**
 * @fileoverview Handler tests for obsidian_list_tags.
 * @module tests/tools/obsidian-list-tags.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianListTags } from '@/mcp-server/tools/definitions/obsidian-list-tags.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian_list_tags', () => {
  it('returns tags from the upstream payload', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(
        200,
        {
          tags: [
            { name: 'work', count: 5 },
            { name: 'work/tasks', count: 3 },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianListTags.handler(
      obsidianListTags.input.parse({}),
      createMockContext(),
    );
    expect(out.tags).toEqual([
      { name: 'work', count: 5 },
      { name: 'work/tasks', count: 3 },
    ]);
  });

  it('handles an empty tag list gracefully', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(200, { tags: [] }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListTags.handler(
      obsidianListTags.input.parse({}),
      createMockContext(),
    );
    expect(out.tags).toEqual([]);
  });
});

describe('obsidian_list_tags / format()', () => {
  it('renders each tag with its count', () => {
    const blocks = obsidianListTags.format!({ tags: [{ name: 'foo', count: 2 }] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('#foo');
    expect(text).toContain('(2)');
  });

  it('renders an empty-state message when there are no tags', () => {
    const blocks = obsidianListTags.format!({ tags: [] });
    expect((blocks[0] as { text: string }).text).toMatch(/no tags/i);
  });
});

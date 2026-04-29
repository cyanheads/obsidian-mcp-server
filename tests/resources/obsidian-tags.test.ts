/**
 * @fileoverview Handler tests for the obsidian://tags resource.
 * @module tests/resources/obsidian-tags.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianTags } from '@/mcp-server/resources/definitions/obsidian-tags.resource.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian://tags', () => {
  it('returns tags as { name, count }', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(
        200,
        { tags: [{ name: 'work', count: 4 }] },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianTags.handler(
      obsidianTags.params!.parse({}),
      createMockContext({ uri: new URL('obsidian://tags') }),
    );
    expect(out.tags).toEqual([{ name: 'work', count: 4 }]);
  });
});

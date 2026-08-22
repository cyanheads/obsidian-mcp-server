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

/**
 * Characterization — the resource is deliberately NOT the tool. `obsidian_list_tags`
 * sorts by count and caps; this resource keeps snapshot semantics, returning the
 * upstream payload whole and in upstream order. Both call the same
 * `ObsidianService.listTags`, so this pins that the tool's shaping lives in the
 * tool handler and cannot leak down into the shared service path.
 */
describe('obsidian://tags — snapshot semantics, unsorted and uncapped', () => {
  /** Deliberately not count-descending, so a sort would be visible. */
  const UPSTREAM = [
    { name: 'alpha', count: 1 },
    { name: 'beta', count: 97 },
    { name: 'gamma', count: 12 },
    { name: 'delta', count: 5 },
  ];

  it('preserves upstream order', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(200, { tags: UPSTREAM }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianTags.handler(
      obsidianTags.params!.parse({}),
      createMockContext({ uri: new URL('obsidian://tags') }),
    );
    expect(out.tags).toEqual(UPSTREAM);
    expect(out.tags.map((t) => t.name)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  it('returns every tag past the tool default cap of 200', async () => {
    const many = Array.from({ length: 260 }, (_, i) => ({ name: `t${i}`, count: 260 - i }));
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(200, { tags: many }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianTags.handler(
      obsidianTags.params!.parse({}),
      createMockContext({ uri: new URL('obsidian://tags') }),
    );
    expect(out.tags).toHaveLength(260);
  });
});

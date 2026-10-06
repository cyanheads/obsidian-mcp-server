/**
 * @fileoverview Handler tests for the obsidian://tags resource.
 * @module tests/resources/obsidian-tags.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { obsidianTags } from '@/mcp-server/resources/definitions/obsidian-tags.resource.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse, setupHarness } from '../helpers.js';

const harness = setupHarness();

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

/**
 * Under `OBSIDIAN_READ_PATHS` the resource reads per-note tags through one
 * JsonLogic search and keeps only readable notes. The stub also answers
 * `/tags/` vault-wide, so ignoring the scope would surface `secret`.
 */
describe('obsidian://tags — OBSIDIAN_READ_PATHS scope', () => {
  afterEach(() => {
    setObsidianService(undefined);
  });

  it('lists only tags from readable notes, counted per note, in first-appearance order', async () => {
    const paths: string[] = [];
    const fetchImpl: ObsidianFetch = async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      const body =
        path === '/search/'
          ? [
              { filename: 'Work/a.md', result: ['work/a', 'work/b'] },
              { filename: 'Private/p.md', result: ['secret', 'work/a'] },
              { filename: 'Work/b.md', result: ['alpha', 'work/a'] },
            ]
          : { tags: [{ name: 'secret', count: 1 }] };
      return mockResponse(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    setObsidianService(new ObsidianService(makeTestConfig({ readPaths: ['work'] }), fetchImpl));

    const out = await obsidianTags.handler(
      obsidianTags.params!.parse({}),
      createMockContext({ uri: new URL('obsidian://tags') }),
    );
    expect(obsidianTags.output!.parse(out)).toEqual({
      tags: [
        { name: 'work', count: 2 },
        { name: 'work/a', count: 2 },
        { name: 'work/b', count: 1 },
        { name: 'alpha', count: 1 },
      ],
    });
    expect(paths).toEqual(['/search/']);
  });

  it('states the scoped count and the scoped first-appearance order', () => {
    const tags = obsidianTags.output!.shape.tags;
    expect(tags.element.shape.count.description).toMatch(
      /When OBSIDIAN_READ_PATHS is set: the number of readable notes carrying the tag or a tag nested under it\./,
    );
    expect(tags.description).toMatch(
      /When OBSIDIAN_READ_PATHS is set: every tag carried by a readable note, in order of first appearance\./,
    );
  });
});

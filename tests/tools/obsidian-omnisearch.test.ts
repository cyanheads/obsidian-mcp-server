/**
 * @fileoverview Handler tests for obsidian_omnisearch — exercises the full
 * pipeline (input parse → service fetch → path-policy filter → cap + clip →
 * format()) against a stub fetch, plus the omnisearch_unreachable error
 * contract on transport failures.
 * @module tests/tools/obsidian-omnisearch.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { obsidianOmnisearch } from '@/mcp-server/tools/definitions/obsidian-omnisearch.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import {
  type OmnisearchFetch,
  OmnisearchService,
  setOmnisearchService,
} from '@/services/omnisearch/omnisearch-service.js';
import { makeTestConfig, setupHarness } from '../helpers.js';

const obsidianHarness = setupHarness();

interface MockHit {
  basename: string;
  excerpt?: string;
  foundWords: string[];
  matches: Array<{ match: string; offset: number }>;
  path: string;
  score: number;
  vault: string;
}

function installOmnisearch(hits: MockHit[] | (() => Response)): void {
  const fetchImpl: OmnisearchFetch = async () => {
    if (typeof hits === 'function') return hits() as unknown as Response;
    return new Response(JSON.stringify(hits), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  setOmnisearchService(new OmnisearchService(makeTestConfig(), fetchImpl));
}

function mockHit(over: Partial<MockHit> = {}): MockHit {
  return {
    basename: 'note',
    foundWords: ['x'],
    matches: [{ match: 'x', offset: 0 }],
    path: 'note.md',
    score: 1,
    vault: 'test',
    ...over,
  };
}

afterEach(() => {
  setOmnisearchService(undefined);
});

describe('obsidian_omnisearch / happy path', () => {
  it('returns upstream hits with score ordering preserved', async () => {
    installOmnisearch([mockHit({ path: 'a.md', score: 10 }), mockHit({ path: 'b.md', score: 5 })]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x' }),
      createMockContext(),
    );
    expect(out.totalUpstream).toBe(2);
    expect(out.hits.map((h) => h.path)).toEqual(['a.md', 'b.md']);
    expect(out.excluded).toBeUndefined();
  });

  it('preserves basename, excerpt, foundWords', async () => {
    installOmnisearch([
      mockHit({
        path: 'Projects/Plan.md',
        basename: 'Plan',
        excerpt: 'a snippet',
        foundWords: ['plan', 'planning'],
      }),
    ]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'plan' }),
      createMockContext(),
    );
    expect(out.hits[0]).toMatchObject({
      basename: 'Plan',
      excerpt: 'a snippet',
      foundWords: ['plan', 'planning'],
    });
  });

  it('renders format() with parity to structuredContent', async () => {
    installOmnisearch([
      mockHit({
        path: 'Projects/Plan.md',
        basename: 'Plan',
        excerpt: 'snippet',
        score: 2.5,
      }),
    ]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'plan' }),
      createMockContext(),
    );
    const blocks = obsidianOmnisearch.format!(out);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Projects/Plan.md');
    expect(text).toContain('2.50');
    expect(text).toContain('`Plan`');
    expect(text).toContain('snippet');
  });
});

describe('obsidian_omnisearch / caps and clipping', () => {
  it('caps hits at `limit` and surfaces an excluded indicator', async () => {
    const hits = Array.from({ length: 7 }, (_, i) => mockHit({ path: `${i}.md`, score: 7 - i }));
    installOmnisearch(hits);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x', limit: 3 }),
      createMockContext(),
    );
    expect(out.hits).toHaveLength(3);
    expect(out.excluded?.count).toBe(4);
    expect(out.totalUpstream).toBe(7);
  });

  it('clips per-file matches at maxMatchesPerFile with truncated + totalMatches', async () => {
    const manyMatches = Array.from({ length: 12 }, (_, i) => ({
      match: `t${i}`,
      offset: i,
    }));
    installOmnisearch([mockHit({ path: 'busy.md', matches: manyMatches })]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x', maxMatchesPerFile: 3 }),
      createMockContext(),
    );
    expect(out.hits[0]?.matches).toHaveLength(3);
    expect(out.hits[0]?.truncated).toBe(true);
    expect(out.hits[0]?.totalMatches).toBe(12);
  });

  it('drops the matches array entirely when maxMatchesPerFile=0', async () => {
    installOmnisearch([
      mockHit({
        matches: [
          { match: 'a', offset: 0 },
          { match: 'b', offset: 1 },
        ],
      }),
    ]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x', maxMatchesPerFile: 0 }),
      createMockContext(),
    );
    expect(out.hits[0]?.matches).toEqual([]);
    expect(out.hits[0]?.truncated).toBeUndefined();
  });

  it('leaves truncated/totalMatches undefined when matches fit the cap', async () => {
    installOmnisearch([mockHit({ matches: [{ match: 'a', offset: 0 }] })]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x', maxMatchesPerFile: 5 }),
      createMockContext(),
    );
    expect(out.hits[0]?.truncated).toBeUndefined();
    expect(out.hits[0]?.totalMatches).toBeUndefined();
  });
});

describe('obsidian_omnisearch / pathPrefix filter', () => {
  it('applies pathPrefix client-side', async () => {
    installOmnisearch([
      mockHit({ path: 'Papers/a.md' }),
      mockHit({ path: 'Notes/b.md' }),
      mockHit({ path: 'Papers/sub/c.md' }),
    ]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x', pathPrefix: 'Papers/' }),
      createMockContext(),
    );
    expect(out.hits.map((h) => h.path)).toEqual(['Papers/a.md', 'Papers/sub/c.md']);
    expect(out.totalUpstream).toBe(3);
  });

  it('normalizes leading and trailing slashes on pathPrefix', async () => {
    installOmnisearch([mockHit({ path: 'Papers/a.md' }), mockHit({ path: 'Notes/b.md' })]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x', pathPrefix: '/Papers' }),
      createMockContext(),
    );
    expect(out.hits.map((h) => h.path)).toEqual(['Papers/a.md']);
  });
});

describe('obsidian_omnisearch / path-policy', () => {
  it('drops hits outside readPaths silently and preserves totalUpstream', async () => {
    /**
     * Replace the harness ObsidianService with one scoped to `public` so
     * `policy.isReadable` rejects `secret/*` paths. We still need an
     * Obsidian fetch impl, but the test never exercises it.
     */
    const obsFetch: ObsidianFetch = async () => {
      throw new Error('Obsidian service should not be hit by this test');
    };
    setObsidianService(new ObsidianService(makeTestConfig({ readPaths: ['public'] }), obsFetch));
    installOmnisearch([
      mockHit({ path: 'public/a.md' }),
      mockHit({ path: 'secret/b.md' }),
      mockHit({ path: 'public/sub/c.md' }),
    ]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x' }),
      createMockContext(),
    );
    expect(out.hits.map((h) => h.path)).toEqual(['public/a.md', 'public/sub/c.md']);
    expect(out.totalUpstream).toBe(3);
    expect(out.excluded).toBeUndefined();
  });
});

describe('obsidian_omnisearch / upstream failures', () => {
  it('tags HTTP 503 with the omnisearch_unreachable reason', async () => {
    setOmnisearchService(
      new OmnisearchService(makeTestConfig(), async () => new Response('boom', { status: 503 })),
    );
    // Ensure the obsidian service is wired (setupHarness already does this).
    obsidianHarness.current();
    await expect(
      obsidianOmnisearch.handler(
        obsidianOmnisearch.input.parse({ query: 'x' }),
        createMockContext({ errors: obsidianOmnisearch.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'omnisearch_unreachable' },
    });
  });

  it('tags transport failures with the omnisearch_unreachable reason', async () => {
    setOmnisearchService(
      new OmnisearchService(makeTestConfig(), async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:1');
      }),
    );
    obsidianHarness.current();
    await expect(
      obsidianOmnisearch.handler(
        obsidianOmnisearch.input.parse({ query: 'x' }),
        createMockContext({ errors: obsidianOmnisearch.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'omnisearch_unreachable' },
    });
  });
});

describe('obsidian_omnisearch / empty state', () => {
  it('renders a guidance message when there are no hits', async () => {
    installOmnisearch([]);
    const out = await obsidianOmnisearch.handler(
      obsidianOmnisearch.input.parse({ query: 'x' }),
      createMockContext(),
    );
    expect(out.hits).toEqual([]);
    expect(out.totalUpstream).toBe(0);
    const blocks = obsidianOmnisearch.format!(out);
    expect((blocks[0] as { text: string }).text).toMatch(/no matches/i);
  });
});

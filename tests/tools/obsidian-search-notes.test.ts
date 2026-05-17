/**
 * @fileoverview Handler tests for obsidian_search_notes across all four modes,
 * including cursor pagination round-trips and the Omnisearch-conditional
 * branch built via `buildSearchNotesTool({ omnisearchReachable: true })`.
 * @module tests/tools/obsidian-search-notes.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSearchNotesTool,
  obsidianSearchNotes,
} from '@/mcp-server/tools/definitions/obsidian-search-notes.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, setupHarness } from '../helpers.js';

const harness = setupHarness();

const omnisearchTool = buildSearchNotesTool({ omnisearchReachable: true });

describe('obsidian_search_notes / text', () => {
  it('returns text hits and applies pathPrefix client-side', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(
        200,
        [
          {
            filename: 'Projects/A.md',
            score: 0.9,
            matches: [{ context: 'aa', match: { start: 0, end: 1 } }],
          },
          {
            filename: 'Other.md',
            score: 0.8,
            matches: [{ context: 'bb', match: { start: 2, end: 3 } }],
          },
        ],
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({
        mode: 'text',
        query: 'a',
        pathPrefix: 'Projects/',
      }),
      createMockContext(),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    expect(out.result.hits).toHaveLength(1);
    expect(out.result.hits[0]?.filename).toBe('Projects/A.md');
    expect(out.result.totalCount).toBe(1);
    expect(out.result.nextCursor).toBeUndefined();
  });

  it('throws query_required (ValidationError) when query is missing in text mode', async () => {
    await expect(
      obsidianSearchNotes.handler(
        obsidianSearchNotes.input.parse({ mode: 'text', query: undefined }),
        createMockContext({ errors: obsidianSearchNotes.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'query_required' },
    });
  });

  it('throws path_prefix_invalid_mode when pathPrefix is used outside text mode', async () => {
    await expect(
      obsidianSearchNotes.handler(
        obsidianSearchNotes.input.parse({
          mode: 'jsonlogic',
          logic: { var: 'path' },
          pathPrefix: 'Projects/',
        }),
        createMockContext({ errors: obsidianSearchNotes.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('pathPrefix'),
      data: { reason: 'path_prefix_invalid_mode' },
    });
  });

  it('clips matches per hit at the default cap (10) and flags `truncated` + `totalMatches`', async () => {
    const matches = Array.from({ length: 25 }, (_, i) => ({
      context: `c${i}`,
      match: { start: 0, end: 1 },
    }));
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(200, [{ filename: 'busy.md', matches }], {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'x' }),
      createMockContext(),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    const hit = out.result.hits[0];
    expect(hit?.matches).toHaveLength(10);
    expect(hit?.truncated).toBe(true);
    expect(hit?.totalMatches).toBe(25);
  });

  it('honors a caller-supplied `maxMatchesPerHit` override', async () => {
    const matches = Array.from({ length: 8 }, (_, i) => ({
      context: `c${i}`,
      match: { start: 0, end: 1 },
    }));
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(200, [{ filename: 'note.md', matches }], {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'x', maxMatchesPerHit: 3 }),
      createMockContext(),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    const hit = out.result.hits[0];
    expect(hit?.matches).toHaveLength(3);
    expect(hit?.truncated).toBe(true);
    expect(hit?.totalMatches).toBe(8);
  });

  it('leaves `truncated` and `totalMatches` undefined when matches fit under the cap', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(
        200,
        [{ filename: 'small.md', matches: [{ context: 'c', match: { start: 0, end: 1 } }] }],
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'x' }),
      createMockContext(),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    const hit = out.result.hits[0];
    expect(hit?.truncated).toBeUndefined();
    expect(hit?.totalMatches).toBeUndefined();
  });
});

describe('obsidian_search_notes / cursor pagination', () => {
  it('returns nextCursor when more hits remain, and resumes from that cursor', async () => {
    const many = Array.from({ length: 125 }, (_, i) => ({
      filename: `n${i}.md`,
      matches: [{ context: 'x', match: { start: 0, end: 1 } }],
    }));
    // Two intercepts — same upstream payload returned for both pages,
    // since pagination is server-side on the full set.
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(200, many, { headers: { 'content-type': 'application/json' } });
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(200, many, { headers: { 'content-type': 'application/json' } });

    const first = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'x' }),
      createMockContext(),
    );
    if (first.result.mode !== 'text') throw new Error('expected text branch');
    expect(first.result.hits).toHaveLength(50); // DEFAULT_PAGE_SIZE
    expect(first.result.totalCount).toBe(125);
    expect(first.result.nextCursor).toBeDefined();

    const second = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({
        mode: 'text',
        query: 'x',
        cursor: first.result.nextCursor,
      }),
      createMockContext(),
    );
    if (second.result.mode !== 'text') throw new Error('expected text branch');
    expect(second.result.hits).toHaveLength(50);
    expect(second.result.hits[0]?.filename).toBe('n50.md');
    expect(second.result.totalCount).toBe(125);
    expect(second.result.nextCursor).toBeDefined();
  });

  it('throws InvalidParams when cursor is malformed (per MCP spec)', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(
        200,
        [{ filename: 'a.md', matches: [{ context: 'c', match: { start: 0, end: 1 } }] }],
        {
          headers: { 'content-type': 'application/json' },
        },
      );

    await expect(
      obsidianSearchNotes.handler(
        obsidianSearchNotes.input.parse({ mode: 'text', query: 'x', cursor: 'not-a-cursor' }),
        createMockContext(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.InvalidParams });
  });
});

describe('obsidian_search_notes / jsonlogic', () => {
  it('forwards the logic object as JSON', async () => {
    harness
      .current()
      .pool.intercept({ path: '/search/', method: 'POST' })
      .reply(200, [{ filename: 'A.md', result: true }], {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({
        mode: 'jsonlogic',
        logic: { '!!': [{ var: 'tags' }] },
      }),
      createMockContext(),
    );
    if (out.result.mode !== 'jsonlogic') throw new Error('expected jsonlogic branch');
    expect(out.result.hits).toEqual([{ filename: 'A.md', result: true }]);
    expect(out.result.totalCount).toBe(1);
  });

  it('throws logic_required (ValidationError) when logic is omitted', async () => {
    await expect(
      obsidianSearchNotes.handler(
        obsidianSearchNotes.input.parse({ mode: 'jsonlogic' }),
        createMockContext({ errors: obsidianSearchNotes.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'logic_required' },
    });
  });
});

describe('obsidian_search_notes / omnisearch (mode-conditional)', () => {
  it('omits the `omnisearch` mode from the input schema when omnisearchReachable=false', () => {
    const result = obsidianSearchNotes.input.safeParse({ mode: 'omnisearch', query: 'x' });
    expect(result.success).toBe(false);
  });

  it('accepts the `omnisearch` mode when built with omnisearchReachable=true', () => {
    const result = omnisearchTool.input.safeParse({ mode: 'omnisearch', query: 'x' });
    expect(result.success).toBe(true);
  });

  it('normalizes upstream hits (HTML entities decoded, <br>→newline, path→filename, drops vault)', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search?q='),
        method: 'GET',
      })
      .reply(
        200,
        [
          {
            basename: 'Note A',
            excerpt: 'Line 1<br>Line 2 — Bob&#039;s pick &amp; <mark>highlight</mark>',
            foundWords: ['bob'],
            matches: [{ match: 'bob', offset: 12 }],
            path: 'Projects/Note A.md',
            score: 7.42,
            vault: 'should-be-dropped',
          },
        ],
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await omnisearchTool.handler(
      omnisearchTool.input.parse({ mode: 'omnisearch', query: 'bob' }),
      createMockContext(),
    );
    if (out.result.mode !== 'omnisearch') throw new Error('expected omnisearch branch');
    expect(out.result.hits).toHaveLength(1);
    const hit = out.result.hits[0];
    expect(hit?.filename).toBe('Projects/Note A.md');
    expect(hit?.basename).toBe('Note A');
    expect(hit?.score).toBe(7.42);
    expect(hit?.excerpt).toBe("Line 1\nLine 2 — Bob's pick & <mark>highlight</mark>");
    expect(hit).not.toHaveProperty('vault');
    expect(out.result.truncated).toBe(false);
    expect(out.result.totalCount).toBe(1);
  });

  it('sets truncated=true when upstream returns exactly 50 hits (the hardwired cap)', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      basename: `n${i}`,
      excerpt: '',
      foundWords: ['x'],
      matches: [],
      path: `n${i}.md`,
      score: 1,
    }));
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search?q='),
        method: 'GET',
      })
      .reply(200, fifty, { headers: { 'content-type': 'application/json' } });

    const out = await omnisearchTool.handler(
      omnisearchTool.input.parse({ mode: 'omnisearch', query: 'x' }),
      createMockContext(),
    );
    if (out.result.mode !== 'omnisearch') throw new Error('expected omnisearch branch');
    expect(out.result.truncated).toBe(true);
    expect(out.result.hits).toHaveLength(50);
  });

  it('throws omnisearch_unreachable when the upstream returns 5xx', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search?q='),
        method: 'GET',
      })
      .reply(503, 'Service Unavailable', { headers: { 'content-type': 'text/plain' } });

    await expect(
      omnisearchTool.handler(
        omnisearchTool.input.parse({ mode: 'omnisearch', query: 'x' }),
        createMockContext({ errors: omnisearchTool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'omnisearch_unreachable' },
    });
  });
});

describe('obsidian_search_notes / probeOmnisearch', () => {
  afterEach(() => {
    setObsidianService(undefined);
  });

  it('returns true when upstream returns 200 + application/json + JSON array', async () => {
    const fetchImpl: ObsidianFetch = async (url) => {
      if (url.includes(':51361/search')) {
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);
    expect(await svc.probeOmnisearch()).toBe(true);
  });

  it('returns false when upstream returns 200 but empty body (unrouted path)', async () => {
    const fetchImpl: ObsidianFetch = async () =>
      new Response('', { status: 200, headers: { 'content-type': 'text/plain' } });
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);
    expect(await svc.probeOmnisearch()).toBe(false);
  });

  it('returns false when upstream returns 200 with JSON content-type but non-array body', async () => {
    const fetchImpl: ObsidianFetch = async () =>
      new Response('{"error":"x"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);
    expect(await svc.probeOmnisearch()).toBe(false);
  });

  it('returns false on network error (connection refused)', async () => {
    const fetchImpl: ObsidianFetch = async () => {
      throw new TypeError('fetch failed');
    };
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);
    expect(await svc.probeOmnisearch()).toBe(false);
  });

  it('derives the omnisearch URL from baseUrl host with port 51361, mapping 127.0.0.1 → localhost', () => {
    const svc = new ObsidianService(
      makeTestConfig({ baseUrl: 'http://127.0.0.1:27123' }),
      async () => new Response('[]'),
    );
    expect(svc.omnisearchUrl).toBe('http://localhost:51361');
  });

  it('honors OBSIDIAN_OMNISEARCH_URL override', () => {
    const svc = new ObsidianService(
      makeTestConfig({ omnisearchUrl: 'http://omni.example:9999/' }),
      async () => new Response('[]'),
    );
    expect(svc.omnisearchUrl).toBe('http://omni.example:9999');
  });
});

describe('obsidian_search_notes / format()', () => {
  it('renders text hits with their context', () => {
    const blocks = obsidianSearchNotes.format!({
      result: {
        mode: 'text',
        hits: [
          {
            filename: 'A.md',
            matches: [{ context: 'snippet', match: { start: 0, end: 1 } }],
          },
        ],
        totalCount: 1,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('A.md');
    expect(text).toContain('snippet');
    expect(text).toContain('1 on this page');
    expect(text).toContain('1 total');
  });

  it('renders structured hits as JSON code blocks', () => {
    const blocks = obsidianSearchNotes.format!({
      result: {
        mode: 'jsonlogic',
        hits: [{ filename: 'A.md', result: { mtime: 1 } }],
        totalCount: 1,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('```json');
    expect(text).toContain('"mtime": 1');
  });

  it('annotates truncated text hits with the "truncated, showing first N of M" indicator', () => {
    const blocks = obsidianSearchNotes.format!({
      result: {
        mode: 'text',
        hits: [
          {
            filename: 'busy.md',
            matches: [{ context: 'snippet', match: { start: 0, end: 1 } }],
            truncated: true,
            totalMatches: 25,
          },
        ],
        totalCount: 1,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('truncated');
    expect(text).toContain('first 1 of 25');
  });

  it('surfaces nextCursor and the more-available indicator when a page has a successor', () => {
    const blocks = obsidianSearchNotes.format!({
      result: {
        mode: 'text',
        hits: [],
        totalCount: 200,
        nextCursor: 'opaque-token',
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('more available');
    expect(text).toContain('opaque-token');
    expect(text).toContain('200 total');
  });

  it('renders omnisearch hits with score, foundWords, and quoted excerpt', () => {
    const blocks = omnisearchTool.format!({
      result: {
        mode: 'omnisearch',
        hits: [
          {
            basename: 'Note A',
            excerpt: 'context around the match',
            filename: 'Projects/Note A.md',
            foundWords: ['match'],
            matches: [{ match: 'match', offset: 14 }],
            score: 7.4242,
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Projects/Note A.md');
    expect(text).toContain('score: 7.42');
    expect(text).toContain('`match`');
    expect(text).toContain('> context around the match');
  });

  it('warns about omnisearch truncation when the upstream cap was hit', () => {
    const blocks = omnisearchTool.format!({
      result: {
        mode: 'omnisearch',
        hits: [
          {
            basename: 'n0',
            excerpt: '',
            filename: 'n0.md',
            foundWords: ['x'],
            matches: [],
            score: 1,
          },
        ],
        totalCount: 50,
        truncated: true,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('50-hit cap');
    expect(text).toContain('Narrow');
  });
});

describe('obsidian_search_notes — path-policy post-filter', () => {
  afterEach(() => {
    setObsidianService(undefined);
  });

  it('drops text hits outside readPaths silently and shrinks totalCount', async () => {
    const fetchImpl: ObsidianFetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.startsWith('/search/simple/')) {
        return new Response(
          JSON.stringify([
            {
              filename: 'public/a.md',
              score: 1,
              matches: [{ context: 'a', match: { start: 0, end: 1 } }],
            },
            {
              filename: 'secret/b.md',
              score: 1,
              matches: [{ context: 'b', match: { start: 0, end: 1 } }],
            },
            {
              filename: 'public/sub/c.md',
              score: 1,
              matches: [{ context: 'c', match: { start: 0, end: 1 } }],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected ${u.pathname}`);
    };
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['public'] }), fetchImpl);
    setObsidianService(svc);

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'x' }),
      createMockContext(),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    expect(out.result.hits.map((h) => h.filename)).toEqual(['public/a.md', 'public/sub/c.md']);
    expect(out.result.totalCount).toBe(2);
  });

  it('filters jsonlogic hits against readPaths', async () => {
    const fetchImpl: ObsidianFetch = async () =>
      new Response(
        JSON.stringify([
          { filename: 'public/a.md', result: 1 },
          { filename: 'secret/b.md', result: 2 },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['public'] }), fetchImpl);
    setObsidianService(svc);

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'jsonlogic', logic: { var: 'path' } }),
      createMockContext(),
    );
    if (out.result.mode !== 'jsonlogic') throw new Error('expected jsonlogic branch');
    expect(out.result.hits.map((h) => h.filename)).toEqual(['public/a.md']);
    expect(out.result.totalCount).toBe(1);
  });

  it('filters omnisearch hits against readPaths but computes truncated against the raw upstream', async () => {
    const fiftyRaw = Array.from({ length: 50 }, (_, i) => ({
      basename: `n${i}`,
      excerpt: '',
      foundWords: ['x'],
      matches: [],
      path: i < 5 ? `public/n${i}.md` : `secret/n${i}.md`,
      score: 1,
    }));
    const fetchImpl: ObsidianFetch = async (url) => {
      if (url.includes(':51361/search')) {
        return new Response(JSON.stringify(fiftyRaw), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['public'] }), fetchImpl);
    setObsidianService(svc);

    const out = await omnisearchTool.handler(
      omnisearchTool.input.parse({ mode: 'omnisearch', query: 'x' }),
      createMockContext(),
    );
    if (out.result.mode !== 'omnisearch') throw new Error('expected omnisearch branch');
    expect(out.result.hits).toHaveLength(5);
    expect(out.result.totalCount).toBe(5);
    expect(out.result.truncated).toBe(true);
  });
});

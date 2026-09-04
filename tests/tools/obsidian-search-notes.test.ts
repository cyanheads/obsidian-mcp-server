/**
 * @fileoverview Handler tests for obsidian_search_notes across all four modes,
 * including cursor pagination round-trips and the Omnisearch-conditional
 * branch built via `buildSearchNotesTool({ omnisearchReachable: true })`.
 * @module tests/tools/obsidian-search-notes.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
import {
  makeTestConfig,
  mockResponse,
  type ReplyFn,
  setupHarness,
  TEST_BASE_URL,
} from '../helpers.js';

const harness = setupHarness();

const omnisearchTool = buildSearchNotesTool({ omnisearchReachable: true });

/**
 * Run `fn` and hand back the error it threw, or `undefined` if it resolved.
 * Used where an assertion needs the error *object* — checking that a key is
 * absent from `data`, which `toMatchObject` cannot express.
 */
async function captureError(
  fn: () => unknown,
): Promise<{ code: number; data?: Record<string, unknown> } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as { code: number; data?: Record<string, unknown> };
  }
}

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
      createMockContext({ errors: obsidianSearchNotes.errors }),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    expect(out.result.hits).toHaveLength(1);
    expect(out.result.hits[0]?.filename).toBe('Projects/A.md');
    expect(out.result.totalCount).toBe(1);
    expect(out.result.nextCursor).toBeUndefined();
  });

  it('populates effectiveQuery enrichment echo in text mode', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(
        200,
        [{ filename: 'A.md', score: 1, matches: [{ context: 'aa', match: { start: 0, end: 1 } }] }],
        { headers: { 'content-type': 'application/json' } },
      );

    const ctx = createMockContext({ errors: obsidianSearchNotes.errors });
    await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'hello' }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('hello');
    expect(enrichment.notice).toBeUndefined();
  });

  it('populates notice enrichment when text search returns no hits', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(200, [], { headers: { 'content-type': 'application/json' } });

    const ctx = createMockContext({ errors: obsidianSearchNotes.errors });
    await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'nothingmatches' }),
      ctx,
    );
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/nothingmatches/);
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
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
        createMockContext({ errors: obsidianSearchNotes.errors }),
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
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
      createMockContext({ errors: omnisearchTool.errors }),
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
      createMockContext({ errors: omnisearchTool.errors }),
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
        return mockResponse('[]', {
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
      mockResponse('', { status: 200, headers: { 'content-type': 'text/plain' } });
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);
    expect(await svc.probeOmnisearch()).toBe(false);
  });

  it('returns false when upstream returns 200 with JSON content-type but non-array body', async () => {
    const fetchImpl: ObsidianFetch = async () =>
      mockResponse('{"error":"x"}', {
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
      async () => mockResponse('[]'),
    );
    expect(svc.omnisearchUrl).toBe('http://localhost:51361');
  });

  it('honors OBSIDIAN_OMNISEARCH_URL override', () => {
    const svc = new ObsidianService(
      makeTestConfig({ omnisearchUrl: 'http://omni.example:9999/' }),
      async () => mockResponse('[]'),
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
            matches: [
              {
                context: 'snippet',
                match: { start: 0, end: 1, contextStart: 0, contextEnd: 1 },
              },
            ],
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
            matches: [
              {
                context: 'snippet',
                match: { start: 0, end: 1, contextStart: 0, contextEnd: 1 },
              },
            ],
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

  it('renders omnisearch hits with score, foundWords, match offsets, and a fenced excerpt', () => {
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
    // The excerpt is vault text, so it is fenced rather than interpolated into
    // a blockquote — a blockquote leaks its own structure and folds the next
    // line in by lazy continuation.
    expect(text).toContain('context around the match');
    expect(text).not.toContain('> context around the match');
    expect(text).toMatch(/^```text$/m);
    // `matches[].offset` reaches the reader instead of being dropped.
    expect(text).toContain('@ 14');
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

describe('obsidian_search_notes / contextLength drives the rendered text', () => {
  /**
   * Echoes a context window sized the way the Local REST API sizes one —
   * `contextLength` characters each side of the match — so the rendered text
   * can be checked against the window the caller actually asked for.
   */
  const echoContextWindow: ReplyFn = (opts) => {
    const requested = Number(
      new URL(opts.path, TEST_BASE_URL).searchParams.get('contextLength') ?? '0',
    );
    const side = 'x'.repeat(requested);
    return {
      statusCode: 200,
      data: [
        {
          filename: 'long.md',
          matches: [
            { context: `${side}TERM${side}`, match: { start: requested, end: requested + 4 } },
          ],
        },
      ],
      responseOptions: { headers: { 'content-type': 'application/json' } },
    };
  };

  it.each([
    { label: 'the default window', contextLength: undefined },
    { label: 'a 400-character window', contextLength: 400 },
    { label: 'an 800-character window', contextLength: 800 },
  ])('renders $label in full, matching structuredContent', async ({ contextLength }) => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(echoContextWindow);

    const input = obsidianSearchNotes.input.parse({ mode: 'text', query: 'TERM', contextLength });
    const out = await obsidianSearchNotes.handler(
      input,
      createMockContext({ errors: obsidianSearchNotes.errors }),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');

    const structured = out.result.hits[0]?.matches[0]?.context ?? '';
    // The upstream honored the caller's window; the rendered text must too.
    expect(structured).toHaveLength(input.contextLength * 2 + 'TERM'.length);

    const text = (obsidianSearchNotes.format!(out)[0] as { text: string }).text;
    expect(text).toContain(structured);
    expect(text).not.toContain('…');
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
        return mockResponse(
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    expect(out.result.hits.map((h) => h.filename)).toEqual(['public/a.md', 'public/sub/c.md']);
    expect(out.result.totalCount).toBe(2);
  });

  it('filters jsonlogic hits against readPaths', async () => {
    const fetchImpl: ObsidianFetch = async () =>
      mockResponse(
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
      createMockContext({ errors: obsidianSearchNotes.errors }),
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
        return mockResponse(JSON.stringify(fiftyRaw), {
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
      createMockContext({ errors: omnisearchTool.errors }),
    );
    if (out.result.mode !== 'omnisearch') throw new Error('expected omnisearch branch');
    expect(out.result.hits).toHaveLength(5);
    expect(out.result.totalCount).toBe(5);
    expect(out.result.truncated).toBe(true);
  });
});

/**
 * The Local REST API's `glob` / `regexp` operators take `[PATTERN, VALUE]`
 * (`docs/openapi.yaml`, the vendored upstream spec). Guidance that shows the
 * reverse order produces a clean, successful, empty result — there is no error
 * for the caller to react to, so a wrong hint is worse than no hint. These pin
 * the two in-code surfaces that document the order.
 */
describe('obsidian_search_notes / jsonlogic operator-order guidance', () => {
  const logicRequiredRecovery = obsidianSearchNotes.errors!.find(
    (e) => e.reason === 'logic_required',
  )!.recovery;

  it('gives the logic_required recovery hint a working [PATTERN, VALUE] example', () => {
    // A `{"var": ...}` in the first slot is the inverted order the upstream
    // silently evaluates to zero hits.
    expect(logicRequiredRecovery).not.toMatch(/\{\s*"glob"\s*:\s*\[\s*\{\s*"var"/);
    expect(logicRequiredRecovery).toMatch(/"glob"\s*:\s*\[\s*"/);
    expect(logicRequiredRecovery).toMatch(/\{\s*"var"\s*:\s*"path"\s*\}\s*\]/);
  });

  it.each([
    ['omnisearch-unreachable', buildSearchNotesTool({ omnisearchReachable: false })],
    ['omnisearch-reachable', buildSearchNotesTool({ omnisearchReachable: true })],
  ])('states the [PATTERN, VALUE] order in the %s mode description', (_label, built) => {
    const modeDescription = built.input.shape.mode.description ?? '';
    expect(modeDescription).toContain('glob');
    expect(modeDescription).toContain('regexp');
    expect(modeDescription).toMatch(/\[PATTERN, VALUE\]/);
  });

  it('documents a backlinks example on the `logic` field', () => {
    const logicDescription = obsidianSearchNotes.input.shape.logic.description ?? '';
    expect(logicDescription).toMatch(/backlink/i);
    // The wikilink-opening pattern must sit in the PATTERN slot, with
    // `content` as the VALUE it is tested against.
    expect(logicDescription).toMatch(/"regexp"\s*:\s*\[\s*"/);
    expect(logicDescription).toMatch(/\{\s*"var"\s*:\s*"content"\s*\}\s*\]/);
  });
});

describe('obsidian_search_notes / logic_invalid', () => {
  const declaredRecovery = obsidianSearchNotes.errors!.find(
    (e) => e.reason === 'logic_invalid',
  )?.recovery;

  it('declares logic_invalid on the tool contract', () => {
    expect(declaredRecovery).toBeTypeOf('string');
  });

  it('maps an upstream 400 on the jsonlogic route to reason logic_invalid', async () => {
    harness
      .current()
      .pool.intercept({ path: '/search/', method: 'POST' })
      .reply(
        400,
        { errorCode: 40000, message: 'Invalid JsonLogic query supplied.' },
        { headers: { 'content-type': 'application/json' } },
      );

    await expect(
      obsidianSearchNotes.handler(
        obsidianSearchNotes.input.parse({ mode: 'jsonlogic', logic: { bogus: [1, 2] } }),
        createMockContext({ errors: obsidianSearchNotes.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'logic_invalid', recovery: { hint: declaredRecovery } },
    });
  });

  it('leaves a 400 on the text-search route out of the logic_invalid branch', async () => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(
        400,
        { errorCode: 40000, message: 'Bad simple-search request.' },
        { headers: { 'content-type': 'application/json' } },
      );

    const err = await captureError(() =>
      obsidianSearchNotes.handler(
        obsidianSearchNotes.input.parse({ mode: 'text', query: 'x' }),
        createMockContext({ errors: obsidianSearchNotes.errors }),
      ),
    );
    expect(err?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err?.data).toBeDefined();
    expect(Object.hasOwn(err!.data!, 'reason')).toBe(false);
  });
});

/**
 * Upstream reports `start`/`end` against the subject it matched, never against
 * the `context` window it ships alongside. Two subjects exist: the note body
 * (window = `body.slice(max(0, start - contextLength), min(len, end + contextLength))`)
 * and, for a filename match, the note's basename returned whole. The derived
 * `contextStart`/`contextEnd` pair must land on the matched text in both.
 */
describe('obsidian_search_notes / context-relative match offsets', () => {
  const textSearch = (reply: unknown, contextLength: number, query = 'TERM') => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(200, reply, { headers: { 'content-type': 'application/json' } });
    return obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query, contextLength }),
      createMockContext({ errors: obsidianSearchNotes.errors }),
    );
  };

  it.each([
    {
      label: 'interior body match (window full on both sides)',
      contextLength: 10,
      filename: 'Notes/Deep.md',
      context: `${'A'.repeat(10)}TERM${'B'.repeat(10)}`,
      match: { start: 500, end: 504 },
      contextStart: 10,
    },
    {
      label: 'body match near the start of the note (left side clipped)',
      contextLength: 10,
      filename: 'Notes/Deep.md',
      context: `AAATERM${'B'.repeat(10)}`,
      match: { start: 3, end: 7 },
      contextStart: 3,
    },
    {
      label: 'body match near the end of the note (right side clipped)',
      contextLength: 10,
      filename: 'Notes/Deep.md',
      context: `${'A'.repeat(10)}TERMBB`,
      match: { start: 900, end: 904 },
      contextStart: 10,
    },
    {
      /**
       * The case `Math.min(start, contextLength)` gets wrong: the whole
       * basename is the window, so the span sits at `start` even when `start`
       * runs past `contextLength`.
       */
      label: 'filename match with start beyond contextLength',
      contextLength: 3,
      filename: 'Notes/Agent TERM Library.md',
      context: 'Agent TERM Library',
      match: { start: 6, end: 10 },
      contextStart: 6,
    },
  ])('$label', async ({ contextLength, filename, context, match, contextStart }) => {
    const out = await textSearch([{ filename, matches: [{ context, match }] }], contextLength);
    if (out.result.mode !== 'text') throw new Error('expected text branch');

    const hit = out.result.hits[0];
    expect(hit).toBeDefined();
    const m = hit!.matches[0];
    expect(m).toBeDefined();

    // The subject-relative pair is passed through untouched.
    expect(m!.match.start).toBe(match.start);
    expect(m!.match.end).toBe(match.end);
    // The derived pair indexes `context` and lands exactly on the matched text.
    expect(m!.match.contextStart).toBe(contextStart);
    expect(m!.match.contextEnd).toBe(contextStart + (match.end - match.start));
    expect(m!.context.slice(m!.match.contextStart, m!.match.contextEnd)).toBe('TERM');
  });

  it('resolves both subjects independently when one hit mixes filename and body matches', async () => {
    const out = await textSearch(
      [
        {
          filename: 'Notes/Agent TERM Library.md',
          matches: [
            { context: 'Agent TERM Library', match: { start: 6, end: 10 } },
            { context: `${'A'.repeat(5)}TERM${'B'.repeat(5)}`, match: { start: 812, end: 816 } },
          ],
        },
      ],
      5,
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    const matches = out.result.hits[0]?.matches ?? [];
    expect(matches).toHaveLength(2);
    expect(matches[0]!.match.contextStart).toBe(6);
    expect(matches[1]!.match.contextStart).toBe(5);
    for (const m of matches) {
      expect(m.context.slice(m.match.contextStart, m.match.contextEnd)).toBe('TERM');
    }
  });

  /**
   * `context === basename` alone does not identify a filename match. A body
   * window whose left edge is trimmed can coincide with the basename — a note
   * that quotes its own name, matched so the window lands on that quote — and
   * the filename reading then slices the wrong text. Both fixtures below are
   * body matches that the coincidence test alone reads as filename matches.
   */
  it.each([
    {
      /** Filename reading runs past the end of `context`, slicing to ''. */
      label: 'body window equal to the basename, span past the end of context',
      query: 'cer',
      contextLength: 3,
      filename: 'Groceries.md',
      // body 'Buy stuff\nGroceries' (len 19); 'cer' at 13; window = body.slice(10, 19).
      context: 'Groceries',
      match: { start: 13, end: 16 },
      contextStart: 3,
    },
    {
      /** Filename reading stays in range and slices plausible-but-wrong text. */
      label: 'body window equal to the basename, span still inside context',
      query: 'rt',
      contextLength: 3,
      filename: 'Quarterly Notes.md',
      // body 'HDR: Quarterly Notes' (len 20); 'rt' at 8; window = body.slice(5, 20).
      context: 'Quarterly Notes',
      match: { start: 8, end: 10 },
      contextStart: 3,
    },
  ])('$label', async ({ query, contextLength, filename, context, match, contextStart }) => {
    const out = await textSearch(
      [{ filename, matches: [{ context, match }] }],
      contextLength,
      query,
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    const m = out.result.hits[0]?.matches[0];
    expect(m).toBeDefined();
    expect(m!.match.contextStart).toBe(contextStart);
    expect(m!.context.slice(m!.match.contextStart, m!.match.contextEnd)).toBe(query);
  });

  it('describes start/end against the matched subject, not the context window', () => {
    const matchShape = (
      obsidianSearchNotes.output.shape.result.options[0] as unknown as {
        shape: {
          hits: {
            element: {
              shape: {
                matches: {
                  element: {
                    shape: {
                      match: {
                        description?: string;
                        shape: Record<string, { description?: string }>;
                      };
                    };
                  };
                };
              };
            };
          };
        };
      }
    ).shape.hits.element.shape.matches.element.shape.match;

    // The three strings that previously all claimed a context-window origin.
    expect(matchShape.description).not.toMatch(/within the context window/i);
    for (const key of ['start', 'end'] as const) {
      expect(matchShape.shape[key]!.description).not.toMatch(/in the surrounding context/i);
    }
    expect(matchShape.shape.contextStart!.description).toMatch(/context/i);
    expect(matchShape.shape.contextEnd!.description).toMatch(/context/i);
  });
});

/**
 * `format()` splices upstream-authored text (note excerpts, Omnisearch
 * excerpts, JSONLogic result payloads) into markdown the model reads as the
 * tool's own output. A heading, fence, or list marker inside that text must
 * not be able to end the quoted region and have the remainder reparsed as
 * document structure. The excerpt is rendered whole either way — clipping it
 * would reintroduce the content[]/structuredContent divergence fixed in #97.
 */
describe('obsidian_search_notes / format() cannot be broken out of by upstream text', () => {
  const HOSTILE = [
    '## Not a real heading',
    '```js',
    "console.log('escaped the block')",
    '```',
    '- not a real bullet',
    '> not a real quote',
  ].join('\n');

  it('renders a text-mode context containing headings and fences verbatim and contained', () => {
    const text = (
      obsidianSearchNotes.format!({
        result: {
          mode: 'text',
          hits: [
            {
              filename: 'A.md',
              matches: [
                {
                  context: HOSTILE,
                  match: { start: 469, end: 474, contextStart: 100, contextEnd: 105 },
                },
              ],
            },
          ],
          totalCount: 1,
        },
      })[0] as { text: string }
    ).text;

    // Whole excerpt survives (no clipping, no lossy escaping).
    expect(text).toContain(HOSTILE);
    // …and is wrapped in a fence longer than the longest run inside it, so the
    // payload's own ``` cannot terminate the block.
    const fences = text.match(/^`{4,}/gm) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(2);
    // Both offset origins are legible to the reader.
    expect(text).toContain('100');
    expect(text).toContain('469');
  });

  it('renders an omnisearch excerpt containing markdown verbatim and contained', () => {
    const text = (
      omnisearchTool.format!({
        result: {
          mode: 'omnisearch',
          hits: [
            {
              basename: 'A',
              excerpt: HOSTILE,
              filename: 'A.md',
              foundWords: ['heading'],
              matches: [{ match: 'heading', offset: 3 }],
              score: 1,
            },
          ],
          totalCount: 1,
          truncated: false,
        },
      })[0] as { text: string }
    ).text;

    expect(text).toContain(HOSTILE);
    expect((text.match(/^`{4,}/gm) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('sizes the fence without spreading every backtick run into Math.max', () => {
    /**
     * Pins the fold: spreading one argument per backtick run into `Math.max`
     * overflows the call stack once the runs pass ~1M, and `context` is
     * upstream text whose size the caller sets with `contextLength`. The input
     * below is pathological rather than typical — the point is that the sizing
     * has no input-dependent cliff at all.
     */
    const backtickHeavy = '`x'.repeat(1_100_000);
    const text = (
      obsidianSearchNotes.format!({
        result: {
          mode: 'text',
          hits: [
            {
              filename: 'A.md',
              matches: [
                {
                  context: backtickHeavy,
                  match: { start: 0, end: 1, contextStart: 0, contextEnd: 1 },
                },
              ],
            },
          ],
          totalCount: 1,
        },
      })[0] as { text: string }
    ).text;
    expect(text).toContain(backtickHeavy);
    // Longest run inside is 1 backtick, so the floor of 3 applies.
    expect(text).toMatch(/^```text$/m);
  });

  it('renders a jsonlogic result whose payload contains a fence without leaking out', () => {
    const payload = { note: '```\nbreak out\n```' };
    const text = (
      obsidianSearchNotes.format!({
        result: {
          mode: 'jsonlogic',
          hits: [{ filename: 'A.md', result: payload }],
          totalCount: 1,
        },
      })[0] as { text: string }
    ).text;

    expect(text).toContain('break out');
    // The opening fence must out-run the ``` embedded in the payload.
    expect(text).toMatch(/^`{4,}json$/m);
  });
});

/**
 * The Local REST API materializes a context window per hit before responding,
 * so it runs out of string capacity somewhere along `contextLength × hit
 * count` and answers HTTP 500 with a V8 `RangeError`. Untyped, that reaches
 * the caller as a bare -32603 naming neither the parameter at fault nor the
 * two levers that fix it.
 */
describe('obsidian_search_notes / context_length_too_large', () => {
  const declaredRecovery = obsidianSearchNotes.errors!.find(
    (e) => e.reason === 'context_length_too_large',
  )?.recovery;

  const replyWith = (status: number, body: unknown) => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(status, body, { headers: { 'content-type': 'application/json' } });
    return obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'the', contextLength: 500 }),
      createMockContext({ errors: obsidianSearchNotes.errors }),
    );
  };

  const RANGE_ERROR = {
    errorCode: 50000,
    message:
      'Error encountered while calling Obsidian `prepareSimpleSearch` API.\nRangeError: Invalid string length',
  };

  it('declares context_length_too_large on the tool contract', () => {
    expect(declaredRecovery).toBeTypeOf('string');
    // Both levers must be named — lowering the window alone does not help a
    // caller whose query is simply too broad.
    expect(declaredRecovery).toMatch(/contextLength/);
    expect(declaredRecovery).toMatch(/narrow|fewer|filter/i);
  });

  it('maps the upstream RangeError to a typed, recoverable validation error', async () => {
    await expect(replyWith(500, RANGE_ERROR)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'context_length_too_large',
        contextLength: 500,
        recovery: { hint: declaredRecovery },
      },
    });
  });

  it('does not carry the raw upstream body or envelope on the replacement error', async () => {
    const err = await captureError(() => replyWith(500, RANGE_ERROR));
    expect(err?.data).toBeDefined();
    expect(Object.hasOwn(err!.data!, 'body')).toBe(false);
    expect(Object.hasOwn(err!.data!, 'upstream')).toBe(false);
    // The message must not smuggle the upstream body back in either.
    expect(JSON.stringify(err!.data)).not.toContain('prepareSimpleSearch');
  });

  it('leaves an unrelated upstream 500 on its existing untyped path', async () => {
    const err = await captureError(() =>
      replyWith(500, { errorCode: 50000, message: 'Something else broke.' }),
    );
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err?.data?.reason).toBeUndefined();
  });
});

/**
 * @fileoverview Handler tests for obsidian_search_notes across all four modes,
 * including cursor pagination round-trips and the Omnisearch-conditional
 * branch built via `buildSearchNotesTool({ omnisearchReachable: true })`.
 * @module tests/tools/obsidian-search-notes.test
 */

import { Worker } from 'node:worker_threads';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  buildSearchNotesTool,
  obsidianSearchNotes,
} from '@/mcp-server/tools/definitions/obsidian-search-notes.tool.js';
import {
  getObsidianService,
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import {
  contractErrorOf,
  deepNoteFetch,
  jsonLogicVault,
  makeTestConfig,
  markdownText,
  mockResponse,
  type ReplyFn,
  rejectionOf,
  setupHarness,
  TEST_BASE_URL,
  type VaultNote,
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

/** The rendered line for each reason `truncated` can be true in omnisearch mode. */
const OMNISEARCH_LINES = {
  cap_reached:
    '_Truncated (cap_reached): Omnisearch returned its 50-hit cap, so more matches may exist. Narrow with `path:`, `ext:`, or more plain terms, which Omnisearch applies before the cap._',
  filtered_after_cap:
    '_Truncated (filtered_after_cap): Omnisearch keeps its top 50 matches before it applies quoted terms and `-exclusion` terms, so matches past the cap were never checked. Narrow with `path:`, `ext:`, or more plain terms, which apply before the cap, or rerun without the quoted and excluded terms to see whether the cap was reached._',
  read_scope:
    '_Truncated (read_scope): Omnisearch keeps its top 50 matches across the whole vault before the read scope filters them, so readable matches may be missing. Add a `path:` term naming a readable folder, which Omnisearch applies before the cap._',
} as const;

/**
 * One omnisearch call through the production envelope, against an Omnisearch
 * that answers every query with a hit per path in `paths`, in that order.
 */
async function omnisearchCall(query: string, paths: string[], config: Partial<ServerConfig> = {}) {
  const queries: string[] = [];
  const fetchImpl: ObsidianFetch = async (url) => {
    const u = new URL(url);
    if (u.port !== '51361' || u.pathname !== '/search') throw new Error(`unexpected ${url}`);
    queries.push(u.searchParams.get('q') ?? '');
    const hits = paths.map((path) => ({
      basename: path.replace(/^.*\//, '').replace(/\.md$/, ''),
      excerpt: '',
      foundWords: ['x'],
      matches: [],
      path,
      score: 1,
    }));
    return mockResponse(JSON.stringify(hits), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  setObsidianService(new ObsidianService(makeTestConfig(config), fetchImpl));
  const res = await runToolContract(omnisearchTool, { mode: 'omnisearch', query });
  const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
  return { queries, res, structured: res.structuredContent as Record<string, unknown>, text };
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
    expect(hit?.matches.map((m) => m.context)).toEqual(matches.slice(0, 10).map((m) => m.context));
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

  it('omits `truncated` and `totalMatches` when matches fit under the cap', async () => {
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
    expect(out.result.hits).toHaveLength(1);
    const [hit] = out.result.hits;
    expect(hit?.matches).toHaveLength(1);
    expect(hit).not.toHaveProperty('truncated');
    expect(hit).not.toHaveProperty('totalMatches');
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
    const logic = { '!!': [{ var: 'tags' }] };
    let sentBody = '';
    harness
      .current()
      .pool.intercept({ path: '/search/', method: 'POST' })
      .reply((opts) => {
        sentBody = opts.body ?? '';
        return {
          statusCode: 200,
          data: [{ filename: 'A.md', result: true }],
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'jsonlogic', logic }),
      createMockContext({ errors: obsidianSearchNotes.errors }),
    );
    expect(JSON.parse(sentBody)).toEqual(logic);
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
    // `toEqual` also fails on an extra key, so a leaked `vault` or `path` breaks it.
    expect(out.result.hits).toEqual([
      {
        filename: 'Projects/Note A.md',
        basename: 'Note A',
        score: 7.42,
        foundWords: ['bob'],
        matches: [{ match: 'bob', offset: 12 }],
        excerpt: "Line 1\nLine 2 — Bob's pick & <mark>highlight</mark>",
      },
    ]);
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

/**
 * Omnisearch 1.31.0 filters `ext:`, `path:`, and `-path:` before it keeps its
 * top 50, and quoted terms and `-exclusion` text after. A query with the
 * latter can come back short of 50 while the cap cut matches. Issue #172.
 */
describe('obsidian_search_notes / omnisearch truncated — filters applied after the cap', () => {
  it.each([
    ['no hits', 'deploy', 0],
    ['49 hits', 'deploy', 49],
    ['a path: filter', 'deploy path:work', 10],
    ['an ext: filter', 'deploy ext:pdf', 10],
    ['a -path: exclusion', 'deploy -path:archive', 10],
    ['a hyphen inside a word', 'pre-deploy', 10],
    ['an apostrophe inside a word', "don't deploy", 10],
    ['a lone dash', 'deploy -', 10],
  ])('reports a complete result for %s', async (_label, query, count) => {
    const paths = Array.from({ length: count }, (_, i) => `n${i}.md`);
    const { queries, structured, text } = await omnisearchCall(query, paths);
    expect(queries).toEqual([query]);
    const result = (structured as { result: Record<string, unknown> }).result;
    expect(result.truncated).toBe(false);
    expect(result).not.toHaveProperty('truncatedReason');
    expect(text).not.toContain('Truncated');
  });

  it.each([
    ['the cap reached', 'deploy', 50, 'cap_reached'],
    ['the cap reached with an exclusion', 'deploy -the', 50, 'cap_reached'],
    ['a -exclusion', 'deploy -the', 21, 'filtered_after_cap'],
    ['a -exclusion that removed every hit', 'deploy -the', 0, 'filtered_after_cap'],
    ['a quoted phrase', '"deploy the"', 3, 'filtered_after_cap'],
    ['a quoted single word', 'deploy "the"', 3, 'filtered_after_cap'],
    ['a single-quoted phrase', "deploy 'next week'", 0, 'filtered_after_cap'],
    ['a quoted exclusion', 'deploy -"the plan"', 5, 'filtered_after_cap'],
  ] as const)('reports truncated for %s', async (_label, query, count, reason) => {
    const paths = Array.from({ length: count }, (_, i) => `n${i}.md`);
    const { structured, text } = await omnisearchCall(query, paths);
    expect(structured).toMatchObject({
      result: { truncated: true, truncatedReason: reason, totalCount: count },
    });
    expect(text).toContain(`\n${OMNISEARCH_LINES[reason]}\n`);
  });

  it('names only the filters Omnisearch applies before its cap as the way to narrow', () => {
    const shape = (
      omnisearchTool.output.shape.result as unknown as {
        options: Array<{ shape: Record<string, { description?: string }> }>;
      }
    ).options.find((o) => o.shape.truncatedReason)?.shape;
    const truncated = shape?.truncated?.description ?? '';
    expect(truncated).toContain('`path:`, `ext:`, or more plain terms');
    expect(truncated).toContain('after its cap');
    expect(truncated).toContain('OBSIDIAN_READ_PATHS');
    expect(truncated).not.toMatch(/narrow the query to surface/i);
    const mode = omnisearchTool.input.shape.mode.description ?? '';
    expect(mode).not.toMatch(/upstream caps results at 50\./);
    expect(mode).toContain('after the cap');
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
    expect(text).toBe(
      [
        '**Search (text) — 1 on this page · 1 total**',
        '',
        '### A.md',
        'match at context[0–1] · subject[0–1]',
        '```text',
        'snippet',
        '```',
      ].join('\n'),
    );
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
    expect(text).toBe(
      [
        '**Search (jsonlogic) — 1 on this page · 1 total**',
        '',
        '### A.md',
        'result:',
        '```json',
        '{',
        '  "mtime": 1',
        '}',
        '```',
      ].join('\n'),
    );
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
    /**
     * The excerpt is vault text, so it is fenced rather than interpolated into
     * a blockquote — a blockquote leaks its own structure and folds the next
     * line in by lazy continuation. `matches[].offset` reaches the reader.
     */
    expect(text).toBe(
      [
        '**Search (omnisearch) — 1 on this page · 1 total**',
        '',
        '### Projects/Note A.md (score: 7.42)',
        '**Matched:** `match`',
        '**Offsets:** `match` @ 14',
        '```text',
        'context around the match',
        '```',
      ].join('\n'),
    );
  });

  it.each(Object.keys(OMNISEARCH_LINES) as Array<keyof typeof OMNISEARCH_LINES>)(
    'says why a result is truncated, and how to narrow it: %s',
    (reason) => {
      const blocks = omnisearchTool.format!({
        result: {
          mode: 'omnisearch',
          hits: [],
          totalCount: 0,
          truncated: true,
          truncatedReason: reason,
        },
      });
      expect((blocks[0] as { text: string }).text).toBe(
        ['**Search (omnisearch) — 0 on this page · 0 total**', OMNISEARCH_LINES[reason], ''].join(
          '\n',
        ),
      );
    },
  );
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
    const { fetchImpl } = jsonLogicVault(
      ['public/a.md', 'secret/b.md', 'public/sub/c.md'].map((path) => ({ path, content: 'x' })),
    );
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
    const { fetchImpl } = jsonLogicVault([{ path: 'public/a.md' }, { path: 'secret/b.md' }]);
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

  /**
   * Omnisearch caps the whole vault at 50 before the read scope filters, so
   * whether the cap cut a readable match is knowable only from out-of-scope
   * notes: under a scope `truncated` is always true. Issue #163.
   */
  it.each([
    ['readPaths', { readPaths: ['public'] }],
    ['a deny list alone', { denyPaths: ['secret'] }],
  ] as Array<[string, Partial<ServerConfig>]>)(
    'filters omnisearch hits under %s, and reports truncated whatever the upstream returned',
    async (_label, config) => {
      for (const count of [0, 1, 20, 49, 50]) {
        const raw = Array.from({ length: count }, (_, i) =>
          i % 4 === 0 ? `public/n${i}.md` : `secret/n${i}.md`,
        );
        const { structured, text } = await omnisearchCall('x', raw, config);
        const readable = raw.filter((p) => p.startsWith('public/'));
        expect(structured, `${count} upstream hits`).toMatchObject({
          result: { totalCount: readable.length, truncated: true, truncatedReason: 'read_scope' },
        });
        expect(text).toContain(OMNISEARCH_LINES.read_scope);
        expect(text).not.toMatch(/returned its 50-hit cap/);
        expect(`${JSON.stringify(structured)}${text}`).not.toMatch(/secret/);
      }
    },
  );

  /** OBSIDIAN_DENY_PATHS with no allowlist: denied hits leave both surfaces in every mode. */
  describe('under a deny list alone', () => {
    const DENIED = { denyPaths: ['secret', 'public/hidden'] };
    const textOf = (blocks: ReturnType<NonNullable<typeof obsidianSearchNotes.format>>) =>
      blocks.map((b) => (b as { text?: string }).text ?? '').join('\n');

    it('drops denied text hits', async () => {
      const { fetchImpl } = jsonLogicVault(
        ['public/a.md', 'secret/b.md', 'Public/Hidden/c.md', 'publicity/d.md'].map((path) => ({
          path,
          content: 'x',
        })),
      );
      setObsidianService(new ObsidianService(makeTestConfig(DENIED), fetchImpl));
      const res = await runToolContract(obsidianSearchNotes, { mode: 'text', query: 'x' });
      const result = (
        res.structuredContent as {
          result: { hits: Array<{ filename: string }>; totalCount: number };
        }
      ).result;
      expect(result.hits.map((h) => h.filename)).toEqual(['public/a.md', 'publicity/d.md']);
      expect(result.totalCount).toBe(2);
      const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('publicity/d.md');
      expect(text).not.toMatch(/secret|Hidden/);
    });

    it('drops denied omnisearch hits', async () => {
      const raw = ['public/a.md', 'secret/b.md', 'public/hidden/c.md'].map((path) => ({
        basename: path,
        excerpt: '',
        foundWords: ['x'],
        matches: [],
        path,
        score: 1,
      }));
      const fetchImpl: ObsidianFetch = async () =>
        mockResponse(JSON.stringify(raw), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      setObsidianService(new ObsidianService(makeTestConfig(DENIED), fetchImpl));
      const out = await omnisearchTool.handler(
        omnisearchTool.input.parse({ mode: 'omnisearch', query: 'x' }),
        createMockContext({ errors: omnisearchTool.errors }),
      );
      if (out.result.mode !== 'omnisearch') throw new Error('expected omnisearch branch');
      expect(out.result.hits.map((h) => h.filename)).toEqual(['public/a.md']);
      expect(textOf(omnisearchTool.format!(out))).not.toMatch(/secret|hidden/);
    });

    it('evaluates jsonlogic over readable notes, and refuses the link fields without naming a deny prefix', async () => {
      const vault = serveVault(
        [
          { path: 'public/a.md', links: ['secret/b.md', 'public/c.md'], tags: ['t'] },
          { path: 'secret/b.md', links: ['public/a.md'], tags: ['t'] },
          { path: 'public/c.md', unresolvedLinks: ['public/hidden/new', 'elsewhere'] },
        ],
        DENIED,
      );
      const tags = await jsonLogicCall({ in: ['t', { var: 'tags' }] });
      expect(tags.res.isError).toBeFalsy();
      expect((tags.structured.result as { hits: unknown[] }).hits).toEqual([
        { filename: 'public/a.md', result: true },
      ]);
      expect(tags.text).not.toMatch(/secret|hidden/);
      const requests = vault.requests.length;
      for (const logic of [{ var: 'links' }, { var: 'backlinks' }, { var: 'unresolvedLinks' }]) {
        const { res, text } = await jsonLogicCall(logic);
        expect(res.isError).toBe(true);
        expect(
          (res.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
        ).toBe('link_fields_unavailable');
        expect(JSON.stringify(res)).not.toMatch(/secret|hidden/);
        expect(markdownText(text)).toContain('(reason link_fields_unavailable');
      }
      expect(vault.requests).toHaveLength(requests);
    });
  });
});

/**
 * Under a read scope text mode never calls `/search/simple/`, whose match
 * windows span the whole vault: the server matches the readable notes itself.
 * Issue #163.
 */
describe('obsidian_search_notes / text under a read scope', () => {
  afterEach(() => {
    setObsidianService(undefined);
  });

  const textCall = async (input: Record<string, unknown>) => {
    const res = await runToolContract(obsidianSearchNotes, { mode: 'text', ...input });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    return { res, structured: res.structuredContent as Record<string, unknown>, text };
  };

  it('answers from the readable notes on both surfaces, with no /search/simple/ request', async () => {
    const vault = serveVault(
      [
        { path: 'Work/plan.md', content: 'ship the alpha build, then alpha docs' },
        { path: 'Secret/alpha.md', content: 'alpha alpha alpha' },
      ],
      { denyPaths: ['secret'] },
    );
    const { structured, text } = await textCall({ query: 'alpha', contextLength: 5 });
    expect(structured).toEqual({
      result: {
        mode: 'text',
        totalCount: 1,
        hits: [
          {
            filename: 'Work/plan.md',
            matches: [
              {
                context: ' the alpha buil',
                match: { start: 9, end: 14, contextStart: 5, contextEnd: 10 },
              },
              {
                context: 'then alpha docs',
                match: { start: 27, end: 32, contextStart: 5, contextEnd: 10 },
              },
            ],
          },
        ],
      },
      effectiveQuery: 'alpha',
    });
    expect(text).toContain('subject[27–32]');
    expect(text).toContain('then alpha docs');
    expect(text).not.toMatch(/secret/i);
    expect(vault.requests).toEqual(['POST /search/', 'GET /vault/Work/plan.md']);
  });

  it('fails past the response ceiling with the declared context_length_too_large, decided by readable matches', async () => {
    const needles = 'needle '.repeat(20_000);
    const declared = obsidianSearchNotes.errors!.find(
      (e) => e.reason === 'context_length_too_large',
    )!;
    serveVault(
      [
        { path: 'Work/a.md', content: 'one needle' },
        { path: 'Secret/b.md', content: needles },
      ],
      { denyPaths: ['secret'] },
    );
    const fits = await textCall({ query: 'needle', contextLength: 2 ** 28 });
    expect(fits.res.isError).toBeFalsy();
    serveVault([{ path: 'Work/a.md', content: needles }], { denyPaths: ['secret'] });
    const { res, text } = await textCall({ query: 'needle', contextLength: 2 ** 28 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: unknown }).error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'context_length_too_large',
        contextLength: 2 ** 28,
        recovery: { hint: declared.recovery },
      },
    });
    expect(markdownText(text)).toContain('(reason context_length_too_large');
  });

  it('declares text_search_too_costly, the scoped search past its deadline, with levers the caller holds', () => {
    const declared = obsidianSearchNotes.errors!.find((e) => e.reason === 'text_search_too_costly');
    expect(declared).toMatchObject({ code: JsonRpcErrorCode.ValidationError });
    expect(declared?.when).toContain('45 s');
    expect(declared?.recovery).toMatch(/rarer/);
    expect(declared?.recovery).toContain('OBSIDIAN_READ_PATHS');
  });
});

/**
 * Under `OBSIDIAN_READ_PATHS=work` no hit, result value, count, or error may
 * depend on a note outside `Work/`. `Work/a.md` links to an existing
 * out-of-scope note, to a missing out-of-scope one, and to `Work/b.md`;
 * `Private/y.md` links back to `Work/a.md`. The vault stub evaluates whatever
 * tree reaches it against every note, as the plugin does.
 */
/** Install a {@link jsonLogicVault} of `notes` under `config`, or serve it through `fetchImpl`. */
function serveVault(
  notes: VaultNote[],
  config: Partial<ServerConfig>,
  wrap?: (vault: ReturnType<typeof jsonLogicVault>) => ObsidianFetch,
) {
  const vault = jsonLogicVault(notes);
  setObsidianService(
    new ObsidianService(makeTestConfig(config), wrap ? wrap(vault) : vault.fetchImpl),
  );
  return vault;
}

/** One jsonlogic call through the production envelope: the result and both surfaces. */
async function jsonLogicCall(logic: Record<string, unknown>, cursor?: string) {
  const res = await runToolContract(obsidianSearchNotes, {
    mode: 'jsonlogic',
    logic,
    ...(cursor ? { cursor } : {}),
  });
  const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
  return { res, structured: res.structuredContent as Record<string, unknown>, text };
}

/** The position a page cursor carries. */
const decodeCursor = (cursor: string): unknown =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

describe('obsidian_search_notes / jsonlogic under OBSIDIAN_READ_PATHS', () => {
  const VAULT: VaultNote[] = [
    {
      path: 'Work/a.md',
      content: 'alpha [[Private/x]] [[Private/ghost]] [[Work/b]]',
      frontmatter: { status: 'open' },
      tags: ['work'],
      links: ['Private/x.md', 'Work/b.md'],
      unresolvedLinks: ['Private/ghost'],
    },
    {
      path: 'Work/b.md',
      content: 'beta',
      tags: [],
      unresolvedLinks: ['Work/missing'],
    },
    { path: 'Private/x.md', content: 'secret body', tags: ['secret'] },
    { path: 'Private/y.md', content: 'see [[Work/a]]', links: ['Work/a.md'] },
  ];

  const serve = (config: Partial<ServerConfig> = { readPaths: ['work'] }) =>
    serveVault(VAULT, config);
  const search = (logic: Record<string, unknown>) => jsonLogicCall(logic);

  /** The hits array of a successful call. */
  function hitsOf(structured: Record<string, unknown>) {
    return (structured.result as { hits: Array<{ filename: string; result: unknown }> }).hits;
  }

  it.each([
    ['links', { var: 'links' }],
    ['backlinks.0', { var: 'backlinks.0' }],
    ['unresolvedLinks with a default', { var: ['unresolvedLinks', []] }],
    ['an unresolved link test', { in: ['Work/x', { var: 'unresolvedLinks' }] }],
    ['a backlink test', { in: ['Work/sub/b.md', { var: 'backlinks' }] }],
    ['a missing key', { missing: ['path', 'backlinks'] }],
    ['a missing key in one array argument', { missing: [['links.0']] }],
    ['a missing_some key', { missing_some: [1, ['unresolvedLinks', 'tags']] }],
    [
      'a missing test in the array some walks',
      { some: [{ missing: ['backlinks.0'] }, { '==': [{ var: '' }, 'x'] }] },
    ],
  ])(
    'refuses a tree reading %s with the declared link_fields_unavailable, before any request',
    async (_label, logic) => {
      const vault = serve();
      const declared = obsidianSearchNotes.errors!.find(
        (e) => e.reason === 'link_fields_unavailable',
      )!;
      const { res, text } = await search(logic);
      expect(res.isError).toBe(true);
      expect((res.structuredContent as { error: unknown }).error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'link_fields_unavailable', recovery: { hint: declared.recovery } },
      });
      expect(markdownText(text)).toContain('(reason link_fields_unavailable');
      expect(markdownText(text)).toContain(`Recovery: ${declared.recovery}`);
      expect(vault.requests).toEqual([]);
    },
  );

  it('gives the link_fields_unavailable recovery the backlinks recipe the `logic` field documents', () => {
    const recipeOf = (text: string) => {
      const recipe = /`(\{"regexp": \[.*?\]\})`/.exec(text)?.[1];
      if (!recipe) throw new Error(`no backlinks recipe in: ${text}`);
      return (JSON.parse(recipe) as { regexp: [string, unknown] }).regexp;
    };
    const declared = obsidianSearchNotes.errors!.find(
      (e) => e.reason === 'link_fields_unavailable',
    )!;
    expect(recipeOf(declared.recovery)).toEqual(
      recipeOf(obsidianSearchNotes.input.shape.logic.description ?? ''),
    );
    expect(declared.recovery).toContain('`obsidian_get_note` with `includeLinks: true`');
  });

  it('hands back the whole note context with no out-of-scope path and no link field in it', async () => {
    serve();
    const { res, structured } = await search({ var: '' });
    const hits = hitsOf(structured);
    expect(hits.map((h) => h.filename)).toEqual(['Work/a.md', 'Work/b.md']);
    expect(hits[0]?.result).toEqual({
      tags: ['work'],
      frontmatter: { status: 'open' },
      stat: { ctime: 1, mtime: 2, size: VAULT[0]?.content?.length },
      path: 'Work/a.md',
      content: '',
    });
    expect(JSON.stringify(res)).not.toMatch(/priv/i);
  });

  /** A tree's outcome as both surfaces carry it — hits, count, or the error. */
  async function outcomeOf(logic: Record<string, unknown>) {
    const { res, text } = await search(logic);
    return { isError: res.isError ?? false, structured: res.structuredContent, text };
  }

  it.each([
    [
      'a query over backlinks by a computed key',
      (path: string) => ({ in: [path, { var: { cat: ['back', 'links'] } }] }),
      'Private/y.md',
    ],
    [
      'a query over links by a computed key with a default',
      (path: string) => ({ in: [path, { var: [{ cat: ['lin', 'ks'] }, []] }] }),
      'Private/x.md',
    ],
    [
      'a query over the note path',
      (path: string) => ({
        if: [{ '==': [{ var: 'path' }, path] }, { regexp: ['(', 'x'] }, false],
      }),
      'Private/x.md',
    ],
  ])(
    'returns the same outcome for %s whether the out-of-scope note exists or not',
    async (_label, build, existing) => {
      serve();
      const present = await outcomeOf(build(existing));
      const absent = await outcomeOf(build('Private/nope.md'));
      expect(present).toEqual(absent);
      expect(present.isError).toBe(false);
    },
  );

  /**
   * Obsidian resolves a link across the whole vault, so which note it points
   * to can change with notes outside the scope. Every tree answers the same
   * whichever notes exist outside it.
   */
  it.each([
    ['an unresolved link test', 'Work/x', 'unresolvedLinks'],
    ['a backlink test', 'Work/sub/b.md', 'backlinks'],
  ])(
    'answers %s the same whether Obsidian resolves the link inside the scope or outside it',
    async (_label, target, field) => {
      const before: VaultNote[] = [
        { path: 'Work/a.md', unresolvedLinks: ['Work/x'] },
        { path: 'Work/sub/b.md', links: ['Work/deep/y.md'] },
        { path: 'Work/deep/y.md' },
      ];
      const after: VaultNote[] = [
        { path: 'Work/a.md', links: ['Archive/Work/x.md'] },
        { path: 'Work/sub/b.md', links: ['Archive/y.md'] },
        { path: 'Work/deep/y.md' },
        { path: 'Archive/Work/x.md' },
        { path: 'Archive/y.md' },
      ];
      const half = Math.ceil(field.length / 2);
      const trees = [
        { in: [target, { var: field }] },
        { in: [target, { var: { cat: [field.slice(0, half), field.slice(half)] } }] },
      ];
      for (const logic of trees) {
        serveVault(before, { readPaths: ['work'] });
        const inScope = await outcomeOf(logic);
        serveVault(after, { readPaths: ['work'] });
        expect(await outcomeOf(logic)).toEqual(inScope);
      }
    },
  );

  it('returns the same outcome whatever an out-of-scope note contains', async () => {
    serve();
    const probe = (token: string) => ({
      if: [
        { and: [{ '==': [{ var: 'path' }, 'Private/x.md'] }, { in: [token, { var: 'content' }] }] },
        { regexp: ['(', 'x'] },
        false,
      ],
    });
    expect(await outcomeOf(probe('secret'))).toEqual(await outcomeOf(probe('zz-absent')));
  });

  it('never sends the caller tree upstream, and reads note bodies only when the tree names content', async () => {
    const vault = serve();
    await search({ in: ['Private/y.md', { var: 'path' }] });
    expect(vault.requests).toEqual(['POST /search/']);
    expect(vault.bodies[0]).not.toContain('Private/y.md');
    expect(vault.bodies[0]).not.toContain('"content"');

    const { structured } = await search({ in: ['alpha', { var: 'content' }] });
    // Contexts first, then one read per readable note's body.
    expect(vault.requests.slice(1)).toEqual([
      'POST /search/',
      'GET /vault/Work/a.md',
      'GET /vault/Work/b.md',
    ]);
    expect(vault.bodies[1]).not.toContain('"content"');
    expect(vault.bodies[1]).not.toContain('alpha');
    expect(hitsOf(structured)).toEqual([{ filename: 'Work/a.md', result: true }]);
  });

  it('matches the plugin in scope: pattern-first operators, truthiness, and logic_invalid', async () => {
    serve();
    expect(hitsOf((await search({ glob: ['Work/*.md', { var: 'path' }] })).structured)).toEqual([
      { filename: 'Work/a.md', result: true },
      { filename: 'Work/b.md', result: true },
    ]);
    // Reversed operands compile the note path as the pattern: no match, no error.
    expect(hitsOf((await search({ regexp: [{ var: 'path' }, 'Work'] })).structured)).toEqual([]);
    // `{}` and `[]` drop a note; a non-empty object keeps it.
    expect(hitsOf((await search({ var: 'frontmatter' })).structured)).toEqual([
      { filename: 'Work/a.md', result: { status: 'open' } },
    ]);
    expect(hitsOf((await search({ var: 'tags' })).structured)).toEqual([
      { filename: 'Work/a.md', result: ['work'] },
    ]);

    const declared = obsidianSearchNotes.errors!.find((e) => e.reason === 'logic_invalid')!;
    const badPattern = await contractErrorOf(obsidianSearchNotes, {
      mode: 'jsonlogic',
      logic: { regexp: ['(', { var: 'path' }] },
    });
    expect(badPattern).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'logic_invalid', recovery: { hint: declared.recovery } },
    });
    expect(badPattern.message).toMatch(/`regexp`/);
    const unknownOp = await contractErrorOf(obsidianSearchNotes, {
      mode: 'jsonlogic',
      logic: { bogus: [1] },
    });
    expect(unknownOp.data.reason).toBe('logic_invalid');
    expect(unknownOp.message).not.toMatch(/regexp/);
  });

  it.each([
    ['write paths alone', { writePaths: ['work'] }],
    ['read-only alone', { readOnly: true }],
  ] as Array<[string, Partial<ServerConfig>]>)(
    'passes the tree upstream unchanged with %s',
    async (_label, config) => {
      const vault = serve(config);
      const logic = { var: 'links' };
      const { structured } = await search(logic);
      expect(vault.bodies).toEqual([JSON.stringify(logic)]);
      expect(hitsOf(structured)).toEqual([
        { filename: 'Work/a.md', result: ['Private/x.md', 'Work/b.md'] },
        { filename: 'Private/y.md', result: ['Work/a.md'] },
      ]);
    },
  );
});

/**
 * A scoped walk evaluates the tree once, on its first page, and serves the
 * pages after it from the hit list that page stored — for the same tree and
 * read scope only.
 */
describe('obsidian_search_notes / scoped jsonlogic paged walks', () => {
  const pad = (i: number) => String(i).padStart(3, '0');
  const WORK = Array.from({ length: 120 }, (_, i) => `Work/n${pad(i)}.md`);
  const VAULT: VaultNote[] = [
    ...WORK.map((path, i) => ({ path, content: `x ${i % 2 === 1 ? 'odd' : 'even'}` })),
    ...Array.from({ length: 30 }, (_, i) => ({ path: `Private/p${pad(i)}.md`, content: 'x odd' })),
  ];
  const ODD = WORK.filter((_, i) => i % 2 === 1);
  const tree = { in: ['x', { var: 'content' }] };

  afterEach(() => {
    vi.useRealTimers();
  });

  const serve = (readPaths = ['work']) => serveVault(VAULT, { readPaths });

  type Page = { hits: Array<{ filename: string }>; totalCount: number; nextCursor?: string };

  /** One successful page through the production envelope: both surfaces. */
  async function pageOf(logic: Record<string, unknown>, cursor?: string) {
    const { res, structured, text } = await jsonLogicCall(logic, cursor);
    expect(res.isError).toBeFalsy();
    const page = structured.result as Page;
    return { res, page, files: page.hits.map((h) => h.filename), text };
  }

  /**
   * Each evaluation makes one context search, so `vault.bodies` (the search
   * bodies sent) counts evaluations; a page served from a stored walk makes no
   * request at all.
   */
  it('evaluates a three-page walk once and serves the later pages from its stored hits', async () => {
    const vault = serve();
    const first = await pageOf(tree);
    const firstPageRequests = [...vault.requests];
    const second = await pageOf(tree, first.page.nextCursor);
    const third = await pageOf(tree, second.page.nextCursor);
    // The first page's requests (contexts, then one read per readable body) are the walk's only ones.
    expect(firstPageRequests).toEqual(['POST /search/', ...WORK.map((p) => `GET /vault/${p}`)]);
    expect(vault.requests).toEqual(firstPageRequests);
    expect([...first.files, ...second.files, ...third.files]).toEqual(WORK);
    expect([first, second, third].map((p) => p.page.totalCount)).toEqual([120, 120, 120]);
    expect(third.page.nextCursor).toBeUndefined();
    expect(second.text).toContain(
      '**Search (jsonlogic) — 50 on this page · 120 total · more available**',
    );
    expect(second.text).toContain(`_Next page cursor: \`${second.page.nextCursor}\`_`);
    expect(second.text).toContain('### Work/n050.md');
    expect(third.text).toContain('### Work/n119.md');
  });

  it('answers a page past the end of a stored walk with no hits', async () => {
    const vault = serve();
    const first = await pageOf(tree);
    const position = decodeCursor(first.page.nextCursor!) as Record<string, unknown>;
    const pastEnd = Buffer.from(JSON.stringify({ ...position, offset: 120 })).toString('base64url');
    const requests = vault.requests.length;
    const page = await pageOf(tree, pastEnd);
    expect(page.page).toEqual({ mode: 'jsonlogic', hits: [], totalCount: 120 });
    expect(vault.requests).toHaveLength(requests);
  });

  it("evaluates a different tree fresh rather than reading another walk's hits", async () => {
    const vault = serve();
    const all = await pageOf(tree);
    const odd = await pageOf({ in: ['odd', { var: 'content' }] }, all.page.nextCursor);
    expect(odd.page.totalCount).toBe(60);
    expect(odd.files).toEqual(ODD.slice(50));
    expect(vault.bodies).toHaveLength(2);
  });

  it("evaluates under the current read scope rather than reading a wider scope's hits", async () => {
    serve(['work', 'private']);
    const wide = await pageOf(tree);
    expect(wide.page.totalCount).toBe(150);
    const vault = serve(['work']);
    const narrow = await pageOf(tree, wide.page.nextCursor);
    expect(narrow.page.totalCount).toBe(120);
    expect(narrow.files).toEqual(WORK.slice(50, 100));
    expect(JSON.stringify(narrow.res)).not.toMatch(/private/i);
    expect(vault.bodies).toHaveLength(1);
    expect(vault.requests.filter((r) => /private/i.test(r))).toEqual([]);
  });

  it('evaluates again once a stored walk sits unread past its lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-10-24T00:00:00Z');
    vi.setSystemTime(start);
    const vault = serve();
    const first = await pageOf(tree);
    // Each read restarts the five-minute lifetime.
    vi.setSystemTime(start + 299_000);
    const second = await pageOf(tree, first.page.nextCursor);
    vi.setSystemTime(start + 598_000);
    expect((await pageOf(tree, second.page.nextCursor)).files).toEqual(WORK.slice(100));
    expect(vault.bodies).toHaveLength(1);
    // Unread for longer than that: the cursor's page is evaluated again, and stored again.
    vi.setSystemTime(start + 899_000);
    const again = await pageOf(tree, first.page.nextCursor);
    expect(again.files).toEqual(WORK.slice(50, 100));
    expect(vault.bodies).toHaveLength(2);
    expect((await pageOf(tree, again.page.nextCursor)).files).toEqual(WORK.slice(100));
    expect(vault.bodies).toHaveLength(2);
  });

  it('sends an unscoped search upstream for every page, its cursor a plain position', async () => {
    const vault = serveVault(VAULT, { writePaths: ['work'] });
    const first = await pageOf(tree);
    const second = await pageOf(tree, first.page.nextCursor);
    expect(second.files).toEqual(WORK.slice(50, 100));
    expect(vault.bodies).toEqual([JSON.stringify(tree), JSON.stringify(tree)]);
    expect(decodeCursor(first.page.nextCursor!)).toEqual({ offset: 50, limit: 50 });
  });

  it('stores nothing for a cancelled first page, and the next walk stores its own hits', async () => {
    const controller = new AbortController();
    // Cancelled once the last readable body has arrived, before the tree is evaluated over them.
    const vault = serveVault(VAULT, { readPaths: ['work'] }, (v) => async (url, init) => {
      const res = await v.fetchImpl(url, init);
      if (v.requests.length === 1 + WORK.length) controller.abort();
      return res;
    });
    const err = await rejectionOf(
      (async () =>
        obsidianSearchNotes.handler(
          obsidianSearchNotes.input.parse({ mode: 'jsonlogic', logic: tree }),
          createMockContext({ signal: controller.signal, errors: obsidianSearchNotes.errors }),
        ))(),
    );
    expect(err).toBe(controller.signal.reason);

    const first = await pageOf(tree);
    const second = await pageOf(tree, first.page.nextCursor);
    expect(second.files).toEqual(WORK.slice(50, 100));
    expect(vault.bodies).toHaveLength(2);
  });

  it('hands the service its page size, and stores no walk for a search that fits one page', async () => {
    serve();
    const svc = getObsidianService();
    const paged = vi.spyOn(svc, 'pageJsonLogic');
    const onePage = await pageOf({ in: ['odd', { var: 'content' }] });
    expect(onePage.page.totalCount).toBe(60);
    const single = { '<': [{ substr: [{ var: 'path' }, 6, 3] }, '050'] };
    const fits = await pageOf(single);
    expect(fits.page.totalCount).toBe(50);
    expect(fits.page.nextCursor).toBeUndefined();
    expect(paged.mock.calls.map((call) => call.slice(2))).toEqual([
      [undefined, 50],
      [undefined, 50],
    ]);
    expect((await paged.mock.results[0]?.value)?.walk).toEqual(expect.any(String));
    expect(await paged.mock.results[1]?.value).not.toHaveProperty('walk');
  });

  it('stores nothing when the cancellation lands after the evaluation answers', async () => {
    const controller = new AbortController();
    const { signal } = controller;
    // The search closes its evaluation's worker once the worker has answered; cancel right then.
    const terminate = Worker.prototype.terminate;
    const terminated = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (
      this: Worker,
    ) {
      controller.abort();
      return terminate.call(this);
    });
    const vault = serve();
    const { result } = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'jsonlogic', logic: tree }),
      createMockContext({ signal, errors: obsidianSearchNotes.errors }),
    );
    terminated.mockRestore();
    expect(signal.aborted).toBe(true);
    expect(result.hits.map((hit) => hit.filename)).toEqual(WORK.slice(0, 50));
    expect(vault.bodies).toHaveLength(1);
    expect(decodeCursor(result.nextCursor!)).toEqual({ offset: 50, limit: 50 });
    // No walk was stored, so the next page evaluates the tree again.
    const second = await pageOf(tree, result.nextCursor);
    expect(second.files).toEqual(WORK.slice(50, 100));
    expect(vault.bodies).toHaveLength(2);
  });
});

describe('obsidian_search_notes / scoped jsonlogic failures the server raises', () => {
  afterEach(() => {
    setObsidianService(undefined);
  });

  it('fails on a readable note too deep to evaluate with note_too_deep, then answers once it is gone', async () => {
    const deep = deepNoteFetch('Work/deep.md', 100_000);
    const vault = jsonLogicVault([{ path: 'Work/a.md' }]);
    let deepNotePresent = true;
    setObsidianService(
      new ObsidianService(makeTestConfig({ readPaths: ['work'] }), (url, init) =>
        deepNotePresent ? deep(url, init) : vault.fetchImpl(url, init),
      ),
    );
    const declared = obsidianSearchNotes.errors!.find((e) => e.reason === 'note_too_deep')!;
    const error = await contractErrorOf(obsidianSearchNotes, {
      mode: 'jsonlogic',
      logic: { var: 'path' },
    });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message:
        'The readable note "Work/deep.md" holds data nested 100,001 levels deep, too deep for the server to hand to its evaluator.',
      data: {
        reason: 'note_too_deep',
        path: 'Work/deep.md',
        recovery: { hint: declared.recovery },
      },
    });
    deepNotePresent = false;
    const { res, structured } = await jsonLogicCall({ var: 'path' });
    expect(res.isError).toBeFalsy();
    expect(structured.result).toEqual({
      mode: 'jsonlogic',
      hits: [{ filename: 'Work/a.md', result: 'Work/a.md' }],
      totalCount: 1,
    });
  });

  it('fails a tree nested past the depth bound with the declared logic_too_costly', async () => {
    const vault = serveVault([{ path: 'Work/a.md' }], { readPaths: ['work'] });
    let deep: Record<string, unknown> = { var: 'path' };
    for (let level = 0; level < 50_000; level++) deep = { '!!': [deep] };
    const declared = obsidianSearchNotes.errors!.find((e) => e.reason === 'logic_too_costly')!;
    const error = await contractErrorOf(obsidianSearchNotes, { mode: 'jsonlogic', logic: deep });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'The JSONLogic tree nests deeper than 1,000 levels.',
      data: { reason: 'logic_too_costly', recovery: { hint: declared.recovery } },
    });
    expect(vault.bodies).toEqual([]);
  });

  it('names the link fields and the scoped walk in its parameter descriptions', () => {
    const shape = obsidianSearchNotes.input.shape;
    expect(shape.mode.description).toContain(
      '`links`, `backlinks`, and `unresolvedLinks` (on plugin versions that provide them; not under OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS, where a tree that reads them is rejected)',
    );
    expect(shape.cursor.description).toContain(
      'Under OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS, later `jsonlogic` pages come from the hit list the first page computed.',
    );
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

  /**
   * The documented recipe, run as the regex a caller would send, against the
   * forms Obsidian indexes as a link to `Target Note`. `\|` is the only way to
   * alias a link inside a table cell; `\#` is no escape, so `[[Target Note\#H]]`
   * links to `Target Note\`, not to `Target Note`.
   */
  it('documents a backlinks recipe that matches every form Obsidian links', () => {
    const logicDescription = obsidianSearchNotes.input.shape.logic.description ?? '';
    const recipe = /`(\{"regexp": \[.*?\]\})`/.exec(logicDescription)?.[1];
    if (!recipe) throw new Error('backlinks recipe not found in the `logic` description');
    const [pattern] = (JSON.parse(recipe) as { regexp: [string, unknown] }).regexp;
    const backlink = new RegExp(pattern);

    for (const body of [
      'See [[Target Note]].',
      'See [[Target Note|alias]].',
      'See [[Target Note#Heading]].',
      '| [[Target Note\\|alias]] |',
      '![[Target Note\\|embed]]',
    ]) {
      expect(backlink.test(body), body).toBe(true);
    }
    for (const body of ['See [[Target Notes]].', 'See [[Target Note\\#Heading]].']) {
      expect(backlink.test(body), body).toBe(false);
    }
  });

  it('does not claim backlinks lack an upstream source', () => {
    const logicDescription = obsidianSearchNotes.input.shape.logic.description ?? '';
    expect(logicDescription).not.toContain('upstream endpoint');
  });
});

describe('obsidian_search_notes / logic_invalid', () => {
  const declaredRecovery = obsidianSearchNotes.errors!.find(
    (e) => e.reason === 'logic_invalid',
  )?.recovery;

  it('maps an upstream 400 on the jsonlogic route to reason logic_invalid', async () => {
    harness
      .current()
      .pool.intercept({ path: '/search/', method: 'POST' })
      .reply(
        400,
        { errorCode: 40000, message: 'Invalid JsonLogic query supplied.' },
        { headers: { 'content-type': 'application/json' } },
      );

    expect(
      await contractErrorOf(obsidianSearchNotes, { mode: 'jsonlogic', logic: { bogus: [1, 2] } }),
    ).toMatchObject({
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
      expect(matchShape.shape[key]!.description).toMatch(/within the (same )?subject/i);
    }
    expect(matchShape.shape.contextStart!.description).toMatch(/within `context`/);
    expect(matchShape.shape.contextEnd!.description).toMatch(/within `context`/);
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
    expect(text).toContain('match at context[100–105] · subject[469–474]');
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
 * The Local REST API serializes every match before responding, its window
 * plus about 150 characters of offsets and framing, so it runs out of string
 * capacity once the matches pass V8's longest string and answers HTTP 500
 * with a V8 `RangeError`. Untyped, that reaches the caller as a bare -32603
 * naming neither the parameter at fault nor the levers that fix it.
 */
describe('obsidian_search_notes / context_length_too_large', () => {
  const declaredRecovery = obsidianSearchNotes.errors!.find(
    (e) => e.reason === 'context_length_too_large',
  )?.recovery;

  const input = { mode: 'text', query: 'the', contextLength: 500 } as const;

  const stubSearch = (status: number, body: unknown) => {
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(status, body, { headers: { 'content-type': 'application/json' } });
  };

  const replyWith = (status: number, body: unknown) => {
    stubSearch(status, body);
    return obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse(input),
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
    // Each match costs about 150 characters beside its window, so a common
    // token can fail at any window; the hint must not promise otherwise.
    expect(declaredRecovery).toMatch(/common token/);
    expect(declaredRecovery).toContain('`contextLength` 0');
    const declared = obsidianSearchNotes.errors!.find(
      (e) => e.reason === 'context_length_too_large',
    );
    expect(declared?.when).toContain('about 150 characters');
    expect(declared?.when).toContain('OBSIDIAN_DENY_PATHS');
  });

  it('maps the upstream RangeError to a typed, recoverable validation error', async () => {
    stubSearch(500, RANGE_ERROR);
    expect(await contractErrorOf(obsidianSearchNotes, input)).toMatchObject({
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
    expect(err?.data?.reason).toBe('context_length_too_large');
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

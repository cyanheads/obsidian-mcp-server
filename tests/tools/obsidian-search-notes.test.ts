/**
 * @fileoverview Handler tests for obsidian_search_notes across the three modes.
 * @module tests/tools/obsidian-search-notes.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianSearchNotes } from '@/mcp-server/tools/definitions/obsidian-search-notes.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

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
          mode: 'dataview',
          query: 'TABLE x FROM ""',
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

  it('caps hits at 100 and reports the overflow in `excluded`', async () => {
    const many = Array.from({ length: 105 }, (_, i) => ({
      filename: `n${i}.md`,
      matches: [{ context: 'x', match: { start: 0, end: 1 } }],
    }));
    harness
      .current()
      .pool.intercept({
        path: (p) => (p as string).startsWith('/search/simple/'),
        method: 'POST',
      })
      .reply(200, many, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'text', query: 'x' }),
      createMockContext(),
    );
    if (out.result.mode !== 'text') throw new Error('expected text branch');
    expect(out.result.hits).toHaveLength(100);
    expect(out.result.excluded).toEqual({ count: 5, hint: expect.any(String) });
  });
});

describe('obsidian_search_notes / dataview', () => {
  it('forwards the DQL string and returns structured hits', async () => {
    harness
      .current()
      .pool.intercept({ path: '/search/', method: 'POST' })
      .reply(200, [{ filename: 'A.md', result: { mtime: 123 } }], {
        headers: { 'content-type': 'application/json' },
      });

    const out = await obsidianSearchNotes.handler(
      obsidianSearchNotes.input.parse({ mode: 'dataview', query: 'TABLE file.mtime FROM ""' }),
      createMockContext(),
    );
    if (out.result.mode !== 'dataview') throw new Error('expected dataview branch');
    expect(out.result.hits).toEqual([{ filename: 'A.md', result: { mtime: 123 } }]);
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
        excluded: undefined,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('A.md');
    expect(text).toContain('snippet');
  });

  it('renders structured hits as JSON code blocks', () => {
    const blocks = obsidianSearchNotes.format!({
      result: {
        mode: 'dataview',
        hits: [{ filename: 'A.md', result: { mtime: 1 } }],
        excluded: undefined,
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
        excluded: undefined,
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('truncated');
    expect(text).toContain('first 1 of 25');
  });

  it('shows the excluded count and hint when results are capped', () => {
    const blocks = obsidianSearchNotes.format!({
      result: {
        mode: 'text',
        hits: [],
        excluded: { count: 5, hint: 'Narrow your query.' },
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Excluded 5');
    expect(text).toContain('Narrow your query.');
  });
});

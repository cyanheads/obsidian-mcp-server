/**
 * @fileoverview Handler tests for obsidian_list_tags.
 * @module tests/tools/obsidian-list-tags.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { obsidianListTags } from '@/mcp-server/tools/definitions/obsidian-list-tags.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse, setupHarness } from '../helpers.js';

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
      createMockContext({ errors: obsidianListTags.errors }),
    );
    expect(out.tags).toEqual([
      { name: 'work', count: 5 },
      { name: 'work/tasks', count: 3 },
    ]);
    // The cap is always in effect, so it is always echoed back.
    expect(out.appliedFilters).toEqual({ limit: 200 });
  });

  it('handles an empty tag list gracefully and populates enrichment notice', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(200, { tags: [] }, { headers: { 'content-type': 'application/json' } });

    const ctx = createMockContext({ errors: obsidianListTags.errors });
    const out = await obsidianListTags.handler(obsidianListTags.input.parse({}), ctx);
    expect(out.tags).toEqual([]);
    // An empty vault is not a filtered-out vault: `limit` is always applied but
    // never causes an empty result, so it must not appear in this notice.
    expect(getEnrichment(ctx).notice).toBe('No tags found. The vault may have no tagged notes.');
  });

  it('applies nameRegex to keep only matching tags', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(
        200,
        {
          tags: [
            { name: 'work', count: 5 },
            { name: 'work/tasks', count: 3 },
            { name: 'personal', count: 2 },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianListTags.handler(
      obsidianListTags.input.parse({ nameRegex: '^work' }),
      createMockContext({ errors: obsidianListTags.errors }),
    );
    expect(out.tags).toEqual([
      { name: 'work', count: 5 },
      { name: 'work/tasks', count: 3 },
    ]);
    expect(out.appliedFilters).toEqual({ nameRegex: '^work', limit: 200 });
  });

  it('returns an empty list with appliedFilters echoed when nameRegex excludes everything, and populates enrichment notice', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(
        200,
        { tags: [{ name: 'work', count: 5 }] },
        { headers: { 'content-type': 'application/json' } },
      );

    const ctx = createMockContext({ errors: obsidianListTags.errors });
    const out = await obsidianListTags.handler(
      obsidianListTags.input.parse({ nameRegex: '^nothing-matches$' }),
      ctx,
    );
    expect(out.tags).toEqual([]);
    expect(out.appliedFilters).toEqual({ nameRegex: '^nothing-matches$', limit: 200 });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no tags/i);
    expect(enrichment.notice).toContain('nameRegex=`^nothing-matches$`');
    expect(enrichment.notice).not.toMatch(/no tagged notes/i);
  });

  it('throws regex_invalid (ValidationError) when nameRegex is not valid', async () => {
    await expect(
      obsidianListTags.handler(
        obsidianListTags.input.parse({ nameRegex: '[' }),
        createMockContext({ errors: obsidianListTags.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_invalid' },
    });
  });

  /**
   * `nameRegex` is compiled from caller input and run against every tag name,
   * and tag names are vault-authored, so a catastrophic-backtracking pattern
   * like `^(a+)+$` against a long all-`a` tag can stall the request. The static
   * guard rejects it before any tag is read: no `/tags/` intercept is
   * registered, so a handler that reached the vault would fail with "No mock
   * intercept" instead of `regex_unsafe`.
   */
  it('throws regex_unsafe (ValidationError) for a catastrophic-backtracking nameRegex before reading tags', async () => {
    await expect(
      obsidianListTags.handler(
        obsidianListTags.input.parse({ nameRegex: '^(a+)+$' }),
        createMockContext({ errors: obsidianListTags.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_unsafe', nameRegex: '^(a+)+$' },
    });
  });
});

describe('obsidian_list_tags / format()', () => {
  const textOf = (result: Parameters<NonNullable<typeof obsidianListTags.format>>[0]) =>
    (obsidianListTags.format!(result)[0] as { text: string }).text;

  it('renders each tag with its count under a header echoing the default limit', () => {
    expect(
      textOf({
        tags: [
          { name: 'foo', count: 2 },
          { name: 'foo/bar', count: 1 },
        ],
        appliedFilters: { limit: 200 },
      }),
    ).toBe(['**2 tags** · limit=200', '', '- `#foo` (2)', '- `#foo/bar` (1)'].join('\n'));
  });

  it('renders a bare zero-count header when there are no tags', () => {
    expect(textOf({ tags: [], appliedFilters: { limit: 200 } })).toBe('**0 tags** · limit=200');
  });

  it('echoes the active nameRegex in the header even when the result is empty', () => {
    expect(
      textOf({ tags: [], appliedFilters: { nameRegex: '^nothing-matches$', limit: 200 } }),
    ).toBe('**0 tags** · nameRegex=`^nothing-matches$` · limit=200');
  });
});

/**
 * An unfiltered `obsidian_list_tags({})` is the exploratory first call — made
 * precisely because the caller does not yet know what to filter on — and it
 * previously returned the vault's entire tag distribution on both consumption
 * paths. The cap makes that call bounded; the sort makes the retained head the
 * informative one; the enrichment makes the withholding visible.
 */
describe('obsidian_list_tags / cap, sort, and truncation disclosure', () => {
  /**
   * Deliberately NOT count-descending. Fixtures that happen to arrive sorted
   * cannot fail if the sort regresses.
   */
  const UNSORTED = [
    { name: 'alpha', count: 1 },
    { name: 'beta', count: 97 },
    { name: 'gamma', count: 12 },
    { name: 'delta', count: 5 },
    { name: 'epsilon', count: 40 },
  ];

  const reply = (tags: Array<{ name: string; count: number }>) => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(200, { tags }, { headers: { 'content-type': 'application/json' } });
  };

  const call = async (input: Record<string, unknown>) => {
    const ctx = createMockContext({ errors: obsidianListTags.errors });
    const out = await obsidianListTags.handler(obsidianListTags.input.parse(input), ctx);
    return { out, enrichment: getEnrichment(ctx) };
  };

  it('sorts by count descending rather than passing upstream order through', async () => {
    reply(UNSORTED);
    const { out } = await call({});
    expect(out.tags.map((t) => t.name)).toEqual(['beta', 'epsilon', 'gamma', 'delta', 'alpha']);
    expect(out.tags.map((t) => t.count)).toEqual([97, 40, 12, 5, 1]);
  });

  it('breaks count ties by name so the order is deterministic', async () => {
    reply([
      { name: 'zulu', count: 7 },
      { name: 'alpha', count: 7 },
      { name: 'mike', count: 7 },
    ]);
    const { out } = await call({});
    expect(out.tags.map((t) => t.name)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('caps at the default 200 and discloses truncation through enrichment', async () => {
    // 260 tags, counts ascending in the payload so the cap must follow the sort.
    reply(Array.from({ length: 260 }, (_, i) => ({ name: `t${i}`, count: i + 1 })));
    const { out, enrichment } = await call({});

    expect(out.tags).toHaveLength(200);
    // The retained head is the most-used, not an arbitrary upstream prefix.
    expect(out.tags[0]).toEqual({ name: 't259', count: 260 });
    expect(out.tags.at(-1)).toEqual({ name: 't60', count: 61 });

    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(200);
    expect(enrichment.cap).toBe(200);
  });

  it('discloses nothing when the candidate set fits under the cap', async () => {
    reply(UNSORTED);
    const { out, enrichment } = await call({});
    expect(out.tags).toHaveLength(5);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('discloses nothing when the candidate count lands exactly on the cap', async () => {
    reply(Array.from({ length: 4 }, (_, i) => ({ name: `t${i}`, count: i + 1 })));
    const { out, enrichment } = await call({ limit: 4 });
    expect(out.tags).toHaveLength(4);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('returns the complete set when limit is raised to the ceiling', async () => {
    reply(Array.from({ length: 1_500 }, (_, i) => ({ name: `t${i}`, count: i + 1 })));
    const { out, enrichment } = await call({ limit: 10_000 });
    expect(out.tags).toHaveLength(1_500);
    expect(enrichment.truncated).toBeUndefined();
    expect(out.appliedFilters.limit).toBe(10_000);
  });

  it('rejects a limit above the ceiling and a limit below 1', () => {
    expect(() => obsidianListTags.input.parse({ limit: 10_001 })).toThrow();
    expect(() => obsidianListTags.input.parse({ limit: 0 })).toThrow();
    expect(obsidianListTags.input.parse({ limit: 10_000 }).limit).toBe(10_000);
    expect(obsidianListTags.input.parse({ limit: 1 }).limit).toBe(1);
  });

  it('drops the single-use tail with minCount and echoes it', async () => {
    reply(UNSORTED);
    const { out } = await call({ minCount: 12 });
    expect(out.tags).toEqual([
      { name: 'beta', count: 97 },
      { name: 'epsilon', count: 40 },
      { name: 'gamma', count: 12 },
    ]);
    expect(out.appliedFilters.minCount).toBe(12);
  });

  it('omits minCount from appliedFilters when it is omitted or explicitly 0', async () => {
    reply(UNSORTED);
    expect((await call({})).out.appliedFilters.minCount).toBeUndefined();
    reply(UNSORTED);
    // The field's own describe offers 0 as the no-filter spelling, so it must
    // be accepted and echoed the same way an omission is.
    const zero = await call({ minCount: 0 });
    expect(zero.out.appliedFilters.minCount).toBeUndefined();
    expect(zero.out.tags).toHaveLength(UNSORTED.length);
  });

  /**
   * Pipeline order is nameRegex → minCount → sort → limit, and the truncation
   * math is computed against the post-filter candidate count. Reporting
   * "shown 2 of 5" here — counting tags `minCount` had already excluded —
   * would misdescribe what was withheld.
   */
  it('applies nameRegex, then minCount, then sort, then limit', async () => {
    reply([
      { name: 'work/a', count: 3 },
      { name: 'personal/x', count: 900 },
      { name: 'work/b', count: 50 },
      { name: 'work/c', count: 1 },
      { name: 'work/d', count: 22 },
    ]);
    const { out, enrichment } = await call({ nameRegex: '^work/', minCount: 3, limit: 2 });

    // personal/x excluded by nameRegex despite the highest count; work/c by minCount.
    expect(out.tags).toEqual([
      { name: 'work/b', count: 50 },
      { name: 'work/d', count: 22 },
    ]);
    // Candidates after both filters = 3 (work/b, work/d, work/a), not 5.
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(2);
    expect(out.appliedFilters).toEqual({ nameRegex: '^work/', minCount: 3, limit: 2 });
  });

  it('still reports the empty-result notice when filters exclude everything', async () => {
    reply(UNSORTED);
    const { out, enrichment } = await call({ minCount: 5_000 });
    expect(out.tags).toEqual([]);
    expect(enrichment.notice).toBe(
      'No tags matched minCount=5000. Loosen or drop the filters to widen the listing.',
    );
    expect(enrichment.truncated).toBeUndefined();
  });

  /**
   * The handler-level cases read the mock's enrichment store, which keeps
   * whatever the handler set. Only the declared `enrichment` schema lets
   * `truncated` / `shown` / `cap` through to a client, so this runs the
   * production pipeline and reads both wire surfaces.
   */
  it('carries truncated, shown, and cap to both wire surfaces when the cap bites', async () => {
    reply(UNSORTED);
    const res = await runToolContract(obsidianListTags, { limit: 2 });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      tags: [
        { name: 'beta', count: 97 },
        { name: 'epsilon', count: 40 },
      ],
      truncated: true,
      shown: 2,
      cap: 2,
    });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('**truncated:** true\n**shown:** 2\n**cap:** 2');
    expect(text).toContain('Showing the 2 most-used of 5 matching tags.');
  });

  it('describes the tags output as ordered by count, ties by name', () => {
    expect(obsidianListTags.output.shape.tags.description).toBe(
      'Matching tags ordered by `count` descending, ties broken by name ascending, truncated to `appliedFilters.limit`.',
    );
  });
});

describe('obsidian_list_tags / format() echoes the applied cap and filters', () => {
  it('renders nameRegex, minCount, and limit in the header', () => {
    const text = (
      obsidianListTags.format!({
        tags: [{ name: 'work', count: 5 }],
        appliedFilters: { nameRegex: '^work', minCount: 3, limit: 25 },
      })[0] as { text: string }
    ).text;
    expect(text).toBe(
      ['**1 tags** · nameRegex=`^work` · minCount=3 · limit=25', '', '- `#work` (5)'].join('\n'),
    );
  });
});

/**
 * Under `OBSIDIAN_READ_PATHS`, tags come from readable notes only, counted as
 * readable notes carrying the tag or a tag nested under it. The stub serves a
 * vault-wide `/tags/` too, so a listing that ignored the scope would surface
 * `secret` and `proj/z` and the vault-wide `misc` count.
 */
describe('obsidian_list_tags / OBSIDIAN_READ_PATHS scope', () => {
  const NOTES = [
    { filename: 'Work/a.md', result: ['proj/x', 'misc'] },
    { filename: 'Work/b.md', result: ['proj/x', 'proj/y'] },
    { filename: 'Work/c.md', result: ['proj/y', 'solo'] },
    { filename: 'Private/p.md', result: ['proj/z', 'secret', 'misc'] },
  ];
  const VAULT_WIDE = [
    { name: 'proj', count: 5 },
    { name: 'proj/x', count: 2 },
    { name: 'proj/y', count: 2 },
    { name: 'proj/z', count: 1 },
    { name: 'misc', count: 2 },
    { name: 'secret', count: 1 },
    { name: 'solo', count: 1 },
  ];

  afterEach(() => {
    setObsidianService(undefined);
  });

  function scope(readPaths: string[]) {
    const fetchImpl: ObsidianFetch = async (url) => {
      const path = new URL(url).pathname;
      const body = path === '/search/' ? NOTES : { tags: VAULT_WIDE };
      return mockResponse(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    setObsidianService(new ObsidianService(makeTestConfig({ readPaths }), fetchImpl));
  }

  it('returns only readable-note tags with note counts on both wire surfaces', async () => {
    scope(['work']);
    const res = await runToolContract(obsidianListTags, {});

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      tags: Array<{ name: string; count: number }>;
      appliedFilters: Record<string, unknown>;
    };
    expect(structured.tags).toEqual([
      { name: 'proj', count: 3 },
      { name: 'proj/x', count: 2 },
      { name: 'proj/y', count: 2 },
      { name: 'misc', count: 1 },
      { name: 'solo', count: 1 },
    ]);
    expect(structured.appliedFilters).toEqual({ limit: 200 });

    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toBe(
      [
        '**5 tags** · limit=200',
        '',
        '- `#proj` (3)',
        '- `#proj/x` (2)',
        '- `#proj/y` (2)',
        '- `#misc` (1)',
        '- `#solo` (1)',
      ].join('\n'),
    );
  });

  it('applies nameRegex, minCount, limit, and truncated to the scoped set', async () => {
    scope(['work']);
    const ctx = createMockContext({ errors: obsidianListTags.errors });
    const out = await obsidianListTags.handler(
      obsidianListTags.input.parse({ nameRegex: '^proj', minCount: 2, limit: 2 }),
      ctx,
    );
    // Scoped candidates: proj 3, proj/x 2, proj/y 2 — proj/z is out of scope.
    expect(out.tags).toEqual([
      { name: 'proj', count: 3 },
      { name: 'proj/x', count: 2 },
    ]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(enrichment.notice).toContain('Showing the 2 most-used of 3 matching tags.');
  });

  it('reports an empty scoped listing with a notice that names the read scope', async () => {
    scope(['nowhere']);
    const ctx = createMockContext({ errors: obsidianListTags.errors });
    const out = await obsidianListTags.handler(obsidianListTags.input.parse({}), ctx);
    expect(out.tags).toEqual([]);
    expect(getEnrichment(ctx).notice).toBe(
      'No tags found in the notes OBSIDIAN_READ_PATHS makes readable.',
    );
  });

  it('describes count as readable notes under a read scope', () => {
    const count = obsidianListTags.output.shape.tags.element.shape.count.description ?? '';
    expect(count).toMatch(/OBSIDIAN_READ_PATHS/);
    expect(count).toMatch(/readable notes carrying the tag or a tag nested under it/);
  });
});

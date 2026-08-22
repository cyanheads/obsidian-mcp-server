/**
 * @fileoverview Handler tests for obsidian_list_tags.
 * @module tests/tools/obsidian-list-tags.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no tags/i);
    // An empty vault is not a filtered-out vault: `limit` is always applied but
    // never causes an empty result, so it must not appear in this notice.
    expect(enrichment.notice).toMatch(/no tagged notes/i);
    expect(enrichment.notice).not.toMatch(/limit/i);
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
   * Regression: `nameRegex` is compiled from user input with `new RegExp(...)`
   * and run against every tag name. A catastrophic-backtracking pattern like
   * `^(a+)+$` against a long all-`a` string blows up exponentially — on V8 a
   * 28-character input takes seconds. Since tag names can be authored inside
   * the vault (or appear in adversarial test data), an LLM that constructs a
   * naive regex can stall the entire request.
   *
   * Acceptable fixes: validate patterns with `safe-regex2` (or equivalent)
   * and throw `regex_invalid` on rejection, cap pattern length, cap tag-name
   * length matched, or run the match in a worker with a hard wall-clock
   * deadline. Any of those satisfies this test.
   */
  it('does not hang on a ReDoS pattern (rejects unsafe regex or completes within 1s)', async () => {
    const longA = 'a'.repeat(28);
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(
        200,
        { tags: [{ name: `${longA}b`, count: 1 }] },
        { headers: { 'content-type': 'application/json' } },
      );

    const start = Date.now();
    try {
      await obsidianListTags.handler(
        obsidianListTags.input.parse({ nameRegex: '^(a+)+$' }),
        createMockContext({ errors: obsidianListTags.errors }),
      );
    } catch (err) {
      // Acceptable outcome: pattern-safety guard rejects the regex before
      // running it. Bubble anything that isn't a McpError so an unexpected
      // crash still fails the test.
      expect(err).toMatchObject({ code: expect.any(Number) });
    }
    expect(Date.now() - start).toBeLessThan(1_000);
  }, 10_000);
});

describe('obsidian_list_tags / format()', () => {
  it('renders each tag with its count', () => {
    const blocks = obsidianListTags.format!({
      tags: [{ name: 'foo', count: 2 }],
      appliedFilters: { limit: 200 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('#foo');
    expect(text).toContain('(2)');
  });

  it('renders a zero-count header when there are no tags', () => {
    const blocks = obsidianListTags.format!({ tags: [], appliedFilters: { limit: 200 } });
    expect((blocks[0] as { text: string }).text).toContain('0 tags');
  });

  it('echoes the active nameRegex in the header when a filter was applied', () => {
    const blocks = obsidianListTags.format!({
      tags: [{ name: 'work', count: 5 }],
      appliedFilters: { nameRegex: '^work', limit: 200 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('nameRegex=`^work`');
    expect(text).toContain('#work');
  });

  it('echoes the active nameRegex in the header even when the result is empty', () => {
    const blocks = obsidianListTags.format!({
      tags: [],
      appliedFilters: { nameRegex: '^nothing-matches$', limit: 200 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('0 tags');
    expect(text).toContain('^nothing-matches$');
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

  it('defaults limit to exactly 200 and echoes it in appliedFilters', async () => {
    reply(UNSORTED);
    const { out } = await call({});
    expect(out.appliedFilters.limit).toBe(200);
    expect(obsidianListTags.input.parse({}).limit).toBe(200);
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
    expect(enrichment.notice).toMatch(/no tags/i);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('declares truncated, shown, and cap in the enrichment block', () => {
    const keys = Object.keys(obsidianListTags.enrichment ?? {});
    expect(keys).toContain('truncated');
    expect(keys).toContain('shown');
    expect(keys).toContain('cap');
  });

  it('no longer describes the tags output as upstream-ordered', () => {
    const description = obsidianListTags.output.shape.tags.description ?? '';
    expect(description).not.toMatch(/upstream-provided order/i);
    expect(description).toMatch(/count/i);
  });
});

describe('obsidian_list_tags / format() echoes the applied cap and filters', () => {
  it('renders limit and minCount alongside nameRegex', () => {
    const text = (
      obsidianListTags.format!({
        tags: [{ name: 'work', count: 5 }],
        appliedFilters: { nameRegex: '^work', minCount: 3, limit: 25 },
      })[0] as { text: string }
    ).text;
    expect(text).toContain('nameRegex=`^work`');
    expect(text).toContain('minCount=3');
    expect(text).toContain('limit=25');
  });

  it('renders the limit even when it is the untouched default', () => {
    const text = (
      obsidianListTags.format!({
        tags: [{ name: 'work', count: 5 }],
        appliedFilters: { limit: 200 },
      })[0] as { text: string }
    ).text;
    expect(text).toContain('limit=200');
    expect(text).not.toContain('minCount');
  });
});

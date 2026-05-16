/**
 * @fileoverview Handler tests for obsidian_list_tags.
 * @module tests/tools/obsidian-list-tags.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
      createMockContext(),
    );
    expect(out.tags).toEqual([
      { name: 'work', count: 5 },
      { name: 'work/tasks', count: 3 },
    ]);
    expect(out.appliedFilters).toBeUndefined();
  });

  it('handles an empty tag list gracefully', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(200, { tags: [] }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListTags.handler(
      obsidianListTags.input.parse({}),
      createMockContext(),
    );
    expect(out.tags).toEqual([]);
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
      createMockContext(),
    );
    expect(out.tags).toEqual([
      { name: 'work', count: 5 },
      { name: 'work/tasks', count: 3 },
    ]);
    expect(out.appliedFilters).toEqual({ nameRegex: '^work' });
  });

  it('returns an empty list with appliedFilters echoed when nameRegex excludes everything', async () => {
    harness
      .current()
      .pool.intercept({ path: '/tags/', method: 'GET' })
      .reply(
        200,
        { tags: [{ name: 'work', count: 5 }] },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianListTags.handler(
      obsidianListTags.input.parse({ nameRegex: '^nothing-matches$' }),
      createMockContext(),
    );
    expect(out.tags).toEqual([]);
    expect(out.appliedFilters).toEqual({ nameRegex: '^nothing-matches$' });
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
    const blocks = obsidianListTags.format!({ tags: [{ name: 'foo', count: 2 }] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('#foo');
    expect(text).toContain('(2)');
  });

  it('renders an empty-state message when there are no tags', () => {
    const blocks = obsidianListTags.format!({ tags: [] });
    expect((blocks[0] as { text: string }).text).toMatch(/no tags/i);
  });

  it('echoes the active nameRegex in the header when a filter was applied', () => {
    const blocks = obsidianListTags.format!({
      tags: [{ name: 'work', count: 5 }],
      appliedFilters: { nameRegex: '^work' },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('nameRegex=`^work`');
    expect(text).toContain('#work');
  });

  it('mentions the active nameRegex in the empty-state message', () => {
    const blocks = obsidianListTags.format!({
      tags: [],
      appliedFilters: { nameRegex: '^nothing-matches$' },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toMatch(/no tags found/i);
    expect(text).toContain('^nothing-matches$');
  });
});

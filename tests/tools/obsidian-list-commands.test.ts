/**
 * @fileoverview Handler tests for obsidian_list_commands.
 * @module tests/tools/obsidian-list-commands.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianListCommands } from '@/mcp-server/tools/definitions/obsidian-list-commands.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian_list_commands', () => {
  it('returns the upstream command list', async () => {
    harness
      .current()
      .pool.intercept({ path: '/commands/', method: 'GET' })
      .reply(
        200,
        {
          commands: [
            { id: 'editor:save-file', name: 'Save current file' },
            { id: 'workspace:close-tab', name: 'Close tab' },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianListCommands.handler(
      obsidianListCommands.input.parse({}),
      createMockContext(),
    );
    expect(out.commands).toEqual([
      { id: 'editor:save-file', name: 'Save current file' },
      { id: 'workspace:close-tab', name: 'Close tab' },
    ]);
    expect(out.appliedFilters).toBeUndefined();
  });

  it('applies nameRegex to keep only matching commands by display name', async () => {
    harness
      .current()
      .pool.intercept({ path: '/commands/', method: 'GET' })
      .reply(
        200,
        {
          commands: [
            {
              id: 'templater-obsidian:new-template',
              name: 'Templater: Create new note from template',
            },
            {
              id: 'templater-obsidian:insert-template',
              name: 'Templater: Open insert template modal',
            },
            { id: 'editor:save-file', name: 'Save current file' },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianListCommands.handler(
      obsidianListCommands.input.parse({ nameRegex: '^Templater' }),
      createMockContext(),
    );
    expect(out.commands).toEqual([
      { id: 'templater-obsidian:new-template', name: 'Templater: Create new note from template' },
      { id: 'templater-obsidian:insert-template', name: 'Templater: Open insert template modal' },
    ]);
    expect(out.appliedFilters).toEqual({ nameRegex: '^Templater' });
  });

  it('returns an empty list with appliedFilters echoed when nameRegex excludes everything', async () => {
    harness
      .current()
      .pool.intercept({ path: '/commands/', method: 'GET' })
      .reply(
        200,
        { commands: [{ id: 'editor:save-file', name: 'Save current file' }] },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianListCommands.handler(
      obsidianListCommands.input.parse({ nameRegex: '^nothing-matches$' }),
      createMockContext(),
    );
    expect(out.commands).toEqual([]);
    expect(out.appliedFilters).toEqual({ nameRegex: '^nothing-matches$' });
  });

  it('throws regex_invalid (ValidationError) when nameRegex is not valid', async () => {
    await expect(
      obsidianListCommands.handler(
        obsidianListCommands.input.parse({ nameRegex: '[' }),
        createMockContext({ errors: obsidianListCommands.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_invalid' },
    });
  });

  /**
   * Regression: see obsidian-list-tags.test.ts for the full rationale.
   * Catastrophic-backtracking patterns must be rejected statically or
   * the request stalls the server.
   */
  it('does not hang on a ReDoS pattern (rejects unsafe regex or completes within 1s)', async () => {
    const longA = 'a'.repeat(28);
    harness
      .current()
      .pool.intercept({ path: '/commands/', method: 'GET' })
      .reply(
        200,
        { commands: [{ id: 'x:y', name: `${longA}b` }] },
        { headers: { 'content-type': 'application/json' } },
      );

    const start = Date.now();
    try {
      await obsidianListCommands.handler(
        obsidianListCommands.input.parse({ nameRegex: '^(a+)+$' }),
        createMockContext({ errors: obsidianListCommands.errors }),
      );
    } catch (err) {
      expect(err).toMatchObject({ code: expect.any(Number) });
    }
    expect(Date.now() - start).toBeLessThan(1_000);
  }, 10_000);
});

describe('obsidian_list_commands / format()', () => {
  it('renders id and name for each command', () => {
    const blocks = obsidianListCommands.format!({
      commands: [{ id: 'a:b', name: 'A B' }],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('a:b');
    expect(text).toContain('A B');
  });

  it('echoes the active nameRegex in the header when a filter was applied', () => {
    const blocks = obsidianListCommands.format!({
      commands: [{ id: 'templater-obsidian:new-template', name: 'Templater: New note' }],
      appliedFilters: { nameRegex: '^Templater' },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('nameRegex=`^Templater`');
    expect(text).toContain('templater-obsidian:new-template');
  });

  it('mentions the active nameRegex in the empty-state message', () => {
    const blocks = obsidianListCommands.format!({
      commands: [],
      appliedFilters: { nameRegex: '^nothing-matches$' },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toMatch(/no commands/i);
    expect(text).toContain('^nothing-matches$');
  });
});

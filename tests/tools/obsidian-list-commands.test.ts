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
      createMockContext({ errors: obsidianListCommands.errors }),
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
      createMockContext({ errors: obsidianListCommands.errors }),
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
      createMockContext({ errors: obsidianListCommands.errors }),
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
   * Command display names are plugin-authored and `nameRegex` runs against
   * each one, so a catastrophic-backtracking pattern must be rejected
   * statically. No `/commands/` intercept is registered: a handler that
   * reached the upstream would fail with "No mock intercept" instead.
   */
  it('throws regex_unsafe (ValidationError) for a catastrophic-backtracking nameRegex before listing', async () => {
    await expect(
      obsidianListCommands.handler(
        obsidianListCommands.input.parse({ nameRegex: '^(a+)+$' }),
        createMockContext({ errors: obsidianListCommands.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_unsafe', nameRegex: '^(a+)+$' },
    });
  });
});

describe('obsidian_list_commands / format()', () => {
  const textOf = (result: Parameters<NonNullable<typeof obsidianListCommands.format>>[0]) =>
    (obsidianListCommands.format!(result)[0] as { text: string }).text;

  it('renders id and name for each command', () => {
    expect(
      textOf({
        commands: [
          { id: 'a:b', name: 'A B' },
          { id: 'c:d', name: 'C D' },
        ],
      }),
    ).toBe(['**2 commands**', '', '- `a:b` — A B', '- `c:d` — C D'].join('\n'));
  });

  it('echoes the active nameRegex in the header when a filter was applied', () => {
    expect(
      textOf({
        commands: [{ id: 'templater-obsidian:new-template', name: 'Templater: New note' }],
        appliedFilters: { nameRegex: '^Templater' },
      }),
    ).toBe(
      [
        '**1 commands** · nameRegex=`^Templater`',
        '',
        '- `templater-obsidian:new-template` — Templater: New note',
      ].join('\n'),
    );
  });

  it('mentions the active nameRegex in the empty-state message', () => {
    expect(textOf({ commands: [], appliedFilters: { nameRegex: '^nothing-matches$' } })).toBe(
      '_No commands available matching `^nothing-matches$`._',
    );
  });
});

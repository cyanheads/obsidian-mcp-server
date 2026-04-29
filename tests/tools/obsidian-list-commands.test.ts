/**
 * @fileoverview Handler tests for obsidian_list_commands.
 * @module tests/tools/obsidian-list-commands.test
 */

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
  });
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
});

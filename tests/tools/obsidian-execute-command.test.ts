/**
 * @fileoverview Handler tests for obsidian_execute_command (gated by env flag).
 * The tool is registered only when OBSIDIAN_ENABLE_COMMANDS=true; the handler
 * itself is unconditional once registered, so we exercise it directly here.
 * @module tests/tools/obsidian-execute-command.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianExecuteCommand } from '@/mcp-server/tools/definitions/obsidian-execute-command.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian_execute_command', () => {
  it('POSTs to /commands/{id}/ and reports executed: true', async () => {
    let seenPath = '';
    harness
      .current()
      .pool.intercept({
        path: (p) => {
          seenPath = p as string;
          return seenPath.startsWith('/commands/');
        },
        method: 'POST',
      })
      .reply(200, '');

    const out = await obsidianExecuteCommand.handler(
      obsidianExecuteCommand.input.parse({ commandId: 'editor:save-file' }),
      createMockContext(),
    );

    expect(seenPath).toBe('/commands/editor%3Asave-file/');
    expect(out).toEqual({ commandId: 'editor:save-file', executed: true });
  });
});

describe('obsidian_execute_command / annotations', () => {
  it('declares destructiveHint and openWorldHint', () => {
    expect(obsidianExecuteCommand.annotations?.destructiveHint).toBe(true);
    expect(obsidianExecuteCommand.annotations?.openWorldHint).toBe(true);
  });
});

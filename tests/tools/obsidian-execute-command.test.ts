/**
 * @fileoverview Handler tests for obsidian_execute_command (gated by env flag).
 * The tool is registered only when OBSIDIAN_ENABLE_COMMANDS=true; the handler
 * itself is unconditional once registered, so we exercise it directly here.
 * @module tests/tools/obsidian-execute-command.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
      createMockContext({ errors: obsidianExecuteCommand.errors }),
    );

    expect(seenPath).toBe('/commands/editor%3Asave-file/');
    expect(out).toEqual({ commandId: 'editor:save-file', executed: true });
  });
});

describe('obsidian_execute_command / command_unknown', () => {
  it('names the command under commandId on both wire surfaces', async () => {
    harness
      .current()
      .pool.intercept({ path: '/commands/nonexistent%3Azzz/', method: 'POST' })
      .reply(404, { errorCode: 40400, message: 'Not Found' });

    const res = await runToolContract(obsidianExecuteCommand, { commandId: 'nonexistent:zzz' });

    expect(res.isError).toBe(true);
    const error = (
      res.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({ reason: 'command_unknown', commandId: 'nonexistent:zzz' });
    expect(Object.hasOwn(error.data, 'path')).toBe(false);
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Unknown Obsidian command: nonexistent:zzz');
    expect(text).toContain('obsidian_list_commands');
  });
});

describe('obsidian_execute_command / annotations', () => {
  it('declares destructiveHint and openWorldHint', () => {
    expect(obsidianExecuteCommand.annotations?.destructiveHint).toBe(true);
    expect(obsidianExecuteCommand.annotations?.openWorldHint).toBe(true);
  });
});

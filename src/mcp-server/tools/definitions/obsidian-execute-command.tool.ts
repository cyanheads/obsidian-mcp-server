/**
 * @fileoverview obsidian_execute_command — execute an Obsidian command-palette
 * command by ID. Gated by `OBSIDIAN_ENABLE_COMMANDS=true` because command
 * behaviour is opaque (some commands are destructive) and consumers must opt in.
 * @module mcp-server/tools/definitions/obsidian-execute-command.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianExecuteCommand = tool('obsidian_execute_command', {
  description:
    'Execute an Obsidian command by ID (from `obsidian_list_commands`). Behaviour depends on the command — some are destructive (delete file, close vault), some open UI. Commands run with the same authority as a user invoking them from the keyboard.',
  annotations: { openWorldHint: true, destructiveHint: true },
  input: z.object({
    commandId: z
      .string()
      .min(1)
      .describe('Command ID, e.g. "editor:save-file". Use obsidian_list_commands to discover.'),
  }),
  output: z.object({
    commandId: z.string().describe('Echoed command ID.'),
    executed: z.boolean().describe('True when the command was dispatched successfully.'),
  }),
  auth: ['tool:obsidian_execute_command:admin'],
  errors: [
    {
      reason: 'command_unknown',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied `commandId` is not registered in Obsidian. Use `obsidian_list_commands` to discover valid IDs.',
      recovery: 'Call obsidian_list_commands to discover the registered command IDs.',
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();
    await svc.executeCommand(ctx, input.commandId);
    return { commandId: input.commandId, executed: true };
  },

  format: (result) => [
    {
      type: 'text',
      text: `**Executed \`${result.commandId}\`** (executed: ${result.executed})`,
    },
  ],
});

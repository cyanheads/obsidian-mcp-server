/**
 * @fileoverview obsidian_list_commands — list Obsidian command-palette commands.
 * Always available; surfaces the command surface even when execution is gated.
 * @module mcp-server/tools/definitions/obsidian-list-commands.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianListCommands = tool('obsidian_list_commands', {
  description:
    'List the Obsidian command-palette commands available in the active vault, with their IDs and display names.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({}),
  output: z.object({
    commands: z
      .array(
        z
          .object({
            id: z.string().describe('Command ID — the slug used to invoke the command.'),
            name: z.string().describe('Display name of the command.'),
          })
          .describe('An Obsidian command-palette entry.'),
      )
      .describe('All commands registered in the active Obsidian instance.'),
  }),
  auth: ['tool:obsidian_list_commands:read'],

  async handler(_input, ctx) {
    const svc = getObsidianService();
    const commands = await svc.listCommands(ctx);
    return { commands };
  },

  format: (result) => {
    if (result.commands.length === 0) {
      return [{ type: 'text', text: '_No commands available._' }];
    }
    const lines = [`**${result.commands.length} commands**`, ''];
    for (const c of result.commands) lines.push(`- \`${c.id}\` — ${c.name}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

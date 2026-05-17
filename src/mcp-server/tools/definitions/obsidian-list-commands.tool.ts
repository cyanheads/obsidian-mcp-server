/**
 * @fileoverview obsidian_list_commands — list Obsidian command-palette commands.
 * Gated behind `OBSIDIAN_ENABLE_COMMANDS=true` alongside `obsidian_execute_command`.
 * Optional `nameRegex` post-filters the upstream payload before returning, since
 * vaults with Templater/Dataview/QuickAdd/Excalidraw routinely register 300+
 * commands and the LLM-bound listing is otherwise mostly noise.
 * @module mcp-server/tools/definitions/obsidian-list-commands.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { nameRegexSafetyIssue } from './_shared/regex-safety.js';

export const obsidianListCommands = tool('obsidian_list_commands', {
  description:
    'List the Obsidian command-palette commands available in the active vault, with their IDs and display names. Filter to a subset with the optional `nameRegex` matched against the display name.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    nameRegex: z
      .string()
      .optional()
      .describe(
        'Optional ECMAScript regex (no flags, ≤256 chars, no nested quantifiers like `(a+)+`) matched against the command display name (the field agents search by, not the slug-shaped `id`). Use character classes (`[Tt]emplater`) for case-insensitivity.',
      ),
  }),
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
    appliedFilters: z
      .object({
        nameRegex: z.string().optional().describe('nameRegex filter applied to this listing.'),
      })
      .optional()
      .describe('Active filters that produced this listing. Absent when no filter was applied.'),
  }),
  auth: ['tool:obsidian_list_commands:read'],
  errors: [
    {
      reason: 'regex_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is not a valid ECMAScript regex.',
      recovery:
        'Use a valid ECMAScript regex (e.g. `^Templater`), or omit nameRegex to disable filtering.',
    },
    {
      reason: 'regex_unsafe',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is well-formed but exceeds the 256-character limit or contains nested quantifiers known to cause catastrophic backtracking.',
      recovery:
        'Avoid nested quantifiers like `(a+)+` or `(.*)*`. Use a simpler pattern (e.g. `^Templater`), or omit nameRegex to disable filtering.',
    },
  ],

  async handler(input, ctx) {
    let regex: RegExp | undefined;
    if (input.nameRegex) {
      const safetyIssue = nameRegexSafetyIssue(input.nameRegex);
      if (safetyIssue) {
        throw ctx.fail('regex_unsafe', `Unsafe nameRegex: ${safetyIssue}`, {
          nameRegex: input.nameRegex,
          ...ctx.recoveryFor('regex_unsafe'),
        });
      }
      try {
        regex = new RegExp(input.nameRegex);
      } catch (err) {
        throw ctx.fail(
          'regex_invalid',
          `Invalid nameRegex: ${(err as Error).message}`,
          { nameRegex: input.nameRegex, ...ctx.recoveryFor('regex_invalid') },
          { cause: err },
        );
      }
    }

    const svc = getObsidianService();
    const commands = await svc.listCommands(ctx);
    const filtered = regex ? commands.filter((c) => regex.test(c.name)) : commands;

    return {
      commands: filtered,
      ...(input.nameRegex ? { appliedFilters: { nameRegex: input.nameRegex } } : {}),
    };
  },

  format: (result) => {
    const activeRegex = result.appliedFilters?.nameRegex;
    if (result.commands.length === 0) {
      const filterNote = activeRegex ? ` matching \`${activeRegex}\`` : '';
      return [{ type: 'text', text: `_No commands available${filterNote}._` }];
    }
    const filterSuffix = activeRegex ? ` · nameRegex=\`${activeRegex}\`` : '';
    const lines = [`**${result.commands.length} commands**${filterSuffix}`, ''];
    for (const c of result.commands) lines.push(`- \`${c.id}\` — ${c.name}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

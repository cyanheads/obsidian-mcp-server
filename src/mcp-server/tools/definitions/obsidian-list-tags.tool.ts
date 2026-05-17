/**
 * @fileoverview obsidian_list_tags — all tags found in the vault, with usage counts.
 * Mirrors the plugin's `/tags/` endpoint; counts are upstream-provided. Optional
 * `nameRegex` post-filters the upstream payload before returning to keep the
 * LLM-bound response small on vaults with long-tail tag noise.
 * @module mcp-server/tools/definitions/obsidian-list-tags.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { nameRegexSafetyIssue } from './_shared/regex-safety.js';

export const obsidianListTags = tool('obsidian_list_tags', {
  description:
    'List every tag found across the vault, with usage counts. Includes hierarchical parents — `work/tasks` contributes to both `work` and `work/tasks`. Filter to a subset with the optional `nameRegex`. To find notes by tag, use `obsidian_search_notes` in jsonlogic mode (e.g. `{"in": ["work", {"var": "tags"}]}`).',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    nameRegex: z
      .string()
      .optional()
      .describe(
        'Optional ECMAScript regex (no flags, ≤256 chars, no nested quantifiers like `(a+)+`) matched against the bare tag name (no leading `#`). Hierarchical tags like `work/tasks` are matched as the full string. Use character classes (`[Mm]cp`) for case-insensitivity.',
      ),
  }),
  output: z.object({
    tags: z
      .array(
        z
          .object({
            name: z.string().describe('Tag name without the leading `#`.'),
            count: z.number().describe('Usage count across the vault.'),
          })
          .describe('A tag with its usage count.'),
      )
      .describe('All tags in the vault, in upstream-provided order.'),
    appliedFilters: z
      .object({
        nameRegex: z.string().optional().describe('nameRegex filter applied to this listing.'),
      })
      .optional()
      .describe('Active filters that produced this listing. Absent when no filter was applied.'),
  }),
  auth: ['tool:obsidian_list_tags:read'],
  errors: [
    {
      reason: 'regex_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is not a valid ECMAScript regex.',
      recovery:
        'Use a valid ECMAScript regex (e.g. `^mcp/.*`), or omit nameRegex to disable filtering.',
    },
    {
      reason: 'regex_unsafe',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is well-formed but exceeds the 256-character limit or contains nested quantifiers known to cause catastrophic backtracking.',
      recovery:
        'Avoid nested quantifiers like `(a+)+` or `(.*)*`. Use a simpler pattern (e.g. `^mcp/.*`), or omit nameRegex to disable filtering.',
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
    const tags = await svc.listTags(ctx);
    const filtered = regex ? tags.filter((t) => regex.test(t.name)) : tags;

    return {
      tags: filtered.map((t) => ({ name: t.name, count: t.count })),
      ...(input.nameRegex ? { appliedFilters: { nameRegex: input.nameRegex } } : {}),
    };
  },

  format: (result) => {
    const activeRegex = result.appliedFilters?.nameRegex;
    if (result.tags.length === 0) {
      const filterNote = activeRegex ? ` matching \`${activeRegex}\`` : '';
      return [{ type: 'text', text: `_No tags found${filterNote}._` }];
    }
    const filterSuffix = activeRegex ? ` · nameRegex=\`${activeRegex}\`` : '';
    const lines = [`**${result.tags.length} tags**${filterSuffix}`, ''];
    for (const t of result.tags) lines.push(`- \`#${t.name}\` (${t.count})`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

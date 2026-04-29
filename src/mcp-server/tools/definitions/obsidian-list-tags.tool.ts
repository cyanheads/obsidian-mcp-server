/**
 * @fileoverview obsidian_list_tags — all tags found in the vault, with usage counts.
 * Mirrors the plugin's `/tags/` endpoint; counts are upstream-provided.
 * @module mcp-server/tools/definitions/obsidian-list-tags.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianListTags = tool('obsidian_list_tags', {
  description:
    'List every tag found across the vault, with usage counts. Includes hierarchical parents — `work/tasks` contributes to both `work` and `work/tasks`.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({}),
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
  }),
  auth: ['tool:obsidian_list_tags:read'],

  async handler(_input, ctx) {
    const svc = getObsidianService();
    const tags = await svc.listTags(ctx);
    return { tags: tags.map((t) => ({ name: t.name, count: t.count })) };
  },

  format: (result) => {
    if (result.tags.length === 0) {
      return [{ type: 'text', text: '_No tags found in the vault._' }];
    }
    const lines = [`**${result.tags.length} tags**`, ''];
    for (const t of result.tags) lines.push(`- \`#${t.name}\` (${t.count})`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

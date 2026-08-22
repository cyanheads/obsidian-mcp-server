/**
 * @fileoverview obsidian://tags — vault tag listing with usage counts, for
 * clients that prefer attaching resources.
 *
 * Not a mirror of `obsidian_list_tags`: this is a snapshot of the upstream
 * `/tags/` payload, returned whole and in upstream order. The tool shapes the
 * same payload for an LLM caller — count-descending, capped, filterable — and
 * that shaping deliberately lives in the tool handler rather than the shared
 * `ObsidianService.listTags` both call.
 * @module mcp-server/resources/definitions/obsidian-tags.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianTags = resource('obsidian://tags', {
  name: 'obsidian-tags',
  description:
    'All tags found in the Obsidian vault, with usage counts, in upstream order and uncapped — a full snapshot. Includes hierarchical parents (e.g. `work` for `work/tasks`). Use the `obsidian_list_tags` tool for a count-ranked, capped, filterable view.',
  mimeType: 'application/json',
  params: z.object({}),
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
      .describe('Every tag in the vault, in upstream-provided order.'),
  }),
  auth: ['resource:obsidian-tags:read'],

  async handler(_params, ctx) {
    const svc = getObsidianService();
    const tags = await svc.listTags(ctx);
    return { tags: tags.map((t) => ({ name: t.name, count: t.count })) };
  },
});

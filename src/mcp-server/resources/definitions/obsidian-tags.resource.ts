/**
 * @fileoverview obsidian://tags — vault tag listing with usage counts.
 * Mirrors `obsidian_list_tags` for clients that prefer attaching resources.
 * @module mcp-server/resources/definitions/obsidian-tags.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianTags = resource('obsidian://tags', {
  name: 'obsidian-tags',
  description:
    'All tags found in the Obsidian vault, with usage counts. Includes hierarchical parents (e.g. `work` for `work/tasks`).',
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
      .describe('All tags in the vault.'),
  }),
  auth: ['resource:obsidian-tags:read'],

  async handler(_params, ctx) {
    const svc = getObsidianService();
    const tags = await svc.listTags(ctx);
    return { tags: tags.map((t) => ({ name: t.name, count: t.count })) };
  },
});

/**
 * @fileoverview obsidian://tags — vault tag listing with usage counts, for
 * clients that prefer attaching resources.
 *
 * Not a mirror of `obsidian_list_tags`: this is a snapshot of
 * `ObsidianService.listTags`, returned whole and unsorted — the upstream
 * `/tags/` payload in upstream order, or under OBSIDIAN_READ_PATHS the tags of
 * readable notes in order of first appearance. The tool shapes the same
 * payload for an LLM caller — count-descending, capped, filterable — and that
 * shaping deliberately lives in the tool handler rather than the shared
 * service call both make.
 * @module mcp-server/resources/definitions/obsidian-tags.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianTags = resource('obsidian://tags', {
  name: 'obsidian-tags',
  description:
    'All tags found in the Obsidian vault, with usage counts, unsorted and uncapped — a full snapshot. When OBSIDIAN_READ_PATHS is set, only tags carried by readable notes. Includes hierarchical parents (e.g. `work` for `work/tasks`). Use the `obsidian_list_tags` tool for a count-ranked, capped, filterable view.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    tags: z
      .array(
        z
          .object({
            name: z.string().describe('Tag name without the leading `#`.'),
            count: z
              .number()
              .describe(
                'Times the tag, or a tag nested under it, occurs across the vault. When OBSIDIAN_READ_PATHS is set: the number of readable notes carrying the tag or a tag nested under it.',
              ),
          })
          .describe('A tag with its usage count.'),
      )
      .describe(
        'Every tag in the vault, in the order the Local REST API reports them. When OBSIDIAN_READ_PATHS is set: every tag carried by a readable note, in order of first appearance.',
      ),
  }),
  auth: ['resource:obsidian-tags:read'],

  async handler(_params, ctx) {
    const svc = getObsidianService();
    const tags = await svc.listTags(ctx);
    return { tags: tags.map((t) => ({ name: t.name, count: t.count })) };
  },
});

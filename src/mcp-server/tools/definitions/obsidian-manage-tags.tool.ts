/**
 * @fileoverview obsidian_manage_tags — add/remove/list tags across both
 * frontmatter (`tags:` array) and inline (`#tag`) syntax. The service layer
 * reconciles both representations; inline matches inside fenced code blocks
 * are left alone.
 * @module mcp-server/tools/definitions/obsidian-manage-tags.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { listTagsFromContent, reconcileTags } from '@/services/obsidian/frontmatter-ops.js';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { TargetSchema } from './_shared/schemas.js';

const LocationSchema = z
  .enum(['frontmatter', 'inline', 'both'])
  .default('both')
  .describe('Where to apply the change. Default `both` reconciles both representations.');

export const obsidianManageTags = tool('obsidian_manage_tags', {
  description:
    "Add, remove, or list a note's tags. The server reconciles both representations — frontmatter `tags:` array and inline `#tag` syntax — so an `add` ensures the tag is present in the requested location(s), and a `remove` strips it. Inline `#tag` occurrences inside fenced code blocks are intentionally left alone. Inline-location additions append the new tag at the end of the file. `list` ignores the `tags` field.",
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Where the note lives.'),
    operation: z
      .enum(['add', 'remove', 'list'])
      .describe('`add` and `remove` mutate the note; `list` reads the current tag set.'),
    tags: z
      .array(z.string().min(1))
      .optional()
      .describe('Tags to add or remove. Omit the leading `#`. Required for add/remove.'),
    location: LocationSchema,
  }),
  output: z.object({
    result: z
      .discriminatedUnion('operation', [
        z
          .object({
            operation: z.literal('list').describe('Echoed operation.'),
            path: z.string().describe('Resolved vault-relative path.'),
            tags: z
              .object({
                frontmatter: z.array(z.string()).describe('Tags from frontmatter `tags:` array.'),
                inline: z.array(z.string()).describe('Tags found in inline `#tag` syntax.'),
                all: z
                  .array(z.string())
                  .describe('Deduplicated union of frontmatter and inline tags.'),
              })
              .describe('Tags split by location plus the deduplicated union.'),
          })
          .describe('Result for `list`.'),
        z
          .object({
            operation: z.literal('add').describe('Echoed operation.'),
            path: z.string().describe('Resolved vault-relative path.'),
            applied: z.array(z.string()).describe('Tags actually changed by this call.'),
            skipped: z
              .array(z.string())
              .describe('Tags already present at the targeted location(s).'),
            tags: z.array(z.string()).describe('All tags on the note after the change.'),
          })
          .describe('Result for `add`.'),
        z
          .object({
            operation: z.literal('remove').describe('Echoed operation.'),
            path: z.string().describe('Resolved vault-relative path.'),
            applied: z.array(z.string()).describe('Tags actually changed by this call.'),
            skipped: z.array(z.string()).describe('Tags absent from the targeted location(s).'),
            tags: z.array(z.string()).describe('All tags on the note after the change.'),
          })
          .describe('Result for `remove`.'),
      ])
      .describe('Operation-discriminated result payload.'),
  }),
  auth: ['tool:obsidian_manage_tags:write'],
  errors: [
    {
      reason: 'tags_required',
      code: JsonRpcErrorCode.ValidationError,
      when: '`operation` is "add" or "remove" but `tags` was empty or omitted.',
    },
    {
      reason: 'note_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'The vault path does not resolve to an existing note.',
    },
    {
      reason: 'no_active_file',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `active` but no file is currently open in Obsidian.',
    },
    {
      reason: 'periodic_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `periodic` but no matching periodic note exists.',
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const { target } = input;
    const note = await svc.getNoteJson(ctx, target);

    if (input.operation === 'list') {
      const split = listTagsFromContent(note.content, note.frontmatter);
      const all = Array.from(new Set([...split.frontmatter, ...split.inline]));
      return {
        result: {
          operation: 'list' as const,
          path: note.path,
          tags: { frontmatter: split.frontmatter, inline: split.inline, all },
        },
      };
    }

    if (!input.tags || input.tags.length === 0) {
      throw ctx.fail(
        'tags_required',
        '`tags` is required and must be non-empty for add/remove operations.',
        { operation: input.operation },
      );
    }

    const reconciled = reconcileTags(note.content, input.tags, input.operation, input.location);

    if (reconciled.applied.length === 0) {
      return {
        result: {
          operation: input.operation,
          path: note.path,
          applied: reconciled.applied,
          skipped: reconciled.skipped,
          tags: note.tags,
        },
      };
    }

    await svc.writeNote(ctx, target, reconciled.content, 'markdown');
    const after = await svc.getNoteJson(ctx, target);
    if (input.operation === 'add') {
      return {
        result: {
          operation: 'add' as const,
          path: after.path,
          applied: reconciled.applied,
          skipped: reconciled.skipped,
          tags: after.tags,
        },
      };
    }
    return {
      result: {
        operation: 'remove' as const,
        path: after.path,
        applied: reconciled.applied,
        skipped: reconciled.skipped,
        tags: after.tags,
      },
    };
  },

  format: ({ result }) => {
    if (result.operation === 'list') {
      const lines = [
        `**Tags (operation: ${result.operation}) in ${result.path}**`,
        `*Frontmatter (${result.tags.frontmatter.length}):* ${formatTags(result.tags.frontmatter)}`,
        `*Inline (${result.tags.inline.length}):* ${formatTags(result.tags.inline)}`,
        `*All (${result.tags.all.length}):* ${formatTags(result.tags.all)}`,
      ];
      return [{ type: 'text', text: lines.join('\n') }];
    }
    const lines = [
      `**${result.operation === 'add' ? 'Added tags to' : 'Removed tags from'} ${result.path}** (operation: ${result.operation})`,
      `*Applied (${result.applied.length}):* ${formatTags(result.applied)}`,
      `*Skipped (${result.skipped.length}):* ${formatTags(result.skipped)}`,
      `*All tags now (${result.tags.length}):* ${formatTags(result.tags)}`,
    ];
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function formatTags(tags: string[]): string {
  if (tags.length === 0) return '_(none)_';
  return tags.map((t) => `\`#${t}\``).join(' ');
}

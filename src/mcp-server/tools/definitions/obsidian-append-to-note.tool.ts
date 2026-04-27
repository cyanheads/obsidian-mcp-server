/**
 * @fileoverview obsidian_append_to_note — append content to the end of a note,
 * or to the end of a heading/block/frontmatter section via PATCH-with-append.
 * @module mcp-server/tools/definitions/obsidian-append-to-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { ContentTypeSchema, SectionSchema, TargetSchema } from './_shared/schemas.js';

export const obsidianAppendToNote = tool('obsidian_append_to_note', {
  description:
    'Append content to a note. Without `section`, the body is appended to the end of the file. With `section`, the content is appended to the end of that heading/block/frontmatter. For block-reference targets, the upstream concatenates `content` adjacent to the block line without inserting a separator — include a leading newline in `content` if you want one. Set `createTargetIfMissing` to bring the target section into existence rather than failing when it does not exist.',
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Where the note lives.'),
    content: z.string().describe('Body to append. Markdown unless `contentType` is `json`.'),
    section: SectionSchema.optional().describe(
      'Optional sub-document target. When set, content is appended to that section instead of the file.',
    ),
    contentType: ContentTypeSchema,
    createTargetIfMissing: z
      .boolean()
      .default(false)
      .describe(
        'When `section` is provided, create the section if it does not already exist (otherwise the call fails when the section is missing).',
      ),
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path of the note.'),
    sectionTargeted: z
      .boolean()
      .describe('True when the append went to a section; false for whole-file appends.'),
  }),
  auth: ['tool:obsidian_append_to_note:write'],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const { target } = input;

    if (input.section) {
      await svc.patchNote(ctx, target, input.content, {
        operation: 'append',
        targetType: input.section.type,
        target: input.section.target,
        targetDelimiter: input.section.type === 'heading' ? '::' : undefined,
        createTargetIfMissing: input.createTargetIfMissing,
        contentType: input.contentType,
      });
      const path = await svc.resolvePath(ctx, target);
      return { path, sectionTargeted: true };
    }

    await svc.appendToNote(ctx, target, input.content, input.contentType);
    const path = await svc.resolvePath(ctx, target);
    return { path, sectionTargeted: false };
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `**Appended to ${result.path}**`,
        `*Section targeted:* ${result.sectionTargeted}`,
      ].join('\n'),
    },
  ],
});

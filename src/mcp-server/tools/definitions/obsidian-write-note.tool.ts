/**
 * @fileoverview obsidian_write_note — create or overwrite a note (whole file)
 * or replace a single section in place via PATCH-with-replace. Idempotent.
 * @module mcp-server/tools/definitions/obsidian-write-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { ContentTypeSchema, SectionSchema, TargetSchema } from './_shared/schemas.js';

export const obsidianWriteNote = tool('obsidian_write_note', {
  description:
    'Create or overwrite a note. With `section` provided, replaces just that heading/block/frontmatter section in place; otherwise overwrites the whole file (creating it if missing). Idempotent — repeated calls with the same input converge on the same result. For heading sections, `content` is the new body; the heading line itself is preserved automatically and a leading duplicate heading is stripped.',
  annotations: { idempotentHint: true, destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Where the note lives.'),
    content: z
      .string()
      .describe(
        'Body to write. For heading sections, the new section body — do not repeat the heading line (it stays in place). Markdown unless `contentType` is `json`.',
      ),
    section: SectionSchema.optional().describe(
      'Optional sub-document target. When set, only this section is replaced; rest of the note is untouched.',
    ),
    contentType: ContentTypeSchema,
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path of the note that was written.'),
    sectionTargeted: z
      .boolean()
      .describe('True when only a section was replaced; false for full-file writes.'),
  }),
  auth: ['tool:obsidian_write_note:write'],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const { target } = input;

    if (input.section) {
      const body =
        input.section.type === 'heading'
          ? stripLeadingHeading(input.content, input.section.target)
          : input.content;
      await svc.patchNote(ctx, target, body, {
        operation: 'replace',
        targetType: input.section.type,
        target: input.section.target,
        targetDelimiter: input.section.type === 'heading' ? '::' : undefined,
        contentType: input.contentType,
        applyIfContentPreexists: true,
      });
      const path = await svc.resolvePath(ctx, target);
      return { path, sectionTargeted: true };
    }

    await svc.writeNote(ctx, target, input.content, input.contentType);
    const path = await svc.resolvePath(ctx, target);
    return { path, sectionTargeted: false };
  },

  format: (result) => [
    {
      type: 'text',
      text: [`**Wrote ${result.path}**`, `*Section targeted:* ${result.sectionTargeted}`].join(
        '\n',
      ),
    },
  ],
});

/**
 * If `content` opens with a markdown heading whose text matches the leaf of
 * `headingTarget` (delimited by `::`), drop that heading line plus a single
 * blank line. Upstream PATCH-replace operates on the section *body*, so a
 * caller-supplied heading line would otherwise be embedded as a duplicate.
 */
function stripLeadingHeading(content: string, headingTarget: string): string {
  const leaf = headingTarget.split('::').pop()?.trim();
  if (!leaf) return content;
  const lines = content.split('\n');
  const first = lines[0]?.trimEnd() ?? '';
  const m = /^(#{1,6})\s+(.+)$/.exec(first);
  if (!m || m[2]?.trim() !== leaf) return content;
  lines.shift();
  if (lines[0]?.trim() === '') lines.shift();
  return lines.join('\n');
}

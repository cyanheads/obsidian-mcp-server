/**
 * @fileoverview obsidian_write_note — create or overwrite a note (whole file)
 * or replace a single section in place via PATCH-with-replace. Idempotent.
 * @module mcp-server/tools/definitions/obsidian-write-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { ContentTypeSchema, SectionSchema, TargetSchema } from './_shared/schemas.js';

export const obsidianWriteNote = tool('obsidian_write_note', {
  description:
    'Create or overwrite a note. With `section`, replaces just that heading/block/frontmatter section in place. Whole-file writes fail with `file_exists` against an existing note unless `overwrite: true` — for in-place edits, prefer `obsidian_patch_note` (sections), `obsidian_append_to_note` (append), or `obsidian_replace_in_note` (find-and-replace). For heading sections, `content` is the new body; the heading line is preserved automatically.',
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
    overwrite: z
      .boolean()
      .default(false)
      .describe(
        'Whole-file mode only (ignored when `section` is set). When `false` (default), the call fails with `file_exists` if the target note already exists — read it first and use `obsidian_patch_note` / `obsidian_append_to_note` / `obsidian_replace_in_note` for in-place edits, or retry with `overwrite: true` for a deliberate full replacement.',
      ),
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path of the note that was written.'),
    sectionTargeted: z
      .boolean()
      .describe('True when only a section was replaced; false for full-file writes.'),
    created: z
      .boolean()
      .describe(
        'True when the write created a new file. False when it replaced an existing one or targeted a section.',
      ),
  }),
  auth: ['tool:obsidian_write_note:write'],
  errors: [
    {
      reason: 'file_exists',
      code: JsonRpcErrorCode.Conflict,
      when: 'Whole-file write was attempted against an existing note and `overwrite` was not set to `true`.',
      recovery: 'Retry with overwrite true or use obsidian_patch_note for in-place edits.',
    },
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The target path is outside OBSIDIAN_WRITE_PATHS, or OBSIDIAN_READ_ONLY=true denies all writes.',
      recovery:
        'Use a path inside the configured write scope. The error data echoes the active scope.',
    },
  ],

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
      return { path, sectionTargeted: true, created: false };
    }

    const exists = await svc.noteExists(ctx, target);
    if (exists && !input.overwrite) {
      const path = await svc.resolvePath(ctx, target);
      throw ctx.fail('file_exists', `Note '${path}' already exists.`, {
        path,
        recovery: {
          hint: 'To modify in place, use obsidian_patch_note (surgical section edits), obsidian_append_to_note (append content), or obsidian_replace_in_note (search-and-replace). To replace the entire file, retry with overwrite: true.',
        },
      });
    }

    await svc.writeNote(ctx, target, input.content, input.contentType);
    const path = await svc.resolvePath(ctx, target);
    return { path, sectionTargeted: false, created: !exists };
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `**${result.created ? 'Created' : 'Wrote'} ${result.path}**`,
        `*Section targeted:* ${result.sectionTargeted}`,
        `*Created:* ${result.created}`,
      ].join('\n'),
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

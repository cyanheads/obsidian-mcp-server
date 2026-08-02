/**
 * @fileoverview obsidian_append_to_note — append content to the end of a note,
 * or to the end of a heading/block/frontmatter section via PATCH-with-append.
 * Whole-file appends are silently upserts (POST creates the file when the path
 * does not exist), so the response surface flags `created` and `previousSize`
 * for agent self-correction.
 * @module mcp-server/tools/definitions/obsidian-append-to-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { ContentTypeSchema, SectionSchema, TargetSchema } from './_shared/schemas.js';

export const obsidianAppendToNote = tool('obsidian_append_to_note', {
  description:
    'Append content to a note. **Without `section`: appends to the end of the file, or creates the file if it does not exist (your content becomes the full file).** With `section`: appends to the end of that heading/block/frontmatter — use `obsidian_get_note` with `format: "document-map"` to discover available targets. A nested heading may be named either by its full `Parent::Child` path or by a bare leaf name that matches exactly one heading; a leaf shared by several headings is rejected with `ambiguous_section`. For block-reference targets, content is concatenated adjacent to the block line without inserting a separator — include a leading newline in `content` if you want one. Set `createTargetIfMissing` to bring the target section into existence rather than failing when it does not exist.',
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
      .describe(
        'True when the append went to a heading/block/frontmatter section (PATCH); false for whole-file appends (POST).',
      ),
    sectionTarget: z
      .string()
      .optional()
      .describe(
        'Section locator the append was applied to. Present when `section` was supplied. For headings this is the resolved locator — a bare leaf name is reported back as its full `Parent::Child` path.',
      ),
    created: z
      .boolean()
      .describe(
        'True when the whole-file append created a new file. Always false for section appends — PATCH requires the file to exist. Best-effort under concurrent writers, racy between the existence check and the write.',
      ),
    previousSizeInBytes: z
      .number()
      .describe('Byte size of the note before the append. Zero when `created` is true.'),
    currentSizeInBytes: z
      .number()
      .describe(
        'Byte size of the note after the append, read from the upstream after the operation completed. Compare against `previousSizeInBytes` and your own content length to detect unexpected upstream behavior (e.g. auto-newline injection, concurrent writers).',
      ),
  }),
  auth: ['tool:obsidian_append_to_note:write'],
  errors: [
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The target path is outside OBSIDIAN_WRITE_PATHS, or OBSIDIAN_READ_ONLY=true denies all writes.',
      recovery:
        'Use a path inside the configured write scope. The error data echoes the active scope.',
    },
    {
      reason: 'note_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'Section append targets a path that does not resolve to an existing note (PATCH requires the file to exist).',
      recovery:
        'Verify the path with obsidian_list_notes, or omit `section` to fall back to whole-file append (which creates the note if missing).',
    },
    {
      reason: 'no_active_file',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `active` but no file is currently open in Obsidian.',
      recovery:
        'Call obsidian_open_in_ui to focus a file, or pass an explicit path target instead.',
    },
    {
      reason: 'periodic_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `periodic` but no matching periodic note exists.',
      recovery: 'Create the periodic note first or pass an explicit path target.',
    },
    {
      reason: 'periodic_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: "Target was `periodic` but the requested period is not enabled in Obsidian's Periodic Notes plugin settings.",
      recovery:
        "Pass an explicit path target — the requested period is disabled in the operator's Periodic Notes plugin.",
    },
    {
      reason: 'section_target_missing',
      code: JsonRpcErrorCode.ValidationError,
      when: '`section` was provided but the named heading/block/frontmatter field does not exist in the note.',
      recovery:
        'Call obsidian_get_note with format document-map to discover available targets, or pass createTargetIfMissing: true to bring it into existence.',
    },
    {
      reason: 'ambiguous_section',
      code: JsonRpcErrorCode.Conflict,
      when: 'A bare heading leaf name matches more than one heading in the note, so the append target is undetermined.',
      recovery:
        'Retry with one of the full Parent::Child heading paths listed in `candidates` on the error data.',
    },
    {
      reason: 'content_preexists',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Section append where the supplied content already appears at the target — rejected to keep retries idempotent (the default for the section path).',
      recovery:
        'Change the content to something not already present at the target, or use obsidian_patch_note with `patchOptions.applyIfContentPreexists: true` if a duplicate is intended.',
    },
    {
      reason: 'path_is_directory',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied path names a folder rather than a note file.',
      recovery:
        'Call obsidian_list_notes with this path to list the folder, then retry with the full path of one of the files it returns.',
    },
    {
      reason: 'path_traversal',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The path contains a `.` or `..` segment, which is rejected to prevent vault escape.',
      recovery:
        'Supply a vault-relative path with no `.` or `..` segments, e.g. "Projects/Note.md". Use obsidian_list_notes to browse the vault.',
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();

    /**
     * Resolve once and pin the rest of the flow to a path target so the
     * presence probe and the write itself act on the same concrete file —
     * avoids re-resolving `active` / `periodic` targets across calls.
     */
    const path = await svc.resolvePath(ctx, input.target);
    const pathTarget = { type: 'path' as const, path };

    if (input.section) {
      const previousSizeInBytes = await svc.getSize(ctx, pathTarget);
      const sectionTarget = await svc.patchNote(ctx, pathTarget, input.content, {
        operation: 'append',
        targetType: input.section.type,
        target: input.section.target,
        targetDelimiter: input.section.type === 'heading' ? '::' : undefined,
        createTargetIfMissing: input.createTargetIfMissing,
        contentType: input.contentType,
      });
      const currentSizeInBytes = await svc.getSize(ctx, pathTarget);
      return {
        path,
        sectionTargeted: true,
        sectionTarget,
        created: false,
        previousSizeInBytes,
        currentSizeInBytes,
      };
    }

    const previousSizeInBytes = await svc.tryGetSize(ctx, pathTarget);
    await svc.appendToNote(ctx, pathTarget, input.content, input.contentType);
    const currentSizeInBytes = await svc.getSize(ctx, pathTarget);
    return {
      path,
      sectionTargeted: false,
      created: previousSizeInBytes === null,
      previousSizeInBytes: previousSizeInBytes ?? 0,
      currentSizeInBytes,
    };
  },

  format: (result) => {
    const action = result.created ? 'Created' : 'Appended to';
    const lines = [`**${action} ${result.path}**`];
    if (result.created) {
      lines.push(
        '*Note:* this file did not exist before — your content is now the entire file. If you expected to add to existing content, double-check the path.',
      );
    }
    lines.push(`*Size:* ${result.previousSizeInBytes} → ${result.currentSizeInBytes} bytes`);
    lines.push(`*Created:* ${result.created}`);
    lines.push(
      `*Section targeted:* ${result.sectionTargeted}${result.sectionTarget ? ` → ${result.sectionTarget}` : ''}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

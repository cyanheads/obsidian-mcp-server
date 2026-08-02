/**
 * @fileoverview obsidian_patch_note — surgical edit (`append` / `prepend` /
 * `replace`) of a heading, block reference, or frontmatter field. Uses the
 * upstream Local REST API v3 PATCH protocol.
 * @module mcp-server/tools/definitions/obsidian-patch-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import {
  ContentTypeSchema,
  PatchOptionsSchema,
  SectionSchema,
  TargetSchema,
} from './_shared/schemas.js';

export const obsidianPatchNote = tool('obsidian_patch_note', {
  description:
    'Edit a heading, block reference, or frontmatter field in place — append to, prepend to, or replace the target\'s body. Use `obsidian_get_note` with `format: "document-map"` to discover available targets first. A nested heading may be named either by its full `Parent::Child` path or by a bare leaf name that matches exactly one heading; a leaf shared by several headings is rejected with `ambiguous_section`.',
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Where the note lives.'),
    section: SectionSchema.describe('Which heading/block/frontmatter field to edit.'),
    operation: z
      .enum(['append', 'prepend', 'replace'])
      .describe(
        "How to apply `content` relative to the targeted section. `append` — at the end of the target's body (for headings, before the next sibling/parent heading; for frontmatter array fields, as a new array item). `prepend` — at the start. `replace` — swaps the target's body.",
      ),
    content: z
      .string()
      .describe('Body to insert/replace. Markdown unless `contentType` is `json`.'),
    contentType: ContentTypeSchema,
    patchOptions: PatchOptionsSchema.describe(
      'Optional flags: createTargetIfMissing, applyIfContentPreexists, trimTargetWhitespace.',
    ),
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path of the note.'),
    section: SectionSchema.describe(
      'Section locator the patch was applied to. For headings this is the resolved locator — a bare leaf name is reported back as its full `Parent::Child` path.',
    ),
    operation: z
      .enum(['append', 'prepend', 'replace'])
      .describe('Echoed operation that was applied.'),
    previousSizeInBytes: z.number().describe('Byte size of the note before the patch was applied.'),
    currentSizeInBytes: z
      .number()
      .describe(
        'Byte size of the note after the patch, read from the upstream after the operation completed.',
      ),
  }),
  auth: ['tool:obsidian_patch_note:write'],
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
      when: 'The vault path does not resolve to an existing note.',
      recovery:
        'Verify the path with obsidian_list_notes or use obsidian_search_notes to locate the note.',
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
      when: 'The named heading/block/frontmatter field does not exist in the note. Use `obsidian_get_note` with `format: "document-map"` to discover available targets.',
      recovery:
        'Call obsidian_get_note with format document-map to discover the available targets.',
    },
    {
      reason: 'ambiguous_section',
      code: JsonRpcErrorCode.Conflict,
      when: 'A bare heading leaf name matches more than one heading in the note, so the write target is undetermined.',
      recovery:
        'Retry with one of the full Parent::Child heading paths listed in `candidates` on the error data.',
    },
    {
      reason: 'content_preexists',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied content already appears at the target — the patch was rejected to keep retries idempotent (the default).',
      recovery:
        'Pass `patchOptions.applyIfContentPreexists: true` to force-apply over preexisting content, or change the content to something not already present.',
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
     * pre-PATCH size probe and the PATCH itself act on the same concrete file.
     */
    const path = await svc.resolvePath(ctx, input.target);
    const pathTarget = { type: 'path' as const, path };

    const previousSizeInBytes = await svc.getSize(ctx, pathTarget);
    const resolvedTarget = await svc.patchNote(ctx, pathTarget, input.content, {
      operation: input.operation,
      targetType: input.section.type,
      target: input.section.target,
      targetDelimiter: input.section.type === 'heading' ? '::' : undefined,
      createTargetIfMissing: input.patchOptions?.createTargetIfMissing,
      applyIfContentPreexists: input.patchOptions?.applyIfContentPreexists,
      trimTargetWhitespace: input.patchOptions?.trimTargetWhitespace,
      contentType: input.contentType,
    });
    const currentSizeInBytes = await svc.getSize(ctx, pathTarget);

    return {
      path,
      section: { ...input.section, target: resolvedTarget },
      operation: input.operation,
      previousSizeInBytes,
      currentSizeInBytes,
    };
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `**Patched ${result.path}**`,
        `*Operation:* ${result.operation}`,
        `*Section:* ${result.section.type} → ${result.section.target}`,
        `*Size:* ${result.previousSizeInBytes} → ${result.currentSizeInBytes} bytes`,
      ].join('\n'),
    },
  ],
});

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
    'Surgical edit of a heading, block reference, or frontmatter field. Choose `operation: "append"` to add after the section, `"prepend"` to add before, or `"replace"` to swap it out. Use `obsidian_get_note` with `format: "document-map"` to discover available headings, blocks, and frontmatter fields. Nested headings need `Parent::Child` syntax.',
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Where the note lives.'),
    section: SectionSchema.describe('Which heading/block/frontmatter field to edit.'),
    operation: z
      .enum(['append', 'prepend', 'replace'])
      .describe('How to apply the content relative to the section.'),
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
    section: SectionSchema.describe('Echoed section locator.'),
    operation: z
      .enum(['append', 'prepend', 'replace'])
      .describe('Echoed operation that was applied.'),
  }),
  auth: ['tool:obsidian_patch_note:write'],
  errors: [
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
      recovery: 'Open a note in Obsidian or pass an explicit path target instead.',
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
        "Enable the period in Obsidian's Periodic Notes plugin settings, or pass an explicit path target instead.",
    },
    {
      reason: 'section_target_missing',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The named heading/block/frontmatter field does not exist in the note. Use `obsidian_get_note` with `format: "document-map"` to discover available targets.',
      recovery:
        'Call obsidian_get_note with format document-map to discover the available targets.',
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const { target } = input;

    await svc.patchNote(ctx, target, input.content, {
      operation: input.operation,
      targetType: input.section.type,
      target: input.section.target,
      targetDelimiter: input.section.type === 'heading' ? '::' : undefined,
      createTargetIfMissing: input.patchOptions?.createTargetIfMissing,
      applyIfContentPreexists: input.patchOptions?.applyIfContentPreexists,
      trimTargetWhitespace: input.patchOptions?.trimTargetWhitespace,
      contentType: input.contentType,
    });

    const path = await svc.resolvePath(ctx, target);
    return { path, section: input.section, operation: input.operation };
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `**Patched ${result.path}**`,
        `*Operation:* ${result.operation}`,
        `*Section:* ${result.section.type} → ${result.section.target}`,
      ].join('\n'),
    },
  ],
});

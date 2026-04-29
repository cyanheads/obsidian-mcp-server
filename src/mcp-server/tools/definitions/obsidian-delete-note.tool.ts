/**
 * @fileoverview obsidian_delete_note — permanently delete a note. Calls
 * `ctx.elicit` to confirm with the user when the client supports it; falls
 * back to the destructive-hint annotation otherwise.
 * @module mcp-server/tools/definitions/obsidian-delete-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { TargetSchema } from './_shared/schemas.js';

export const obsidianDeleteNote = tool('obsidian_delete_note', {
  description:
    'Permanently delete a note from the vault. Confirms with the user before deleting when the client supports interactive confirmation. Recovery requires the local trash in Obsidian — there is no API-level undo.',
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Which note to delete.'),
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path of the deleted note.'),
    deleted: z.boolean().describe('True when the file was removed.'),
  }),
  auth: ['tool:obsidian_delete_note:write'],
  errors: [
    {
      reason: 'cancelled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'User declined the deletion via interactive elicitation.',
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

    const path = await svc.resolvePath(ctx, target);

    if (ctx.elicit) {
      const confirmed = await ctx.elicit(
        `Permanently delete '${path}'? This cannot be undone via the API; recovery would require Obsidian's local trash.`,
        z.object({
          confirm: z.boolean().describe('Set to true to delete the note. Any other value cancels.'),
        }),
      );
      if (confirmed.action !== 'accept' || confirmed.content?.confirm !== true) {
        throw ctx.fail('cancelled', 'Deletion cancelled by user.', { path });
      }
    }

    await svc.deleteNote(ctx, target);
    return { path, deleted: true };
  },

  format: (result) => [
    {
      type: 'text',
      text: `**Deleted ${result.path}** (deleted: ${result.deleted})`,
    },
  ],
});

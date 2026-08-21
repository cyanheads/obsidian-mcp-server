/**
 * @fileoverview obsidian_delete_note — permanently delete a note. Suspends via
 * `ctx.requestInput` to confirm with the user before the DELETE, and is
 * re-entered with the answer on `ctx.inputs`.
 * @module mcp-server/tools/definitions/obsidian-delete-note.tool
 */

import { inputRequired, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { TargetSchema } from './_shared/schemas.js';

/** Answered by the client in the confirmation round; re-validated on re-entry. */
const DeleteConfirmation = z.object({
  confirm: z.boolean().describe('Set to true to delete the note. Any other value cancels.'),
});

export const obsidianDeleteNote = tool('obsidian_delete_note', {
  description:
    'Permanently delete a note from the vault. Asks the user to confirm before deleting — the call is answered with a confirmation request and retried with the answer. Recovery requires the local trash in Obsidian — there is no API-level undo.',
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Which note to delete.'),
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path of the deleted note.'),
    deleted: z.boolean().describe('True when the file was removed.'),
    previousSizeInBytes: z
      .number()
      .describe(
        'Byte size of the note immediately before deletion. Confirms the size of what was removed.',
      ),
    currentSizeInBytes: z
      .number()
      .describe('Always 0 after a successful delete — the file no longer exists.'),
  }),
  auth: ['tool:obsidian_delete_note:write'],
  errors: [
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The target path is outside OBSIDIAN_WRITE_PATHS, or OBSIDIAN_READ_ONLY=true denies all writes.',
      recovery:
        'Use a path inside the configured write scope. The error data echoes the active scope.',
    },
    {
      reason: 'cancelled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'User declined, cancelled, or answered false to the confirmation request.',
      recovery: 'Re-run the tool when the user is ready to confirm deletion.',
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
      recovery: 'Pass an explicit path target — periodic notes must already exist.',
    },
    {
      reason: 'periodic_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: "Target was `periodic` but the requested period is not enabled in Obsidian's Periodic Notes plugin settings.",
      recovery:
        "Pass an explicit path target — the requested period is disabled in the operator's Periodic Notes plugin.",
    },
    {
      reason: 'path_is_directory',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied path names a folder rather than a note file. Deleting a folder is not offered — the upstream removes it and everything inside it in one unrecoverable step.',
      recovery:
        'Call obsidian_list_notes with this path to list the folder, then delete files one at a time by their full paths.',
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

    const path = await svc.resolvePath(ctx, input.target);
    const pathTarget = { type: 'path' as const, path };

    /**
     * Probe size before asking for confirmation so the user sees how much
     * they're about to destroy. Throws `note_missing` if the file is already
     * gone — preempts a confusing post-confirmation DELETE 404. The probe runs
     * again on re-entry, so the size is re-verified against the answer round.
     */
    const previousSizeInBytes = await svc.getSize(ctx, pathTarget);

    /**
     * A declined or cancelled prompt is a dead end, not a round to retry —
     * re-asking would burn the round budget until the client gives up.
     */
    const view = ctx.inputs.view('confirm');
    if (view.kind === 'elicit' && view.action !== 'accept') {
      throw ctx.fail('cancelled', `User sent '${view.action}' for the deletion confirmation.`, {
        path,
        ...ctx.recoveryFor('cancelled'),
      });
    }

    const answer = ctx.inputs.accepted('confirm', DeleteConfirmation);
    if (!answer) {
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Permanently delete '${path}' (${previousSizeInBytes} bytes)? This cannot be undone via the API; recovery would require Obsidian's local trash.`,
            requestedSchema: DeleteConfirmation,
          }),
        },
      });
    }

    if (!answer.confirm) {
      throw ctx.fail('cancelled', 'Deletion cancelled by user.', {
        path,
        ...ctx.recoveryFor('cancelled'),
      });
    }

    await svc.deleteNote(ctx, pathTarget);
    return { path, deleted: true, previousSizeInBytes, currentSizeInBytes: 0 };
  },

  format: (result) => [
    {
      type: 'text',
      text: `**Deleted ${result.path}** (size: ${result.previousSizeInBytes} → ${result.currentSizeInBytes} bytes)`,
    },
  ],
});

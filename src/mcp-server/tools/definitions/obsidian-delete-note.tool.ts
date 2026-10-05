/**
 * @fileoverview obsidian_delete_note — permanently delete a note. Suspends via
 * `ctx.requestInput` to confirm with the user before the DELETE, and is
 * re-entered with the answer on `ctx.inputs`. The answer counts only on a
 * round that redeems the consent record this handler stored when it asked.
 * @module mcp-server/tools/definitions/obsidian-delete-note.tool
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inputRequired, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { TargetSchema } from './_shared/schemas.js';

const OPERATION = 'obsidian_delete_note';
const CONSENT_TTL_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Answered by the client in the confirmation round; re-validated on re-entry. */
const DeleteConfirmation = z.object({
  confirm: z.boolean().describe('Set to true to delete the note. Any other value cancels.'),
});

/**
 * What a confirmation prompt confirmed, stored in `ctx.state` under
 * `consent/<id>` when the handler asks; only the id travels as `requestState`.
 */
const ConsentRecord = z.object({
  operation: z.string().describe('Tool the record was minted for.'),
  clientId: z.string().describe('Authenticated client that was asked; empty without auth.'),
  subject: z.string().describe('Authenticated subject that was asked; empty without auth.'),
  target: z.string().describe('Resolved vault path the user confirmed.'),
  contentHash: z.string().describe('SHA-256 of the note content the user confirmed.'),
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
      thrownBy: 'service',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The target path is outside OBSIDIAN_WRITE_PATHS, or OBSIDIAN_READ_ONLY=true denies all writes.',
      recovery:
        'Use a path inside the configured write scope. The error data echoes the active scope.',
    },
    {
      reason: 'cancelled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'User declined, cancelled, or answered false to the confirmation request.',
      severity: 'notice',
      recovery: 'Re-run the tool when the user is ready to confirm deletion.',
    },
    {
      reason: 'note_missing',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'The vault path does not resolve to an existing note.',
      recovery:
        'Verify the path with obsidian_list_notes or use obsidian_search_notes to locate the note.',
    },
    {
      reason: 'no_active_file',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `active` but no file is currently open in Obsidian.',
      recovery:
        'Call obsidian_open_in_ui to focus a file, or pass an explicit path target instead.',
    },
    {
      reason: 'periodic_unsupported',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `periodic` and this vault runs Local REST API v5.0.2 or later without the companion periodic-notes extension, so the `/periodic/` routes are not served at all.',
      recovery:
        'Install the periodic-notes extension from https://github.com/coddingtonbear/obsidian-local-rest-api-periodic-notes, or address the note by an explicit vault path.',
    },
    {
      reason: 'periodic_not_found',
      thrownBy: 'service',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `periodic`, the `/periodic/` routes are served on this vault, and no note exists for the requested period.',
      recovery: 'Pass an explicit path target — periodic notes must already exist.',
    },
    {
      reason: 'periodic_disabled',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: "Target was `periodic` but the requested period is not enabled in Obsidian's Periodic Notes plugin settings.",
      recovery:
        "Pass an explicit path target — the requested period is disabled in the operator's Periodic Notes plugin.",
    },
    {
      reason: 'path_is_directory',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied path names a folder rather than a note file. Deleting a folder is not offered — the upstream removes it and everything inside it in one unrecoverable step.',
      recovery:
        'Call obsidian_list_notes with this path to list the folder, then delete files one at a time by their full paths.',
    },
    {
      reason: 'path_traversal',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The path contains a `.` or `..` segment, which is rejected to prevent vault escape.',
      recovery:
        'Supply a vault-relative path with no `.` or `..` segments, e.g. "Projects/Note.md". Use obsidian_list_notes to browse the vault.',
    },
  ],

  async handler(input, ctx) {
    /**
     * Redeem first: whatever this round carries, the record it names is spent
     * before anything acts on the answer. An accepted answer on `ctx.inputs` is
     * not proof the user was asked — a client that declared elicitation can
     * pre-answer a call nothing prompted for — so only the record this handler
     * stored when it asked makes the answer count.
     *
     * Single-use holds against a sequential replay, not concurrent retries:
     * `ctx.state` has no atomic read-and-delete, so retries carrying one id at
     * the same moment can each read the record before a delete lands, and the
     * Local REST API DELETE takes no idempotency key to dedupe them upstream.
     * The losing DELETE finds the file gone and fails `note_missing`, so the
     * race removes nothing beyond the confirmed note unless that path is
     * recreated in between. Tracked as cyanheads/mcp-ts-core#593 (an atomic
     * `ctx.state.take`).
     */
    const id = ctx.inputs.state();
    const record = id && UUID.test(id) ? await ctx.state.get(`consent/${id}`, ConsentRecord) : null;
    if (record) await ctx.state.delete(`consent/${id}`);

    const svc = getObsidianService();
    const path = await svc.resolvePath(ctx, input.target);
    const pathTarget = { type: 'path' as const, path };

    /**
     * One read serves the prompt and the record: the bytes the user is told
     * they're destroying, and the hash a later round must still match. Throws
     * `note_missing` before any prompt when the file is already gone, and
     * `path_is_directory` for a folder, so no DELETE is ever reached for one.
     */
    const content = await svc.getNoteContent(ctx, pathTarget);
    const previousSizeInBytes = Buffer.byteLength(content);
    const expected = {
      operation: OPERATION,
      clientId: ctx.auth?.clientId ?? '',
      subject: ctx.auth?.sub ?? '',
      target: path,
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
    const matches = record !== null && isDeepStrictEqual(record, expected);

    /**
     * A declined or cancelled prompt the user was actually shown is a dead end,
     * not a round to retry — re-asking would burn the round budget until the
     * client gives up.
     */
    const view = ctx.inputs.view('confirm');
    if (matches && view.kind === 'elicit' && view.action !== 'accept') {
      throw ctx.fail('cancelled', `User sent '${view.action}' for the deletion confirmation.`, {
        path,
      });
    }

    const answer = matches ? ctx.inputs.accepted('confirm', DeleteConfirmation) : undefined;
    if (!answer) {
      const fresh = randomUUID();
      await ctx.state.set(`consent/${fresh}`, expected, { ttl: CONSENT_TTL_SECONDS });
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Permanently delete '${path}' (${previousSizeInBytes} bytes)? This cannot be undone via the API; recovery would require Obsidian's local trash.`,
            requestedSchema: DeleteConfirmation,
          }),
        },
        requestState: fresh,
      });
    }

    if (!answer.confirm) {
      throw ctx.fail('cancelled', 'Deletion cancelled by user.', { path });
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

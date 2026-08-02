/**
 * @fileoverview obsidian_open_in_ui — open a file in the Obsidian app UI.
 * Defaults to `failIfMissing: true` because Obsidian silently creates files on
 * open otherwise; opt out for an "open or create" flow.
 *
 * The existence probe runs on both paths. It is what lets `createdIfMissing`
 * report what actually happened, and it is the point where an open that would
 * create a file is gated as a write — so opening a note that already exists
 * keeps working under `OBSIDIAN_READ_ONLY`, while the create-capable branch is
 * refused there and outside `OBSIDIAN_WRITE_PATHS`.
 * @module mcp-server/tools/definitions/obsidian-open-in-ui.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import type { NoteTarget } from '@/services/obsidian/types.js';
import { withCaseFallback } from './_shared/suggest-paths.js';

export const obsidianOpenInUi = tool('obsidian_open_in_ui', {
  description:
    'Open a file in the Obsidian app UI. By default fails when the path does not exist; the `failIfMissing` flag controls the open-or-create behavior. Opening an existing file needs read access; opening a missing one creates it, so that case needs write access to the path.',
  annotations: { openWorldHint: true, destructiveHint: false, idempotentHint: true },
  input: z.object({
    path: z.string().min(1).describe('Vault-relative path of the file to open.'),
    failIfMissing: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), fails if the file does not exist. When false, allows Obsidian to create the file on open — which requires write access to the path and is rejected in read-only mode.',
      ),
    newLeaf: z
      .boolean()
      .default(false)
      .describe('Open in a new leaf (split pane) instead of the active one.'),
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path that was opened.'),
    opened: z.boolean().describe('True when the open call succeeded.'),
    createdIfMissing: z
      .boolean()
      .describe('True when the file did not exist before the call and was created by Obsidian.'),
  }),
  auth: ['tool:obsidian_open_in_ui:write'],
  errors: [
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The path is outside OBSIDIAN_READ_PATHS, or — when the file does not exist and `failIfMissing: false` would have Obsidian create it — outside OBSIDIAN_WRITE_PATHS or blocked by OBSIDIAN_READ_ONLY=true.',
      recovery:
        'Open a path inside the configured scope. The error data echoes the active scope and whether read or write access was the one denied.',
    },
    {
      reason: 'note_missing',
      code: JsonRpcErrorCode.NotFound,
      when: '`failIfMissing: true` (default) and the path does not exist in the vault. Pass `failIfMissing: false` to allow Obsidian to create the file on open.',
      recovery:
        'Verify the path with obsidian_list_notes or obsidian_search_notes first — a typo would otherwise materialize as an empty file. If creation is intended, retry with failIfMissing: false.',
    },
    {
      reason: 'ambiguous_path',
      code: JsonRpcErrorCode.Conflict,
      when: 'The parent directory contains multiple files whose names differ only in case (case-sensitive filesystems only).',
      recovery: 'Retry with one of the exact paths listed in `matches` on the error data.',
    },
    {
      reason: 'path_is_directory',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied path names a folder rather than a file.',
      recovery:
        'Call obsidian_list_notes with this path to list the folder, then open one of the files it returns.',
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
    const target: NoteTarget = { type: 'path', path: input.path };

    /**
     * Obsidian creates the file when `/open/` names a path that isn't there,
     * so the probe is the only place an open can be told from a create.
     */
    let resolvedPath = input.path;
    let existed = true;

    try {
      const { resolvedPath: rp } = await withCaseFallback(ctx, svc, target, (t) =>
        svc.getNoteJson(ctx, t),
      );
      resolvedPath = rp ?? input.path;
    } catch (err) {
      // Match on `data.reason` rather than the JSON-RPC code so the handler text
      // doesn't trip `error-contract-prefer-fail` on a comparison literal. The
      // service tags path 404s with `reason: 'note_missing'` in its error data.
      const reason = err instanceof McpError ? err.data?.reason : undefined;
      if (reason !== 'note_missing') throw err;
      existed = false;
      if (input.failIfMissing) {
        const suggestions = (err instanceof McpError && (err.data?.suggestions as string[])) || [];
        const hintParts: string[] = [];
        if (suggestions.length > 0) {
          hintParts.push(`Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`);
        }
        // Lead with verification so a typo doesn't get materialized as an empty
        // file by following the recovery hint blindly. Creation stays as the
        // explicit opt-in second path.
        hintParts.push(
          'Verify the path with obsidian_list_notes or obsidian_search_notes — or, if creation is intended, retry with failIfMissing: false.',
        );
        throw ctx.fail(
          'note_missing',
          `Cannot open '${input.path}' — file does not exist.`,
          {
            path: input.path,
            ...(suggestions.length > 0 ? { suggestions } : {}),
            recovery: { hint: hintParts.join(' ') },
          },
          { cause: err },
        );
      }
    }

    await svc.openInUi(ctx, resolvedPath, {
      newLeaf: input.newLeaf,
      createIfMissing: !existed,
    });
    return {
      path: resolvedPath,
      opened: true,
      createdIfMissing: !existed,
    };
  },

  format: (result) => [
    {
      type: 'text',
      text: [
        `**Opened ${result.path}**`,
        `*Opened:* ${result.opened}`,
        `*Created if missing:* ${result.createdIfMissing}`,
      ].join('\n'),
    },
  ],
});

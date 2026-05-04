/**
 * @fileoverview obsidian_open_in_ui — open a file in the Obsidian app UI.
 * Defaults to `failIfMissing: true` because Obsidian silently creates files on
 * open otherwise; opt out for an "open or create" flow.
 * @module mcp-server/tools/definitions/obsidian-open-in-ui.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import type { NoteTarget } from '@/services/obsidian/types.js';
import { withCaseFallback } from './_shared/suggest-paths.js';

export const obsidianOpenInUi = tool('obsidian_open_in_ui', {
  description:
    'Open a file in the Obsidian app UI. By default fails when the path does not exist; the `failIfMissing` flag controls the open-or-create behavior.',
  annotations: { openWorldHint: true },
  input: z.object({
    path: z.string().min(1).describe('Vault-relative path of the file to open.'),
    failIfMissing: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), fails if the file does not exist. When false, allows Obsidian to create the file on open.',
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
      when: 'The target path is outside OBSIDIAN_READ_PATHS (and OBSIDIAN_WRITE_PATHS, since write paths imply read access).',
      recovery:
        'Use a path inside the configured read scope. The error data echoes the active scope.',
    },
    {
      reason: 'note_missing',
      code: JsonRpcErrorCode.NotFound,
      when: '`failIfMissing: true` (default) and the path does not exist in the vault. Pass `failIfMissing: false` to allow Obsidian to create the file on open.',
      recovery:
        'Verify the path with obsidian_list_notes or pass failIfMissing false to create on open.',
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const target: NoteTarget = { type: 'path', path: input.path };

    if (!input.failIfMissing) {
      // Caller opted into "open or create" — skip the existence probe and let
      // Obsidian create the file on open.
      await svc.openInUi(ctx, input.path, { newLeaf: input.newLeaf });
      return { path: input.path, opened: true, createdIfMissing: true };
    }

    let resolvedPath = input.path;

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
      const suggestions = (err instanceof McpError && (err.data?.suggestions as string[])) || [];
      const hintParts: string[] = [];
      if (suggestions.length > 0) {
        hintParts.push(`Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`);
      }
      hintParts.push('Pass failIfMissing: false to create on open.');
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

    await svc.openInUi(ctx, resolvedPath, { newLeaf: input.newLeaf });
    return {
      path: resolvedPath,
      opened: true,
      createdIfMissing: false,
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

/**
 * @fileoverview obsidian://vault/{+path} — note content as a stable, addressable
 * URI. Mirrors `obsidian_get_note` with `format: "full"` for clients that
 * support attaching resources to a conversation.
 * @module mcp-server/resources/definitions/obsidian-vault-note.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianVaultNote = resource('obsidian://vault/{+path}', {
  name: 'obsidian-vault-note',
  description:
    'A note in the Obsidian vault. Returns the parsed note — content, frontmatter, tags, and stat — so clients can attach a specific note to a conversation.',
  mimeType: 'application/json',
  params: z.object({
    path: z.string().min(1).describe('Vault-relative path of the note, including extension.'),
  }),
  output: z.object({
    path: z.string().describe('Vault-relative path of the note.'),
    content: z.string().describe('Raw markdown body.'),
    frontmatter: z
      .record(z.string(), z.unknown())
      .describe(
        'Parsed YAML frontmatter. Values are strings, numbers, booleans, arrays, or nested objects.',
      ),
    tags: z.array(z.string()).describe('Tags from frontmatter and inline #tag syntax.'),
    stat: z
      .object({
        ctime: z.number().describe('Created time, ms since epoch.'),
        mtime: z.number().describe('Modified time, ms since epoch.'),
        size: z.number().describe('File size in bytes.'),
      })
      .describe('File metadata.'),
  }),
  auth: ['resource:obsidian-vault-note:read'],
  errors: [
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The requested path is outside OBSIDIAN_READ_PATHS (and OBSIDIAN_WRITE_PATHS, since write paths imply read access).',
      recovery:
        'Use a path inside the configured read scope. The error data echoes the active scope.',
    },
    {
      reason: 'note_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'The vault path does not resolve to an existing note.',
      recovery:
        'Verify the path with obsidian_list_notes or use obsidian_search_notes to locate the note.',
    },
  ],

  async handler(params, ctx) {
    const svc = getObsidianService();
    const note = await svc.getNoteJson(ctx, { type: 'path', path: params.path });
    return note;
  },
});

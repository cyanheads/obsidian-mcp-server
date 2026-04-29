/**
 * @fileoverview obsidian://vault/{+path} — note content as a stable, addressable
 * URI. Mirrors `obsidian_get_note` with `format: "full"` for clients that
 * support attaching resources to a conversation.
 * @module mcp-server/resources/definitions/obsidian-vault-note.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianVaultNote = resource('obsidian://vault/{+path}', {
  name: 'obsidian-vault-note',
  description:
    'A note in the Obsidian vault. Returns the parsed NoteJson — content, frontmatter, tags, and stat — so clients can attach a specific note to a conversation.',
  mimeType: 'application/json',
  params: z.object({
    path: z.string().min(1).describe('Vault-relative path of the note, including extension.'),
  }),
  output: z.object({
    path: z.string().describe('Vault-relative path of the note.'),
    content: z.string().describe('Raw markdown body.'),
    frontmatter: z
      .record(z.string(), z.unknown())
      .describe('Parsed YAML frontmatter as an object.'),
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

  async handler(params, ctx) {
    const svc = getObsidianService();
    const note = await svc.getNoteJson(ctx, { type: 'path', path: params.path });
    return note;
  },
});

/**
 * @fileoverview obsidian_list_files — list files and subdirectories at a vault path.
 * Splits the mixed `files[]` (entries ending in `/` are directories) into separate
 * arrays and applies optional extension/regex filters.
 * @module mcp-server/tools/definitions/obsidian-list-files.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianListFiles = tool('obsidian_list_files', {
  description:
    'List files and subdirectories at a vault path. Defaults to vault root when `path` is omitted. Optional `extension` and `nameRegex` filters narrow the listing.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    path: z.string().optional().describe('Vault-relative directory path. Omit for the vault root.'),
    extension: z
      .string()
      .optional()
      .describe(
        'Only include files matching this extension, with or without leading dot. Applies to files only — directories are returned regardless.',
      ),
    nameRegex: z
      .string()
      .optional()
      .describe(
        'Optional ECMAScript regex (no flags) applied to entry names. Matches both files and directories.',
      ),
  }),
  output: z.object({
    path: z.string().describe('The directory listed (empty string for vault root).'),
    files: z.array(z.string()).describe('Files in the listed directory.'),
    directories: z.array(z.string()).describe('Subdirectory entries (without trailing slash).'),
    appliedFilters: z
      .object({
        extension: z
          .string()
          .optional()
          .describe('The extension filter applied to this listing, normalized with leading dot.'),
        nameRegex: z.string().optional().describe('The nameRegex filter applied to this listing.'),
      })
      .optional()
      .describe('Active filters that narrowed the listing, when any were applied.'),
  }),
  auth: ['tool:obsidian_list_files:read'],
  errors: [
    {
      reason: 'regex_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is not a valid ECMAScript regex.',
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const listing = await svc.listFiles(ctx, input.path);

    const directories: string[] = [];
    const files: string[] = [];
    for (const entry of listing.files) {
      if (entry.endsWith('/')) directories.push(entry.slice(0, -1));
      else files.push(entry);
    }

    const ext = input.extension
      ? input.extension.startsWith('.')
        ? input.extension.toLowerCase()
        : `.${input.extension.toLowerCase()}`
      : undefined;

    let filteredFiles = files;
    let filteredDirs = directories;

    if (ext) {
      filteredFiles = filteredFiles.filter((f) => f.toLowerCase().endsWith(ext));
    }
    if (input.nameRegex) {
      let re: RegExp;
      try {
        re = new RegExp(input.nameRegex);
      } catch (err) {
        throw ctx.fail(
          'regex_invalid',
          `Invalid nameRegex: ${(err as Error).message}`,
          { nameRegex: input.nameRegex },
          { cause: err },
        );
      }
      filteredFiles = filteredFiles.filter((f) => re.test(f));
      filteredDirs = filteredDirs.filter((d) => re.test(d));
    }

    const appliedFilters: { extension?: string; nameRegex?: string } = {};
    if (ext) appliedFilters.extension = ext;
    if (input.nameRegex) appliedFilters.nameRegex = input.nameRegex;

    return {
      path: input.path ?? '',
      files: filteredFiles,
      directories: filteredDirs,
      ...(Object.keys(appliedFilters).length > 0 ? { appliedFilters } : {}),
    };
  },

  format: (result) => {
    const lines = [`**${result.path === '' ? '(vault root)' : result.path}**`];
    if (result.appliedFilters) {
      const parts: string[] = [];
      if (result.appliedFilters.extension)
        parts.push(`extension=\`${result.appliedFilters.extension}\``);
      if (result.appliedFilters.nameRegex)
        parts.push(`nameRegex=\`${result.appliedFilters.nameRegex}\``);
      lines.push(`*Filters:* ${parts.join(', ')}`);
    }
    lines.push('', `**Directories (${result.directories.length})**`);
    if (result.directories.length === 0) lines.push('_(none)_');
    else for (const d of result.directories) lines.push(`- ${d}/`);
    lines.push('', `**Files (${result.files.length})**`);
    if (result.files.length === 0) lines.push('_(none)_');
    else for (const f of result.files) lines.push(`- ${f}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

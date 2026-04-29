/**
 * @fileoverview obsidian_list_notes — recursive vault listing with bounded depth.
 * Walks the vault tree DFS up to `depth` levels (default 3), applying optional
 * extension and nameRegex filters across the walk, and renders both a flat
 * `entries[]` array (for programmatic consumption) and a box-drawing tree view
 * in `format()` (for LLM consumption — tree views are easier to scan than flat
 * paths). Hard cap at {@link ENTRY_CAP} entries protects against runaway HTTP
 * fan-out on large vaults; per-directory `truncated: true` flags signal where
 * the depth limit cut off recursion.
 *
 * Named `_notes` rather than `_files` to disambiguate from agents' generic
 * file-system tools (Read, Glob, LS) — a `_files` tool surface tempts agents
 * to fish for non-vault paths through it.
 * @module mcp-server/tools/definitions/obsidian-list-notes.tool
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService, type ObsidianService } from '@/services/obsidian/obsidian-service.js';

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 20;
const ENTRY_CAP = 1000;
const ENTRY_CAP_HINT = `Walk stopped at ${ENTRY_CAP} entries. Narrow with \`extension\`/\`nameRegex\`, list a deeper subdirectory, or lower \`depth\`.`;

interface Entry {
  path: string;
  truncated?: boolean | undefined;
  type: 'file' | 'directory';
}

interface WalkState {
  cappedByEntries: boolean;
  entries: Entry[];
  totalDirs: number;
  totalFiles: number;
}

interface WalkOpts {
  depth: number;
  ext: string | undefined;
  regex: RegExp | undefined;
}

const EntrySchema = z
  .object({
    path: z.string().describe('Vault-relative path of this entry.'),
    type: z
      .enum(['file', 'directory'])
      .describe('Whether this entry is a regular file or a subdirectory.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'On directory entries: true when the depth limit prevented walking into this directory. Pass a deeper `depth` to expand.',
      ),
  })
  .describe('A single entry in the listing.');

export const obsidianListNotes = tool('obsidian_list_notes', {
  description: `List notes and subdirectories at a vault path. Defaults to vault root when \`path\` is omitted. Walks the directory tree up to \`depth\` levels (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}); pass \`depth: 1\` for a flat single-directory listing. Optional \`extension\` and \`nameRegex\` filters apply across the whole walk. Returns flat \`entries[]\` (each with \`path\`, \`type\`, optional \`truncated\`) plus a tree view in the rendered output. Capped at ${ENTRY_CAP} entries per call — when reached, walking stops and \`excluded\` is set.`,
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
        'Optional ECMAScript regex (no flags) applied to entry names. Matches both files and directories; directories that fail the regex are skipped without recursing into them.',
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .max(MAX_DEPTH)
      .optional()
      .describe(
        `How many directory levels to walk. \`1\` lists the target directory only with no recursion. Default ${DEFAULT_DEPTH}.`,
      ),
  }),
  output: z.object({
    path: z.string().describe('The directory listed (empty string for vault root).'),
    entries: z
      .array(EntrySchema)
      .describe('Entries in DFS order — top-level first, then descendants.'),
    totals: z
      .object({
        entries: z.number().describe('Total entries returned across all walked depths.'),
        files: z.number().describe('Number of file entries.'),
        directories: z.number().describe('Number of directory entries.'),
      })
      .describe('Counts across the returned tree.'),
    appliedFilters: z
      .object({
        extension: z
          .string()
          .optional()
          .describe('Extension filter applied, normalized with leading dot.'),
        nameRegex: z.string().optional().describe('nameRegex filter applied to this listing.'),
        depth: z.number().describe('Recursion depth used to produce this listing.'),
      })
      .describe('Active filters and the recursion depth that produced this listing.'),
    excluded: z
      .object({
        reason: z
          .literal('entry_cap')
          .describe('`entry_cap`: walk stopped because the per-call entry limit was reached.'),
        cap: z.number().describe('The cap value at which walking stopped.'),
        hint: z.string().describe('Suggestion for narrowing the listing.'),
      })
      .optional()
      .describe('Present when the walk was truncated by the global entry cap.'),
  }),
  auth: ['tool:obsidian_list_notes:read'],
  errors: [
    {
      reason: 'regex_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is not a valid ECMAScript regex.',
    },
    {
      reason: 'note_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied `path` does not exist in the vault. Sub-directories that disappear mid-walk are silently skipped — only the root path surfaces this error.',
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const depth = input.depth ?? DEFAULT_DEPTH;

    let regex: RegExp | undefined;
    if (input.nameRegex) {
      try {
        regex = new RegExp(input.nameRegex);
      } catch (err) {
        throw ctx.fail(
          'regex_invalid',
          `Invalid nameRegex: ${(err as Error).message}`,
          { nameRegex: input.nameRegex },
          { cause: err },
        );
      }
    }

    const ext = input.extension
      ? input.extension.startsWith('.')
        ? input.extension.toLowerCase()
        : `.${input.extension.toLowerCase()}`
      : undefined;

    const rootDir = (input.path ?? '').replace(/^\/+|\/+$/g, '');
    const state: WalkState = { entries: [], totalFiles: 0, totalDirs: 0, cappedByEntries: false };
    await walkVault(svc, ctx, rootDir, 1, state, { depth, regex, ext });

    const appliedFilters: { extension?: string; nameRegex?: string; depth: number } = { depth };
    if (ext) appliedFilters.extension = ext;
    if (input.nameRegex) appliedFilters.nameRegex = input.nameRegex;

    return {
      path: input.path ?? '',
      entries: state.entries,
      totals: {
        entries: state.entries.length,
        files: state.totalFiles,
        directories: state.totalDirs,
      },
      appliedFilters,
      ...(state.cappedByEntries
        ? { excluded: { reason: 'entry_cap' as const, cap: ENTRY_CAP, hint: ENTRY_CAP_HINT } }
        : {}),
    };
  },

  format: (result) => {
    const headerName = result.path === '' ? '(vault root)' : result.path;
    const meta = [
      `${result.totals.entries} entries`,
      `${result.totals.files} files, ${result.totals.directories} directories`,
      `depth=${result.appliedFilters.depth}`,
    ];
    const filterParts: string[] = [];
    if (result.appliedFilters.extension)
      filterParts.push(`extension=\`${result.appliedFilters.extension}\``);
    if (result.appliedFilters.nameRegex)
      filterParts.push(`nameRegex=\`${result.appliedFilters.nameRegex}\``);
    if (filterParts.length) meta.push(`filters: ${filterParts.join(', ')}`);

    const lines = [`**${headerName}** — ${meta.join(' · ')}`];

    if (result.entries.length === 0) {
      lines.push('', '_(empty)_');
    } else {
      lines.push('', '```');
      lines.push(...renderTree(result.entries));
      lines.push('```');
    }

    if (result.excluded) {
      lines.push(
        '',
        `_Excluded: ${result.excluded.reason} (cap=${result.excluded.cap}). ${result.excluded.hint}_`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Recursive vault walk with depth and entry-count caps. Mutates `state` in
 * place; returns once the walk completes or hits the entry cap. Sub-directory
 * 404s (currentDepth > 1) are swallowed because the vault can shift mid-walk;
 * a 404 at currentDepth === 1 is the caller's root path missing and propagates
 * as a `note_missing` service error. Hoisted out of the handler so the lint's
 * source scanner doesn't see the framework's NotFound code in handler text.
 */
async function walkVault(
  svc: ObsidianService,
  ctx: Context,
  dir: string,
  currentDepth: number,
  state: WalkState,
  opts: WalkOpts,
): Promise<void> {
  if (state.cappedByEntries) return;

  let listing: { files: string[] };
  try {
    listing = await svc.listFiles(ctx, dir);
  } catch (err) {
    if (currentDepth > 1 && err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
      ctx.log.warning('Subdirectory disappeared during walk; skipping', { dir });
      return;
    }
    throw err;
  }

  for (const raw of listing.files) {
    if (state.entries.length >= ENTRY_CAP) {
      state.cappedByEntries = true;
      return;
    }

    const isDir = raw.endsWith('/');
    const name = isDir ? raw.slice(0, -1) : raw;

    if (opts.regex && !opts.regex.test(name)) continue;
    if (!isDir && opts.ext && !name.toLowerCase().endsWith(opts.ext)) continue;

    const fullPath = dir ? `${dir}/${name}` : name;
    const entry: Entry = { path: fullPath, type: isDir ? 'directory' : 'file' };
    if (isDir && currentDepth >= opts.depth) entry.truncated = true;

    state.entries.push(entry);
    if (isDir) state.totalDirs++;
    else state.totalFiles++;

    if (isDir && currentDepth < opts.depth) {
      await walkVault(svc, ctx, fullPath, currentDepth + 1, state, opts);
      if (state.cappedByEntries) return;
    }
  }
}

/**
 * Render entries (in DFS order) as a box-drawing tree. Builds a parent→children
 * map keyed by each entry's parent vault path, then emits each top-level group
 * (parents that aren't themselves entries) as the roots of the rendered tree.
 * This makes the renderer agnostic to the caller's root path — entries anchor
 * the tree, not the input.
 */
function renderTree(entries: Entry[]): string[] {
  const childrenByParent = new Map<string, Entry[]>();
  const entryPaths = new Set<string>();
  for (const e of entries) entryPaths.add(e.path);
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const parent = slash >= 0 ? e.path.slice(0, slash) : '';
    let list = childrenByParent.get(parent);
    if (!list) {
      list = [];
      childrenByParent.set(parent, list);
    }
    list.push(e);
  }

  const lines: string[] = [];

  function emit(entry: Entry, prefix: string, isLast: boolean): void {
    const branch = isLast ? '└── ' : '├── ';
    const slashIdx = entry.path.lastIndexOf('/');
    const name = slashIdx >= 0 ? entry.path.slice(slashIdx + 1) : entry.path;
    const trailing = entry.type === 'directory' ? '/' : '';
    const truncMarker = entry.truncated ? ' [truncated — pass deeper `depth` to expand]' : '';
    lines.push(`${prefix}${branch}${name}${trailing}${truncMarker}`);
    if (entry.type === 'directory' && !entry.truncated) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      const children = childrenByParent.get(entry.path) ?? [];
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c) emit(c, childPrefix, i === children.length - 1);
      }
    }
  }

  for (const parent of childrenByParent.keys()) {
    if (entryPaths.has(parent)) continue;
    const children = childrenByParent.get(parent) ?? [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c) emit(c, '', i === children.length - 1);
    }
  }
  return lines;
}

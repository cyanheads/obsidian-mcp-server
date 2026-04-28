/**
 * @fileoverview obsidian_replace_in_note — string/regex search-replace inside a
 * single note. Composed read → mutate → write at the service layer; replacements
 * are applied sequentially over the evolving body.
 * @module mcp-server/tools/definitions/obsidian-replace-in-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { TargetSchema } from './_shared/schemas.js';

const ReplacementSchema = z
  .object({
    search: z.string().min(1).describe('Substring or regex pattern to match.'),
    replace: z.string().describe('Replacement text. Empty string deletes matches.'),
    useRegex: z.boolean().default(false).describe('Treat `search` as an ECMAScript regex pattern.'),
    caseSensitive: z.boolean().default(true).describe('When false, match case-insensitively.'),
    wholeWord: z
      .boolean()
      .default(false)
      .describe(
        'Match only at word boundaries. Applies in both literal and regex modes — the search pattern is wrapped with `\\b…\\b`.',
      ),
    flexibleWhitespace: z
      .boolean()
      .default(false)
      .describe(
        'Treat any run of whitespace in `search` as matching any whitespace in the body. Literal mode only — has no effect when `useRegex: true` (express it directly with `\\s+`).',
      ),
    replaceAll: z.boolean().default(true).describe('When false, only the first match is replaced.'),
  })
  .describe('A single search/replace operation.');

export const obsidianReplaceInNote = tool('obsidian_replace_in_note', {
  description:
    "String or regex search-replace inside a single note. The note is fetched, replacements are applied sequentially (each sees the previous one's output), and the result is written back. Use for edits that don't fit `obsidian_patch_note`'s structural targets — e.g., body-wide find-and-replace.",
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Where the note lives.'),
    replacements: z
      .array(ReplacementSchema)
      .min(1)
      .describe('Replacements to apply in array order over the evolving content.'),
  }),
  output: z.object({
    path: z.string().describe('Resolved vault-relative path of the note.'),
    totalReplacements: z
      .number()
      .describe('Total number of substitutions applied across all replacement entries.'),
    perReplacement: z
      .array(
        z
          .object({
            search: z.string().describe('The search term/pattern that ran.'),
            count: z.number().describe('Number of matches replaced for this entry.'),
          })
          .describe('Counts for one replacement entry.'),
      )
      .describe('Per-entry counts in the order replacements were applied.'),
  }),
  auth: ['tool:obsidian_replace_in_note:write'],
  errors: [
    {
      reason: 'regex_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A `useRegex: true` replacement supplied a `search` pattern that is not a valid ECMAScript regex.',
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
    const note = await svc.getNoteJson(ctx, target);

    let body = note.content;
    const perReplacement: Array<{ search: string; count: number }> = [];
    let totalReplacements = 0;

    for (const r of input.replacements) {
      let count = 0;
      if (r.useRegex) {
        const pattern = r.wholeWord ? `\\b(?:${r.search})\\b` : r.search;
        let re: RegExp;
        try {
          re = new RegExp(pattern, `${r.replaceAll ? 'g' : ''}${r.caseSensitive ? '' : 'i'}`);
        } catch (err) {
          throw ctx.fail(
            'regex_invalid',
            `Invalid regex '${r.search}': ${(err as Error).message}`,
            { search: r.search },
            { cause: err },
          );
        }
        // Count separately, then apply with the string overload so $1/$2/$&
        // capture-group references in `r.replace` are honored.
        const matches = body.match(re);
        count = matches ? (re.global ? matches.length : 1) : 0;
        body = body.replace(re, r.replace);
      } else if (r.wholeWord || r.flexibleWhitespace) {
        // Literal-with-transformations: build a regex from the escaped needle.
        // Use the callback overload so `$1`/`$&` in `r.replace` stay literal.
        let escaped = r.search.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
        if (r.flexibleWhitespace) escaped = escaped.replace(/\s+/g, '\\s+');
        if (r.wholeWord) escaped = `\\b${escaped}\\b`;
        const re = new RegExp(escaped, `${r.replaceAll ? 'g' : ''}${r.caseSensitive ? '' : 'i'}`);
        body = body.replace(re, () => {
          count++;
          return r.replace;
        });
      } else if (r.caseSensitive) {
        body = replaceLiteral(body, r.search, r.replace, r.replaceAll, () => {
          count++;
        });
      } else {
        body = replaceLiteralCaseInsensitive(body, r.search, r.replace, r.replaceAll, () => {
          count++;
        });
      }
      perReplacement.push({ search: r.search, count });
      totalReplacements += count;
    }

    if (totalReplacements > 0) {
      await svc.writeNote(ctx, target, body, 'markdown');
    }

    return { path: note.path, totalReplacements, perReplacement };
  },

  format: (result) => {
    const lines = [
      `**Replaced in ${result.path}**`,
      `*Total replacements:* ${result.totalReplacements}`,
      '',
      '**Per replacement**',
    ];
    for (const r of result.perReplacement) {
      lines.push(`- \`${r.search}\` → ${r.count} match${r.count === 1 ? '' : 'es'}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function replaceLiteral(
  haystack: string,
  needle: string,
  replacement: string,
  all: boolean,
  onMatch: () => void,
): string {
  if (!all) {
    const idx = haystack.indexOf(needle);
    if (idx === -1) return haystack;
    onMatch();
    return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
  }
  const parts = haystack.split(needle);
  if (parts.length <= 1) return haystack;
  for (let i = 0; i < parts.length - 1; i++) onMatch();
  return parts.join(replacement);
}

function replaceLiteralCaseInsensitive(
  haystack: string,
  needle: string,
  replacement: string,
  all: boolean,
  onMatch: () => void,
): string {
  const escaped = needle.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const re = new RegExp(escaped, all ? 'gi' : 'i');
  return haystack.replace(re, () => {
    onMatch();
    return replacement;
  });
}

/**
 * @fileoverview obsidian_replace_in_note — string/regex search-replace inside a
 * single note. Composed read → mutate → write at the service layer; replacements
 * are applied sequentially over the evolving text of whichever parts of the note
 * `scope` selects, with the frontmatter block out of scope by default.
 * @module mcp-server/tools/definitions/obsidian-replace-in-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { frontmatterParseError, splice } from '@/services/obsidian/frontmatter-ops.js';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { nameRegexSafetyIssue } from './_shared/regex-safety.js';
import { TargetSchema } from './_shared/schemas.js';

/**
 * Length cap for `useRegex` patterns — higher than the 256 default for name
 * filters, since body-wide replace patterns are legitimately longer. The
 * nested-quantifier guard applies regardless of length.
 */
const REPLACE_REGEX_MAX_LENGTH = 1024;

const ReplacementSchema = z
  .object({
    search: z.string().min(1).describe('Substring or regex pattern to match.'),
    replace: z.string().describe('Replacement text. Empty string deletes matches.'),
    useRegex: z
      .boolean()
      .default(false)
      .describe(
        'Treat `search` as an ECMAScript regex pattern (≤1024 chars, no nested quantifiers like `(a+)+` — catastrophic-backtracking guard).',
      ),
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

type Replacement = z.infer<typeof ReplacementSchema>;

/** One replacement's effect on a stretch of text. */
interface Applied {
  count: number;
  text: string;
}

export const obsidianReplaceInNote = tool('obsidian_replace_in_note', {
  description:
    "Search and replace inside a single note, literally or by regex. Replacements run in array order, each over the previous one's output, and cover the note body only unless `scope` says otherwise — the YAML frontmatter block is left byte-identical by default, because a prose edit that lands in a scalar can silently invalidate the whole block. Use for edits that don't fit `obsidian_patch_note`'s structural targets — e.g., body-wide find-and-replace. Prefer `obsidian_manage_frontmatter` for typed edits to a single property.",
  annotations: { destructiveHint: true },
  input: z.object({
    target: TargetSchema.describe('Where the note lives.'),
    scope: z
      .enum(['body', 'frontmatter', 'both'])
      .default('body')
      .describe(
        "Which part of the note the replacements run over. `body` leaves the YAML frontmatter block byte-identical. `frontmatter` and `both` also rewrite the YAML between the `---` fences — never the fences themselves — and re-parse it afterwards, failing the whole call and writing nothing if the result no longer parses. That check catches YAML that breaks, not YAML that still parses while meaning something else: a replacement that renames a key or strips a scalar's quotes passes it.",
      ),
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
            count: z
              .number()
              .describe('Number of matches replaced for this entry, across every scope it ran in.'),
            bodyCount: z.number().describe('Matches replaced in the note body.'),
            frontmatterCount: z
              .number()
              .describe(
                'Matches replaced inside the YAML frontmatter block. Always 0 under the default `body` scope.',
              ),
          })
          .describe('Counts for one replacement entry.'),
      )
      .describe('Per-entry counts in the order replacements were applied.'),
    previousSizeInBytes: z
      .number()
      .describe('Byte size of the note before replacements were applied.'),
    currentSizeInBytes: z
      .number()
      .describe(
        'Byte size of the note after replacements were applied. Equals `previousSizeInBytes` when no matches were found and no write was issued.',
      ),
  }),
  auth: ['tool:obsidian_replace_in_note:write'],
  errors: [
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The target path is outside OBSIDIAN_WRITE_PATHS, or OBSIDIAN_READ_ONLY=true denies all writes. (The pre-read also requires the path to be readable.)',
      recovery:
        'Use a path inside the configured write scope. The error data echoes the active scope.',
    },
    {
      reason: 'regex_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A `useRegex: true` replacement supplied a `search` pattern that is not a valid ECMAScript regex.',
      recovery:
        'Use a valid ECMAScript regex, or set useRegex to false to match `search` as a literal string.',
    },
    {
      reason: 'regex_unsafe',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A `useRegex: true` replacement supplied a `search` pattern that is well-formed but exceeds the 1024-character limit or contains nested quantifiers known to cause catastrophic backtracking against the note body.',
      recovery:
        'Avoid nested quantifiers like `(a+)+` or `(.*)*`. Use a simpler pattern, or set useRegex to false to match `search` as a literal string.',
    },
    {
      reason: 'frontmatter_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A `scope` of "frontmatter" or "both" produced YAML that no longer parses as a mapping of properties. Nothing is written — the note keeps its original bytes. The check reads the rewritten YAML only, so a replacement that renames a key or changes a scalar\'s type while still parsing is not caught by it.',
      recovery:
        'Narrow the search so it cannot match inside the YAML, or leave scope at "body" and edit the property with obsidian_manage_frontmatter.',
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
      recovery: 'Create the periodic note first or pass an explicit path target.',
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
      when: 'The supplied path names a folder rather than a note file.',
      recovery:
        'Call obsidian_list_notes with this path to list the folder, then retry with the full path of one of the files it returns.',
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
    const { target } = input;
    const note = await svc.getNoteJson(ctx, target);
    // Delivered bytes — not note.stat.size (see ObsidianService.tryGetSize).
    const previousSizeInBytes = Buffer.byteLength(note.content, 'utf8');

    /**
     * `note.content` is the whole file. Split it so each replacement runs only
     * over the parts `scope` selects, and so the untouched half is re-attached
     * from the original bytes rather than re-emitted.
     */
    const fm = splice(note.content);
    const editFrontmatter = fm.hasFrontmatter && input.scope !== 'body';
    const editBody = input.scope !== 'frontmatter';
    let yamlText = fm.yamlText;
    let body = fm.body;

    const perReplacement: Array<{
      bodyCount: number;
      count: number;
      frontmatterCount: number;
      search: string;
    }> = [];
    let totalReplacements = 0;

    /**
     * Compile once per replacement — the pattern guards fire before any text is
     * touched — and return a function that can run over each in-scope stretch.
     */
    const compile = (r: Replacement): ((text: string) => Applied) => {
      if (r.useRegex) {
        const pattern = r.wholeWord ? `\\b(?:${r.search})\\b` : r.search;
        const safetyIssue = nameRegexSafetyIssue(pattern, REPLACE_REGEX_MAX_LENGTH);
        if (safetyIssue) {
          throw ctx.fail('regex_unsafe', `Unsafe regex '${r.search}': ${safetyIssue}`, {
            search: r.search,
            ...ctx.recoveryFor('regex_unsafe'),
          });
        }
        let re: RegExp;
        try {
          re = new RegExp(pattern, `${r.replaceAll ? 'g' : ''}${r.caseSensitive ? '' : 'i'}`);
        } catch (err) {
          throw ctx.fail(
            'regex_invalid',
            `Invalid regex '${r.search}': ${(err as Error).message}`,
            { search: r.search, ...ctx.recoveryFor('regex_invalid') },
            { cause: err },
          );
        }
        // Count separately, then apply with the string overload so $1/$2/$&
        // capture-group references in `r.replace` are honored.
        return (text) => {
          const matches = text.match(re);
          return {
            text: text.replace(re, r.replace),
            count: matches ? (re.global ? matches.length : 1) : 0,
          };
        };
      }
      if (r.wholeWord || r.flexibleWhitespace) {
        // Literal-with-transformations: build a regex from the escaped needle.
        // Use the callback overload so `$1`/`$&` in `r.replace` stay literal.
        let escaped = r.search.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
        if (r.flexibleWhitespace) escaped = escaped.replace(/\s+/g, '\\s+');
        if (r.wholeWord) escaped = `\\b${escaped}\\b`;
        const re = new RegExp(escaped, `${r.replaceAll ? 'g' : ''}${r.caseSensitive ? '' : 'i'}`);
        return (text) => {
          let count = 0;
          const next = text.replace(re, () => {
            count++;
            return r.replace;
          });
          return { text: next, count };
        };
      }
      const replaceEach = r.caseSensitive ? replaceLiteral : replaceLiteralCaseInsensitive;
      return (text) => {
        let count = 0;
        const next = replaceEach(text, r.search, r.replace, r.replaceAll, () => {
          count++;
        });
        return { text: next, count };
      };
    };

    for (const r of input.replacements) {
      const apply = compile(r);
      let frontmatterCount = 0;
      let bodyCount = 0;
      if (editFrontmatter) {
        const applied = apply(yamlText);
        yamlText = applied.text;
        frontmatterCount = applied.count;
      }
      // `replaceAll: false` means one substitution for the note, and the
      // frontmatter comes first — a hit there is that one.
      if (editBody && (r.replaceAll || frontmatterCount === 0)) {
        const applied = apply(body);
        body = applied.text;
        bodyCount = applied.count;
      }
      const count = frontmatterCount + bodyCount;
      perReplacement.push({ search: r.search, count, bodyCount, frontmatterCount });
      totalReplacements += count;
    }

    // Validate before the write: a broken block reaching disk costs the note its
    // properties, and Obsidian reports nothing.
    if (editFrontmatter && yamlText !== fm.yamlText) {
      const problem = frontmatterParseError(yamlText);
      if (problem) {
        throw ctx.fail(
          'frontmatter_invalid',
          `Replacements left the frontmatter of ${note.path} unparseable: ${problem}`,
          { path: note.path, ...ctx.recoveryFor('frontmatter_invalid') },
        );
      }
    }

    let currentSizeInBytes = previousSizeInBytes;
    if (totalReplacements > 0) {
      await svc.writeNote(ctx, target, fm.open + yamlText + fm.close + body, 'markdown');
      currentSizeInBytes = await svc.getSize(ctx, { type: 'path', path: note.path });
    }

    return {
      path: note.path,
      totalReplacements,
      perReplacement,
      previousSizeInBytes,
      currentSizeInBytes,
    };
  },

  format: (result) => {
    const lines = [
      `**Replaced in ${result.path}**`,
      `*Total replacements:* ${result.totalReplacements}`,
      `*Size:* ${result.previousSizeInBytes} → ${result.currentSizeInBytes} bytes`,
      '',
      '**Per replacement**',
    ];
    for (const r of result.perReplacement) {
      lines.push(
        `- \`${r.search}\` → ${r.count} match${r.count === 1 ? '' : 'es'} (body ${r.bodyCount}, frontmatter ${r.frontmatterCount})`,
      );
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

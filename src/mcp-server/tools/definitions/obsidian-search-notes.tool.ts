/**
 * @fileoverview obsidian_search_notes — text/dataview/jsonlogic search.
 * Caps results at 100 hits and surfaces an `excluded` indicator when more
 * were returned upstream.
 * @module mcp-server/tools/definitions/obsidian-search-notes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

const HIT_CAP = 100;
const EXCLUSION_HINT =
  'Narrow your query (add filters or more specific terms) to surface the rest.';

const TextHitSchema = z
  .object({
    filename: z.string().describe('Vault-relative path of the matching note.'),
    score: z.number().optional().describe('Relevance score from the search index, when available.'),
    matches: z
      .array(
        z
          .object({
            context: z.string().describe('Surrounding text around the match.'),
            match: z
              .object({
                start: z.number().describe('Match start offset in the surrounding context.'),
                end: z.number().describe('Match end offset in the surrounding context.'),
              })
              .describe('Match offsets within the context window.'),
          })
          .describe('A single match within a file.'),
      )
      .describe('Per-match context windows.'),
  })
  .describe('A file with one or more text-search matches.');

const StructuredHitSchema = z
  .object({
    filename: z.string().describe('Vault-relative path of the matching note.'),
    result: z.unknown().describe('The query result for this file — shape determined by the query.'),
  })
  .describe('A file with a structured (Dataview/JSONLogic) result value.');

const ExcludedSchema = z
  .object({
    count: z.number().describe('Number of additional hits the upstream returned beyond the cap.'),
    hint: z.string().describe('Suggestion for narrowing the query.'),
  })
  .optional();

export const obsidianSearchNotes = tool('obsidian_search_notes', {
  description: `Search the vault. Modes:
- \`text\`: substring match with context windows. Pass \`query\` as a string and optionally \`pathPrefix\` to filter the returned filenames.
- \`dataview\`: a Dataview DQL query (\`TABLE …\`). Pass \`query\` as the DQL string. Use this for path/date/metadata filters; \`file.mtime\`, \`file.path\`, etc. are queryable.
- \`jsonlogic\`: a JSONLogic tree evaluated over each note's NoteJson. Pass \`logic\` as a JSON object. Available \`var\` paths: \`path\` (string), \`content\` (string), \`frontmatter.<key>\` (any), \`tags\` (string[]), \`stat.ctime\` / \`stat.mtime\` / \`stat.size\` (number). Custom operators include \`glob\` and \`regexp\`.

Results are capped at ${HIT_CAP} hits; an \`excluded\` indicator reports the overflow.`,
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    mode: z
      .enum(['text', 'dataview', 'jsonlogic'])
      .describe('Search algorithm and request body shape.'),
    query: z
      .string()
      .optional()
      .describe(
        'For `text` mode: substring to match. For `dataview` mode: the DQL query string. Required for those modes.',
      ),
    logic: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSONLogic tree. Required and only used when `mode` is `"jsonlogic"`.'),
    contextLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Characters of context on each side of the match (text mode only). Default 100.'),
    pathPrefix: z
      .string()
      .optional()
      .describe('Filter returned filenames by prefix (text mode only, applied client-side).'),
  }),
  output: z.object({
    result: z
      .discriminatedUnion('mode', [
        z
          .object({
            mode: z.literal('text').describe('Echoed mode.'),
            hits: z.array(TextHitSchema).describe('Matching files with per-match context.'),
            excluded: ExcludedSchema.describe('Present when results were truncated to the cap.'),
          })
          .describe('Text-search results.'),
        z
          .object({
            mode: z.literal('dataview').describe('Echoed mode.'),
            hits: z
              .array(StructuredHitSchema)
              .describe('Matching files with the query result per file.'),
            excluded: ExcludedSchema.describe('Present when results were truncated to the cap.'),
          })
          .describe('Dataview DQL results.'),
        z
          .object({
            mode: z.literal('jsonlogic').describe('Echoed mode.'),
            hits: z
              .array(StructuredHitSchema)
              .describe('Matching files with the JSONLogic result per file.'),
            excluded: ExcludedSchema.describe('Present when results were truncated to the cap.'),
          })
          .describe('JSONLogic results.'),
      ])
      .describe('Mode-discriminated search payload.'),
  }),
  auth: ['tool:obsidian_search_notes:read'],

  async handler(input, ctx) {
    const svc = getObsidianService();

    if (input.pathPrefix && input.mode !== 'text') {
      throw invalidParams('`pathPrefix` is only valid in text mode.', { mode: input.mode });
    }

    if (input.mode === 'text') {
      if (!input.query) {
        throw invalidParams('`query` is required for text mode.', { mode: input.mode });
      }
      const all = await svc.searchText(ctx, input.query, input.contextLength);
      const prefix = input.pathPrefix;
      const filtered = prefix ? all.filter((h) => h.filename.startsWith(prefix)) : all;
      const capped = applyCap(filtered);
      return { result: { mode: 'text' as const, ...capped } };
    }

    if (input.mode === 'dataview') {
      if (!input.query) {
        throw invalidParams('`query` (DQL string) is required for dataview mode.', {
          mode: input.mode,
        });
      }
      const all = await svc.searchDataview(ctx, input.query);
      const capped = applyCap(all);
      return { result: { mode: 'dataview' as const, ...capped } };
    }

    if (!input.logic) {
      throw invalidParams('`logic` (JSONLogic tree) is required for jsonlogic mode.', {
        mode: input.mode,
      });
    }
    const all = await svc.searchJsonLogic(ctx, input.logic);
    const capped = applyCap(all);
    return { result: { mode: 'jsonlogic' as const, ...capped } };
  },

  format: ({ result }) => {
    const lines: string[] = [`**Search (${result.mode}) — ${result.hits.length} hits**`];
    if (result.excluded) {
      lines.push(`_Excluded ${result.excluded.count} additional hits — ${result.excluded.hint}_`);
    }
    if (result.hits.length === 0) {
      lines.push(
        '',
        '_No matches. Try broader terms, a different mode, or check that the path/filter is correct._',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('');
    if (result.mode === 'text') {
      for (const h of result.hits) {
        lines.push(`### ${h.filename}${h.score !== undefined ? ` (score: ${h.score})` : ''}`);
        for (const m of h.matches) {
          lines.push(`- match[${m.match.start}–${m.match.end}]: ${truncate(m.context, 240)}`);
        }
      }
    } else {
      for (const h of result.hits) {
        lines.push(`### ${h.filename}`);
        lines.push('```json');
        lines.push(safeJsonStringify(h.result));
        lines.push('```');
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function applyCap<T>(all: T[]): {
  hits: T[];
  excluded: { count: number; hint: string } | undefined;
} {
  if (all.length <= HIT_CAP) return { hits: all, excluded: undefined };
  return {
    hits: all.slice(0, HIT_CAP),
    excluded: { count: all.length - HIT_CAP, hint: EXCLUSION_HINT },
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

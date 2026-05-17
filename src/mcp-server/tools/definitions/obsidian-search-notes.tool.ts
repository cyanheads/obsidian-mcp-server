/**
 * @fileoverview obsidian_search_notes — text/jsonlogic/omnisearch search with
 * MCP-spec cursor pagination. The `omnisearch` mode is added conditionally by
 * the entry point only when the Omnisearch plugin's HTTP server is reachable
 * at startup. Text-mode hits additionally clip per file via `maxMatchesPerHit`
 * so a single match-heavy note can't blow the response budget — clipped hits
 * carry `truncated: true` and `totalMatches`.
 * @module mcp-server/tools/definitions/obsidian-search-notes.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { paginateArray } from '@cyanheads/mcp-ts-core/utils';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_MATCHES_PER_HIT = 10;
/** Omnisearch's hardwired upstream cap — pagination/limit params are ignored. */
const OMNISEARCH_UPSTREAM_CAP = 50;

const CursorSchema = z
  .string()
  .optional()
  .describe(
    'Opaque cursor from a prior response. Omit for the first page. Page size is server-determined; do not assume a fixed value.',
  );

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
      .describe('Per-match context windows. Capped per file by `maxMatchesPerHit`.'),
    totalMatches: z
      .number()
      .optional()
      .describe(
        'Total matches in this file. Present only when `matches` was clipped to `maxMatchesPerHit`.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when `matches` was clipped to `maxMatchesPerHit`. Use `obsidian_get_note` to read the full file when more context is needed.',
      ),
  })
  .describe('A file with one or more text-search matches.');

const StructuredHitSchema = z
  .object({
    filename: z.string().describe('Vault-relative path of the matching note.'),
    result: z.unknown().describe('The query result for this file — shape determined by the query.'),
  })
  .describe('A file with a structured (Dataview/JSONLogic) result value.');

const OmnisearchHitSchema = z
  .object({
    filename: z.string().describe('Vault-relative path of the matching note.'),
    basename: z.string().describe('Note basename without extension.'),
    score: z.number().describe('BM25 relevance score. Higher is more relevant.'),
    foundWords: z
      .array(z.string())
      .describe(
        'Query words found in the note. Populated even when no body match exists (e.g. basename-only match), so empty `matches` paired with non-empty `foundWords` is valid.',
      ),
    matches: z
      .array(
        z
          .object({
            match: z.string().describe('The matched substring.'),
            offset: z.number().describe('Offset of the match within the note body.'),
          })
          .describe('A single match span in the note body.'),
      )
      .describe('Match positions within the note body. May be empty for basename-only matches.'),
    excerpt: z
      .string()
      .describe(
        'Surrounding-context excerpt with `<mark>` around matches; HTML entities are decoded and `<br>` becomes `\\n`.',
      ),
  })
  .describe('An Omnisearch BM25-ranked hit.');

/**
 * Build the `obsidian_search_notes` tool. The `omnisearch` mode is included
 * in the input/output schemas only when `omnisearchReachable` is true so the
 * LLM never sees it as an option on a deployment where it can't run. Re-probe
 * requires a server restart.
 */
export function buildSearchNotesTool({ omnisearchReachable }: { omnisearchReachable: boolean }) {
  const modeEnum = omnisearchReachable
    ? (['text', 'jsonlogic', 'omnisearch'] as const)
    : (['text', 'jsonlogic'] as const);

  const description = omnisearchReachable
    ? 'Search the vault by text substring, JSONLogic predicate, or BM25-ranked Omnisearch query. Pick the mode that matches the query shape — `omnisearch` is best for ranked relevance, typo tolerance, and PDF/OCR coverage (via the Text Extractor plugin). Results paginate via opaque cursors: omit `cursor` for the first page, then pass `nextCursor` from the prior response. Text-mode hits additionally clip per file at `maxMatchesPerHit`.'
    : 'Search the vault by text substring or JSONLogic predicate. Pick the mode that matches the query shape. Results paginate via opaque cursors: omit `cursor` for the first page, then pass `nextCursor` from the prior response. Text-mode hits additionally clip per file at `maxMatchesPerHit`.';

  const inputSchema = z.object({
    mode: z
      .enum(modeEnum)
      .describe(
        omnisearchReachable
          ? 'Which search algorithm to run. `text` matches a substring case-insensitively across filenames and note bodies, returning surrounding context windows. `jsonlogic` evaluates a JSONLogic tree against each note, with `var` paths into `path`, `content`, `frontmatter.<key>`, `tags`, and `stat.{ctime,mtime,size}`, plus `glob` and `regexp` operators. `omnisearch` runs a BM25-ranked query via the Omnisearch plugin — supports quoted phrases, `-exclusion`, `path:` / `ext:` filters, typo tolerance, and PDF/OCR (with Text Extractor); upstream caps results at 50.'
          : 'Which search algorithm to run. `text` matches a substring case-insensitively across filenames and note bodies, returning surrounding context windows. `jsonlogic` evaluates a JSONLogic tree against each note, with `var` paths into `path`, `content`, `frontmatter.<key>`, `tags`, and `stat.{ctime,mtime,size}`, plus `glob` and `regexp` operators.',
      ),
    query: z
      .string()
      .optional()
      .describe('For `text` and `omnisearch` modes: the query string. Required for both.'),
    logic: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSONLogic tree. Required and only used when `mode` is `"jsonlogic"`.'),
    contextLength: z
      .number()
      .int()
      .positive()
      .default(100)
      .describe('Characters of context on each side of the match (text mode only).'),
    pathPrefix: z
      .string()
      .optional()
      .describe('Filter returned filenames by prefix (text mode only, applied client-side).'),
    maxMatchesPerHit: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MATCHES_PER_HIT)
      .describe(
        'Cap on match contexts returned per file in text mode. When clipped, the hit carries `truncated: true` and `totalMatches`.',
      ),
    cursor: CursorSchema,
  });

  const textBranch = z
    .object({
      mode: z.literal('text').describe('Echoed mode.'),
      hits: z.array(TextHitSchema).describe('Matching files with per-match context.'),
      totalCount: z
        .number()
        .describe('Total post-path-policy hit count across all pages, before pagination.'),
      nextCursor: z
        .string()
        .optional()
        .describe(
          'Opaque cursor for the next page. Omitted on the last page (do not treat absent as null).',
        ),
    })
    .describe('Text-search results.');

  const jsonlogicBranch = z
    .object({
      mode: z.literal('jsonlogic').describe('Echoed mode.'),
      hits: z
        .array(StructuredHitSchema)
        .describe('Matching files with the JSONLogic result per file.'),
      totalCount: z
        .number()
        .describe('Total post-path-policy hit count across all pages, before pagination.'),
      nextCursor: z
        .string()
        .optional()
        .describe(
          'Opaque cursor for the next page. Omitted on the last page (do not treat absent as null).',
        ),
    })
    .describe('JSONLogic results.');

  const omnisearchBranch = z
    .object({
      mode: z.literal('omnisearch').describe('Echoed mode.'),
      hits: z.array(OmnisearchHitSchema).describe('BM25-ranked matching files.'),
      totalCount: z
        .number()
        .describe('Total post-path-policy hit count across all pages, before pagination.'),
      nextCursor: z
        .string()
        .optional()
        .describe(
          'Opaque cursor for the next page. Omitted on the last page (do not treat absent as null).',
        ),
      truncated: z
        .boolean()
        .describe(
          "True when the upstream returned exactly 50 raw hits (Omnisearch's hardwired cap); more matches may exist that are not retrievable. Narrow the query to surface additional results.",
        ),
    })
    .describe('Omnisearch BM25 results.');

  const branches = omnisearchReachable
    ? ([textBranch, jsonlogicBranch, omnisearchBranch] as const)
    : ([textBranch, jsonlogicBranch] as const);

  const outputSchema = z.object({
    result: z
      .discriminatedUnion('mode', [...branches])
      .describe('Mode-discriminated search payload.'),
  });

  /**
   * Declared inline as a `const` tuple so `tool()`'s `const TErrors` generic
   * captures the literal reason strings — that's what gives the handler its
   * typed `ctx.fail<'reason'>(...)`. The `omnisearch_unreachable` entry is
   * declared unconditionally even when `omnisearchReachable` is false; the
   * branch that throws it only runs in the omnisearch handler path (which
   * only runs when reachable), so the entry is harmless when unused and
   * keeps the contract shape stable across deployments.
   */
  const errors = [
    {
      reason: 'path_prefix_invalid_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: '`pathPrefix` was provided in a non-text mode (only `text` supports prefix filtering).',
      recovery: 'Drop pathPrefix or switch mode to text for prefix filtering.',
    },
    {
      reason: 'query_required',
      code: JsonRpcErrorCode.ValidationError,
      when: '`query` is missing for `text` or `omnisearch` mode (required for both).',
      recovery:
        'Pass `query` — substring for text mode, or BM25 query syntax (quoted phrases, `-exclusion`, `path:` / `ext:` filters) for omnisearch.',
    },
    {
      reason: 'logic_required',
      code: JsonRpcErrorCode.ValidationError,
      when: '`logic` is missing for `jsonlogic` mode.',
      recovery:
        'Pass a JSONLogic tree as `logic`, e.g. `{"glob": [{"var": "path"}, "Projects/*.md"]}`.',
    },
    {
      reason: 'omnisearch_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Omnisearch was reachable at startup but is now unreachable (Obsidian quit, plugin disabled, or mobile session).',
      retryable: true,
      recovery:
        'Restart Obsidian with the Omnisearch plugin enabled, then restart this MCP server so it re-probes the plugin URL.',
    },
  ] as const;

  return tool('obsidian_search_notes', {
    description,
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: inputSchema,
    output: outputSchema,
    auth: ['tool:obsidian_search_notes:read'],
    errors,

    async handler(input, ctx) {
      const svc = getObsidianService();

      if (input.pathPrefix && input.mode !== 'text') {
        throw ctx.fail('path_prefix_invalid_mode', '`pathPrefix` is only valid in text mode.', {
          mode: input.mode,
          ...ctx.recoveryFor('path_prefix_invalid_mode'),
        });
      }

      const policy = svc.policy;

      if (input.mode === 'text') {
        if (!input.query) {
          throw ctx.fail('query_required', '`query` is required for text mode.', {
            mode: input.mode,
            ...ctx.recoveryFor('query_required'),
          });
        }
        const raw = await svc.searchText(ctx, input.query, input.contextLength);
        const prefix = input.pathPrefix;
        const prefixed = prefix ? raw.filter((h) => h.filename.startsWith(prefix)) : raw;
        const allowed = policy.filterReadable(prefixed);
        const clipped = allowed.map((h) => clipMatches(h, input.maxMatchesPerHit));
        return { result: { mode: 'text' as const, ...paginate(clipped, input.cursor, ctx) } };
      }

      if (input.mode === 'jsonlogic') {
        if (!input.logic) {
          throw ctx.fail(
            'logic_required',
            '`logic` (JSONLogic tree) is required for jsonlogic mode.',
            { mode: input.mode, ...ctx.recoveryFor('logic_required') },
          );
        }
        const raw = await svc.searchJsonLogic(ctx, input.logic);
        const allowed = policy.filterReadable(raw);
        return { result: { mode: 'jsonlogic' as const, ...paginate(allowed, input.cursor, ctx) } };
      }

      // omnisearch — only reachable when omnisearchReachable is true at build time.
      if (!input.query) {
        throw ctx.fail('query_required', '`query` is required for omnisearch mode.', {
          mode: input.mode,
          ...ctx.recoveryFor('query_required'),
        });
      }
      const raw = await svc.searchOmnisearch(ctx, input.query);
      /**
       * Compute `truncated` against the raw upstream array, before path-policy
       * filtering — a filtered-down set legitimately under 50 should not be
       * reported as truncated.
       */
      const truncated = raw.length >= OMNISEARCH_UPSTREAM_CAP;
      const allowed = policy.filterReadable(raw);
      return {
        result: {
          mode: 'omnisearch' as const,
          ...paginate(allowed, input.cursor, ctx),
          truncated,
        },
      };
    },

    format: ({ result }) => {
      const lines: string[] = [];
      const pageInfo = `${result.hits.length} on this page · ${result.totalCount} total`;
      const cursorInfo = result.nextCursor ? ' · more available' : '';
      lines.push(`**Search (${result.mode}) — ${pageInfo}${cursorInfo}**`);
      if (result.mode === 'omnisearch' && result.truncated) {
        lines.push(
          `_Upstream returned the full ${OMNISEARCH_UPSTREAM_CAP}-hit cap; more matches may exist. Narrow the query to surface them._`,
        );
      }
      if (result.nextCursor) {
        lines.push(`_Next page cursor: \`${result.nextCursor}\`_`);
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
          const score = h.score !== undefined ? ` (score: ${h.score})` : '';
          const trunc = h.truncated
            ? ` — truncated, showing first ${h.matches.length} of ${h.totalMatches} matches`
            : '';
          lines.push(`### ${h.filename}${score}${trunc}`);
          for (const m of h.matches) {
            lines.push(`- match[${m.match.start}–${m.match.end}]: ${truncate(m.context, 240)}`);
          }
        }
      } else if (result.mode === 'omnisearch') {
        for (const h of result.hits) {
          lines.push(`### ${h.filename} (score: ${h.score.toFixed(2)})`);
          if (h.foundWords.length > 0) {
            lines.push(`**Matched:** ${h.foundWords.map((w) => `\`${w}\``).join(', ')}`);
          }
          if (h.excerpt) lines.push(`> ${h.excerpt.replace(/\n/g, '\n> ')}`);
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
}

/**
 * Static specimen for the MCP definition linter (which duck-types tool
 * exports out of each `.tool.ts` file) and for existing tests that import
 * the tool directly. Defaults to `omnisearchReachable: false` — the safe
 * baseline that doesn't assume the optional plugin is installed. The entry
 * point (`src/index.ts`) builds the live tool via `buildSearchNotesTool`
 * with the actual probe result; this export is not the registered tool.
 * The omnisearch-enabled variant is exercised by tests rather than the
 * linter (two exports under the same tool name would collide on
 * `name-unique`).
 */
export const obsidianSearchNotes = buildSearchNotesTool({ omnisearchReachable: false });

/**
 * Apply MCP-spec cursor pagination to a fully assembled, post-filter result
 * array. Returns the page's hits, the total pre-pagination count, and
 * `nextCursor` (omitted on the last page). Localizes the `Context` →
 * `RequestContext` cast — `paginateArray`'s signature requires the index-
 * signature shape that handler-facing `Context` doesn't carry.
 */
function paginate<T>(
  items: T[],
  cursor: string | undefined,
  ctx: Context,
): { hits: T[]; totalCount: number; nextCursor?: string } {
  const page = paginateArray(
    items,
    cursor,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    ctx as unknown as RequestContext,
  );
  return {
    hits: page.items,
    totalCount: page.totalCount ?? items.length,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  };
}

function clipMatches<T extends { matches: unknown[] }>(
  hit: T,
  cap: number,
): T & { truncated?: boolean; totalMatches?: number } {
  if (hit.matches.length <= cap) return hit;
  return {
    ...hit,
    matches: hit.matches.slice(0, cap),
    truncated: true,
    totalMatches: hit.matches.length,
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

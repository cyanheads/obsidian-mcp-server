/**
 * @fileoverview obsidian_search_notes — text/jsonlogic/omnisearch search with
 * MCP-spec cursor pagination. The `omnisearch` mode is offered only with reads
 * unscoped and the Omnisearch plugin's HTTP server answering at startup
 * (`omnisearchAvailability`). Text-mode hits carry match locations (the
 * service merges a multi-token query's per-token spans) and additionally clip
 * per file via `maxMatchesPerHit` so a single match-heavy note can't blow the
 * response budget — clipped hits carry `truncated: true` and `totalMatches`.
 * @module mcp-server/tools/definitions/obsidian-search-notes.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import {
  decodeCursor,
  encodeCursor,
  escapeMarkdownInline,
  markdown,
  paginateArray,
} from '@cyanheads/mcp-ts-core/utils';
import { getObsidianService, type ObsidianService } from '@/services/obsidian/obsidian-service.js';
import { inlineCode } from './_shared/markdown.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_MATCHES_PER_HIT = 10;
/** Omnisearch's hardwired upstream cap — pagination/limit params are ignored. */
const OMNISEARCH_UPSTREAM_CAP = 50;

/** Why an omnisearch result may be missing matches its 50-hit cap cut. */
const OMNISEARCH_TRUNCATIONS = {
  cap_reached: `Omnisearch returned its ${OMNISEARCH_UPSTREAM_CAP}-hit cap, so more matches may exist. Narrow with \`path:\`, \`ext:\`, or more plain terms, which Omnisearch applies before the cap.`,
  filtered_after_cap: `Omnisearch keeps its top ${OMNISEARCH_UPSTREAM_CAP} matches before it applies quoted terms and \`-exclusion\` terms, so matches past the cap were never checked. Narrow with \`path:\`, \`ext:\`, or more plain terms, which apply before the cap, or rerun without the quoted and excluded terms to see whether the cap was reached.`,
} as const;

type OmnisearchTruncation = keyof typeof OMNISEARCH_TRUNCATIONS;

/**
 * Whether `obsidian_search_notes` offers `omnisearch` mode: `offered` when
 * reads are unscoped and the plugin answered the startup probe,
 * `unreachable` when it did not answer, and `withheld` under
 * OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS, where the plugin is never
 * called. Omnisearch ranks and selects its results over the whole vault, so
 * every one of them depends on notes outside a read scope.
 */
export type OmnisearchAvailability = 'offered' | 'unreachable' | 'withheld';

/**
 * Decide {@link OmnisearchAvailability} once, at startup. Under a read scope
 * it is `withheld` with no request, the probe included; otherwise the probe
 * decides.
 */
export async function omnisearchAvailability(
  svc: ObsidianService,
): Promise<OmnisearchAvailability> {
  if (svc.policy.restrictsReads) return 'withheld';
  return (await svc.probeOmnisearch()) ? 'offered' : 'unreachable';
}

const CursorSchema = z
  .string()
  .optional()
  .describe(
    'Opaque cursor from a prior response. Omit for the first page. Page size is server-determined; do not assume a fixed value. Under OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS, later `text` and `jsonlogic` pages come from the hit list the first page computed.',
  );

const TextHitSchema = z
  .object({
    filename: z.string().describe('Vault-relative path of the matching note.'),
    matches: z
      .array(
        z
          .object({
            context: z.string().describe('Surrounding text around the location.'),
            match: z
              .object({
                start: z
                  .number()
                  .describe(
                    'Location start offset within the subject upstream matched — the note body in the usual case, or the note basename (extension stripped) when the filename itself matched, in which case `context` is that basename. This is not an offset into `context`; use `contextStart` for that. Note-body values index the same string `obsidian_get_note` returns.',
                  ),
                end: z
                  .number()
                  .describe('Location end offset within the same subject `start` indexes.'),
                contextStart: z
                  .number()
                  .describe(
                    'Location start offset within `context`. `context.slice(contextStart, contextEnd)` is the matched text, from the first matched token through the last.',
                  ),
                contextEnd: z.number().describe('Location end offset within `context`.'),
              })
              .describe(
                'Where the location sits, on two origins: `start`/`end` index the matched subject, `contextStart`/`contextEnd` index the accompanying `context` window.',
              ),
          })
          .describe(
            'A match location within a file: one token occurrence, or several query tokens close enough to share one context window (a phrase).',
          ),
      )
      .describe(
        'Match locations with their context windows, in document order. Capped per file by `maxMatchesPerHit`.',
      ),
    totalMatches: z
      .number()
      .optional()
      .describe(
        'Total match locations in this file. Present only when `matches` was clipped to `maxMatchesPerHit`.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when `matches` was clipped to `maxMatchesPerHit` locations. Use `obsidian_get_note` to read the full file when more context is needed.',
      ),
  })
  .describe('A file with one or more text-search match locations.');

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
    score: z
      .number()
      .describe(
        "Omnisearch's BM25 relevance score; higher is more relevant. `0` marks a note Omnisearch added because it embeds an earlier hit, which need not contain the query words.",
      ),
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
      .describe(
        'Match positions within the note body. Omnisearch locates them only for the first 10 hits it returns, so every later hit has none, and an earlier hit has none when the query words occur only in its basename.',
      ),
    excerpt: z
      .string()
      .describe(
        "Text from the note around its first match in `matches`; a hit with empty `matches` gets the note's opening instead. HTML entities are decoded and `<br>` becomes `\\n`.",
      ),
  })
  .describe('An Omnisearch BM25-ranked hit.');

/**
 * Build the `obsidian_search_notes` tool. The `omnisearch` mode is included
 * in the input/output schemas and the description only when `omnisearch` is
 * `offered`, so the LLM never sees it as an option on a deployment where it
 * can't run or is withheld. Re-probe requires a server restart.
 */
export function buildSearchNotesTool({ omnisearch }: { omnisearch: OmnisearchAvailability }) {
  const omnisearchOffered = omnisearch === 'offered';
  const modeEnum = omnisearchOffered
    ? (['text', 'jsonlogic', 'omnisearch'] as const)
    : (['text', 'jsonlogic'] as const);

  const description = omnisearchOffered
    ? 'Search the vault by text tokens, JSONLogic predicate, or BM25-ranked Omnisearch query. Pick the mode that matches the query shape — `omnisearch` is best for ranked relevance, typo tolerance, and PDF/OCR coverage (via the Text Extractor plugin). Results paginate via opaque cursors: omit `cursor` for the first page, then pass `nextCursor` from the prior response. Text-mode hits additionally clip per file at `maxMatchesPerHit` match locations.'
    : 'Search the vault by text tokens or JSONLogic predicate. Pick the mode that matches the query shape. Results paginate via opaque cursors: omit `cursor` for the first page, then pass `nextCursor` from the prior response. Text-mode hits additionally clip per file at `maxMatchesPerHit` match locations.';

  const textModeDescription =
    '`text` splits `query` on spaces and requires every token, each matched case-insensitively as a substring of the filename or note body; a tab or line break stays part of its token. Quotes are literal characters, not a phrase operator. Each hit returns match locations with surrounding context windows; tokens that sit close together, such as the words of a phrase, share one location.';

  const jsonlogicModeDescription =
    '`jsonlogic` evaluates a JSONLogic tree against each note, with `var` paths into `path`, `content`, `frontmatter.<key>`, `tags`, `stat.{ctime,mtime,size}`, and `links`, `backlinks`, and `unresolvedLinks` (on plugin versions that provide them; not under OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS, where a tree that reads them is rejected), plus `glob` and `regexp` operators — both take their arguments as `[PATTERN, VALUE]`, so the pattern comes first and the `{"var": ...}` reference second.';

  const inputSchema = z.object({
    mode: z
      .enum(modeEnum)
      .describe(
        omnisearchOffered
          ? `Which search algorithm to run. ${textModeDescription} ${jsonlogicModeDescription} \`omnisearch\` runs a BM25-ranked query via the Omnisearch plugin — supports quoted phrases, \`-exclusion\`, \`path:\` / \`ext:\` filters, typo tolerance, and PDF/OCR (with Text Extractor). Omnisearch keeps its top ${OMNISEARCH_UPSTREAM_CAP} matches, applying \`path:\` and \`ext:\` before that cap and quoted phrases and \`-exclusion\` after the cap (see \`truncated\`).`
          : `Which search algorithm to run. ${textModeDescription} ${jsonlogicModeDescription}`,
      ),
    query: z
      .string()
      .optional()
      .describe(
        'The query string. Required in every mode but `jsonlogic`, which ignores it (use `logic` instead — this field must be a string, so passing a JSONLogic tree here is rejected). In `text` mode it is split on spaces and every token must appear; quotes stay part of the tokens, so a quoted phrase matches nothing unless the note contains the quote characters.',
      ),
    logic: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'JSONLogic tree. Required for `jsonlogic` mode and ignored in every other (use `query` instead — this field must be an object, so passing a string here is rejected). `glob` and `regexp` take `[PATTERN, VALUE]` — pattern first: `{"glob": ["Projects/*.md", {"var": "path"}]}`. Backlinks ("what links here") have no dedicated tool; find them this way: `{"regexp": ["\\\\[\\\\[Target Note(\\\\\\\\?\\\\||#|\\\\]\\\\])", {"var": "content"}]}` finds every readable note whose body wikilinks or embeds `Target Note`, in plain, aliased (`|`, or the table-safe `\\|`), or section form. `obsidian_get_note` with `includeLinks: true` covers the outgoing direction.',
      ),
    contextLength: z
      .number()
      .int()
      .positive()
      .default(100)
      .describe(
        'Characters of context on each side of a match location (text mode only). Sizes the rendered text as well as the structured payload, so a wide window multiplies the response across every location on the page. Query tokens within 2 × `contextLength` of each other share a location.',
      ),
    pathPrefix: z
      .string()
      .optional()
      .describe(
        'Filter returned filenames by prefix (text mode only, applied after matching — does not narrow the search itself).',
      ),
    maxMatchesPerHit: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MATCHES_PER_HIT)
      .describe(
        'Cap on match locations returned per file in text mode. A phrase whose tokens share one location counts once. When clipped, the hit carries `truncated: true` and `totalMatches`.',
      ),
    cursor: CursorSchema,
  });

  const textBranch = z
    .object({
      mode: z.literal('text').describe('Echoed mode.'),
      hits: z.array(TextHitSchema).describe('Matching files with their match locations.'),
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
          `True whenever Omnisearch's ${OMNISEARCH_UPSTREAM_CAP}-hit cap may have cut matches that are not retrievable: when it returned ${OMNISEARCH_UPSTREAM_CAP} or more, and when the query holds quoted terms or \`-exclusion\` terms, which Omnisearch applies after its cap. Narrow with \`path:\`, \`ext:\`, or more plain terms, which Omnisearch applies before its cap.`,
        ),
      truncatedReason: z
        .enum(['cap_reached', 'filtered_after_cap'])
        .optional()
        .describe(
          'Why `truncated` is true, present only then: `cap_reached` (Omnisearch returned its cap) or `filtered_after_cap` (quoted or `-exclusion` terms filtered after the cap).',
        ),
    })
    .describe('Omnisearch BM25 results.');

  const branches = omnisearchOffered
    ? ([textBranch, jsonlogicBranch, omnisearchBranch] as const)
    : ([textBranch, jsonlogicBranch] as const);

  const outputSchema = z.object({
    result: z
      .discriminatedUnion('mode', [...branches])
      .describe('Mode-discriminated search payload.'),
  });

  /**
   * Thrown by the service on the omnisearch path alone, so declared only where
   * the mode is offered: `tools/list` renders every entry, and a withheld or
   * unreachable mode leaves nothing that names Omnisearch.
   */
  const omnisearchErrors = [
    {
      reason: 'omnisearch_unreachable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Omnisearch was reachable at startup but did not answer: it is unreachable (Obsidian quit, plugin disabled, or mobile session), answered with a non-2xx status, or took longer than OBSIDIAN_REQUEST_TIMEOUT_MS. One attempt, never retried.',
      retryable: true,
      recovery:
        'Confirm Obsidian is running with the Omnisearch plugin enabled and retry, or narrow the query if it was slow. If Omnisearch stays down, restart Obsidian, then restart this MCP server so it re-probes the plugin URL.',
    },
  ] as const;

  /**
   * Declared inline as a `const` tuple so `tool()`'s `const TErrors` generic
   * captures the literal reason strings — that's what gives the handler its
   * typed `ctx.fail<'reason'>(...)`.
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
      when: '`query` is missing in a mode that requires it: every mode but `jsonlogic`.',
      recovery: omnisearchOffered
        ? 'Pass `query` — space-separated tokens, all required, for text mode, or BM25 query syntax (quoted phrases, `-exclusion`, `path:` / `ext:` filters) for omnisearch.'
        : 'Pass `query` as space-separated tokens, all of which a note must contain.',
    },
    {
      reason: 'context_length_too_large',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: "The matches would make a response longer than one can be, so the whole text search failed: the Local REST API runs out of string capacity serializing them, or, under OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS, the readable notes' matches alone would pass the same ceiling. Each match costs its context window plus about 150 characters of offsets and framing.",
      recovery:
        'Narrow the query so fewer notes match, and drop very common tokens: every occurrence of each token in a matching note is a match costing about 150 characters beside its window, so a token like `the` can fail even at `contextLength` 0. Lowering `contextLength` helps only while the windows, about twice `contextLength` each, dominate that cost.',
    },
    {
      reason: 'logic_required',
      code: JsonRpcErrorCode.ValidationError,
      when: '`logic` is missing for `jsonlogic` mode.',
      recovery:
        'Pass a JSONLogic tree as `logic`. `glob` and `regexp` take `[PATTERN, VALUE]` — pattern first, e.g. `{"glob": ["Projects/*.md", {"var": "path"}]}`.',
    },
    {
      reason: 'logic_invalid',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The JSONLogic tree failed to evaluate against a note — an unrecognized operator, or an operand that could not be evaluated (an uncompilable `regexp` pattern). A mis-arity operator is not rejected: it evaluates to false and the search returns zero hits.',
      recovery:
        'Check the operator names and arity. `glob` and `regexp` take `[PATTERN, VALUE]` — pattern first, e.g. `{"regexp": ["^Inbox/", {"var": "path"}]}`; the reverse order compiles the note field as the pattern.',
    },
    {
      reason: 'logic_too_costly',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: "With OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS set, the server evaluates the JSONLogic tree itself, and the tree passed a bound: nesting deeper than 1,000 levels, more than a work budget, more than 10 s of evaluation, or more than 45 s for the whole search, reading the readable notes included. One work budget is per note — the size of values built by `merge`, `cat`, `map`, and array literals while evaluating that note, up to the note's own size plus 10,000,000 units — and one is per search: 10,000,000 units across every note for returned results, where a result whose JSON is at most 1,024 characters is free and a larger one pays for what it holds beyond its own note.",
      recovery:
        "Simplify the tree: nest fewer levels, avoid building arrays or strings many times a note's size with `merge`, `cat`, `map`, or `reduce`, return values drawn from the note rather than large built values or constants, and prefer a simpler `regexp` pattern.",
    },
    {
      reason: 'text_search_too_costly',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'With OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS set, the server runs text mode itself, reading every readable note whose path or body holds each token, and reading and matching them took more than 45 s.',
      recovery:
        'Add rarer tokens, which every candidate note must contain, so fewer readable notes are read, or ask the operator to narrow OBSIDIAN_READ_PATHS or extend OBSIDIAN_DENY_PATHS.',
    },
    {
      reason: 'link_fields_unavailable',
      thrownBy: 'service',
      code: JsonRpcErrorCode.ValidationError,
      when: 'With OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS set, the JSONLogic tree names `links`, `backlinks`, or `unresolvedLinks` by a fixed `var`, `missing`, or `missing_some` key. Scoped searches leave these fields out, since Obsidian resolves each link across the whole vault, notes outside the scope included; a computed key reads them as null.',
      recovery:
        'Find backlinks by body text: `{"regexp": ["\\\\[\\\\[Target Note(\\\\\\\\?\\\\||#|\\\\]\\\\])", {"var": "content"}]}` matches every readable note that wikilinks or embeds `Target Note`. For a note\'s outgoing links, call `obsidian_get_note` with `includeLinks: true`.',
    },
    {
      reason: 'note_too_deep',
      thrownBy: 'service',
      code: JsonRpcErrorCode.SerializationError,
      when: 'With OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS set, a readable note holds data, usually a frontmatter value, nested deeper than the server can hand to its evaluator (about 3,500 levels under Node, more under Bun).',
      recovery:
        'Flatten the deeply nested value, usually a frontmatter field, in the note the message names, or ask the operator to leave that note out of OBSIDIAN_READ_PATHS or add it to OBSIDIAN_DENY_PATHS; no scoped jsonlogic search runs while it is readable.',
    },
    ...(omnisearchOffered ? omnisearchErrors : []),
  ] as const;

  return tool('obsidian_search_notes', {
    description,
    annotations: { readOnlyHint: true, idempotentHint: true },
    input: inputSchema,
    output: outputSchema,
    // Agent-facing context on the success path — reaches structuredContent AND
    // content[] automatically; no format() entry needed.
    enrichment: {
      effectiveQuery: z
        .string()
        .optional()
        .describe('The query string as submitted (every mode but `jsonlogic`).'),
      notice: z.string().optional().describe('Recovery guidance when the search returned no hits.'),
    },
    auth: ['tool:obsidian_search_notes:read'],
    errors,

    async handler(input, ctx) {
      const svc = getObsidianService();

      if (input.pathPrefix && input.mode !== 'text') {
        throw ctx.fail('path_prefix_invalid_mode', '`pathPrefix` is only valid in text mode.', {
          mode: input.mode,
        });
      }

      const policy = svc.policy;

      if (input.mode === 'text') {
        if (!input.query) {
          throw ctx.fail('query_required', '`query` is required for text mode.', {
            mode: input.mode,
          });
        }
        ctx.enrich.echo(input.query);
        const prefix = input.pathPrefix;
        const searched = await svc.pageText(
          ctx,
          {
            query: input.query,
            contextLength: input.contextLength,
            maxMatchesPerHit: input.maxMatchesPerHit,
            pathPrefix: prefix,
          },
          ...cursorPage(input.cursor, ctx),
        );
        const allowed = policy.filterReadable(searched.hits);
        const page = paginate(allowed, input.cursor, ctx, searched.walk);
        if (page.hits.length === 0) {
          ctx.enrich.notice(
            `No matches for ${inlineCode(input.query)}${prefix ? ` under prefix ${inlineCode(prefix)}` : ''}. Try broader terms, a different mode, or check that the path/filter is correct.`,
          );
        }
        return { result: { mode: 'text' as const, ...page } };
      }

      if (input.mode === 'jsonlogic') {
        if (!input.logic) {
          throw ctx.fail(
            'logic_required',
            '`logic` (JSONLogic tree) is required for jsonlogic mode.',
            { mode: input.mode },
          );
        }
        const searched = await svc.pageJsonLogic(
          ctx,
          input.logic,
          ...cursorPage(input.cursor, ctx),
        );
        const allowed = policy.filterReadable(searched.hits);
        const page = paginate(allowed, input.cursor, ctx, searched.walk);
        if (page.hits.length === 0) {
          ctx.enrich.notice(
            'No matches for the JSONLogic predicate. Verify the logic tree and field references.',
          );
        }
        return { result: { mode: 'jsonlogic' as const, ...page } };
      }

      // omnisearch — in the schema only when the mode was offered at build time.
      if (!input.query) {
        throw ctx.fail('query_required', '`query` is required for omnisearch mode.', {
          mode: input.mode,
        });
      }
      ctx.enrich.echo(input.query);
      const raw = await svc.searchOmnisearch(ctx, input.query);
      const truncatedReason = omnisearchTruncation(input.query, raw.length);
      const allowed = policy.filterReadable(raw);
      const page = paginate(allowed, input.cursor, ctx);
      if (page.hits.length === 0) {
        ctx.enrich.notice(
          `No Omnisearch matches for ${inlineCode(input.query)}. Try broader terms, fewer exclusions, or switch to text mode.`,
        );
      }
      return {
        result: {
          mode: 'omnisearch' as const,
          ...page,
          truncated: truncatedReason !== undefined,
          ...(truncatedReason ? { truncatedReason } : {}),
        },
      };
    },

    format: ({ result }) => {
      const lines: string[] = [];
      const pageInfo = `${result.hits.length} on this page · ${result.totalCount} total`;
      const cursorInfo = result.nextCursor ? ' · more available' : '';
      lines.push(`**Search (${result.mode}) — ${pageInfo}${cursorInfo}**`);
      if (result.mode === 'omnisearch' && result.truncatedReason) {
        lines.push(
          `_Truncated (${result.truncatedReason}): ${OMNISEARCH_TRUNCATIONS[result.truncatedReason]}_`,
        );
      }
      if (result.nextCursor) {
        lines.push(`_Next page cursor: ${inlineCode(result.nextCursor)}_`);
      }
      lines.push('');
      if (result.mode === 'text') {
        for (const h of result.hits) {
          const trunc = h.truncated
            ? ` — truncated, showing first ${h.matches.length} of ${h.totalMatches} locations`
            : '';
          lines.push(`### ${escapeMarkdownInline(h.filename)}${trunc}`);
          for (const m of h.matches) {
            lines.push(
              `match at context[${m.match.contextStart}–${m.match.contextEnd}] · subject[${m.match.start}–${m.match.end}]`,
            );
            lines.push(fenced(m.context));
          }
        }
      } else if (result.mode === 'omnisearch') {
        for (const h of result.hits) {
          lines.push(`### ${escapeMarkdownInline(h.filename)} (score: ${h.score.toFixed(2)})`);
          if (h.foundWords.length > 0) {
            lines.push(`**Matched:** ${h.foundWords.map((w) => inlineCode(w)).join(', ')}`);
          }
          if (h.matches.length > 0) {
            lines.push(
              `**Offsets:** ${h.matches.map((mm) => `${inlineCode(mm.match)} @ ${mm.offset}`).join(', ')}`,
            );
          }
          if (h.excerpt) lines.push(fenced(h.excerpt));
        }
      } else {
        for (const h of result.hits) {
          lines.push(`### ${escapeMarkdownInline(h.filename)}`);
          lines.push(`result:`);
          lines.push(fenced(safeJsonStringify(h.result), 'json'));
        }
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  });
}

/**
 * Static specimen for the MCP definition linter (which duck-types tool
 * exports out of each `.tool.ts` file) and for existing tests that import
 * the tool directly. Built without the `omnisearch` mode — the safe baseline
 * that doesn't assume the optional plugin is installed. The entry point
 * (`src/index.ts`) builds the live tool via `buildSearchNotesTool` with the
 * startup `omnisearchAvailability`; this export is not the registered tool.
 * The omnisearch-enabled variant is exercised by tests rather than the
 * linter (two exports under the same tool name would collide on
 * `name-unique`).
 */
export const obsidianSearchNotes = buildSearchNotesTool({ omnisearch: 'unreachable' });

/**
 * Apply MCP-spec cursor pagination to a fully assembled, post-filter result
 * array. Returns the page's hits, the total pre-pagination count, and
 * `nextCursor` (omitted on the last page), which carries `walk` when given.
 */
function paginate<T>(
  items: T[],
  cursor: string | undefined,
  ctx: Context,
  walk?: string,
): { hits: T[]; totalCount: number; nextCursor?: string } {
  const page = paginateArray(items, cursor, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, requestContext(ctx));
  const nextCursor =
    page.nextCursor !== undefined && walk !== undefined
      ? encodeCursor({ ...decodeCursor(page.nextCursor, requestContext(ctx)), walk })
      : page.nextCursor;
  return {
    hits: page.items,
    totalCount: page.totalCount ?? items.length,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

/**
 * The walk a cursor names, if any, and the index just past the page it asks
 * for, as `paginate` will slice it. A scoped search's cursor names the walk its
 * first page stored, so the later pages read that stored hit list instead of
 * searching again.
 */
function cursorPage(
  cursor: string | undefined,
  ctx: Context,
): [walk: string | undefined, pageEnd: number] {
  if (!cursor) return [undefined, DEFAULT_PAGE_SIZE];
  const { offset, limit, walk } = decodeCursor(cursor, requestContext(ctx));
  return [typeof walk === 'string' ? walk : undefined, offset + Math.min(limit, MAX_PAGE_SIZE)];
}

/**
 * The `Context` → `RequestContext` cast the cursor helpers need — their
 * signatures require the index-signature shape that handler-facing `Context`
 * doesn't carry.
 */
function requestContext(ctx: Context): RequestContext {
  return ctx as unknown as RequestContext;
}

/**
 * Why Omnisearch's 50-hit cap may have cut matches from a result, or
 * `undefined` when the result is complete: a full cap, or a query Omnisearch
 * filters after the cap (`filteredAfterCap`), leaves it unknown.
 */
function omnisearchTruncation(
  query: string,
  upstreamHits: number,
): OmnisearchTruncation | undefined {
  if (upstreamHits >= OMNISEARCH_UPSTREAM_CAP) return 'cap_reached';
  if (filteredAfterCap(query)) return 'filtered_after_cap';
  return;
}

/**
 * True when Omnisearch (1.31.0) may filter `query`'s results after its cap:
 * it applies quoted terms (any `"`, or a term opening with `'`, which its
 * parser reads as a quoted phrase) and `-exclusion` terms once it has kept
 * its top 50, while `path:`, `ext:`, and `-path:` apply before. Read
 * generously: a query that might be filtered after the cap counts as one that
 * is.
 */
function filteredAfterCap(query: string): boolean {
  if (query.includes('"')) return true;
  return query
    .split(/\s+/)
    .some(
      (term) =>
        term.startsWith("'") ||
        (term.length > 1 && term.startsWith('-') && !/^-(?:path|ext):/i.test(term)),
    );
}

/**
 * Wrap upstream-authored text in a code fence long enough that nothing inside
 * it can close the block.
 *
 * `content[]` is markdown the model reads as this tool's own output, and note
 * excerpts, Omnisearch excerpts, and JSONLogic payloads are all vault text the
 * server does not control — a heading, list marker, or fence inside one would
 * otherwise end the quoted region and have the remainder reparsed as document
 * structure. This is the single escaping boundary for all three: the payload
 * is emitted byte-for-byte (clipping it would put `content[]` back out of
 * parity with `structuredContent` — see #97) and only the delimiter around it
 * adapts, sized past the longest backtick run in the payload by the framework's
 * `MarkdownBuilder.codeBlock`.
 */
function fenced(body: string, lang = 'text'): string {
  return markdown().codeBlock(body, lang).build();
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

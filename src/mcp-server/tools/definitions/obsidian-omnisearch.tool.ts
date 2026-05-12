/**
 * @fileoverview obsidian_omnisearch — fast indexed full-text search backed by
 * the Omnisearch community plugin's HTTP server. Much faster than
 * `obsidian_search_notes` on large vaults and returns Omnisearch's relevance
 * scoring, matched-word lists, and excerpts. Path-policy gating reuses the
 * shared `PathPolicy` so OBSIDIAN_READ_PATHS / OBSIDIAN_READ_ONLY apply
 * uniformly with other read tools. Caps results at 100 hits with an
 * `excluded` indicator and clips per-file matches via `maxMatchesPerFile`.
 * @module mcp-server/tools/definitions/obsidian-omnisearch.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import {
  getOmnisearchService,
  type OmnisearchHit,
} from '@/services/omnisearch/omnisearch-service.js';

const HIT_CAP = 100;
const DEFAULT_MATCHES_PER_FILE = 5;
const EXCLUSION_HINT =
  'Narrow your query (more specific terms or a `pathPrefix`) to surface the rest.';

const OmnisearchMatchSchema = z
  .object({
    match: z.string().describe('The matched token as it appears in the note.'),
    offset: z.number().describe('Character offset of the match in the source file.'),
  })
  .describe('A single Omnisearch token match within a file.');

const OmnisearchHitSchema = z
  .object({
    path: z.string().describe('Vault-relative path of the matching note.'),
    basename: z.string().describe('Filename without extension.'),
    score: z.number().describe('Omnisearch relevance score — higher is more relevant.'),
    foundWords: z
      .array(z.string())
      .describe('Distinct query tokens Omnisearch matched in this file.'),
    matches: z
      .array(OmnisearchMatchSchema)
      .describe(
        'Per-token match offsets in the file. Capped per file by `maxMatchesPerFile`; empty when the cap is 0.',
      ),
    excerpt: z
      .string()
      .optional()
      .describe('Short snippet of surrounding text Omnisearch produced for preview.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when `matches` was clipped to `maxMatchesPerFile`.'),
    totalMatches: z
      .number()
      .optional()
      .describe('Total match count in this file before clipping. Present only when `truncated`.'),
  })
  .describe('A single Omnisearch hit.');

export const obsidianOmnisearch = tool('obsidian_omnisearch', {
  description: `Fast indexed full-text search across the vault using the Obsidian Omnisearch community plugin's HTTP server. Supports fuzzy matching, tokenization, and multi-word queries (default AND semantics). Returns hits sorted by Omnisearch relevance score along with matched-word lists and excerpts. Much faster than \`obsidian_search_notes\` on large vaults — prefer it for keyword discovery. Requires the Omnisearch plugin with its HTTP server enabled in Obsidian. Results cap at ${HIT_CAP} hits with an \`excluded\` indicator; per-file matches clip at \`maxMatchesPerFile\`.`,
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Search query. Omnisearch tokenizes and fuzzy-matches; multiple words combine with AND by default. Prefix with `+` for required, `-` to exclude (per the plugin syntax).',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(HIT_CAP)
      .default(20)
      .describe(`Maximum hits to return (1-${HIT_CAP}). Defaults to 20.`),
    maxMatchesPerFile: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(DEFAULT_MATCHES_PER_FILE)
      .describe(
        `Cap on match offsets returned per file (0-50). Set to 0 to drop the \`matches\` arrays entirely and keep only score + excerpt. Defaults to ${DEFAULT_MATCHES_PER_FILE}.`,
      ),
    pathPrefix: z
      .string()
      .optional()
      .describe(
        "Optional vault-relative path prefix filter (e.g. 'Papers/'). Applied client-side after Omnisearch returns hits. Trailing slash is normalized.",
      ),
  }),
  output: z.object({
    hits: z.array(OmnisearchHitSchema).describe('Matching files, ordered by Omnisearch score.'),
    excluded: z
      .object({
        count: z.number().describe('Hits dropped because the cap was reached.'),
        hint: z.string().describe('Suggestion for narrowing the query.'),
      })
      .optional()
      .describe('Present when results were truncated to the cap.'),
    totalUpstream: z
      .number()
      .describe('Total hits Omnisearch returned upstream, before path-policy and prefix filters.'),
  }),
  auth: ['tool:obsidian_omnisearch:read'],
  errors: [
    {
      reason: 'omnisearch_unreachable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Omnisearch HTTP server did not respond or returned a 5xx error.',
      retryable: true,
      recovery:
        'Confirm Obsidian is running with the Omnisearch plugin installed and its HTTP server enabled, then verify OBSIDIAN_OMNISEARCH_BASE_URL matches the plugin port.',
    },
  ],

  async handler(input, ctx) {
    const omni = getOmnisearchService();
    const policy = getObsidianService().policy;

    const upstream = await omni.search(ctx, input.query);
    const totalUpstream = upstream.length;

    const prefixRaw = input.pathPrefix;
    const prefix = prefixRaw ? `${prefixRaw.replace(/^\/+|\/+$/g, '')}/` : '';
    const prefixed = prefix ? upstream.filter((h) => h.path.startsWith(prefix)) : upstream;

    /**
     * Path-policy post-filter: reads outside OBSIDIAN_READ_PATHS are dropped
     * silently, matching the behavior of `obsidian_search_notes`. The
     * `excluded` indicator only counts hits trimmed by the response cap so
     * the policy denial count never leaks back to the caller.
     */
    const allowed = prefixed.filter((h) => policy.isReadable(h.path));

    const limited = allowed.slice(0, Math.min(input.limit, HIT_CAP));
    const excluded =
      allowed.length > limited.length
        ? { count: allowed.length - limited.length, hint: EXCLUSION_HINT }
        : undefined;

    const cap = input.maxMatchesPerFile;
    const hits = limited.map((h) => clipMatches(h, cap));

    return { hits, excluded, totalUpstream };
  },

  format: (result) => {
    const lines: string[] = [
      `**Omnisearch — ${result.hits.length} hits (upstream: ${result.totalUpstream})**`,
    ];
    if (result.excluded) {
      lines.push(`_Excluded ${result.excluded.count} additional hits — ${result.excluded.hint}_`);
    }
    if (result.hits.length === 0) {
      lines.push(
        '',
        '_No matches. Try broader terms, drop `pathPrefix`, or confirm the Omnisearch plugin has indexed the vault._',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push('');
    for (const h of result.hits) {
      const truncFlag = h.truncated === true;
      const trunc = truncFlag
        ? ` — truncated, showing first ${h.matches.length} of ${h.totalMatches} matches`
        : '';
      lines.push(`### ${h.path} (score: ${h.score.toFixed(2)})${trunc}`);
      lines.push(`- basename: \`${h.basename}\``);
      if (h.foundWords.length > 0) {
        lines.push(`- matched: ${h.foundWords.map((w) => `\`${w}\``).join(', ')}`);
      }
      if (h.excerpt) {
        lines.push(`- excerpt: ${truncate(h.excerpt, 240)}`);
      }
      for (const m of h.matches) {
        lines.push(`  - \`${m.match}\` @ ${m.offset}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function clipMatches(
  hit: OmnisearchHit,
  cap: number,
): OmnisearchHit & { truncated?: boolean; totalMatches?: number } {
  if (cap === 0) return { ...hit, matches: [] };
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

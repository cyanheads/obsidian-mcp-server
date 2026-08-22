/**
 * @fileoverview obsidian_list_tags — the most-used tags in the vault, with usage counts.
 * Wraps the plugin's `/tags/` endpoint, then shapes it for an LLM caller: `nameRegex`
 * and `minCount` narrow the candidate set, the survivors are ordered by usage, and
 * `limit` keeps the exploratory zero-argument call bounded on a vault with a long
 * single-use tail. The `obsidian://tags` resource wraps the same endpoint but keeps
 * snapshot semantics — unsorted, uncapped — so the two surfaces differ by design.
 * @module mcp-server/tools/definitions/obsidian-list-tags.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { nameRegexSafetyIssue } from './_shared/regex-safety.js';

/** Bounded so the first exploratory call cannot return the whole tag distribution. */
const DEFAULT_TAG_LIMIT = 200;
/**
 * Set far above any plausible vault's tag cardinality so "give me everything" is
 * reachable by asking for a number, with no `0`-means-uncapped sentinel — to a
 * model reading the schema, `0` reads as "return none".
 */
const MAX_TAG_LIMIT = 10_000;

export const obsidianListTags = tool('obsidian_list_tags', {
  description: `List the vault's tags with usage counts, ordered by count descending and capped at \`limit\` (default ${DEFAULT_TAG_LIMIT}) — the response says so when it withheld any. Includes hierarchical parents: \`work/tasks\` contributes to both \`work\` and \`work/tasks\`. Narrow with \`nameRegex\` for a known prefix or \`minCount\` to drop the single-use tail. To find notes by tag, use \`obsidian_search_notes\` in jsonlogic mode (e.g. \`{"in": ["work", {"var": "tags"}]}\`).`,
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    nameRegex: z
      .string()
      .optional()
      .describe(
        'Optional ECMAScript regex (no flags, ≤256 chars, no nested quantifiers like `(a+)+`) matched against the bare tag name (no leading `#`). Hierarchical tags like `work/tasks` are matched as the full string. Use character classes (`[Mm]cp`) for case-insensitivity.',
      ),
    minCount: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Keep only tags used at least this many times. Omit (or pass 0) for no filter. On a vault with a long single-use tail this drops it in one argument.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TAG_LIMIT)
      .default(DEFAULT_TAG_LIMIT)
      .describe(
        `Maximum tags to return, applied after \`nameRegex\` and \`minCount\` and after ordering by count descending, so the cap keeps the most-used. Max ${MAX_TAG_LIMIT} — high enough to return any real vault whole. When the cap bites, the response reports \`truncated\`, \`shown\`, and \`cap\`.`,
      ),
  }),
  output: z.object({
    tags: z
      .array(
        z
          .object({
            name: z.string().describe('Tag name without the leading `#`.'),
            count: z.number().describe('Usage count across the vault.'),
          })
          .describe('A tag with its usage count.'),
      )
      .describe(
        'Matching tags ordered by `count` descending, ties broken by name ascending, truncated to `appliedFilters.limit`.',
      ),
    appliedFilters: z
      .object({
        nameRegex: z.string().optional().describe('nameRegex filter applied to this listing.'),
        minCount: z
          .number()
          .optional()
          .describe('minCount filter applied to this listing. Absent when none was supplied.'),
        limit: z.number().describe('Cap applied to this listing.'),
      })
      .describe('Filters and cap that produced this listing.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no tags matched the applied filters, when the vault has no tags, or — since `ctx.enrich.truncated` routes its guidance here — when the cap withheld some.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more tags matched the filters than `limit` allowed through.'),
    shown: z.number().optional().describe('Number of tags returned.'),
    cap: z.number().optional().describe('The `limit` that was applied.'),
  },
  auth: ['tool:obsidian_list_tags:read'],
  errors: [
    {
      reason: 'regex_invalid',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is not a valid ECMAScript regex.',
      recovery:
        'Use a valid ECMAScript regex (e.g. `^mcp/.*`), or omit nameRegex to disable filtering.',
    },
    {
      reason: 'regex_unsafe',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The supplied `nameRegex` is well-formed but exceeds the 256-character limit or contains nested quantifiers known to cause catastrophic backtracking.',
      recovery:
        'Avoid nested quantifiers like `(a+)+` or `(.*)*`. Use a simpler pattern (e.g. `^mcp/.*`), or omit nameRegex to disable filtering.',
    },
  ],

  async handler(input, ctx) {
    let regex: RegExp | undefined;
    if (input.nameRegex) {
      const safetyIssue = nameRegexSafetyIssue(input.nameRegex);
      if (safetyIssue) {
        throw ctx.fail('regex_unsafe', `Unsafe nameRegex: ${safetyIssue}`, {
          nameRegex: input.nameRegex,
          ...ctx.recoveryFor('regex_unsafe'),
        });
      }
      try {
        regex = new RegExp(input.nameRegex);
      } catch (err) {
        throw ctx.fail(
          'regex_invalid',
          `Invalid nameRegex: ${(err as Error).message}`,
          { nameRegex: input.nameRegex, ...ctx.recoveryFor('regex_invalid') },
          { cause: err },
        );
      }
    }

    const svc = getObsidianService();
    const minCount = input.minCount ?? 0;

    /**
     * Order is load-bearing: narrow, then rank, then cap. Truncation is
     * measured against the post-filter candidate count — reporting the raw
     * vault total would describe tags `minCount` had already excluded as
     * things the cap withheld.
     */
    const candidates = (await svc.listTags(ctx))
      .filter((t) => (regex ? regex.test(t.name) : true))
      .filter((t) => t.count >= minCount)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const tags = candidates.slice(0, input.limit).map((t) => ({ name: t.name, count: t.count }));

    const appliedFilters = {
      ...(input.nameRegex ? { nameRegex: input.nameRegex } : {}),
      ...(minCount > 0 ? { minCount } : {}),
      limit: input.limit,
    };

    if (candidates.length === 0) {
      /**
       * Keyed on the narrowing filters only. `limit` is always present and
       * never causes an empty result, so folding it in here would make the
       * "this vault has no tags at all" case unreachable.
       */
      const narrowing = describeFilters({ ...appliedFilters, limit: undefined });
      ctx.enrich.notice(
        narrowing
          ? `No tags matched ${narrowing}. Loosen or drop the filters to widen the listing.`
          : 'No tags found. The vault may have no tagged notes.',
      );
    } else if (candidates.length > input.limit) {
      ctx.enrich.truncated({
        shown: tags.length,
        cap: input.limit,
        guidance: `Showing the ${tags.length} most-used of ${candidates.length} matching tags. Raise \`limit\` (max ${MAX_TAG_LIMIT}) for more, or narrow with \`nameRegex\` / \`minCount\`.`,
      });
    }

    return { tags, appliedFilters };
  },

  format: (result) => {
    const suffix = describeFilters(result.appliedFilters);
    const lines = [`**${result.tags.length} tags**${suffix ? ` · ${suffix}` : ''}`];
    if (result.tags.length > 0) {
      lines.push('');
      for (const t of result.tags) lines.push(`- \`#${t.name}\` (${t.count})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** Human-readable echo of the filters and cap behind a listing. */
function describeFilters(filters: {
  nameRegex?: string | undefined;
  minCount?: number | undefined;
  limit?: number | undefined;
}): string {
  const parts: string[] = [];
  if (filters.nameRegex) parts.push(`nameRegex=\`${filters.nameRegex}\``);
  if (filters.minCount !== undefined) parts.push(`minCount=${filters.minCount}`);
  if (filters.limit !== undefined) parts.push(`limit=${filters.limit}`);
  return parts.join(' · ');
}

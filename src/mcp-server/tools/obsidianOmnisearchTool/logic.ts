import { z } from "zod";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  OmnisearchHit,
  OmnisearchService,
} from "../../../services/omnisearch/index.js";
import {
  logger,
  RequestContext,
  sanitizeInputForLogging,
} from "../../../utils/index.js";

const ObsidianOmnisearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        "Search query. Omnisearch supports fuzzy matching, tokenization, and multi-word queries with default AND semantics.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .default(20)
      .describe(
        "Maximum number of results to return (1-200). Defaults to 20.",
      ),
    maxMatchesPerFile: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(5)
      .describe(
        "Maximum match offsets to return per file. 0 drops match arrays entirely. Defaults to 5.",
      ),
    searchInPath: z
      .string()
      .optional()
      .describe(
        "Optional vault-relative path prefix to filter results by (e.g. 'papers/'). Applied client-side after Omnisearch returns hits.",
      ),
  })
  .describe(
    "Performs fast indexed full-text search across the Obsidian vault using the Omnisearch plugin's HTTP API. Supports fuzzy matching and tokenization. Much faster than obsidian_global_search for large vaults.",
  );

export const ObsidianOmnisearchInputSchemaShape =
  ObsidianOmnisearchInputSchema.shape;
export type ObsidianOmnisearchInput = z.infer<
  typeof ObsidianOmnisearchInputSchema
>;

export interface ObsidianOmnisearchResult {
  path: string;
  basename: string;
  score: number;
  foundWords: string[];
  matches: { match: string; offset: number }[];
  excerpt?: string;
}

export interface ObsidianOmnisearchResponse {
  success: boolean;
  message: string;
  query: string;
  totalHits: number;
  returned: number;
  results: ObsidianOmnisearchResult[];
}

export async function processObsidianOmnisearch(
  params: ObsidianOmnisearchInput,
  context: RequestContext,
  omnisearchService: OmnisearchService,
): Promise<ObsidianOmnisearchResponse> {
  const operation = "processObsidianOmnisearch";
  const opContext = { ...context, operation };
  logger.info(
    `Processing obsidian_omnisearch: "${params.query}"`,
    { ...opContext, params: sanitizeInputForLogging(params) },
  );

  let hits: OmnisearchHit[];
  try {
    hits = await omnisearchService.search(params.query, opContext);
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE,
      `Omnisearch query failed: ${err instanceof Error ? err.message : String(err)}`,
      opContext,
    );
  }

  const pathPrefix = params.searchInPath
    ? params.searchInPath.replace(/^\/+|\/+$/g, "") + "/"
    : "";

  const filtered = pathPrefix
    ? hits.filter((h) => h.path.startsWith(pathPrefix))
    : hits;

  const totalHits = filtered.length;
  const limited = filtered.slice(0, params.limit);

  const results: ObsidianOmnisearchResult[] = limited.map((h) => ({
    path: h.path,
    basename: h.basename,
    score: h.score,
    foundWords: h.foundWords,
    matches: params.maxMatchesPerFile > 0
      ? h.matches.slice(0, params.maxMatchesPerFile)
      : [],
    excerpt: h.excerpt,
  }));

  const message = `Omnisearch returned ${hits.length} hits${
    pathPrefix ? ` (${totalHits} after path filter '${pathPrefix}')` : ""
  }. Returning ${results.length} result(s), limit ${params.limit}, max matches per file ${params.maxMatchesPerFile}.`;

  return {
    success: true,
    message,
    query: params.query,
    totalHits,
    returned: results.length,
    results,
  };
}

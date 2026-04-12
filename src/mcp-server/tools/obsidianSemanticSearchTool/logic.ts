import { z } from "zod";
import {
  SemanticHit,
  SmartConnectionsService,
} from "../../../services/smartConnections/index.js";
import {
  logger,
  RequestContext,
  sanitizeInputForLogging,
} from "../../../utils/index.js";

const ObsidianSemanticSearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        "Natural-language query. The server encodes it with the Smart Connections embedding model and returns notes whose stored vectors are most similar.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(10)
      .describe("Maximum number of results to return. Defaults to 10."),
    minSimilarity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.3)
      .describe(
        "Minimum cosine similarity threshold, 0-1. Defaults to 0.3. Lower returns more results; higher returns only tight matches.",
      ),
  })
  .describe(
    "Semantic search over the Obsidian vault using Smart Connections embeddings. Finds notes by meaning rather than exact keywords. Requires the Smart Connections community plugin with embeddings already generated.",
  );

export const ObsidianSemanticSearchInputSchemaShape =
  ObsidianSemanticSearchInputSchema.shape;
export type ObsidianSemanticSearchInput = z.infer<
  typeof ObsidianSemanticSearchInputSchema
>;

export interface ObsidianSemanticSearchResponse {
  success: boolean;
  message: string;
  query: string;
  returned: number;
  results: SemanticHit[];
}

export async function processObsidianSemanticSearch(
  params: ObsidianSemanticSearchInput,
  context: RequestContext,
  smartConnectionsService: SmartConnectionsService,
): Promise<ObsidianSemanticSearchResponse> {
  const operation = "processObsidianSemanticSearch";
  const opContext = { ...context, operation };
  logger.info(
    `Processing obsidian_semantic_search: "${params.query}"`,
    { ...opContext, params: sanitizeInputForLogging(params) },
  );

  const results = await smartConnectionsService.semanticSearch(
    params.query,
    params.limit,
    params.minSimilarity,
    opContext,
  );

  const stats = smartConnectionsService.stats();
  const message = `Semantic search returned ${results.length} result(s) over ${stats.sources} embedded source notes (minSimilarity ${params.minSimilarity}, limit ${params.limit}).`;

  return {
    success: true,
    message,
    query: params.query,
    returned: results.length,
    results,
  };
}

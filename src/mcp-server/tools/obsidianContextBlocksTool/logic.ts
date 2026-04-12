import { z } from "zod";
import {
  SemanticBlockHit,
  SmartConnectionsService,
} from "../../../services/smartConnections/index.js";
import {
  logger,
  RequestContext,
  sanitizeInputForLogging,
} from "../../../utils/index.js";

const ObsidianContextBlocksInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe(
        "Natural-language query describing what context you need. The server returns the most semantically relevant block-level chunks with their text, ideal for RAG.",
      ),
    maxBlocks: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .default(5)
      .describe("Maximum number of blocks to return. Defaults to 5."),
    minSimilarity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.4)
      .describe(
        "Minimum cosine similarity threshold. Defaults to 0.4 — higher than semantic_search because block-level embeddings are noisier.",
      ),
  })
  .describe(
    "Get the best block-level context for a query from Smart Connections embeddings. Returns actual text content suitable for RAG-style LLM context assembly.",
  );

export const ObsidianContextBlocksInputSchemaShape =
  ObsidianContextBlocksInputSchema.shape;
export type ObsidianContextBlocksInput = z.infer<
  typeof ObsidianContextBlocksInputSchema
>;

export interface ObsidianContextBlocksResponse {
  success: boolean;
  message: string;
  query: string;
  returned: number;
  blocks: SemanticBlockHit[];
}

export async function processObsidianContextBlocks(
  params: ObsidianContextBlocksInput,
  context: RequestContext,
  smartConnectionsService: SmartConnectionsService,
): Promise<ObsidianContextBlocksResponse> {
  const operation = "processObsidianContextBlocks";
  const opContext = { ...context, operation };
  logger.info(
    `Processing obsidian_context_blocks: "${params.query}"`,
    { ...opContext, params: sanitizeInputForLogging(params) },
  );

  const blocks = await smartConnectionsService.getContextBlocks(
    params.query,
    params.maxBlocks,
    params.minSimilarity,
    opContext,
  );

  const stats = smartConnectionsService.stats();
  return {
    success: true,
    message: `Returned ${blocks.length} block(s) over ${stats.blocks} embedded blocks (minSimilarity ${params.minSimilarity}, maxBlocks ${params.maxBlocks}).`,
    query: params.query,
    returned: blocks.length,
    blocks,
  };
}

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

const ObsidianFindRelatedInputSchema = z
  .object({
    filePath: z
      .string()
      .min(1)
      .describe(
        "Vault-relative path of the source note (e.g. 'papers/2603.16417.md'). The file must have been embedded by Smart Connections.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(10)
      .describe("Maximum number of related notes to return. Defaults to 10."),
  })
  .describe(
    "Find notes semantically related to a specific source note, using Smart Connections embeddings. Equivalent to the Smart Connections sidebar's 'related notes' view.",
  );

export const ObsidianFindRelatedInputSchemaShape =
  ObsidianFindRelatedInputSchema.shape;
export type ObsidianFindRelatedInput = z.infer<
  typeof ObsidianFindRelatedInputSchema
>;

export interface ObsidianFindRelatedResponse {
  success: boolean;
  message: string;
  sourceFile: string;
  returned: number;
  results: SemanticHit[];
}

export async function processObsidianFindRelated(
  params: ObsidianFindRelatedInput,
  context: RequestContext,
  smartConnectionsService: SmartConnectionsService,
): Promise<ObsidianFindRelatedResponse> {
  const operation = "processObsidianFindRelated";
  const opContext = { ...context, operation };
  logger.info(
    `Processing obsidian_find_related: "${params.filePath}"`,
    { ...opContext, params: sanitizeInputForLogging(params) },
  );

  const results = await smartConnectionsService.findRelated(
    params.filePath,
    params.limit,
    opContext,
  );

  return {
    success: true,
    message: `Found ${results.length} related note(s) for '${params.filePath}'.`,
    sourceFile: params.filePath,
    returned: results.length,
    results,
  };
}

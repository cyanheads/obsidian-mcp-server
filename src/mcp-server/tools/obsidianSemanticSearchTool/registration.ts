import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SmartConnectionsService } from "../../../services/smartConnections/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import type {
  ObsidianSemanticSearchInput,
  ObsidianSemanticSearchResponse,
} from "./logic.js";
import {
  ObsidianSemanticSearchInputSchemaShape,
  processObsidianSemanticSearch,
} from "./logic.js";

export async function registerObsidianSemanticSearchTool(
  server: McpServer,
  smartConnectionsService: SmartConnectionsService,
): Promise<void> {
  const toolName = "obsidian_semantic_search";
  const toolDescription = `Semantic search across the Obsidian vault using Smart Connections embeddings. Finds notes by meaning, not exact keywords. Best for conceptual queries ("what have I written about attention mechanisms?") rather than lexical ones. Requires the Smart Connections community plugin to have generated embeddings first.`;

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianSemanticSearchTool",
      toolName,
      module: "ObsidianSemanticSearchRegistration",
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianSemanticSearchInputSchemaShape,
        async (params: ObsidianSemanticSearchInput): Promise<any> => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              operation: "HandleObsidianSemanticSearchRequest",
              toolName,
              paramsSummary: {
                query: params.query,
                limit: params.limit,
                minSimilarity: params.minSimilarity,
              },
            });
          return await ErrorHandler.tryCatch(
            async () => {
              const response: ObsidianSemanticSearchResponse =
                await processObsidianSemanticSearch(
                  params,
                  handlerContext,
                  smartConnectionsService,
                );
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(response, null, 2),
                  },
                ],
                isError: false,
              };
            },
            {
              operation: `executing tool ${toolName}`,
              context: handlerContext,
              errorCode: BaseErrorCode.INTERNAL_ERROR,
            },
          );
        },
      );
      logger.info(`Tool registered successfully: ${toolName}`, registrationContext);
    },
    {
      operation: `registering tool ${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext },
        ),
      critical: true,
    },
  );
}

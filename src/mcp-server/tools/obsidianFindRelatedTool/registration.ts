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
  ObsidianFindRelatedInput,
  ObsidianFindRelatedResponse,
} from "./logic.js";
import {
  ObsidianFindRelatedInputSchemaShape,
  processObsidianFindRelated,
} from "./logic.js";

export async function registerObsidianFindRelatedTool(
  server: McpServer,
  smartConnectionsService: SmartConnectionsService,
): Promise<void> {
  const toolName = "obsidian_find_related";
  const toolDescription = `Find notes semantically related to a specific source note using Smart Connections embeddings. Equivalent to Smart Connections' in-Obsidian sidebar. Use this when you have a specific file and want to discover other notes on similar topics, rather than searching with free-form text.`;

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianFindRelatedTool",
      toolName,
      module: "ObsidianFindRelatedRegistration",
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianFindRelatedInputSchemaShape,
        async (params: ObsidianFindRelatedInput): Promise<any> => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              operation: "HandleObsidianFindRelatedRequest",
              toolName,
              paramsSummary: {
                filePath: params.filePath,
                limit: params.limit,
              },
            });
          return await ErrorHandler.tryCatch(
            async () => {
              const response: ObsidianFindRelatedResponse =
                await processObsidianFindRelated(
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

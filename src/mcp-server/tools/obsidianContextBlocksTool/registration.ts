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
  ObsidianContextBlocksInput,
  ObsidianContextBlocksResponse,
} from "./logic.js";
import {
  ObsidianContextBlocksInputSchemaShape,
  processObsidianContextBlocks,
} from "./logic.js";

export async function registerObsidianContextBlocksTool(
  server: McpServer,
  smartConnectionsService: SmartConnectionsService,
): Promise<void> {
  const toolName = "obsidian_context_blocks";
  const toolDescription = `Get the best block-level text chunks for a query from Smart Connections embeddings. Returns actual text content, not just file references — ideal for RAG-style context assembly when you need the relevant passages inline rather than note paths.`;

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianContextBlocksTool",
      toolName,
      module: "ObsidianContextBlocksRegistration",
    });

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianContextBlocksInputSchemaShape,
        async (params: ObsidianContextBlocksInput): Promise<any> => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              operation: "HandleObsidianContextBlocksRequest",
              toolName,
              paramsSummary: {
                query: params.query,
                maxBlocks: params.maxBlocks,
                minSimilarity: params.minSimilarity,
              },
            });
          return await ErrorHandler.tryCatch(
            async () => {
              const response: ObsidianContextBlocksResponse =
                await processObsidianContextBlocks(
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

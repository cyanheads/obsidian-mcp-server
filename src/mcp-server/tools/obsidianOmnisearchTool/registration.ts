import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OmnisearchService } from "../../../services/omnisearch/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import type {
  ObsidianOmnisearchInput,
  ObsidianOmnisearchResponse,
} from "./logic.js";
import {
  ObsidianOmnisearchInputSchemaShape,
  processObsidianOmnisearch,
} from "./logic.js";

export async function registerObsidianOmnisearchTool(
  server: McpServer,
  omnisearchService: OmnisearchService,
): Promise<void> {
  const toolName = "obsidian_omnisearch";
  const toolDescription = `Performs fast indexed full-text search across the Obsidian vault using the Omnisearch plugin's HTTP API. Supports fuzzy matching, tokenization, and multi-word queries. Returns hits sorted by relevance score, with match offsets and the words that triggered the match. Much faster than obsidian_global_search for large vaults. Requires the Omnisearch community plugin with its HTTP server enabled.`;

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianOmnisearchTool",
      toolName,
      module: "ObsidianOmnisearchRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        ObsidianOmnisearchInputSchemaShape,
        async (params: ObsidianOmnisearchInput): Promise<any> => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              operation: "HandleObsidianOmnisearchRequest",
              toolName,
              paramsSummary: {
                query: params.query,
                limit: params.limit,
                maxMatchesPerFile: params.maxMatchesPerFile,
                searchInPath: params.searchInPath,
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              const response: ObsidianOmnisearchResponse =
                await processObsidianOmnisearch(
                  params,
                  handlerContext,
                  omnisearchService,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
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

      logger.info(
        `Tool registered successfully: ${toolName}`,
        registrationContext,
      );
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

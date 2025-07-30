/**
 * @fileoverview Handles the registration of the `obsidian_global_search` tool with the MCP server.
 * @module src/mcp-server/tools/obsidianGlobalSearchTool/registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  obsidianGlobalSearchLogic,
  ObsidianGlobalSearchInputSchema,
  ObsidianGlobalSearchResponseSchema,
  type ObsidianGlobalSearchInput,
} from "./logic.js";

/**
 * Registers the `obsidian_global_search` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param obsidianService - The instance of the Obsidian REST API service.
 * @param vaultCacheService - The instance of the Vault Cache service.
 */
export const registerObsidianGlobalSearchTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<void> => {
  const toolName = "obsidian_global_search";
  const toolDescription = `Performs search across the Obsidian vault using text or regex, primarily relying on the Obsidian REST API's simple search. Supports filtering by modification date, optionally restricting search to a specific directory path (recursively), pagination (page, pageSize), and limiting matches shown per file (maxMatchesPerFile). Returns a JSON object containing success status, a message, pagination details (currentPage, pageSize, totalPages), total file/match counts (before pagination), and an array of results. Each result includes the file path, filename, creation timestamp (ctime), modification timestamp (mtime), and an array of match context snippets (limited by maxMatchesPerFile). If there are multiple pages of results, it also includes an 'alsoFoundInFiles' array listing filenames found on other pages.`;

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterTool",
      toolName: toolName,
    });

  logger.info(`Registering tool: '${toolName}'`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.registerTool(
        toolName,
        {
          title: "Obsidian Global Search",
          description: toolDescription,
          inputSchema: ObsidianGlobalSearchInputSchema.shape,
          outputSchema: ObsidianGlobalSearchResponseSchema.shape,
        },
        async (params: ObsidianGlobalSearchInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await obsidianGlobalSearchLogic(
              params,
              handlerContext,
              obsidianService,
              vaultCacheService,
            );
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "obsidianGlobalSearchToolHandler",
              context: handlerContext,
              input: params,
            }) as McpError;

            return {
              isError: true,
              content: [{ type: "text", text: `Error: ${mcpError.message}` }],
              structuredContent: {
                code: mcpError.code,
                message: mcpError.message,
                details: mcpError.details,
              },
            };
          }
        },
      );

      logger.info(
        `Tool '${toolName}' registered successfully.`,
        registrationContext,
      );
    },
    {
      operation: `RegisteringTool_${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INITIALIZATION_FAILED,
      critical: true,
    },
  );
};

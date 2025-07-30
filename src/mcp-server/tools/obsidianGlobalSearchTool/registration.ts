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
  ObsidianGlobalSearchInputSchema,
  obsidianGlobalSearchLogic,
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
  const toolDescription = `Performs a powerful, Obsidian vault-wide search using text or regular expressions. It supports advanced filtering by modification date and specific folder paths, includes  pagination, and allows for fine-tuning of match context. The tool returns a detailed, paginated list of matching notes, complete with metadata and match snippets.`;

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
          annotations: {
            readOnlyHint: true,
          },
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

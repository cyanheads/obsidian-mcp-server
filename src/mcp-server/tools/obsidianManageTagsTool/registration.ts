/**
 * @fileoverview Handles the registration of the `obsidian_manage_tags` tool.
 * @module src/mcp-server/tools/obsidianManageTagsTool/registration
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
  obsidianManageTagsLogic,
  ObsidianManageTagsInputSchema,
  ObsidianManageTagsResponseSchema,
  type ObsidianManageTagsInput,
} from "./logic.js";

/**
 * Registers the `obsidian_manage_tags` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param obsidianService - The instance of the Obsidian REST API service.
 * @param vaultCacheService - The instance of the Vault Cache service.
 */
export const registerObsidianManageTagsTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<void> => {
  const toolName = "obsidian_manage_tags";
  const toolDescription =
    "Manages tags for a specified note, handling them in both the YAML frontmatter and inline content. Supports adding, removing, and listing tags to provide a comprehensive tag management solution.";

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
          title: "Manage Obsidian Tags",
          description: toolDescription,
          inputSchema: ObsidianManageTagsInputSchema.shape,
          outputSchema: ObsidianManageTagsResponseSchema.shape,
        },
        async (params: ObsidianManageTagsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await obsidianManageTagsLogic(
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
              operation: "obsidianManageTagsToolHandler",
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

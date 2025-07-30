/**
 * @fileoverview Handles the registration of the `obsidian_manage_frontmatter` tool.
 * @module src/mcp-server/tools/obsidianManageFrontmatterTool/registration
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
  obsidianManageFrontmatterLogic,
  ObsidianManageFrontmatterInputSchema,
  ObsidianManageFrontmatterInputSchemaShape,
  ObsidianManageFrontmatterResponseSchema,
  type ObsidianManageFrontmatterInput,
} from "./logic.js";

/**
 * Registers the `obsidian_manage_frontmatter` tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param obsidianService - The instance of the Obsidian REST API service.
 * @param vaultCacheService - The instance of the Vault Cache service.
 */
export const registerObsidianManageFrontmatterTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<void> => {
  const toolName = "obsidian_manage_frontmatter";
  const toolDescription =
    "Atomically manages a note's YAML frontmatter. Supports getting, setting (creating/updating), and deleting specific keys without rewriting the entire file. Ideal for efficient metadata operations on primitive or structured Obsidian frontmatter data.";

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
          title: "Manage Obsidian Frontmatter",
          description: toolDescription,
          inputSchema: ObsidianManageFrontmatterInputSchemaShape,
          outputSchema: ObsidianManageFrontmatterResponseSchema.shape,
        },
        async (params: ObsidianManageFrontmatterInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const validatedParams =
              ObsidianManageFrontmatterInputSchema.parse(params);
            const result = await obsidianManageFrontmatterLogic(
              validatedParams,
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
              operation: "obsidianManageFrontmatterToolHandler",
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

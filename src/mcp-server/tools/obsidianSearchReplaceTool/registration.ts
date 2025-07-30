/**
 * @fileoverview Registers the `obsidian_search_replace` tool, providing advanced,
 * in-memory search and replace capabilities for Obsidian notes.
 * @module src/mcp-server/tools/obsidianSearchReplaceTool/registration
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
  obsidianSearchReplaceLogic,
  ObsidianSearchReplaceInputSchema,
  ObsidianSearchReplaceInputSchemaShape,
  ObsidianSearchReplaceResponseSchema,
  type ObsidianSearchReplaceInput,
} from "./logic.js";

/**
 * Registers the 'obsidian_search_replace' tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param obsidianService - The instance of the Obsidian REST API service.
 * @param vaultCacheService - The instance of the Vault Cache service.
 */
export const registerObsidianSearchReplaceTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<void> => {
  const toolName = "obsidian_search_replace";
  const toolDescription =
    "Performs one or more search-and-replace operations on a specified Obsidian note. It supports string or regex patterns, case sensitivity, whole word matching, and flexible whitespace. Changes are applied sequentially and overwrite the original note.";

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
          title: "Obsidian Search and Replace",
          description: toolDescription,
          inputSchema: ObsidianSearchReplaceInputSchemaShape,
          outputSchema: ObsidianSearchReplaceResponseSchema.shape,
          annotations: {
            destructiveHint: false,
          },
        },
        async (params: ObsidianSearchReplaceInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const validatedParams =
              ObsidianSearchReplaceInputSchema.parse(params);
            const result = await obsidianSearchReplaceLogic(
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
              operation: "obsidianSearchReplaceToolHandler",
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

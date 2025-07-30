/**
 * @fileoverview Handles the registration of the `obsidian_delete_note` tool with the MCP server.
 * This tool provides functionality to permanently delete a file from an Obsidian vault.
 * @module src/mcp-server/tools/obsidianDeleteNoteTool/registration
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
  obsidianDeleteNoteLogic,
  ObsidianDeleteNoteInputSchema,
  ObsidianDeleteNoteResponseSchema,
  type ObsidianDeleteNoteInput,
} from "./logic.js";

/**
 * Registers the `obsidian_delete_note` tool with the MCP server.
 *
 * @param server - The MCP server instance to register the tool with.
 * @param obsidianService - Service for interacting with the Obsidian REST API.
 * @param vaultCacheService - Service for caching vault data to improve performance.
 */
export const registerObsidianDeleteNoteTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<void> => {
  const toolName = "obsidian_delete_note";
  const toolDescription =
    "Permanently deletes a specified file from the Obsidian vault. Tries the exact path first, then attempts a case-insensitive fallback if the file is not found. Requires the vault-relative path including the file extension.";

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
          title: "Delete Obsidian Note",
          description: toolDescription,
          inputSchema: ObsidianDeleteNoteInputSchema.shape,
          outputSchema: ObsidianDeleteNoteResponseSchema.shape,
        },
        async (params: ObsidianDeleteNoteInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await obsidianDeleteNoteLogic(
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
              operation: "obsidianDeleteNoteToolHandler",
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

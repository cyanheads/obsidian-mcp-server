/**
 * @fileoverview Registers the 'obsidian_update_note' tool with the MCP server.
 * @module src/mcp-server/tools/obsidianUpdateNoteTool/registration
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
  obsidianUpdateNoteLogic,
  ObsidianUpdateNoteInputSchema,
  ObsidianUpdateNoteInputSchemaShape,
  ObsidianUpdateNoteResponseSchema,
  type ObsidianUpdateNoteInput,
} from "./logic.js";

/**
 * Registers the 'obsidian_update_note' tool with the MCP server.
 *
 * @param server - The MCP server instance.
 * @param obsidianService - The instance of the Obsidian REST API service.
 * @param vaultCacheService - The instance of the Vault Cache service.
 */
export const registerObsidianUpdateNoteTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<void> => {
  const toolName = "obsidian_update_note";
  const toolDescription =
    "Tool to modify Obsidian notes (specified by file path, the active file, or a periodic note) using whole-file operations: 'append', 'prepend', or 'overwrite'. Options allow creating missing files/targets and controlling overwrite behavior. Returns success status, message, a formatted timestamp string, file stats (stats), and optionally the final file content.";

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
          title: "Update Obsidian Note",
          description: toolDescription,
          inputSchema: ObsidianUpdateNoteInputSchemaShape,
          outputSchema: ObsidianUpdateNoteResponseSchema.shape,
        },
        async (params: ObsidianUpdateNoteInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const validatedParams = ObsidianUpdateNoteInputSchema.parse(params);
            const result = await obsidianUpdateNoteLogic(
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
              operation: "obsidianUpdateNoteToolHandler",
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

/**
 * @fileoverview Registers the 'obsidian_list_notes' tool with the MCP server.
 * This file defines the tool's metadata and sets up the handler that links
 * the tool call to its core processing logic.
 * @module src/mcp-server/tools/obsidianListNotesTool/registration
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import {
  obsidianListNotesLogic,
  ObsidianListNotesInputSchema,
  ObsidianListNotesResponseSchema,
  type ObsidianListNotesInput,
} from "./logic.js";

/**
 * Registers the 'obsidian_list_notes' tool with the MCP server.
 *
 * @param server - The MCP server instance to register the tool with.
 * @param obsidianService - An instance of the Obsidian REST API service.
 */
export const registerObsidianListNotesTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> => {
  const toolName = "obsidian_list_notes";
  const toolDescription =
    "Lists files and subdirectories within a specified Obsidian vault folder. Supports optional filtering by extension or name regex, and recursive listing to a specified depth (-1 for infinite). Returns an object containing the listed directory path, a formatted tree string of its contents, and the total entry count. Use an empty string or '/' for dirPath to list the vault root.";

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
          title: "List Obsidian Notes",
          description: toolDescription,
          inputSchema: ObsidianListNotesInputSchema.shape,
          outputSchema: ObsidianListNotesResponseSchema.shape,
        },
        async (params: ObsidianListNotesInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await obsidianListNotesLogic(
              params,
              handlerContext,
              obsidianService,
            );
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "obsidianListNotesToolHandler",
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

/**
 * @fileoverview Registers the `obsidian_list_notes` tool, which provides functionality
 * to explore the directory structure of an Obsidian vault.
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
    "Lists notes and directories within a specified Obsidian vault path. This tool supports advanced filtering by file extension and name (using regex) and allows for recursive exploration to a defined depth. It returns a formatted tree structure, perfect for visualizing folder contents.";

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
          annotations: {
            readOnlyHint: true,
          },
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

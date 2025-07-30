/**
 * @fileoverview Registers the `obsidian_read_note` tool, which enables the retrieval
 * of content and metadata from notes in an Obsidian vault, featuring a case-insensitive
 * fallback for convenience.
 * @module src/mcp-server/tools/obsidianReadNoteTool/registration
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
  obsidianReadNoteLogic,
  ObsidianReadNoteInputSchema,
  ObsidianReadNoteResponseSchema,
  type ObsidianReadNoteInput,
} from "./logic.js";

/**
 * Registers the 'obsidian_read_note' tool with the MCP server.
 *
 * @param server - The MCP server instance to register the tool with.
 * @param obsidianService - An instance of the Obsidian REST API service.
 */
export const registerObsidianReadNoteTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
): Promise<void> => {
  const toolName = "obsidian_read_note";
  const toolDescription =
    "Retrieves the content and metadata of a specified Obsidian note. It first attempts a case-sensitive match and, if not found, performs a case-insensitive search. The tool can return content as raw markdown or a structured JSON object and can optionally include file statistics.";

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
          title: "Read Obsidian Note",
          description: toolDescription,
          inputSchema: ObsidianReadNoteInputSchema.shape,
          outputSchema: ObsidianReadNoteResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
          },
        },
        async (params: ObsidianReadNoteInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await obsidianReadNoteLogic(
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
              operation: "obsidianReadNoteToolHandler",
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

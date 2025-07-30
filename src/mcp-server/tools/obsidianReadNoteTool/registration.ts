/**
 * @fileoverview Registers the 'obsidian_read_note' tool with the MCP server.
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
    "Retrieves the content and metadata of a specified file within the Obsidian vault. Tries the exact path first, then attempts a case-insensitive fallback. Returns an object containing the content (markdown string or full NoteJson object based on 'format'), and optionally formatted file stats ('stats' object with creationTime, modifiedTime, tokenCountEstimate). Use 'includeStat: true' with 'format: markdown' to include stats; stats are always included with 'format: json'.";

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

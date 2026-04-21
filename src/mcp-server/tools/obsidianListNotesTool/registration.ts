/**
 * @fileoverview Registers the 'obsidian_list_notes' tool with the MCP server.
 * This file defines the tool's metadata and sets up the handler that links
 * the tool call to its core processing logic.
 * @module src/mcp-server/tools/obsidianListNotesTool/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
  createJsonSchema,
} from "../../../utils/index.js";
// Import necessary types, schema, and logic function from the logic file
import type {
  ObsidianListNotesInput,
  ObsidianListNotesResponse,
} from "./logic.js";
import {
  ObsidianListNotesInputSchema,
  processObsidianListNotes,
} from "./logic.js";

/**
 * Registers the 'obsidian_list_notes' tool with the MCP server.
 *
 * This tool lists the files and subdirectories within a specified directory
 * in the user's Obsidian vault. It supports optional filtering by file extension,
 * by a regular expression matching the entry name, and recursive listing up to a
 * specified depth.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianListNotesTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService, // Dependency injection for the Obsidian service
): Promise<void> => {
  const toolName = "obsidian_list_notes";
  const toolDescription =
    "Lists files and subdirectories within a specified Obsidian vault folder. Supports optional filtering by extension or name regex, and recursive listing to a specified depth (-1 for infinite). Returns an object containing the listed directory path, a formatted tree string of its contents, and the total entry count. Use an empty string or '/' for dirPath to list the vault root.";

  // Create a context specifically for the registration process.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianListNotesTool",
      toolName: toolName,
      module: "ObsidianListNotesRegistration", // Identify the module
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling during server setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration.
      // Convert Zod schema to JSON Schema with explicit type fields for Gemini CLI compatibility.
      // Cast to ZodRawShape as the MCP SDK accepts this at runtime despite TypeScript strictness.
      const jsonSchema = createJsonSchema(ObsidianListNotesInputSchema) as unknown as z.ZodRawShape;
      (server.tool as any)(
        toolName,
        toolDescription,
        jsonSchema, // Provide the JSON Schema with explicit type fields.
        /**
         * The handler function executed when the 'obsidian_list_notes' tool is called by the client.
         *
         * @param {ObsidianListNotesInput} params - The input parameters received from the client,
         *   validated against the ObsidianListNotesInputSchema shape.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client,
         *   containing either the successful response data (serialized JSON) or an error indication.
         */
        async (params: any) => {
          // Type matches the inferred input schema
          // Create a specific context for this handler invocation.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext, // Link to registration context
              operation: "HandleObsidianListNotesRequest",
              toolName: toolName,
              params: {
                // Log all relevant parameters for debugging
                dirPath: params.dirPath,
                fileExtensionFilter: params.fileExtensionFilter,
                nameRegexFilter: params.nameRegexFilter,
                recursionDepth: params.recursionDepth,
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block.
          return await ErrorHandler.tryCatch(
            async () => {
              // Delegate the actual file listing and filtering logic to the processing function.
              const response: ObsidianListNotesResponse =
                await processObsidianListNotes(
                  params,
                  handlerContext,
                  obsidianService,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              // Format the successful response object from the logic function into the required MCP CallToolResult structure.
              return {
                content: [
                  {
                    type: "text", // Standard content type for structured JSON data
                    text: JSON.stringify(response, null, 2), // Pretty-print JSON
                  },
                ],
                isError: false, // Indicate successful execution
              };
            },
            {
              // Configuration for the inner error handler (processing logic).
              operation: `processing ${toolName} handler`,
              context: handlerContext,
              input: params, // Log the full input parameters if an error occurs.
              // Custom error mapping for consistent error reporting.
              errorMapper: (error: unknown) =>
                new McpError(
                  error instanceof McpError
                    ? error.code
                    : BaseErrorCode.INTERNAL_ERROR,
                  `Error processing ${toolName} tool: ${error instanceof Error ? error.message : "Unknown error"}`,
                  { ...handlerContext }, // Include context
                ),
            },
          ); // End of inner ErrorHandler.tryCatch
        },
      ); // End of server.tool call

      logger.info(
        `Tool registered successfully: ${toolName}`,
        registrationContext,
      );
    },
    {
      // Configuration for the outer error handler (registration process).
      operation: `registering tool ${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR, // Default error code for registration failure.
      // Custom error mapping for registration failures.
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext }, // Include context
        ),
      critical: true, // Treat registration failure as critical.
    },
  ); // End of outer ErrorHandler.tryCatch
};

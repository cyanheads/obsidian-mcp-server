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
  ObsidianReadNoteInput,
  ObsidianReadNoteResponse,
} from "./logic.js";
import {
  ObsidianReadNoteInputSchema,
  processObsidianReadNote,
} from "./logic.js";

/**
 * Registers the 'obsidian_read_note' tool with the MCP server.
 *
 * This tool retrieves the content and optionally metadata of a specified file
 * within the user's Obsidian vault. It supports specifying the output format
 * ('markdown' or 'json') and includes a case-insensitive fallback mechanism
 * if the exact file path is not found initially.
 *
 * The response is a JSON string containing the file content in the requested format
 * and optionally formatted file statistics (timestamps, token count).
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianReadNoteTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService, // Dependency injection for the Obsidian service
): Promise<void> => {
  const toolName = "obsidian_read_note";
  const toolDescription =
    "Retrieves the content and metadata of a specified file within the Obsidian vault. Tries the exact path first, then attempts a case-insensitive fallback. Returns an object containing the content (markdown string or full NoteJson object based on 'format'), and optionally formatted file stats ('stats' object with creationTime, modifiedTime, tokenCountEstimate). Use 'includeStat: true' with 'format: markdown' to include stats; stats are always included with 'format: json'.";

  // Create a context specifically for the registration process.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianReadNoteTool",
      toolName: toolName,
      module: "ObsidianReadNoteRegistration", // Identify the module
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling during server setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration.
      // It handles schema generation from the shape, basic validation, and routing.
      // Convert Zod schema to JSON Schema with explicit type fields for Gemini CLI compatibility.
      // Cast to ZodRawShape as the MCP SDK accepts this at runtime despite TypeScript strictness.
      const jsonSchema = createJsonSchema(ObsidianReadNoteInputSchema) as unknown as z.ZodRawShape;
      // Cast server.tool to any to bypass TypeScript strict type checking on overloads
      // The runtime behavior is correct - the MCP SDK accepts both Zod schemas and JSON Schema objects
      (server.tool as any)(
        toolName,
        toolDescription,
        jsonSchema,
        /**
         * The handler function executed when the 'obsidian_read_note' tool is called by the client.
         *
         * @param {ObsidianReadNoteInput} params - The input parameters received from the client,
         *   validated against the ObsidianReadNoteInputSchema shape. Note: The handler receives the raw input;
         *   stricter validation against the full schema should happen inside if needed, though in this case,
         *   the shape and the full schema are identical.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client,
         *   containing either the successful response data (serialized JSON) or an error indication.
         */
        async (params: any) => {
          // Type matches the inferred input schema
          // Create a specific context for this handler invocation.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext, // Link to registration context
              operation: "HandleObsidianReadNoteRequest",
              toolName: toolName,
              params: {
                // Log key parameters for debugging
                filePath: params.filePath,
                format: params.format,
                includeStat: params.includeStat,
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block.
          return await ErrorHandler.tryCatch(
            async () => {
              // Delegate the actual file reading logic to the dedicated processing function.
              // Pass the (already shape-validated) parameters, context, and the Obsidian service.
              // The process function handles the refined validation internally if needed, but here shape = refined.
              const response: ObsidianReadNoteResponse =
                await processObsidianReadNote(
                  params, // Pass params directly as shape matches refined schema
                  handlerContext,
                  obsidianService,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              // Format the successful response object from the logic function into the required MCP CallToolResult structure.
              // The entire response object (containing content and optional stat) is serialized to JSON.
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

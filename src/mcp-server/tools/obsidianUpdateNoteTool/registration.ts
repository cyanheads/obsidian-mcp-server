import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
  createJsonSchema,
} from "../../../utils/index.js";
// Import types for handler signature and response structure
import type {
  ObsidianUpdateNoteRegistrationInput,
  ObsidianUpdateNoteResponse,
} from "./logic.js";
// Import the Zod schema for validation and the core processing logic
import {
  ObsidianUpdateNoteInputSchema,
  ObsidianUpdateNoteInputSchemaShape,
  processObsidianUpdateNote,
} from "./logic.js";

/**
 * Registers the 'obsidian_update_note' tool with the MCP server.
 *
 * This tool allows modification of Obsidian notes (specified by file path,
 * the active file, or a periodic note) using whole-file operations:
 * 'append', 'prepend', or 'overwrite'. It includes options for creating
 * missing files/targets and controlling overwrite behavior.
 *
 * The tool returns a JSON string containing the operation status, a message,
 * a formatted timestamp of the operation, file statistics (stat), and
 * optionally the final content of the modified file.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianUpdateNoteTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void> => {
  const toolName = "obsidian_update_note";
  const toolDescription =
    "Tool to modify Obsidian notes (specified by file path, the active file, or a periodic note) using whole-file operations: 'append', 'prepend', or 'overwrite'. Options allow creating missing files/targets and controlling overwrite behavior. Returns success status, message, a formatted timestamp string, file stats (stats), and optionally the final file content.";

  // Create a context for the registration process itself for better traceability.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianUpdateNoteTool",
      toolName: toolName,
      module: "ObsidianUpdateNoteRegistration", // Identify the module performing registration
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration in a tryCatch block for robust error handling during setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method for tool registration.
      // This handles schema generation, validation, and routing automatically.
      // Convert Zod schema to JSON Schema with explicit type fields for Gemini CLI compatibility.
      // Cast to ZodRawShape as the MCP SDK accepts this at runtime despite TypeScript strictness.
      const jsonSchema = createJsonSchema(ObsidianUpdateNoteInputSchema) as unknown as z.ZodRawShape;
      (server.tool as any)(
        toolName,
        toolDescription,
        jsonSchema, // Provide the JSON Schema with explicit type fields.
        /**
         * The handler function executed when the 'obsidian_update_note' tool is called.
         *
         * @param {ObsidianUpdateNoteRegistrationInput} params - The raw input parameters received from the client,
         *   matching the structure defined by ObsidianUpdateNoteInputSchemaShape.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client,
         *   containing either the successful response data or an error indication.
         */
        async (params: any) => {
          // Create a specific context for this handler invocation.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext, // Link to the registration context
              operation: "HandleObsidianUpdateNoteRequest",
              toolName: toolName,
              params: {
                // Log key parameters for easier debugging, content is omitted for brevity/security
                targetType: params.targetType,
                modificationType: params.modificationType, // Note: Will always be 'wholeFile' due to schema
                targetIdentifier: params.targetIdentifier,
                wholeFileMode: params.wholeFileMode,
                createIfNeeded: params.createIfNeeded,
                overwriteIfExists: params.overwriteIfExists,
                returnContent: params.returnContent,
              },
            });
          logger.debug(
            `Handling '${toolName}' request (wholeFile mode)`,
            handlerContext,
          );

          // Wrap the core logic execution in a tryCatch block for handling errors during processing.
          return await ErrorHandler.tryCatch(
            async () => {
              // Explicitly parse and validate the incoming parameters using the full Zod schema.
              // This ensures type safety and adherence to constraints defined in logic.ts.
              // While server.tool performs initial validation based on the shape,
              // this step applies any stricter rules or refinements from the full schema.
              const validatedParams =
                ObsidianUpdateNoteInputSchema.parse(params);

              // Delegate the actual file update logic to the dedicated processing function.
              // Pass the validated parameters, the handler context, and the Obsidian service instance.
              const response: ObsidianUpdateNoteResponse =
                await processObsidianUpdateNote(
                  validatedParams,
                  handlerContext,
                  obsidianService,
                  vaultCacheService,
                );
              logger.debug(
                `'${toolName}' (wholeFile mode) processed successfully`,
                handlerContext,
              );

              // Format the successful response from the logic function into the MCP CallToolResult structure.
              // The response object (containing status, message, timestamp, stat, etc.) is serialized to JSON.
              return {
                content: [
                  {
                    type: "text", // Standard content type for structured data
                    text: JSON.stringify(response, null, 2), // Pretty-print JSON for readability
                  },
                ],
                isError: false, // Indicate successful execution
              };
            },
            {
              // Configuration for the inner error handler (processing logic).
              operation: `processing ${toolName} handler`,
              context: handlerContext,
              input: params, // Log the full raw input parameters if an error occurs during processing.
              // Custom error mapping to ensure consistent McpError format.
              errorMapper: (error: unknown) =>
                new McpError(
                  error instanceof McpError
                    ? error.code
                    : BaseErrorCode.INTERNAL_ERROR, // Use INTERNAL_ERROR as the fallback
                  `Error processing ${toolName} tool: ${error instanceof Error ? error.message : "Unknown error"}`,
                  { ...handlerContext }, // Include context in the error details
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
      errorCode: BaseErrorCode.INTERNAL_ERROR, // Default error code for registration failure
      // Custom error mapping for registration failures.
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext }, // Include context
        ),
      critical: true, // Registration failure is considered critical and should likely halt server startup.
    },
  ); // End of outer ErrorHandler.tryCatch
};

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
// Import necessary types and schemas from the logic file
import type {
  ObsidianSearchReplaceRegistrationInput,
  ObsidianSearchReplaceResponse,
} from "./logic.js";
import {
  ObsidianSearchReplaceInputSchema,
  ObsidianSearchReplaceInputSchemaShape,
  processObsidianSearchReplace,
} from "./logic.js";

/**
 * Registers the 'obsidian_search_replace' tool with the MCP server.
 *
 * This tool performs one or more search-and-replace operations within a specified
 * Obsidian note (identified by file path, the active file, or a periodic note).
 * It reads the note content, applies the replacements sequentially based on the
 * provided options (regex, case sensitivity, etc.), writes the modified content
 * back to the vault, and returns the operation results.
 *
 * The response includes success status, a summary message, the total number of
 * replacements made, formatted file statistics (timestamp, token count), and
 * optionally the final content of the note.
 *
 * @param {McpServer} server - The MCP server instance to register the tool with.
 * @param {ObsidianRestApiService} obsidianService - An instance of the Obsidian REST API service
 *   used to interact with the user's Obsidian vault.
 * @returns {Promise<void>} A promise that resolves when the tool registration is complete or rejects on error.
 * @throws {McpError} Throws an McpError if registration fails critically.
 */
export const registerObsidianSearchReplaceTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void> => {
  const toolName = "obsidian_search_replace";
  const toolDescription =
    "Performs one or more search-and-replace operations within a target Obsidian note (file path, active, or periodic). Reads the file, applies replacements sequentially in memory, and writes the modified content back, overwriting the original. Supports string/regex search, case sensitivity toggle, replacing first/all occurrences, flexible whitespace matching (non-regex), and whole word matching. Returns success status, message, replacement count, a formatted timestamp string, file stats (stats), and optionally the final file content.";

  // Create a context specifically for the registration process.
  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianSearchReplaceTool",
      toolName: toolName,
      module: "ObsidianSearchReplaceRegistration", // Identify the module
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  // Wrap the registration logic in a tryCatch block for robust error handling during server setup.
  await ErrorHandler.tryCatch(
    async () => {
      // Use the high-level SDK method `server.tool` for registration.
      // It handles schema generation from the shape, basic validation, and routing.
      // Convert Zod schema to JSON Schema with explicit type fields for Gemini CLI compatibility.
      // Cast to ZodRawShape as the MCP SDK accepts this at runtime despite TypeScript strictness.
      const jsonSchema = createJsonSchema(ObsidianSearchReplaceInputSchema) as unknown as z.ZodRawShape;
      (server.tool as any)(
        toolName,
        toolDescription,
        jsonSchema,
        /**
         * The handler function executed when the 'obsidian_search_replace' tool is called by the client.
         *
         * @param {ObsidianSearchReplaceRegistrationInput} params - The raw input parameters received from the client,
         *   matching the structure defined by ObsidianSearchReplaceInputSchemaShape.
         * @returns {Promise<CallToolResult>} A promise resolving to the structured result for the MCP client,
         *   containing either the successful response data (serialized JSON) or an error indication.
         */
        async (params: any) => {
          // Create a specific context for this handler invocation, linked to the registration context.
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianSearchReplaceRequest",
              toolName: toolName,
              params: {
                // Log key parameters for debugging (excluding potentially large replacements array)
                targetType: params.targetType,
                targetIdentifier: params.targetIdentifier,
                replacementCount: params.replacements?.length ?? 0, // Log count instead of full array
                useRegex: params.useRegex,
                replaceAll: params.replaceAll,
                caseSensitive: params.caseSensitive,
                flexibleWhitespace: params.flexibleWhitespace,
                wholeWord: params.wholeWord,
                returnContent: params.returnContent,
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          // Wrap the core logic execution in a tryCatch block for handling errors during processing.
          return await ErrorHandler.tryCatch(
            async () => {
              // **Crucial Step:** Explicitly parse and validate the raw input parameters using the
              // *refined* Zod schema (`ObsidianSearchReplaceInputSchema`). This applies stricter rules
              // and cross-field validations defined in logic.ts.
              const validatedParams =
                ObsidianSearchReplaceInputSchema.parse(params);
              logger.debug(
                `Input parameters successfully validated against refined schema.`,
                handlerContext,
              );

              // Delegate the actual search/replace logic to the dedicated processing function.
              // Pass the *validated* parameters, the handler context, and the Obsidian service instance.
              const response: ObsidianSearchReplaceResponse =
                await processObsidianSearchReplace(
                  validatedParams,
                  handlerContext,
                  obsidianService,
                  vaultCacheService,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              // Format the successful response object from the logic function into the required MCP CallToolResult structure.
              // The entire response object (containing success, message, count, stat, etc.) is serialized to JSON.
              return {
                content: [
                  {
                    type: "text", // Standard content type for structured JSON data
                    text: JSON.stringify(response, null, 2), // Pretty-print JSON for readability
                  },
                ],
                isError: false, // Indicate successful execution to the client
              };
            },
            {
              // Configuration for the inner error handler (processing logic).
              operation: `processing ${toolName} handler`,
              context: handlerContext,
              input: params, // Log the full raw input parameters if an error occurs during processing.
              // Custom error mapping to ensure consistent McpError format is returned to the client.
              errorMapper: (error: unknown) =>
                new McpError(
                  // Use the specific code from McpError if available, otherwise default to INTERNAL_ERROR.
                  error instanceof McpError
                    ? error.code
                    : BaseErrorCode.INTERNAL_ERROR,
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
      errorCode: BaseErrorCode.INTERNAL_ERROR, // Default error code for registration failure.
      // Custom error mapping for registration failures.
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext }, // Include context
        ),
      critical: true, // Treat registration failure as critical, potentially halting server startup.
    },
  ); // End of outer ErrorHandler.tryCatch
};

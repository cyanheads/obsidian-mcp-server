/**
 * @module ObsidianGlobalSearchToolRegistration
 * @description Registers the 'obsidian_global_search' tool with the MCP server.
 * This tool allows searching the Obsidian vault using text/regex queries with optional date filters.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import type { VaultCacheService } from "../../../services/obsidianRestAPI/vaultCache/index.js"; // Import VaultCacheService type
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { z } from "zod";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
  createJsonSchema,
} from "../../../utils/index.js";
// Import types, schema shape, and the core processing logic from logic.ts
import type {
  ObsidianGlobalSearchInput,
  ObsidianGlobalSearchResponse,
} from "./logic.js"; // Ensure '.js' extension
import {
  ObsidianGlobalSearchInputSchema,
  ObsidianGlobalSearchInputSchemaShape,
  processObsidianGlobalSearch,
} from "./logic.js"; // Ensure '.js' extension

/**
 * Registers the 'obsidian_global_search' tool with the MCP server instance.
 *
 * @param {McpServer} server - The MCP server instance.
 * @param {ObsidianRestApiService} obsidianService - The instance of the Obsidian REST API service.
 * @param {VaultCacheService} vaultCacheService - The instance of the Vault Cache service.
 * @returns {Promise<void>} A promise that resolves when the tool is registered.
 * @throws {McpError} If registration fails critically.
 */
export async function registerObsidianGlobalSearchTool(
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService, // Now required
): Promise<void> {
  const toolName = "obsidian_global_search";
  const toolDescription = `Performs search across the Obsidian vault using text or regex, primarily relying on the Obsidian REST API's simple search. Supports filtering by modification date, optionally restricting search to a specific directory path (recursively), pagination (page, pageSize), and limiting matches shown per file (maxMatchesPerFile). Returns a JSON object containing success status, a message, pagination details (currentPage, pageSize, totalPages), total file/match counts (before pagination), and an array of results. Each result includes the file path, filename, creation timestamp (ctime), modification timestamp (mtime), and an array of match context snippets (limited by maxMatchesPerFile). If there are multiple pages of results, it also includes an 'alsoFoundInFiles' array listing filenames found on other pages.`;

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianGlobalSearchTool",
      toolName: toolName,
      module: "ObsidianGlobalSearchRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      // Convert Zod schema to JSON Schema with explicit type fields for Gemini CLI compatibility.
      // Cast to ZodRawShape as the MCP SDK accepts this at runtime despite TypeScript strictness.
      const jsonSchema = createJsonSchema(ObsidianGlobalSearchInputSchema) as unknown as z.ZodRawShape;
      (server.tool as any)(
        toolName,
        toolDescription,
        jsonSchema,
        async (
          params: ObsidianGlobalSearchInput,
          handlerInvocationContext: any,
        ): Promise<any> => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              operation: "HandleObsidianGlobalSearchRequest",
              toolName: toolName,
              paramsSummary: {
                useRegex: params.useRegex,
                caseSensitive: params.caseSensitive,
                pageSize: params.pageSize,
                page: params.page,
                maxMatchesPerFile: params.maxMatchesPerFile,
                searchInPath: params.searchInPath,
                hasDateFilter: !!(
                  params.modified_since || params.modified_until
                ),
              },
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              const response: ObsidianGlobalSearchResponse =
                await processObsidianGlobalSearch(
                  params,
                  handlerContext,
                  obsidianService,
                  vaultCacheService,
                );
              logger.debug(
                `'${toolName}' processed successfully`,
                handlerContext,
              );

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(response, null, 2),
                  },
                ],
                isError: false,
              };
            },
            {
              operation: `executing tool ${toolName}`,
              context: handlerContext,
              errorCode: BaseErrorCode.INTERNAL_ERROR,
            },
          );
        },
      );

      logger.info(
        `Tool registered successfully: ${toolName}`,
        registrationContext,
      );
    },
    {
      operation: `registering tool ${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INTERNAL_ERROR,
      errorMapper: (error: unknown) =>
        new McpError(
          error instanceof McpError ? error.code : BaseErrorCode.INTERNAL_ERROR,
          `Failed to register tool '${toolName}': ${error instanceof Error ? error.message : "Unknown error"}`,
          { ...registrationContext },
        ),
      critical: true,
    },
  );
}

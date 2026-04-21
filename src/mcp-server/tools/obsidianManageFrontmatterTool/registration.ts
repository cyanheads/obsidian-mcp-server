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
import type {
  ObsidianManageFrontmatterInput,
  ObsidianManageFrontmatterResponse,
} from "./logic.js";
import {
  ManageFrontmatterInputSchema,
  ObsidianManageFrontmatterInputSchemaShape,
  processObsidianManageFrontmatter,
} from "./logic.js";

export const registerObsidianManageFrontmatterTool = async (
  server: McpServer,
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void> => {
  const toolName = "obsidian_manage_frontmatter";
  const toolDescription =
    "Atomically manages a note's YAML frontmatter. Supports getting, setting (creating/updating), and deleting specific keys without rewriting the entire file. Ideal for efficient metadata operations on primitive or structured Obsidian frontmatter data.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterObsidianManageFrontmatterTool",
      toolName: toolName,
      module: "ObsidianManageFrontmatterRegistration",
    });

  logger.info(`Attempting to register tool: ${toolName}`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      // Convert Zod schema to JSON Schema with explicit type fields for Gemini CLI compatibility.
      // Cast to ZodRawShape as the MCP SDK accepts this at runtime despite TypeScript strictness.
      const jsonSchema = createJsonSchema(ManageFrontmatterInputSchema) as unknown as z.ZodRawShape;
      (server.tool as any)(
        toolName,
        toolDescription,
        jsonSchema,
        async (params: any) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleObsidianManageFrontmatterRequest",
              toolName: toolName,
              params: params,
            });
          logger.debug(`Handling '${toolName}' request`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              const validatedParams =
                ManageFrontmatterInputSchema.parse(params);

              const response: ObsidianManageFrontmatterResponse =
                await processObsidianManageFrontmatter(
                  validatedParams,
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
              operation: `processing ${toolName} handler`,
              context: handlerContext,
              input: params,
              errorMapper: (error: unknown) =>
                new McpError(
                  error instanceof McpError
                    ? error.code
                    : BaseErrorCode.INTERNAL_ERROR,
                  `Error processing ${toolName} tool: ${error instanceof Error ? error.message : "Unknown error"}`,
                  { ...handlerContext },
                ),
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
};

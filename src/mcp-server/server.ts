/**
 * @fileoverview Main entry point for the MCP (Model Context Protocol) server.
 * This file orchestrates the server's lifecycle:
 * 1. Initializes the core `McpServer` instance (from `@modelcontextprotocol/sdk`) with its identity and capabilities.
 * 2. Registers available resources and tools, making them discoverable and usable by clients.
 * 3. Selects and starts the appropriate communication transport (stdio or Streamable HTTP)
 *    based on configuration.
 * 4. Handles top-level error management during startup.
 *
 * MCP Specification References:
 * - Lifecycle: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/lifecycle.mdx
 * - Overview (Capabilities): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/index.mdx
 * - Transports: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/transports.mdx
 * @module src/mcp-server/server
 */

import { ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, environment } from "../config/index.js";
import { ObsidianRestApiService } from "../services/obsidianRestAPI/index.js";
import { VaultCacheService } from "../services/obsidianRestAPI/vaultCache/index.js";
import { BaseErrorCode } from "../types-global/errors.js";
import { ErrorHandler, logger, requestContextService } from "../utils/index.js";
import { registerObsidianDeleteNoteTool } from "./tools/obsidianDeleteNoteTool/index.js";
import { registerObsidianGlobalSearchTool } from "./tools/obsidianGlobalSearchTool/index.js";
import { registerObsidianListNotesTool } from "./tools/obsidianListNotesTool/index.js";
import { registerObsidianManageFrontmatterTool } from "./tools/obsidianManageFrontmatterTool/index.js";
import { registerObsidianManageTagsTool } from "./tools/obsidianManageTagsTool/index.js";
import { registerObsidianReadNoteTool } from "./tools/obsidianReadNoteTool/index.js";
import { registerObsidianSearchReplaceTool } from "./tools/obsidianSearchReplaceTool/index.js";
import { registerObsidianUpdateNoteTool } from "./tools/obsidianUpdateNoteTool/index.js";
import { startHttpTransport } from "./transports/http/index.js";
import { startStdioTransport } from "./transports/stdio/index.js";

/**
 * Creates and configures a new instance of the `McpServer`.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance.
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance.
 * @returns {Promise<McpServer>} A promise resolving with the configured `McpServer` instance.
 * @throws {McpError} If any resource or tool registration fails.
 * @private
 */
async function createMcpServerInstance(
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<McpServer> {
  const context = requestContextService.createRequestContext({
    operation: "createMcpServerInstance",
  });
  logger.info("Initializing MCP server instance with shared services", context);

  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    {
      capabilities: {
        logging: {},
        resources: { listChanged: true },
        tools: { listChanged: true },
      },
    },
  );

  await ErrorHandler.tryCatch(
    async () => {
      logger.debug(
        "Registering resources and tools using shared services...",
        context,
      );
      await registerObsidianListNotesTool(server, obsidianService);
      await registerObsidianReadNoteTool(server, obsidianService);
      await registerObsidianDeleteNoteTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      if (vaultCacheService) {
        await registerObsidianGlobalSearchTool(
          server,
          obsidianService,
          vaultCacheService,
        );
      } else {
        logger.warning(
          "Skipping registration of 'obsidian_global_search' because the Vault Cache Service is disabled.",
          context,
        );
      }
      await registerObsidianSearchReplaceTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerObsidianUpdateNoteTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerObsidianManageFrontmatterTool(
        server,
        obsidianService,
        vaultCacheService,
      );
      await registerObsidianManageTagsTool(
        server,
        obsidianService,
        vaultCacheService,
      );

      logger.info("Resources and tools registered successfully", context);

      if (vaultCacheService) {
        logger.info(
          "Triggering background vault cache build (if not already built/building)...",
          context,
        );
        vaultCacheService.buildVaultCache().catch((cacheBuildError) => {
          logger.error(
            "Error occurred during background vault cache build",
            cacheBuildError,
            {
              ...context,
              subOperation: "BackgroundVaultCacheBuild",
            },
          );
        });
      }
    },
    {
      operation: "registerAllCapabilities",
      context,
      errorCode: BaseErrorCode.INITIALIZATION_FAILED,
      critical: true,
    },
  );

  return server;
}

/**
 * Selects, sets up, and starts the appropriate MCP transport layer based on configuration.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance.
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance.
 * @returns {Promise<McpServer | ServerType | void>} Resolves with the server instance or void.
 * @throws {Error} If transport type is unsupported or setup fails.
 * @private
 */
async function startTransport(
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<McpServer | ServerType | void> {
  const transportType = config.mcpTransportType;
  const context = requestContextService.createRequestContext({
    operation: "startTransport",
    transport: transportType,
  });
  logger.info(`Starting transport: ${transportType}`, context);

  const serverFactory = () =>
    createMcpServerInstance(obsidianService, vaultCacheService);

  if (transportType === "http") {
    const { server } = await startHttpTransport(serverFactory, context);
    return server;
  }

  if (transportType === "stdio") {
    const server = await serverFactory();
    await startStdioTransport(server, context);
    return server;
  }

  throw new Error(
    `Unsupported transport type: ${transportType}. Must be 'stdio' or 'http'.`,
  );
}

/**
 * Main application entry point. Initializes services and starts the MCP server.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance.
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance.
 * @returns {Promise<void | McpServer | ServerType>} Resolves with the server instance or void.
 */
export async function initializeAndStartServer(
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
): Promise<void | McpServer | ServerType> {
  const context = requestContextService.createRequestContext({
    operation: "initializeAndStartServer",
  });
  logger.info(
    "MCP Server initialization sequence started (services provided).",
    context,
  );

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

  try {
    const result = await startTransport(obsidianService, vaultCacheService);
    logger.info(
      "MCP Server initialization sequence completed successfully.",
      context,
    );
    return result;
  } catch (err) {
    ErrorHandler.handleError(err, {
      operation: "initializeAndStartServer",
      context: context,
      critical: true,
      rethrow: false,
    });
    logger.info(
      "Exiting process due to critical initialization error.",
      context,
    );
    process.exit(1);
  }
}

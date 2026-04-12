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
// Import validated configuration and environment details.
import { config, environment } from "../config/index.js";
// Import core utilities: ErrorHandler, logger, requestContextService.
import { ErrorHandler, logger, requestContextService } from "../utils/index.js";
// Import the Obsidian service
import { ObsidianRestApiService } from "../services/obsidianRestAPI/index.js";
// Import the Vault Cache service
import { VaultCacheService } from "../services/obsidianRestAPI/vaultCache/index.js";
// Import the Omnisearch service
import { OmnisearchService } from "../services/omnisearch/index.js";
// Import registration functions for specific resources and tools.
import { registerObsidianDeleteNoteTool } from "./tools/obsidianDeleteNoteTool/index.js";
import { registerObsidianGlobalSearchTool } from "./tools/obsidianGlobalSearchTool/index.js";
import { registerObsidianListNotesTool } from "./tools/obsidianListNotesTool/index.js";
import { registerObsidianOmnisearchTool } from "./tools/obsidianOmnisearchTool/index.js";
import { registerObsidianReadNoteTool } from "./tools/obsidianReadNoteTool/index.js";
import { registerObsidianSearchReplaceTool } from "./tools/obsidianSearchReplaceTool/index.js";
import { registerObsidianUpdateNoteTool } from "./tools/obsidianUpdateNoteTool/index.js";
import { registerObsidianManageFrontmatterTool } from "./tools/obsidianManageFrontmatterTool/index.js";
import { registerObsidianManageTagsTool } from "./tools/obsidianManageTagsTool/index.js";
// Import transport setup functions.
import { startHttpTransport } from "./transports/httpTransport.js";
import { connectStdioTransport } from "./transports/stdioTransport.js";

/**
 * Creates and configures a new instance of the `McpServer`.
 *
 * This function is central to defining the server's identity and functionality
 * as presented to connecting clients during the MCP initialization phase.
 * It uses pre-instantiated shared services like Obsidian API and Vault Cache.
 *
 * MCP Spec Relevance:
 * - Server Identity (`serverInfo`): The `name` and `version` provided here are part
 *   of the `ServerInformation` object returned in the `InitializeResult` message.
 * - Capabilities Declaration: Declares supported features (logging, dynamic resources/tools).
 * - Resource/Tool Registration: Calls registration functions, passing necessary service instances.
 *
 * Design Note: This factory is called once for 'stdio' transport and per session for 'http' transport.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance.
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance, which may be undefined if disabled.
 * @returns {Promise<McpServer>} A promise resolving with the configured `McpServer` instance.
 * @throws {Error} If any resource or tool registration fails.
 * @private
 */
async function createMcpServerInstance(
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
  omnisearchService: OmnisearchService,
): Promise<McpServer> {
  const context = requestContextService.createRequestContext({
    operation: "createMcpServerInstance",
  });
  logger.info("Initializing MCP server instance with shared services", context);

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

  logger.debug("Instantiating McpServer with capabilities", {
    ...context,
    serverInfo: {
      name: config.mcpServerName,
      version: config.mcpServerVersion,
    },
    capabilities: {
      logging: {},
      resources: { listChanged: true },
      tools: { listChanged: true },
    },
  });
  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    {
      capabilities: {
        logging: {}, // Server can receive logging/setLevel and send notifications/message
        resources: { listChanged: true }, // Server supports dynamic resource lists
        tools: { listChanged: true }, // Server supports dynamic tool lists
      },
    },
  );

  try {
    logger.debug(
      "Registering resources and tools using shared services...",
      context,
    );
    // Register all tools, passing the vaultCacheService which may be undefined
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
    await registerObsidianOmnisearchTool(server, omnisearchService);

    logger.info("Resources and tools registered successfully", context);

    if (vaultCacheService) {
      logger.info(
        "Triggering background vault cache build (if not already built/building)...",
        context,
      );
      // Intentionally not awaiting this promise to allow server startup to proceed.
      // Errors are logged within the catch block.
      vaultCacheService.buildVaultCache().catch((cacheBuildError) => {
        logger.error("Error occurred during background vault cache build", {
          ...context, // Use the initial context for correlation
          subOperation: "BackgroundVaultCacheBuild", // Add sub-operation for clarity
          error:
            cacheBuildError instanceof Error
              ? cacheBuildError.message
              : String(cacheBuildError),
          stack:
            cacheBuildError instanceof Error
              ? cacheBuildError.stack
              : undefined,
        });
      });
    }
  } catch (err) {
    logger.error("Failed to register resources/tools", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err; // Re-throw to be caught by the caller (e.g., startTransport)
  }

  return server;
}

/**
 * Selects, sets up, and starts the appropriate MCP transport layer based on configuration.
 * This function acts as the bridge between the core server logic and the communication channel.
 * It now accepts shared service instances to pass them down the chain.
 *
 * MCP Spec Relevance:
 * - Transport Selection: Uses `config.mcpTransportType` ('stdio' or 'http').
 * - Transport Connection: Calls dedicated functions for chosen transport.
 * - Server Instance Lifecycle: Single instance for 'stdio', per-session for 'http'.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance.
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance.
 * @returns {Promise<McpServer | void>} Resolves with the `McpServer` instance for 'stdio', or `void` for 'http'.
 * @throws {Error} If the configured transport type is unsupported or if transport setup fails.
 * @private
 */
async function startTransport(
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
  omnisearchService: OmnisearchService,
): Promise<McpServer | ServerType | void> {
  const transportType = config.mcpTransportType;
  const context = requestContextService.createRequestContext({
    operation: "startTransport",
    transport: transportType,
  });
  logger.info(`Starting transport: ${transportType}`, context);

  if (transportType === "http") {
    logger.debug(
      "Delegating to startHttpTransport with a factory for McpServer instances...",
      context,
    );
    // For HTTP, startHttpTransport manages its own lifecycle and server instances per session.
    // It needs a factory function to create new McpServer instances, passing along the shared services.
    const mcpServerFactory = async () =>
      createMcpServerInstance(
        obsidianService,
        vaultCacheService,
        omnisearchService,
      );
    const httpServerInstance = await startHttpTransport(
      mcpServerFactory,
      context,
    );
    return httpServerInstance; // Return the http.Server instance.
  }

  if (transportType === "stdio") {
    logger.debug(
      "Creating single McpServer instance for stdio transport using shared services...",
      context,
    );
    const server = await createMcpServerInstance(
      obsidianService,
      vaultCacheService,
      omnisearchService,
    );
    logger.debug("Delegating to connectStdioTransport...", context);
    await connectStdioTransport(server, context);
    return server; // Return the single server instance for stdio.
  }

  // Should not be reached if config validation is effective.
  logger.fatal(
    `Unsupported transport type configured: ${transportType}`,
    context,
  );
  throw new Error(
    `Unsupported transport type: ${transportType}. Must be 'stdio' or 'http'.`,
  );
}

/**
 * Main application entry point. Initializes services and starts the MCP server.
 * Orchestrates server startup, transport selection, and top-level error handling.
 *
 * MCP Spec Relevance:
 * - Manages server startup, leading to a server ready for MCP messages.
 * - Handles critical startup failures, ensuring appropriate process exit.
 *
 * @param {ObsidianRestApiService} obsidianService - The shared Obsidian REST API service instance, instantiated by the caller (e.g., index.ts).
 * @param {VaultCacheService | undefined} vaultCacheService - The shared Vault Cache service instance, instantiated by the caller (e.g., index.ts).
 * @returns {Promise<void | McpServer>} For 'stdio', resolves with `McpServer`. For 'http', runs indefinitely.
 *   Rejects on critical failure, leading to process exit.
 */
export async function initializeAndStartServer(
  obsidianService: ObsidianRestApiService,
  vaultCacheService: VaultCacheService | undefined,
  omnisearchService: OmnisearchService,
): Promise<void | McpServer | ServerType> {
  const context = requestContextService.createRequestContext({
    operation: "initializeAndStartServer",
  });
  logger.info(
    "MCP Server initialization sequence started (services provided).",
    context,
  );

  try {
    // Services are now provided by the caller (e.g., index.ts)
    logger.debug(
      "Using provided shared services (ObsidianRestApiService, VaultCacheService).",
      context,
    );

    // Initiate the transport setup based on configuration, passing shared services.
    const result = await startTransport(
      obsidianService,
      vaultCacheService,
      omnisearchService,
    );
    logger.info(
      "MCP Server initialization sequence completed successfully.",
      context,
    );
    return result;
  } catch (err) {
    logger.fatal("Critical error during MCP server initialization.", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Ensure the error is handled by our centralized handler, which might log more details or perform cleanup.
    ErrorHandler.handleError(err, {
      operation: "initializeAndStartServer", // More specific operation
      context: context, // Pass the existing context
      critical: true, // This is a critical failure
    });
    logger.info(
      "Exiting process due to critical initialization error.",
      context,
    );
    process.exit(1); // Exit with a non-zero code to indicate failure.
  }
}

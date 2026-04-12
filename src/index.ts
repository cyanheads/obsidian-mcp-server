#!/usr/bin/env node

// Imports MUST be at the top level
import { ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, environment } from "./config/index.js"; // This loads .env via dotenv.config()
import { initializeAndStartServer } from "./mcp-server/server.js";
import { requestContextService, retryWithDelay } from "./utils/index.js";
import { logger, McpLogLevel } from "./utils/internal/logger.js"; // Import logger instance early
// Import Services
import { ObsidianRestApiService } from "./services/obsidianRestAPI/index.js";
import { VaultCacheService } from "./services/obsidianRestAPI/vaultCache/index.js"; // Import VaultCacheService
import { OmnisearchService } from "./services/omnisearch/index.js";

/**
 * The main MCP server instance (only stored globally for stdio shutdown).
 * @type {McpServer | undefined}
 */
let server: McpServer | undefined;
/**
 * The main HTTP server instance (only stored globally for http shutdown).
 * @type {ServerType | undefined}
 */
let httpServerInstance: ServerType | undefined;
/**
 * Shared Obsidian REST API service instance.
 * @type {ObsidianRestApiService | undefined}
 */
let obsidianService: ObsidianRestApiService | undefined;
/**
 * Shared Vault Cache service instance.
 * @type {VaultCacheService | undefined}
 */
let vaultCacheService: VaultCacheService | undefined;

/**
 * Gracefully shuts down the main MCP server.
 * Handles process termination signals (SIGTERM, SIGINT) and critical errors.
 *
 * @param signal - The signal or event name that triggered the shutdown (e.g., "SIGTERM", "uncaughtException").
 */
const shutdown = async (signal: string) => {
  // Define context for the shutdown operation
  const shutdownContext = requestContextService.createRequestContext({
    operation: "Shutdown",
    signal,
  });

  logger.info(
    `Received ${signal}. Starting graceful shutdown...`,
    shutdownContext,
  );

  try {
    // Stop cache refresh timer first
    if (config.obsidianEnableCache && vaultCacheService) {
      vaultCacheService.stopPeriodicRefresh();
    }

    // Close the main MCP server (only relevant for stdio)
    if (server) {
      logger.info("Closing main MCP server (stdio)...", shutdownContext);
      await server.close();
      logger.info(
        "Main MCP server (stdio) closed successfully",
        shutdownContext,
      );
    }

    // Close the main HTTP server instance (if it exists)
    if (httpServerInstance) {
      logger.info("Closing main HTTP server...", shutdownContext);
      await new Promise<void>((resolve, reject) => {
        httpServerInstance!.close((err?: Error) => {
          if (err) {
            logger.error("Error closing HTTP server", err, shutdownContext);
            reject(err);
            return;
          }
          logger.info("Main HTTP server closed successfully", shutdownContext);
          resolve();
        });
      });
    }

    if (!server && !httpServerInstance) {
      logger.warning(
        "No server instance (Stdio or HTTP) found to close during shutdown.",
        shutdownContext,
      );
    }

    // Add any other necessary cleanup here (e.g., closing database connections if added later)

    logger.info("Graceful shutdown completed successfully", shutdownContext);
    process.exit(0);
  } catch (error) {
    // Handle any errors during shutdown
    logger.error(
      "Critical error during shutdown",
      error instanceof Error ? error : undefined,
      {
        ...shutdownContext, // Spread the existing RequestContext
        // error field is handled by logger.error's second argument
      },
    );
    process.exit(1); // Exit with error code if shutdown fails
  }
};

/**
 * Initializes and starts the main MCP server.
 * Sets up request context, initializes the server instance, starts the transport,
 * and registers signal handlers for graceful shutdown and error handling.
 */
const start = async () => {
  // --- Logger Initialization (Moved here AFTER config/dotenv is loaded) ---
  const validMcpLogLevels: McpLogLevel[] = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "crit",
    "alert",
    "emerg",
  ];
  // Read level from config (which read from env var or default)
  const initialLogLevelConfig = config.logLevel;
  // Validate the configured log level
  let validatedMcpLogLevel: McpLogLevel = "info"; // Default to 'info'
  if (validMcpLogLevels.includes(initialLogLevelConfig as McpLogLevel)) {
    validatedMcpLogLevel = initialLogLevelConfig as McpLogLevel;
  } else {
    // Use console.warn here as logger isn't initialized yet
    console.warn(
      `Invalid MCP_LOG_LEVEL "${initialLogLevelConfig}" provided via config/env. Defaulting to "info".`,
    );
  }
  // Initialize the logger with the validated MCP level and wait for it to complete.
  await logger.initialize(validatedMcpLogLevel);
  // Log initialization message using the logger itself (will go to file/console)
  logger.info(
    `Logger initialized by start(). MCP logging level: ${validatedMcpLogLevel}`,
  );
  // --- End Logger Initialization ---

  // Log that config is loaded (this was previously done earlier)
  logger.debug(
    "Configuration loaded successfully",
    requestContextService.createRequestContext({
      configLoaded: true,
      configSummary: {
        serverName: config.mcpServerName,
        transport: config.mcpTransportType,
        logLevel: config.logLevel,
      },
    }),
  );

  // Create application-level request context using the service instance
  // Use the validated transport type from the config object
  const transportType = config.mcpTransportType;
  const startupContext = requestContextService.createRequestContext({
    operation: `ServerStartup_${transportType}`, // Include transport in operation name
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment: environment,
  });

  logger.info(
    `Starting ${config.mcpServerName} v${config.mcpServerVersion} (Transport: ${transportType})...`,
    startupContext,
  );

  try {
    // --- Instantiate Shared Services ---
    logger.debug("Instantiating shared services...", startupContext);
    obsidianService = new ObsidianRestApiService(); // Instantiate Obsidian Service

    // --- Perform Initial Obsidian API Status Check ---
    try {
      logger.info(
        "Performing initial Obsidian API status check with retries...",
        startupContext,
      );

      const status = await retryWithDelay(
        async () => {
          if (!obsidianService) {
            // This case should not happen in practice, but it satisfies the type checker.
            throw new Error("Obsidian service not initialized.");
          }
          const checkStatusContext = {
            ...startupContext,
            operation: "checkStatusAttempt",
          };
          const currentStatus =
            await obsidianService.checkStatus(checkStatusContext);
          if (
            currentStatus?.service !== "Obsidian Local REST API" ||
            !currentStatus?.authenticated
          ) {
            // Throw an error to trigger a retry
            throw new Error(
              `Obsidian API status check failed or indicates authentication issue. Status: ${JSON.stringify(
                currentStatus,
              )}`,
            );
          }
          return currentStatus;
        },
        {
          operationName: "initialObsidianApiCheck",
          context: startupContext,
          maxRetries: 5, // Retry up to 5 times
          delayMs: 3000, // Wait 3 seconds between retries
        },
      );

      logger.info("Obsidian API status check successful.", {
        ...startupContext,
        obsidianVersion: status.versions.obsidian,
        pluginVersion: status.versions.self,
      });
    } catch (statusError) {
      logger.error(
        "Critical error during initial Obsidian API status check after multiple retries. Check OBSIDIAN_BASE_URL, OBSIDIAN_API_KEY, and plugin status.",
        {
          ...startupContext,
          error:
            statusError instanceof Error
              ? statusError.message
              : String(statusError),
          stack: statusError instanceof Error ? statusError.stack : undefined,
        },
      );
      // Re-throw the final error to be caught by the main startup catch block, which will exit the process.
      throw statusError;
    }
    // --- End Status Check ---

    if (config.obsidianEnableCache) {
      vaultCacheService = new VaultCacheService(obsidianService); // Instantiate Cache Service, passing Obsidian Service
      logger.info(
        "Vault cache is enabled and service is instantiated.",
        startupContext,
      );
    } else {
      logger.info("Vault cache is disabled by configuration.", startupContext);
    }

    const omnisearchService = new OmnisearchService(
      config.obsidianOmnisearchBaseUrl,
    );
    logger.info(
      `Omnisearch service instantiated (baseUrl: ${config.obsidianOmnisearchBaseUrl}).`,
      startupContext,
    );

    logger.info("Shared services instantiated.", startupContext);
    // --- End Service Instantiation ---

    // Initialize the server instance and start the selected transport
    logger.debug(
      "Initializing and starting MCP server transport",
      startupContext,
    );

    // Start the server transport. Services are instantiated here and passed down.
    // For stdio, this returns the McpServer instance.
    // For http, it returns the http.Server instance.
    const serverOrHttpInstance = await initializeAndStartServer(
      obsidianService,
      vaultCacheService,
      omnisearchService,
    );

    if (
      transportType === "stdio" &&
      serverOrHttpInstance instanceof McpServer
    ) {
      server = serverOrHttpInstance; // Store McpServer for stdio
      logger.debug(
        "Stored McpServer instance for stdio transport.",
        startupContext,
      );
    } else if (transportType === "http" && serverOrHttpInstance) {
      // The instance is of ServerType (http.Server or https.Server)
      httpServerInstance = serverOrHttpInstance as ServerType; // Store ServerType for http transport
      logger.debug(
        "Stored http.Server instance for http transport.",
        startupContext,
      );
    } else if (transportType === "http") {
      // This case should ideally not be reached if startHttpTransport always returns an http.Server
      logger.warning(
        "HTTP transport selected, but initializeAndStartServer did not return an http.Server instance.",
        startupContext,
      );
    }

    // If initializeAndStartServer failed, it would have thrown an error,
    // and execution would jump to the outer catch block.

    logger.info(
      `${config.mcpServerName} is running with ${transportType} transport`,
      {
        ...startupContext,
        startTime: new Date().toISOString(),
      },
    );

    // --- Trigger Background Cache Build ---
    if (config.obsidianEnableCache && vaultCacheService) {
      // Start building the cache, but don't wait for it to finish.
      // The server will be operational while the cache builds.
      // Tools needing the cache should check its readiness state.
      logger.info("Triggering background vault cache build...", startupContext);
      // No 'await' here - run in background
      vaultCacheService
        .buildVaultCache()
        .then(() => {
          // Once the initial build is done, start the periodic refresh
          vaultCacheService?.startPeriodicRefresh();
        })
        .catch((cacheBuildError) => {
          // Log errors during the background build process
          logger.error("Error occurred during background vault cache build", {
            ...startupContext, // Use startup context for correlation
            operation: "BackgroundCacheBuild",
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
    // --- End Cache Build Trigger ---

    // --- Signal and Error Handling Setup ---

    // Handle process signals for graceful shutdown
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Handle uncaught exceptions
    process.on("uncaughtException", async (error) => {
      const errorContext = {
        ...startupContext, // Include base context for correlation
        event: "uncaughtException",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      logger.error(
        "Uncaught exception detected. Initiating shutdown...",
        errorContext,
      );
      // Attempt graceful shutdown; shutdown() handles its own errors.
      await shutdown("uncaughtException");
      // If shutdown fails internally, it will call process.exit(1).
      // If shutdown succeeds, it calls process.exit(0).
      // If shutdown itself throws unexpectedly *before* exiting, this process might terminate abruptly,
      // but the core shutdown logic is handled within shutdown().
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", async (reason: unknown) => {
      const rejectionContext = {
        ...startupContext, // Include base context for correlation
        event: "unhandledRejection",
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      };
      logger.error(
        "Unhandled promise rejection detected. Initiating shutdown...",
        rejectionContext,
      );
      // Attempt graceful shutdown; shutdown() handles its own errors.
      await shutdown("unhandledRejection");
      // Similar logic as uncaughtException: shutdown handles its exit codes.
    });
  } catch (error) {
    // Handle critical startup errors (already logged by ErrorHandler or caught above)
    // Log the final failure context, including error details, before exiting
    logger.error("Critical error during startup, exiting.", {
      ...startupContext,
      finalErrorContext: "Startup Failure",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
};

// --- Async IIFE to allow top-level await ---
// This remains necessary because start() is async
(async () => {
  // Start the application
  await start();
})(); // End async IIFE

/**
 * @fileoverview Configures and starts the HTTP MCP transport using Hono.
 * This file has been refactored to correctly integrate Hono's streaming
 * capabilities with the Model Context Protocol SDK's transport layer.
 * @module src/mcp-server/transports/http/httpTransport
 */

import { serve, ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Context, Hono, Next } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import http from "http";
import { config } from "../../../config/index.js";
import {
  logger,
  rateLimiter,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { createAuthMiddleware, createAuthStrategy } from "../auth/index.js";
import { StatefulTransportManager } from "../core/statefulTransportManager.js";
import { StatelessTransportManager } from "../core/statelessTransportManager.js";
import { TransportManager } from "../core/transportTypes.js";
import { httpErrorHandler } from "./httpErrorHandler.js";
import { HonoNodeBindings } from "./httpTypes.js";
import { mcpTransportMiddleware } from "./mcpTransportMiddleware.js";

const HTTP_PORT = config.mcpHttpPort;
const HTTP_HOST = config.mcpHttpHost;
const MCP_ENDPOINT_PATH = config.mcpHttpEndpointPath;

/**
 * Converts a Fetch API Headers object to Node.js IncomingHttpHeaders.
 * Hono uses Fetch API Headers, but the underlying transport managers expect
 * Node's native IncomingHttpHeaders.
 * @param headers - The Headers object to convert.
 * @returns An object compatible with IncomingHttpHeaders.
 */

async function isPortInUse(
  port: number,
  host: string,
  parentContext: RequestContext,
): Promise<boolean> {
  const context = { ...parentContext, operation: "isPortInUse", port, host };
  logger.debug(`Checking if port ${port} is in use...`, context);
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once("error", (err: NodeJS.ErrnoException) => {
        const inUse = err.code === "EADDRINUSE";
        logger.debug(
          `Port check resulted in error: ${err.code}. Port in use: ${inUse}`,
          context,
        );
        resolve(inUse);
      })
      .once("listening", () => {
        logger.debug(
          `Successfully bound to port ${port} temporarily. Port is not in use.`,
          context,
        );
        tempServer.close(() => resolve(false));
      })
      .listen(port, host);
  });
}

function startHttpServerWithRetry(
  app: Hono<{ Bindings: HonoNodeBindings }>,
  initialPort: number,
  host: string,
  maxRetries: number,
  parentContext: RequestContext,
): Promise<ServerType> {
  const startContext = {
    ...parentContext,
    operation: "startHttpServerWithRetry",
  };
  logger.info(
    `Attempting to start HTTP server on port ${initialPort} with ${maxRetries} retries.`,
    startContext,
  );

  return new Promise((resolve, reject) => {
    const tryBind = (port: number, attempt: number) => {
      const attemptContext = { ...startContext, port, attempt };
      if (attempt > maxRetries + 1) {
        const error = new Error(
          `Failed to bind to any port after ${maxRetries} retries.`,
        );
        logger.fatal(error.message, attemptContext);
        return reject(error);
      }

      isPortInUse(port, host, attemptContext)
        .then((inUse) => {
          if (inUse) {
            logger.warning(
              `Port ${port} is in use, retrying on port ${port + 1}...`,
              attemptContext,
            );
            setTimeout(
              () => tryBind(port + 1, attempt + 1),
              config.mcpHttpPortRetryDelayMs,
            );
            return;
          }

          try {
            const serverInstance = serve(
              { fetch: app.fetch, port, hostname: host },
              (info: { address: string; port: number }) => {
                const serverAddress = `http://${info.address}:${info.port}${MCP_ENDPOINT_PATH}`;
                logger.info(`HTTP transport listening at ${serverAddress}`, {
                  ...attemptContext,
                  address: serverAddress,
                  sessionMode: config.mcpSessionMode,
                });
                if (process.stdout.isTTY) {
                  console.log(`\n🚀 MCP Server running at: ${serverAddress}`);
                  console.log(`   Session Mode: ${config.mcpSessionMode}\n`);
                }
              },
            );
            resolve(serverInstance);
          } catch (err: unknown) {
            if (
              err &&
              typeof err === "object" &&
              "code" in err &&
              (err as { code: string }).code !== "EADDRINUSE"
            ) {
              const errorToLog =
                err instanceof Error ? err : new Error(String(err));
              logger.error(
                "An unexpected error occurred while starting the server.",
                errorToLog,
                attemptContext,
              );
              return reject(err);
            }
            logger.warning(
              `Encountered EADDRINUSE race condition on port ${port}, retrying...`,
              attemptContext,
            );
            setTimeout(
              () => tryBind(port + 1, attempt + 1),
              config.mcpHttpPortRetryDelayMs,
            );
          }
        })
        .catch((err) => {
          logger.fatal(
            "Failed to check if port is in use.",
            err,
            attemptContext,
          );
          reject(err);
        });
    };

    tryBind(initialPort, 1);
  });
}

function createTransportManager(
  createServerInstanceFn: () => Promise<McpServer>,
  sessionMode: string,
  context: RequestContext,
): TransportManager {
  const opContext = {
    ...context,
    operation: "createTransportManager",
    sessionMode,
  };
  logger.info(
    `Creating transport manager for session mode: ${sessionMode}`,
    opContext,
  );
  switch (sessionMode) {
    case "stateless":
      return new StatelessTransportManager(createServerInstanceFn);
    case "stateful":
      return new StatefulTransportManager(createServerInstanceFn);
    case "auto":
    default:
      logger.info(
        "Defaulting to 'auto' mode (stateful with stateless fallback).",
        opContext,
      );
      return new StatefulTransportManager(createServerInstanceFn);
  }
}

export function createHttpApp(
  transportManager: TransportManager,
  createServerInstanceFn: () => Promise<McpServer>,
  parentContext: RequestContext,
): Hono<{ Bindings: HonoNodeBindings }> {
  const app = new Hono<{ Bindings: HonoNodeBindings }>();
  const transportContext = {
    ...parentContext,
    component: "HttpTransportSetup",
  };
  logger.info("Creating Hono HTTP application.", transportContext);

  app.use(
    "*",
    cors({
      origin: config.mcpAllowedOrigins || [],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Mcp-Session-Id",
        "Last-Event-ID",
        "Authorization",
      ],
      credentials: true,
    }),
  );

  app.use(
    "*",
    async (c: Context<{ Bindings: HonoNodeBindings }>, next: Next) => {
      (c.env.outgoing as http.ServerResponse).setHeader(
        "X-Content-Type-Options",
        "nosniff",
      );
      await next();
    },
  );

  app.use(
    MCP_ENDPOINT_PATH,
    async (c: Context<{ Bindings: HonoNodeBindings }>, next: Next) => {
      const clientIp =
        c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown_ip";
      const context = requestContextService.createRequestContext({
        operation: "httpRateLimitCheck",
        ipAddress: clientIp,
      });
      try {
        rateLimiter.check(clientIp, context);
        logger.debug("Rate limit check passed.", context);
      } catch (error) {
        logger.warning("Rate limit check failed.", {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      await next();
    },
  );

  const authStrategy = createAuthStrategy();
  if (authStrategy) {
    logger.info(
      "Authentication strategy found, enabling auth middleware.",
      transportContext,
    );
    app.use(MCP_ENDPOINT_PATH, createAuthMiddleware(authStrategy));
  } else {
    logger.info(
      "No authentication strategy found, auth middleware disabled.",
      transportContext,
    );
  }

  app.onError(httpErrorHandler);

  app.get("/healthz", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.get(MCP_ENDPOINT_PATH, (c: Context<{ Bindings: HonoNodeBindings }>) => {
    const sessionId = c.req.header("mcp-session-id");
    if (sessionId) {
      return c.text(
        "GET requests to existing sessions are not supported.",
        405,
      );
    }
    return c.json({
      status: "ok",
      mode: "stateless",
      message:
        "Server is running. Provide a Mcp-Session-Id header to stream from a session.",
    });
  });

  app.post(
    MCP_ENDPOINT_PATH,
    mcpTransportMiddleware(transportManager, createServerInstanceFn),
    (c) => {
      const response = c.get("mcpResponse");

      if (response.sessionId) {
        c.header("Mcp-Session-Id", response.sessionId);
      }
      response.headers.forEach((value, key) => {
        c.header(key, value);
      });

      c.status(response.statusCode);

      if (response.stream) {
        return stream(c, async (s) => {
          if (response.stream) {
            await s.pipe(response.stream);
          }
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return c.json(response.body as any);
      }
    },
  );

  app.delete(
    MCP_ENDPOINT_PATH,
    async (c: Context<{ Bindings: HonoNodeBindings }>) => {
      const sessionId = c.req.header("mcp-session-id");
      const context = requestContextService.createRequestContext({
        ...transportContext,
        operation: "handleDeleteRequest",
        sessionId,
      });

      if (sessionId) {
        if (transportManager instanceof StatefulTransportManager) {
          const response = await transportManager.handleDeleteRequest(
            sessionId,
            context,
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return c.json(response.body as any, response.statusCode);
        } else {
          return c.json(
            {
              error: "Method Not Allowed",
              message: "DELETE operations are not supported in this mode.",
            },
            405,
          );
        }
      } else {
        return c.json({
          status: "stateless_mode",
          message: "No sessions to delete in stateless mode",
        });
      }
    },
  );

  logger.info("Hono application setup complete.", transportContext);
  return app;
}

export async function startHttpTransport(
  createServerInstanceFn: () => Promise<McpServer>,
  parentContext: RequestContext,
): Promise<{
  app: Hono<{ Bindings: HonoNodeBindings }>;
  server: ServerType;
  transportManager: TransportManager;
}> {
  const transportContext = {
    ...parentContext,
    component: "HttpTransportStart",
  };
  logger.info("Starting HTTP transport.", transportContext);

  const transportManager = createTransportManager(
    createServerInstanceFn,
    config.mcpSessionMode,
    transportContext,
  );
  const app = createHttpApp(
    transportManager,
    createServerInstanceFn,
    transportContext,
  );

  const server = await startHttpServerWithRetry(
    app,
    HTTP_PORT,
    HTTP_HOST,
    config.mcpHttpMaxPortRetries,
    transportContext,
  );

  logger.info("HTTP transport started successfully.", transportContext);
  return { app, server, transportManager };
}

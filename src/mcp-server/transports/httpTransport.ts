/**
 * @fileoverview Configures and starts the Streamable HTTP MCP transport using Hono.
 * This module integrates the `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`
 * into a Hono web server. Its responsibilities include:
 * - Creating a Hono server instance.
 * - Applying and configuring middleware for CORS, rate limiting, and authentication (JWT/OAuth).
 * - Defining the routes (`/mcp` endpoint for POST, GET, DELETE) to handle the MCP lifecycle.
 * - Orchestrating session management by mapping session IDs to SDK transport instances.
 * - Implementing port-binding logic with automatic retry on conflicts.
 *
 * The underlying implementation of the MCP Streamable HTTP specification, including
 * Server-Sent Events (SSE) for streaming, is handled by the SDK's transport class.
 *
 * Specification Reference:
 * https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/transports.mdx#streamable-http
 * @module src/mcp-server/transports/httpTransport
 */

import { HttpBindings, serve, ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Context, Hono, Next } from "hono";
import { cors } from "hono/cors";
import http from "http";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  logger,
  rateLimiter,
  RequestContext,
  requestContextService,
} from "../../utils/index.js";
import {
  jwtAuthMiddleware,
  oauthMiddleware,
  type AuthInfo,
} from "./auth/index.js";
import { httpErrorHandler } from "./httpErrorHandler.js";

const HTTP_PORT = config.mcpHttpPort;
const HTTP_HOST = config.mcpHttpHost;
const MCP_ENDPOINT_PATH = "/mcp";
const MAX_PORT_RETRIES = 15;

// The transports map will store active sessions, keyed by session ID.
// NOTE: This is an in-memory session store, which is a known limitation for scalability.
// It will not work in a multi-process (clustered) or serverless environment.
// For a scalable deployment, this would need to be replaced with a distributed
// store like Redis or Memcached.
const transports: Record<string, StreamableHTTPServerTransport> = {};

async function isPortInUse(
  port: number,
  host: string,
  parentContext: RequestContext,
): Promise<boolean> {
  const checkContext = requestContextService.createRequestContext({
    ...parentContext,
    operation: "isPortInUse",
    port,
    host,
  });
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once("error", (err: NodeJS.ErrnoException) => {
        resolve(err.code === "EADDRINUSE");
      })
      .once("listening", () => {
        tempServer.close(() => resolve(false));
      })
      .listen(port, host);
  });
}

function startHttpServerWithRetry(
  app: Hono<{ Bindings: HttpBindings }>,
  initialPort: number,
  host: string,
  maxRetries: number,
  parentContext: RequestContext,
): Promise<ServerType> {
  const startContext = requestContextService.createRequestContext({
    ...parentContext,
    operation: "startHttpServerWithRetry",
  });

  return new Promise(async (resolve, reject) => {
    for (let i = 0; i <= maxRetries; i++) {
      const currentPort = initialPort + i;
      const attemptContext = {
        ...startContext,
        port: currentPort,
        attempt: i + 1,
      };

      if (await isPortInUse(currentPort, host, attemptContext)) {
        logger.warning(
          `Port ${currentPort} is in use, retrying...`,
          attemptContext,
        );
        continue;
      }

      try {
        const serverInstance = serve(
          { fetch: app.fetch, port: currentPort, hostname: host },
          (info: { address: string; port: number }) => {
            const serverAddress = `http://${info.address}:${info.port}${MCP_ENDPOINT_PATH}`;
            logger.info(`HTTP transport listening at ${serverAddress}`, {
              ...attemptContext,
              address: serverAddress,
            });
            if (process.stdout.isTTY) {
              console.log(`\n🚀 MCP Server running at: ${serverAddress}\n`);
            }
          },
        );
        resolve(serverInstance);
        return;
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          reject(err);
          return;
        }
      }
    }
    reject(new Error("Failed to bind to any port after multiple retries."));
  });
}

export async function startHttpTransport(
  createServerInstanceFn: () => Promise<McpServer>,
  parentContext: RequestContext,
): Promise<ServerType> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const transportContext = requestContextService.createRequestContext({
    ...parentContext,
    component: "HttpTransportSetup",
  });

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

  app.use("*", async (c: Context, next: Next) => {
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    await next();
  });

  app.use(MCP_ENDPOINT_PATH, async (c: Context, next: Next) => {
    // NOTE (Security): The 'x-forwarded-for' header is used for rate limiting.
    // This is only secure if the server is run behind a trusted proxy that
    // correctly sets or validates this header.
    const clientIp =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown_ip";
    const context = requestContextService.createRequestContext({
      operation: "httpRateLimitCheck",
      ipAddress: clientIp,
    });
    // Let the centralized error handler catch rate limit errors
    rateLimiter.check(clientIp, context);
    await next();
  });

  if (config.mcpAuthMode === "oauth") {
    app.use(MCP_ENDPOINT_PATH, oauthMiddleware);
  } else {
    app.use(MCP_ENDPOINT_PATH, jwtAuthMiddleware);
  }

  // Centralized Error Handling
  app.onError(httpErrorHandler);

  app.post(MCP_ENDPOINT_PATH, async (c: Context) => {
    const postContext = requestContextService.createRequestContext({
      ...transportContext,
      operation: "handlePost",
    });
    const body = await c.req.json();
    const sessionId = c.req.header("mcp-session-id");
    let transport: StreamableHTTPServerTransport | undefined = sessionId
      ? transports[sessionId]
      : undefined;

    if (isInitializeRequest(body)) {
      // If a transport already exists for a session, it's a re-initialization.
      if (transport) {
        logger.warning("Re-initializing existing session.", {
          ...postContext,
          sessionId,
        });
        await transport.close(); // This will trigger the onclose handler.
      }

      // Create a new transport for a new session.
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId) => {
          transports[newId] = newTransport;
          logger.info(`HTTP Session created: ${newId}`, {
            ...postContext,
            newSessionId: newId,
          });
        },
      });

      // Set up cleanup logic for when the transport is closed.
      newTransport.onclose = () => {
        const closedSessionId = newTransport.sessionId;
        if (closedSessionId && transports[closedSessionId]) {
          delete transports[closedSessionId];
          logger.info(`HTTP Session closed: ${closedSessionId}`, {
            ...postContext,
            closedSessionId,
          });
        }
      };

      // Connect the new transport to a new server instance.
      const server = await createServerInstanceFn();
      await server.connect(newTransport);
      transport = newTransport;
    } else if (!transport) {
      // If it's not an initialization request and no transport was found, it's an error.
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "Invalid or expired session ID.",
      );
    }

    // Pass the request to the transport to handle.
    // The transport writes directly to the Node.js ServerResponse (c.env.outgoing).
    // We must signal to @hono/node-server that the response is already handled,
    // otherwise it will try to write headers again, causing ERR_HTTP_HEADERS_SENT.
    await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
    return new Response(null, { headers: { "x-hono-already-sent": "true" } });
  });

  // A reusable handler for GET and DELETE requests which operate on existing sessions.
  const handleSessionRequest = async (
    c: Context<{ Bindings: HttpBindings }>,
  ) => {
    const sessionId = c.req.header("mcp-session-id");
    const transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "Session not found or expired.",
      );
    }

    // Let the transport handle the streaming (GET) or termination (DELETE) request.
    await transport.handleRequest(c.env.incoming, c.env.outgoing);
    return new Response(null, { headers: { "x-hono-already-sent": "true" } });
  };

  app.get(MCP_ENDPOINT_PATH, handleSessionRequest);
  app.delete(MCP_ENDPOINT_PATH, handleSessionRequest);

  return startHttpServerWithRetry(
    app,
    HTTP_PORT,
    HTTP_HOST,
    MAX_PORT_RETRIES,
    transportContext,
  );
}

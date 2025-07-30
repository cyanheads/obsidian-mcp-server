/**
 * @fileoverview Stateful Transport Manager implementation for MCP SDK.
 * This manager handles multiple, persistent sessions, creating a dedicated
 * McpServer and StreamableHTTPServerTransport instance for each one.
 * This version is adapted for Hono by bridging the SDK's Node.js-style
 * request handling with Hono's stream-based response model.
 * @module src/mcp-server/transports/core/statefulTransportManager
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingHttpHeaders, ServerResponse } from "http";
import { randomUUID } from "node:crypto";
import { Readable } from "stream";
import { config } from "../../../config/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { BaseTransportManager } from "./baseTransportManager.js";
import { HonoStreamResponse } from "./honoNodeBridge.js";
import {
  HttpStatusCode,
  StatefulTransportManager as IStatefulTransportManager,
  TransportResponse,
  TransportSession,
} from "./transportTypes.js";

/**
 * Stateful Transport Manager that handles MCP SDK integration and session management
 * for a Hono-based HTTP server.
 */
export class StatefulTransportManager
  extends BaseTransportManager
  implements IStatefulTransportManager
{
  private readonly transports = new Map<
    string,
    StreamableHTTPServerTransport
  >();
  private readonly servers = new Map<string, McpServer>();
  private readonly sessions = new Map<string, TransportSession>();
  private readonly garbageCollector: NodeJS.Timeout;

  constructor(createServerInstanceFn: () => Promise<McpServer>) {
    super(createServerInstanceFn);
    const context = requestContextService.createRequestContext({
      operation: "StatefulTransportManager.constructor",
    });
    logger.info("Starting session garbage collector.", context);
    this.garbageCollector = setInterval(
      () => this.cleanupStaleSessions(),
      config.mcpStatefulSessionStaleTimeoutMs,
    );
  }

  async initializeAndHandle(
    headers: IncomingHttpHeaders,
    body: unknown,
    context: RequestContext,
  ): Promise<TransportResponse> {
    const operationName = "StatefulTransportManager.initializeAndHandle";
    const opContext = { ...context, operation: operationName };
    logger.debug("Initializing new stateful session.", opContext);

    const server = await this.createServerInstanceFn();
    const mockRes = new HonoStreamResponse() as unknown as ServerResponse;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        const sessionContext = { ...opContext, sessionId };
        this.transports.set(sessionId, transport);
        this.servers.set(sessionId, server);
        this.sessions.set(sessionId, {
          id: sessionId,
          createdAt: new Date(),
          lastAccessedAt: new Date(),
        });
        logger.info(`MCP Session created: ${sessionId}`, sessionContext);
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        const closeContext = requestContextService.createRequestContext({
          operation: "StatefulTransportManager.transport.onclose",
          sessionId,
        });
        this.closeSession(sessionId, closeContext).catch((err) =>
          logger.error(
            `Error during transport.onclose cleanup for session ${sessionId}`,
            err,
            closeContext,
          ),
        );
      }
    };

    await server.connect(transport);
    logger.debug(
      "Server connected to transport, handling initial request.",
      opContext,
    );

    const mockReq = {
      headers,
      method: "POST",
      url: config.mcpHttpEndpointPath,
    } as import("http").IncomingMessage;
    await transport.handleRequest(mockReq, mockRes, body);

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(mockRes.getHeaders())) {
      responseHeaders.set(
        key,
        Array.isArray(value) ? value.join(", ") : String(value),
      );
    }
    if (transport.sessionId) {
      responseHeaders.set("Mcp-Session-Id", transport.sessionId);
    }

    const webStream = Readable.toWeb(
      mockRes as unknown as HonoStreamResponse,
    ) as ReadableStream<Uint8Array>;

    return {
      headers: responseHeaders,
      statusCode: mockRes.statusCode as HttpStatusCode,
      stream: webStream,
      sessionId: transport.sessionId,
    };
  }

  async handleRequest(
    headers: IncomingHttpHeaders,
    body: unknown,
    context: RequestContext,
    sessionId?: string,
  ): Promise<TransportResponse> {
    if (!sessionId) {
      throw new McpError(
        BaseErrorCode.INVALID_INPUT,
        "Session ID is required for stateful requests.",
        context,
      );
    }
    const sessionContext = {
      ...context,
      sessionId,
      operation: "StatefulTransportManager.handleRequest",
    };
    logger.debug(`Handling request for session: ${sessionId}`, {
      ...sessionContext,
      method: headers["x-forwarded-proto"] || "http",
    });

    const transport = this.transports.get(sessionId);
    if (!transport) {
      logger.warning(
        `Request for non-existent session: ${sessionId}`,
        sessionContext,
      );
      return {
        headers: new Headers({ "Content-Type": "application/json" }),
        statusCode: 404,
        body: {
          jsonrpc: "2.0",
          error: { code: -32601, message: "Session not found" },
        },
      };
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = new Date();
      logger.debug(
        `Updated lastAccessedAt for session ${sessionId}.`,
        sessionContext,
      );
    }

    const mockReq = {
      headers,
      method: "POST",
    } as import("http").IncomingMessage;
    const mockRes = new HonoStreamResponse() as unknown as ServerResponse;

    await transport.handleRequest(mockReq, mockRes, body);

    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(mockRes.getHeaders())) {
      responseHeaders.set(
        key,
        Array.isArray(value) ? value.join(", ") : String(value),
      );
    }

    const webStream = Readable.toWeb(
      mockRes as unknown as HonoStreamResponse,
    ) as ReadableStream<Uint8Array>;

    return {
      headers: responseHeaders,
      statusCode: mockRes.statusCode as HttpStatusCode,
      stream: webStream,
      sessionId: transport.sessionId,
    };
  }

  async handleDeleteRequest(
    sessionId: string,
    context: RequestContext,
  ): Promise<TransportResponse> {
    const sessionContext = {
      ...context,
      sessionId,
      operation: "StatefulTransportManager.handleDeleteRequest",
    };
    logger.info(`Attempting to delete session: ${sessionId}`, sessionContext);

    const transport = this.transports.get(sessionId);
    if (!transport) {
      logger.warning(
        `Attempted to delete non-existent session: ${sessionId}`,
        sessionContext,
      );
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        "Session not found or expired.",
        sessionContext,
      );
    }

    await this.closeSession(sessionId, sessionContext);

    const headers = new Headers();
    headers.set("Content-Type", "application/json");

    return {
      headers,
      statusCode: 200 as HttpStatusCode,
      body: { status: "session_closed", sessionId },
    };
  }

  getSession(sessionId: string): TransportSession | undefined {
    const context = requestContextService.createRequestContext({
      operation: "StatefulTransportManager.getSession",
      sessionId,
    });
    logger.debug(`Retrieving session: ${sessionId}`, context);
    return this.sessions.get(sessionId);
  }

  async shutdown(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: "StatefulTransportManager.shutdown",
    });
    logger.info("Shutting down stateful transport manager...", context);
    clearInterval(this.garbageCollector);
    logger.debug("Garbage collector stopped.", context);

    const sessionIds = Array.from(this.transports.keys());
    logger.info(`Closing ${sessionIds.length} active sessions.`, context);

    const closePromises = sessionIds.map((sessionId) =>
      this.closeSession(sessionId, context),
    );

    await Promise.all(closePromises);
    this.transports.clear();
    this.sessions.clear();
    this.servers.clear();
    logger.info("All active sessions closed and manager shut down.", context);
  }

  private async closeSession(
    sessionId: string,
    context: RequestContext,
  ): Promise<void> {
    const sessionContext = {
      ...context,
      sessionId,
      operation: "StatefulTransportManager.closeSession",
    };
    logger.debug(`Closing session: ${sessionId}`, sessionContext);

    const transport = this.transports.get(sessionId);
    const server = this.servers.get(sessionId);

    await ErrorHandler.tryCatch(
      async () => {
        if (transport) {
          await transport.close();
          logger.debug(
            `Transport closed for session ${sessionId}.`,
            sessionContext,
          );
        }
        if (server) {
          await server.close();
          logger.debug(
            `Server instance closed for session ${sessionId}.`,
            sessionContext,
          );
        }
      },
      {
        operation: "closeSession.cleanup",
        context: sessionContext,
      },
    );

    this.transports.delete(sessionId);
    this.servers.delete(sessionId);
    this.sessions.delete(sessionId);

    logger.info(
      `MCP Session closed and resources released: ${sessionId}`,
      sessionContext,
    );
  }

  private async cleanupStaleSessions() {
    const context = requestContextService.createRequestContext({
      operation: "StatefulTransportManager.cleanupStaleSessions",
    });
    logger.debug("Running stale session cleanup...", context);

    const now = Date.now();
    const STALE_TIMEOUT_MS = config.mcpStatefulSessionStaleTimeoutMs;
    let staleCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt.getTime() > STALE_TIMEOUT_MS) {
        staleCount++;
        const sessionContext = {
          ...context,
          sessionId,
          lastAccessed: session.lastAccessedAt.toISOString(),
        };
        logger.info(
          `Found stale session, closing: ${sessionId}`,
          sessionContext,
        );
        await this.closeSession(sessionId, sessionContext);
      }
    }
    if (staleCount > 0) {
      logger.info(
        `Stale session cleanup complete. Closed ${staleCount} sessions.`,
        context,
      );
    } else {
      logger.debug("No stale sessions found.", context);
    }
  }
}

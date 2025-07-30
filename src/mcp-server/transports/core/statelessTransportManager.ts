/**
 * @fileoverview Stateless Transport Manager implementation for MCP SDK.
 * This manager handles single-request operations without maintaining sessions.
 * Each request creates a temporary server instance that is cleaned up immediately.
 * This version is adapted for Hono by bridging the SDK's Node.js-style
 * request handling with Hono's stream-based response model.
 * @module src/mcp-server/transports/core/statelessTransportManager
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingHttpHeaders, ServerResponse } from "http";
import { Readable } from "stream";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { BaseTransportManager } from "./baseTransportManager.js";
import { HonoStreamResponse } from "./honoNodeBridge.js";
import { HttpStatusCode, TransportResponse } from "./transportTypes.js";

/**
 * Stateless Transport Manager that handles ephemeral MCP operations.
 */
export class StatelessTransportManager extends BaseTransportManager {
  async handleRequest(
    headers: IncomingHttpHeaders,
    body: unknown,
    context: RequestContext,
  ): Promise<TransportResponse> {
    const opContext = {
      ...context,
      operation: "StatelessTransportManager.handleRequest",
    };
    logger.debug(
      "Creating ephemeral server instance for stateless request.",
      opContext,
    );

    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    try {
      server = await this.createServerInstanceFn();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        onsessioninitialized: undefined,
      });

      await server.connect(transport);
      logger.debug("Ephemeral server connected to transport.", opContext);

      const mockReq = {
        headers,
        method: "POST",
      } as import("http").IncomingMessage;
      const mockRes = new HonoStreamResponse() as unknown as ServerResponse;

      await transport.handleRequest(mockReq, mockRes, body);

      logger.info("Stateless request handled successfully.", opContext);

      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(mockRes.getHeaders())) {
        responseHeaders.set(
          key,
          Array.isArray(value) ? value.join(", ") : String(value),
        );
      }

      // Bridge the Node.js stream (PassThrough) to a Web Stream (ReadableStream)
      const webStream = Readable.toWeb(
        mockRes as unknown as HonoStreamResponse,
      ) as ReadableStream<Uint8Array>;

      return {
        headers: responseHeaders,
        statusCode: mockRes.statusCode as HttpStatusCode,
        stream: webStream,
      };
    } catch (error) {
      throw ErrorHandler.handleError(error, {
        operation: "StatelessTransportManager.handleRequest",
        context: opContext,
        rethrow: true,
      });
    } finally {
      if (server || transport) {
        this.cleanup(server, transport, opContext);
      }
    }
  }

  async shutdown(): Promise<void> {
    const context = requestContextService.createRequestContext({
      operation: "StatelessTransportManager.shutdown",
    });
    logger.info(
      "Stateless transport manager shutdown - no persistent resources to clean up.",
      context,
    );
    return Promise.resolve();
  }

  private cleanup(
    server: McpServer | undefined,
    transport: StreamableHTTPServerTransport | undefined,
    context: RequestContext,
  ): void {
    const opContext = {
      ...context,
      operation: "StatelessTransportManager.cleanup",
    };
    logger.debug("Scheduling cleanup for ephemeral resources.", opContext);

    Promise.all([transport?.close(), server?.close()])
      .then(() => {
        logger.debug("Ephemeral resources cleaned up successfully.", opContext);
      })
      .catch((cleanupError) => {
        logger.warning("Error during stateless resource cleanup.", {
          ...opContext,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        });
      });
  }
}

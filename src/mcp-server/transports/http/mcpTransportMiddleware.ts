/**
 * @fileoverview Hono middleware for handling MCP transport logic.
 * This middleware encapsulates the logic for processing MCP requests,
 * delegating to the appropriate transport manager, and preparing the
 * response for Hono to send.
 * @module src/mcp-server/transports/http/mcpTransportMiddleware
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMiddleware } from "hono/factory";
import { IncomingHttpHeaders } from "http";
import { config } from "../../../config/index.js";
import { RequestContext, requestContextService } from "../../../utils/index.js";
import { StatefulTransportManager } from "../core/statefulTransportManager.js";
import { StatelessTransportManager } from "../core/statelessTransportManager.js";
import { TransportManager, TransportResponse } from "../core/transportTypes.js";
import { HonoNodeBindings } from "./httpTypes.js";

/**
 * Converts a Fetch API Headers object to Node.js IncomingHttpHeaders.
 * @param headers - The Headers object to convert.
 * @returns An object compatible with IncomingHttpHeaders.
 */
function toIncomingHttpHeaders(headers: Headers): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Handles a stateless request by creating an ephemeral transport manager.
 * @param createServerInstanceFn - Function to create an McpServer instance.
 * @param headers - The request headers.
 * @param body - The request body.
 * @param context - The request context.
 * @returns A promise resolving with the transport response.
 */
async function handleStatelessRequest(
  createServerInstanceFn: () => Promise<McpServer>,
  headers: Headers,
  body: unknown,
  context: RequestContext,
): Promise<TransportResponse> {
  const statelessManager = new StatelessTransportManager(
    createServerInstanceFn,
  );
  return statelessManager.handleRequest(
    toIncomingHttpHeaders(headers),
    body,
    context,
  );
}

/**
 * Creates a Hono middleware for handling MCP POST requests.
 * @param transportManager - The main transport manager (usually stateful).
 * @param createServerInstanceFn - Function to create an McpServer instance.
 * @returns A Hono middleware function.
 */

type McpMiddlewareEnv = {
  Variables: {
    mcpResponse: TransportResponse;
  };
};

export const mcpTransportMiddleware = (
  transportManager: TransportManager,
  createServerInstanceFn: () => Promise<McpServer>,
) =>
  createMiddleware<McpMiddlewareEnv & { Bindings: HonoNodeBindings }>(
    async (c, next) => {
      const sessionId = c.req.header("mcp-session-id");
      const context = requestContextService.createRequestContext({
        operation: "mcpTransportMiddleware",
        sessionId,
      });

      const body = await c.req.json();
      let response: TransportResponse;

      if (isInitializeRequest(body)) {
        if (config.mcpSessionMode === "stateless") {
          response = await handleStatelessRequest(
            createServerInstanceFn,
            c.req.raw.headers,
            body,
            context,
          );
        } else {
          response = await (
            transportManager as StatefulTransportManager
          ).initializeAndHandle(
            toIncomingHttpHeaders(c.req.raw.headers),
            body,
            context,
          );
        }
      } else {
        if (sessionId) {
          response = await transportManager.handleRequest(
            toIncomingHttpHeaders(c.req.raw.headers),
            body,
            context,
            sessionId,
          );
        } else {
          response = await handleStatelessRequest(
            createServerInstanceFn,
            c.req.raw.headers,
            body,
            context,
          );
        }
      }

      c.set("mcpResponse", response);
      await next();
    },
  );

/**
 * @fileoverview Core types and interfaces for the transport layer abstraction.
 * @module src/mcp-server/transports/core/transportTypes
 */

import type { IncomingHttpHeaders } from "http";
import { RequestContext } from "../../../utils/index.js";

/**
 * Valid HTTP status codes for transport responses.
 */
export type HttpStatusCode =
  | 200
  | 201
  | 400
  | 401
  | 403
  | 404
  | 409
  | 429
  | 500
  | 502
  | 503;

/**
 * Represents the result of a transport operation.
 */
export interface TransportResponse {
  sessionId?: string;
  headers: Headers;
  statusCode: HttpStatusCode;
  body?: unknown;
  stream?: ReadableStream<Uint8Array>;
}

/**
 * Represents an active transport session.
 */
export interface TransportSession {
  id: string;
  createdAt: Date;
  lastAccessedAt: Date;
}

/**
 * Abstract interface for managing MCP transport operations.
 * This interface separates transport logic from HTTP routing concerns.
 */
export interface TransportManager {
  /**
   * Handles an incoming request.
   * @param headers The request headers.
   * @param body The parsed body of the request.
   * @param context Request context for logging and tracing.
   * @param sessionId Optional session identifier for stateful operations.
   * @returns A promise resolving to a TransportResponse.
   */
  handleRequest(
    headers: IncomingHttpHeaders,
    body: unknown,
    context: RequestContext,
    sessionId?: string,
  ): Promise<TransportResponse>;

  /**
   * Clean up resources.
   */
  shutdown(): Promise<void>;
}

/**
 * Extends the base TransportManager with session-specific operations.
 */
export interface StatefulTransportManager extends TransportManager {
  /**
   * Initializes a new session and handles the request.
   * @param headers The request headers.
   * @param body The parsed body of the request.
   * @param context Request context for logging and tracing.
   * @returns A promise resolving to a TransportResponse.
   */
  initializeAndHandle(
    headers: IncomingHttpHeaders,
    body: unknown,
    context: RequestContext,
  ): Promise<TransportResponse>;

  /**
   * Handles a DELETE request to close a session.
   */
  handleDeleteRequest(
    sessionId: string,
    context: RequestContext,
  ): Promise<TransportResponse>;

  /**
   * Retrieves session information.
   */
  getSession(sessionId: string): TransportSession | undefined;
}

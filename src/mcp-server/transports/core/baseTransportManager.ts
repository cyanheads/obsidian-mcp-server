/**
 * @fileoverview Abstract base class for transport managers.
 * @module src/mcp-server/transports/core/baseTransportManager
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IncomingHttpHeaders } from "http";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { TransportManager, TransportResponse } from "./transportTypes.js";

/**
 * Abstract base class for transport managers, providing common functionality.
 */
export abstract class BaseTransportManager implements TransportManager {
  protected readonly createServerInstanceFn: () => Promise<McpServer>;

  constructor(createServerInstanceFn: () => Promise<McpServer>) {
    const context = requestContextService.createRequestContext({
      operation: "BaseTransportManager.constructor",
      managerType: this.constructor.name,
    });
    logger.debug("Initializing transport manager.", context);
    this.createServerInstanceFn = createServerInstanceFn;
  }

  abstract handleRequest(
    headers: IncomingHttpHeaders,
    body: unknown,
    context: RequestContext,
    sessionId?: string,
  ): Promise<TransportResponse>;

  abstract shutdown(): Promise<void>;
}

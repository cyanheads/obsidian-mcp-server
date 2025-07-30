/**
 * @fileoverview Factory for creating an authentication strategy based on configuration.
 * This module centralizes the logic for selecting and instantiating the correct
 * authentication strategy, promoting loose coupling and easy extensibility.
 * @module src/mcp-server/transports/auth/authFactory
 */
import { config } from "../../../config/index.js";
import { logger, requestContextService } from "../../../utils/index.js";
import { AuthStrategy } from "./strategies/authStrategy.js";
import { JwtStrategy } from "./strategies/jwtStrategy.js";
import { OauthStrategy } from "./strategies/oauthStrategy.js";

/**
 * Creates and returns an authentication strategy instance based on the
 * application's configuration (`config.mcpAuthMode`).
 *
 * @returns An instance of a class that implements the `AuthStrategy` interface,
 *          or `null` if authentication is disabled (`none`).
 * @throws {Error} If the auth mode is unknown or misconfigured.
 */
export function createAuthStrategy(): AuthStrategy | null {
  const context = requestContextService.createRequestContext({
    operation: "createAuthStrategy",
    authMode: config.mcpAuthMode,
  });
  logger.info("Creating authentication strategy...", context);

  switch (config.mcpAuthMode) {
    case "jwt":
      logger.debug("Instantiating JWT authentication strategy.", context);
      return new JwtStrategy();
    case "oauth":
      logger.debug("Instantiating OAuth authentication strategy.", context);
      return new OauthStrategy();
    case "none":
      logger.info("Authentication is disabled ('none' mode).", context);
      return null; // No authentication
    default:
      // This ensures that if a new auth mode is added to the config type
      // but not to this factory, we get a compile-time or runtime error.
      logger.error(
        `Unknown authentication mode: ${config.mcpAuthMode}`,
        context,
      );
      throw new Error(`Unknown authentication mode: ${config.mcpAuthMode}`);
  }
}

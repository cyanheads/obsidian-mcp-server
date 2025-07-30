/**
 * @fileoverview Implements the OAuth 2.1 authentication strategy.
 * This module provides a concrete implementation of the AuthStrategy for validating
 * JWTs against a remote JSON Web Key Set (JWKS), as is common in OAuth 2.1 flows.
 * @module src/mcp-server/transports/auth/strategies/OauthStrategy
 */
import { createRemoteJWKSet, jwtVerify, JWTVerifyResult } from "jose";
import { config } from "../../../../config/index.js";
import { BaseErrorCode, McpError } from "../../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  requestContextService,
} from "../../../../utils/index.js";
import type { AuthInfo } from "../lib/authTypes.js";
import type { AuthStrategy } from "./authStrategy.js";

export class OauthStrategy implements AuthStrategy {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
    const context = requestContextService.createRequestContext({
      operation: "OauthStrategy.constructor",
    });
    logger.debug("Initializing OauthStrategy...", context);

    if (config.mcpAuthMode !== "oauth") {
      // This check is for internal consistency, so a standard Error is acceptable here.
      throw new Error("OauthStrategy instantiated for non-oauth auth mode.");
    }
    if (!config.oauthIssuerUrl || !config.oauthAudience) {
      logger.fatal(
        "CRITICAL: OAUTH_ISSUER_URL and OAUTH_AUDIENCE must be set for OAuth mode.",
        context,
      );
      // This is a user-facing configuration error, so McpError is appropriate.
      throw new McpError(
        BaseErrorCode.CONFIGURATION_ERROR,
        "OAUTH_ISSUER_URL and OAUTH_AUDIENCE must be set for OAuth mode.",
        context,
      );
    }

    try {
      const jwksUrl = new URL(
        config.oauthJwksUri ||
          `${config.oauthIssuerUrl.replace(/\/$/, "")}/.well-known/jwks.json`,
      );
      this.jwks = createRemoteJWKSet(jwksUrl, {
        cooldownDuration: 300000, // 5 minutes
        timeoutDuration: 5000, // 5 seconds
      });
      logger.info(`JWKS client initialized for URL: ${jwksUrl.href}`, context);
    } catch (error) {
      logger.fatal("Failed to initialize JWKS client.", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
      // This is a critical startup failure, so a specific McpError is warranted.
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Could not initialize JWKS client for OAuth strategy.",
        {
          ...context,
          originalError: error instanceof Error ? error.message : "Unknown",
        },
      );
    }
  }

  async verify(token: string): Promise<AuthInfo> {
    const context = requestContextService.createRequestContext({
      operation: "OauthStrategy.verify",
    });
    logger.debug("Attempting to verify OAuth token via JWKS.", context);

    try {
      const { payload }: JWTVerifyResult = await jwtVerify(token, this.jwks, {
        issuer: config.oauthIssuerUrl!,
        audience: config.oauthAudience!,
      });
      logger.debug("OAuth token signature verified successfully.", {
        ...context,
        claims: payload,
      });

      const scopes =
        typeof payload.scope === "string" ? payload.scope.split(" ") : [];
      if (scopes.length === 0) {
        logger.warning(
          "Invalid token: missing or empty 'scope' claim.",
          context,
        );
        throw new McpError(
          BaseErrorCode.UNAUTHORIZED,
          "Token must contain valid, non-empty scopes.",
          context,
        );
      }

      const clientId =
        typeof payload.client_id === "string" ? payload.client_id : undefined;
      if (!clientId) {
        logger.warning("Invalid token: missing 'client_id' claim.", context);
        throw new McpError(
          BaseErrorCode.UNAUTHORIZED,
          "Token must contain a 'client_id' claim.",
          context,
        );
      }

      const authInfo: AuthInfo = {
        token,
        clientId,
        scopes,
        subject: typeof payload.sub === "string" ? payload.sub : undefined,
      };
      logger.info("OAuth token verification successful.", {
        ...context,
        clientId,
        scopes,
      });
      return authInfo;
    } catch (error) {
      const message =
        error instanceof Error && error.name === "JWTExpired"
          ? "Token has expired."
          : "OAuth token verification failed.";

      logger.warning(`OAuth token verification failed: ${message}`, {
        ...context,
        errorName: error instanceof Error ? error.name : "Unknown",
      });

      throw ErrorHandler.handleError(error, {
        operation: "OauthStrategy.verify",
        context,
        rethrow: true,
        errorCode: BaseErrorCode.UNAUTHORIZED,
        errorMapper: () =>
          new McpError(BaseErrorCode.UNAUTHORIZED, message, context),
      });
    }
  }
}

/**
 * @fileoverview Hono middleware for OAuth 2.0 Token Introspection (RFC 7662).
 * This middleware validates opaque bearer tokens by calling a remote introspection endpoint.
 * Unlike JWT validation which is done locally, opaque tokens must be validated by the
 * authorization server that issued them.
 *
 * RFC 7662: https://datatracker.ietf.org/doc/html/rfc7662
 *
 * @module src/mcp-server/transports/auth/strategies/introspection/tokenIntrospectionMiddleware
 */

import { HttpBindings } from "@hono/node-server";
import { Context, Next } from "hono";
import { config } from "../../../../../config/index.js";
import { BaseErrorCode, McpError } from "../../../../../types-global/errors.js";
import { logger, requestContextService } from "../../../../../utils/index.js";
import { ErrorHandler } from "../../../../../utils/internal/errorHandler.js";
import { authContext } from "../../core/authContext.js";
import type { AuthInfo } from "../../core/authTypes.js";

// --- Startup Validation ---
if (config.mcpAuthMode === "introspection") {
  if (!config.tokenIntrospectionUrl) {
    throw new Error(
      "TOKEN_INTROSPECTION_URL must be set when MCP_AUTH_MODE is 'introspection'",
    );
  }
  logger.info(
    "Token Introspection mode enabled. Validating tokens against introspection endpoint.",
    requestContextService.createRequestContext({
      introspectionUrl: config.tokenIntrospectionUrl,
    }),
  );
}

/**
 * Response from the token introspection endpoint (RFC 7662 Section 2.2)
 */
interface IntrospectionResponse {
  /** REQUIRED. Boolean indicator of whether the token is active */
  active: boolean;
  /** OPTIONAL. A space-separated list of scopes */
  scope?: string;
  /** OPTIONAL. Client identifier for the OAuth 2.0 client */
  client_id?: string;
  /** OPTIONAL. Human-readable identifier for the resource owner */
  username?: string;
  /** OPTIONAL. Type of the token (e.g., "Bearer") */
  token_type?: string;
  /** OPTIONAL. Unix timestamp indicating when the token will expire */
  exp?: number;
  /** OPTIONAL. Unix timestamp indicating when the token was issued */
  iat?: number;
  /** OPTIONAL. Unix timestamp indicating when the token is not to be used before */
  nbf?: number;
  /** OPTIONAL. Subject of the token (usually user ID) */
  sub?: string;
  /** OPTIONAL. String representing the intended audience */
  aud?: string | string[];
  /** OPTIONAL. String representing the issuer */
  iss?: string;
  /** OPTIONAL. String identifier for the token */
  jti?: string;
}

// Simple in-memory cache for introspection results
// This avoids calling the introspection endpoint on every request
const tokenCache = new Map<
  string,
  { response: IntrospectionResponse; expiresAt: number }
>();
const CACHE_TTL_MS = 60000; // Cache for 60 seconds

/**
 * Calls the token introspection endpoint to validate an opaque token.
 * @param token - The bearer token to validate
 * @returns The introspection response
 */
async function introspectToken(token: string): Promise<IntrospectionResponse> {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response;
  }

  const introspectionUrl = config.tokenIntrospectionUrl!;

  // Build the request body (RFC 7662 Section 2.1)
  const body = new URLSearchParams();
  body.append("token", token);

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  // Add client authentication if configured
  // RFC 7662 Section 2.1: The introspection endpoint MAY require client authentication
  if (config.tokenIntrospectionClientId && config.tokenIntrospectionClientSecret) {
    // Use HTTP Basic Auth for client credentials
    const credentials = Buffer.from(
      `${config.tokenIntrospectionClientId}:${config.tokenIntrospectionClientSecret}`,
    ).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  const response = await fetch(introspectionUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Token introspection failed: HTTP ${response.status} - ${errorText}`,
    );
  }

  const result = (await response.json()) as IntrospectionResponse;

  // Cache the result
  tokenCache.set(token, {
    response: result,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  // Clean up old cache entries periodically
  if (tokenCache.size > 1000) {
    const now = Date.now();
    for (const [key, value] of tokenCache.entries()) {
      if (value.expiresAt < now) {
        tokenCache.delete(key);
      }
    }
  }

  return result;
}

/**
 * Hono middleware for validating opaque bearer tokens via RFC 7662 Token Introspection.
 * @param c - The Hono context object.
 * @param next - The function to call to proceed to the next middleware.
 */
export async function tokenIntrospectionMiddleware(
  c: Context<{ Bindings: HttpBindings }>,
  next: Next,
) {
  // If introspection is not the configured auth mode, skip this middleware.
  if (config.mcpAuthMode !== "introspection") {
    return await next();
  }

  const context = requestContextService.createRequestContext({
    operation: "tokenIntrospectionMiddleware",
    httpMethod: c.req.method,
    httpPath: c.req.path,
  });

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new McpError(
      BaseErrorCode.UNAUTHORIZED,
      "Missing or invalid token format.",
    );
  }

  const token = authHeader.substring(7);

  try {
    const introspectionResult = await introspectToken(token);

    // Check if token is active (RFC 7662 Section 2.2)
    if (!introspectionResult.active) {
      logger.warning("Token introspection returned inactive token.", context);
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        "Token is inactive or expired.",
      );
    }

    // Extract scopes
    const scopes = introspectionResult.scope
      ? introspectionResult.scope.split(" ").filter(Boolean)
      : [];

    // Extract client ID — required for consistency with jwt/oauth middleware
    const clientId = introspectionResult.client_id;
    if (!clientId) {
      logger.warning(
        "Authentication failed: Token introspection did not return a client_id.",
        context,
      );
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        "Invalid token, missing client identifier.",
      );
    }

    const authInfo: AuthInfo = {
      token,
      clientId,
      scopes,
      subject: introspectionResult.sub,
    };

    logger.debug("Token introspection successful.", {
      ...context,
      clientId,
      scopes,
      subject: introspectionResult.sub,
    });

    // Attach to the raw request and store in AsyncLocalStorage
    c.env.incoming.auth = authInfo;
    await authContext.run({ authInfo }, next);
  } catch (error: unknown) {
    if (error instanceof McpError) {
      throw error;
    }

    const handledError = ErrorHandler.handleError(error, {
      operation: "tokenIntrospectionMiddleware",
      context,
      rethrow: false,
    });

    if (handledError instanceof McpError) {
      throw handledError;
    } else {
      throw new McpError(
        BaseErrorCode.UNAUTHORIZED,
        `Token validation failed: ${handledError.message || "Unknown error"}`,
        { originalError: handledError.name },
      );
    }
  }
}

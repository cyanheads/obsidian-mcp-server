/**
 * @fileoverview Barrel file for the auth module.
 * Exports core utilities and middleware strategies for easier imports.
 * @module src/mcp-server/transports/auth/index
 */

export { authContext } from "./core/authContext.js";
export { withRequiredScopes } from "./core/authUtils.js";
export type { AuthInfo } from "./core/authTypes.js";

export { mcpAuthMiddleware as jwtAuthMiddleware } from "./strategies/jwt/jwtMiddleware.js";
export { oauthMiddleware } from "./strategies/oauth/oauthMiddleware.js";
export { tokenIntrospectionMiddleware } from "./strategies/introspection/tokenIntrospectionMiddleware.js";

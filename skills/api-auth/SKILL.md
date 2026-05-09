---
name: api-auth
description: >
  Authentication, authorization, and multi-tenancy patterns for `@cyanheads/mcp-ts-core`. Use when implementing auth scopes on tools/resources, configuring auth modes (none/jwt/oauth), working with JWT/OAuth env vars, or understanding how tenantId flows through ctx.state.
metadata:
  author: cyanheads
  version: "1.1"
  audience: external
  type: reference
---

## Overview

The framework handles auth at the handler factory level — tools and resources declare required scopes declaratively, and the framework enforces them before calling the handler. No try/catch or manual scope checking required for the common case.

---

## Inline auth (primary pattern)

Declare required scopes directly on the tool or resource definition via the `auth` property. The handler factory checks `ctx.auth.scopes` against these before calling `handler`.

```ts
import { tool } from '@cyanheads/mcp-ts-core';

const myTool = tool('my_tool', {
  input: z.object({ query: z.string().describe('Search query') }),
  output: z.object({ result: z.string().describe('Search result') }),
  auth: ['tool:my_tool:read'],
  async handler(input, ctx) {
    // Only reached if caller has 'tool:my_tool:read' scope
  },
});
```

When `MCP_AUTH_MODE=none`, auth checks are skipped and defaults are allowed.

---

## Dynamic auth

For runtime-computed scopes (e.g., scopes that depend on input values like a team or resource ID), use `checkScopes` from `@cyanheads/mcp-ts-core/auth` inside the handler:

```ts
import { checkScopes } from '@cyanheads/mcp-ts-core/auth';

handler: async (input, ctx) => {
  checkScopes(ctx, [`team:${input.teamId}:write`]);
  // Continues only if scope is satisfied
},
```

**Signature:** `checkScopes(ctx: Context, requiredScopes: string[]): void`

**Throws:**

- `McpError(Forbidden)` — auth is active and one or more required scopes are missing
- `McpError(Unauthorized)` — auth is enabled but no auth context exists on the request
- No-ops when `MCP_AUTH_MODE=none`

---

## Auth modes

Set via `MCP_AUTH_MODE` environment variable.

| Mode | Value | Behavior |
|:-----|:------|:---------|
| Disabled | `none` | No auth enforcement. All requests allowed. |
| JWT | `jwt` | Local secret verification via `MCP_AUTH_SECRET_KEY`. Requires explicit `DEV_MCP_AUTH_BYPASS=true` to bypass in development. |
| OAuth | `oauth` | JWKS verification against an external issuer. |

### JWT config

| Variable | Required | Purpose |
|:---------|:---------|:--------|
| `MCP_AUTH_SECRET_KEY` | Yes (unless bypass) | Signing secret for HS256 JWT verification. Must be ≥ 32 characters. |
| `DEV_MCP_AUTH_BYPASS` | No | Set to `true` to skip JWT verification in development. Blocked in `NODE_ENV=production`. |
| `DEV_MCP_CLIENT_ID` | No | Client ID injected when bypass is active (default: `'dev-client-id'`). |
| `DEV_MCP_SCOPES` | No | Comma-separated scopes injected when bypass is active (default: `['dev-scope']`). |

**Important:** With `MCP_AUTH_MODE=jwt`, a missing `MCP_AUTH_SECRET_KEY` is a **fatal startup error** unless `DEV_MCP_AUTH_BYPASS=true` is explicitly set. Setting `DEV_MCP_AUTH_BYPASS` in production (`NODE_ENV=production`) is rejected at config parse time.

### OAuth config

| Variable | Required | Purpose |
|:---------|:---------|:--------|
| `OAUTH_ISSUER_URL` | Yes | Token issuer URL (used for JWKS discovery) |
| `OAUTH_AUDIENCE` | Yes | Expected `aud` claim value |
| `OAUTH_JWKS_URI` | No | Override JWKS endpoint (defaults to `{issuer}/.well-known/jwks.json`) |
| `MCP_SERVER_RESOURCE_IDENTIFIER` | No | RFC 8707 resource indicator URI. When set, the OAuth strategy validates that the token's `resource` or `aud` claim matches this value — throws `Forbidden` on mismatch. |

### JWT claims mapping

| Claim | JWT Field | Purpose |
|:------|:----------|:--------|
| `clientId` | `cid` / `client_id` | Identifies the calling client |
| `scopes` | union of `scp`, `scope`, `mcp_tool_scopes` | Granted scope list (see below) |
| `sub` | `sub` | Subject (user or service identity) |
| `tenantId` | `tid` | Tenant identifier — drives `ctx.state` scoping |

`scopes` is the **union** of three claims, in this order:

| Claim | Form | Source |
|:------|:-----|:-------|
| `scp` | array of strings | Okta-style |
| `scope` | space-delimited string | OAuth 2.1 / OIDC standard |
| `mcp_tool_scopes` | array of strings **or** space-delimited string | Custom claim for OIDC providers that cannot inject scopes into `scope` during the `authorization_code` flow (Authentik, Keycloak < 26.5, Zitadel) |

Auth0/Okta-style providers that already populate `scp` or `scope` need no migration. Other deployments add a property mapping returning `{"mcp_tool_scopes": "tool:foo:read tool:bar:write"}` — the framework unions it into `ctx.auth.scopes` alongside the standard claims. Hardcoded claim name; deployments whose IdP cannot emit `mcp_tool_scopes` use the bypass flag below.

### OIDC operator setup (Authentik / Keycloak / Zitadel)

Standard OIDC providers compute the JWT `scope` claim from what the OAuth client requested at the authorization endpoint and ignore property mappings that try to override `scope` in the `authorization_code` flow. Property mappings that inject **other** claim names work fine. To grant per-tool scopes to a Claude.ai or ChatGPT custom connector that doesn't expose scope customization, configure your IdP to return the per-tool scopes under `mcp_tool_scopes` instead of overriding `scope`.

| Provider | Where to configure |
|:---------|:--------------------|
| Authentik | Customization → Property Mappings → new "Scope Mapping" returning `{"mcp_tool_scopes": "tool:foo:read tool:bar:write"}`; bind to the OAuth2/OpenID provider |
| Keycloak (< 26.5) | Client → Client Scopes → Mappers → new "Hardcoded claim" or "Script Mapper" emitting `mcp_tool_scopes` |
| Zitadel | Project → Roles + Action returning `{"mcp_tool_scopes": "..."}` from a pre-token script |

Keycloak ≥ 26.5 ships native MCP integration support; check its release notes before falling back to a custom claim.

### Bypass flag

For environments where no custom claim can be injected (managed services, restricted IdPs), set `MCP_AUTH_DISABLE_SCOPE_CHECKS=true` to bypass scope enforcement entirely.

| Variable | Default | Effect |
|:---------|:--------|:-------|
| `MCP_AUTH_DISABLE_SCOPE_CHECKS` | `false` | When `true`, both `withRequiredScopes` (declared `auth: [...]`) and `checkScopes` (runtime-computed scopes inside handlers) early-return after the auth-context presence check. Token signature, audience, issuer, and expiry validation remain intact. |

The flag bypasses **both** declared `auth: [...]` enforcement and runtime `checkScopes` calls — including tenant isolation patterns like `team:${input.teamId}:write`. Naming is deliberate: this disables all scope checks, not just per-tool ones. Applies to `MCP_AUTH_MODE=jwt` and `MCP_AUTH_MODE=oauth` (no effect under `none`).

A `WARNING`-level log is emitted at startup whenever the flag is active so operators don't lose track of it. Combine with server-side ACLs (path filters, allowlists, tenant rules) — without an in-handler ACL, every authenticated user effectively has every scope.

---

## Endpoints

| Endpoint | Protected |
|:---------|:----------|
| `GET /healthz` | No |
| `GET /mcp` | No |
| `POST /mcp` | Yes (when auth enabled) |
| `OPTIONS /mcp` | Yes (when auth enabled) |

**CORS:** Set `MCP_ALLOWED_ORIGINS` to a comma-separated list of allowed origins, or `*` for open access.

**Stdio mode:** No HTTP auth layer. Authorization is handled entirely by the host process.

---

## Multi-tenancy

`ctx.state` is automatically scoped to the current tenant — no manual key prefixing needed.

### tenantId sources

| Mode | Source | Value |
|:-----|:-------|:------|
| Stdio (any auth mode) | Hardcoded default | `'default'` |
| HTTP + `MCP_AUTH_MODE=none` | Hardcoded default | `'default'` (single-tenant by design) |
| HTTP + `MCP_AUTH_MODE=jwt`/`oauth` | JWT `tid` claim | Auto-propagated from token; `undefined` if absent (fail-closed) |

### Tenant ID validation rules

- Max 128 characters
- Characters: alphanumeric, hyphens, underscores, dots
- Must start and end with an alphanumeric character
- No path traversal sequences (`../`)
- No consecutive dots (`..`)

### Using `ctx.state`

```ts
handler: async (input, ctx) => {
  // Automatically scoped to ctx.tenantId — no manual prefixing
  await ctx.state.set('item:123', { name: 'Widget', count: 42 });
  const item = await ctx.state.get<Item>('item:123');
  await ctx.state.delete('item:123');

  const page = await ctx.state.list('item:', { cursor, limit: 20 });
  // page: { items: Array<{ key, value }>, cursor?: string }
},
```

`ctx.state` throws `McpError(InvalidRequest)` if `tenantId` is missing. Stdio (any auth mode) and HTTP+`MCP_AUTH_MODE=none` default `tenantId` to `'default'` so `ctx.state` works without forcing operators to mint tokens. HTTP+`jwt`/`oauth` deliberately fails closed when the token lacks a `tid` claim — distinct authenticated callers must not silently share state.

---

## Auth context shape

Available on `ctx.auth` inside handlers (when auth is enabled):

```ts
interface AuthContext {
  clientId: string;        // Required — 'cid' or 'client_id' JWT claim
  scopes: string[];        // Required — union of 'scp', 'scope', and 'mcp_tool_scopes' claims
  sub: string;             // Required — 'sub' claim; falls back to clientId when absent
  token: string;           // Required — raw JWT or OAuth bearer token string
  tenantId?: string;       // Optional — 'tid' claim; present only for multi-tenant tokens
}
```

Access directly for conditional logic:

```ts
handler: async (input, ctx) => {
  const isAdmin = ctx.auth?.scopes.includes('admin:write') ?? false;
  // ...
},
```

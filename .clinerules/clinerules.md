# Obsidian MCP Server: Architectural Standard & Developer Guide

**Version:** 2.1
**Last Updated:** 2025-07-30

## Preamble

This document constitutes the official mandate governing all development practices, architectural patterns, and operational procedures for the `obsidian-mcp-server`. It integrates the core principles of the `mcp-ts-template` with project-specific guidelines. It is the single source of truth for ensuring code quality, consistency, and long-term maintainability. Adherence to these standards is not optional; it is a condition of all development activity.

---

## I. Core Architectural Principles

The architecture is founded upon a strict separation of concerns to guarantee modularity, testability, and operational clarity. These principles are non-negotiable.

### 1. The Logic Throws, The Handler Catches

This is the immutable cornerstone of the error-handling and control-flow strategy.

**Core Logic (logic.ts):** This layer's sole responsibility is the execution of business logic. It shall be pure, self-contained, and stateless where possible. If an operational or validation error occurs, it must terminate its execution by throwing a structured `McpError`. Logic files shall not contain `try...catch` blocks for the purpose of formatting a final response.

**Handlers (registration.ts, Transports):** This layer's responsibility is to interface with the transport layer (e.g., MCP, HTTP), invoke core logic, and manage the final response lifecycle. It must wrap every call to the logic layer in a `try...catch` block. This is the exclusive location where errors are caught, processed by the `ErrorHandler`, and formatted into a definitive `CallToolResult` or HTTP response.

### 2. Structured, Traceable Operations

Every operation must be fully traceable from initiation to completion via structured logging and context propagation.

**RequestContext:** Any significant operation shall be initiated by creating a `RequestContext` via `requestContextService.createRequestContext()`. This context, containing a unique `requestId`, must be passed as an argument through the entire call stack of the operation.

**Logger:** All logging shall be performed through the centralized logger singleton. Every log entry must include the `RequestContext` to ensure traceability.

---

## II. Tool & Resource Development Workflow

This section mandates the workflow for creating and modifying all tools and resources. Deviation is not permitted.

### A. File and Directory Structure

Each tool or resource shall reside in a dedicated directory within `src/mcp-server/tools/` or `src/mcp-server/resources/`. The structure is fixed as follows:

- **`yourCapabilityName/`**
  - **`index.ts`**: A barrel file that performs a single function: exporting the `register...` function from `registration.ts`. No other logic shall exist in this file.
  - **`logic.ts`**: Contains the core business logic. It must define and export the Zod input schema, all inferred TypeScript types (input and output), and the primary logic function.
  - **`registration.ts`**: Registers the capability with the MCP server. It imports from `logic.ts` and strictly implements the "Handler" role.

### B. SDK Usage (TypeScript) - IMPORTANT

- **High-Level SDK Abstractions (Strongly Recommended):**
  - **Use `server.tool(name, metadata, handler)`:** This is the **preferred and strongly recommended** way to define tools. It automatically handles schema validation, routing, and response formatting.
  - **Use `server.resource(regName, template, metadata, handler)`:** Similarly recommended for resources.
  - **Benefits:** Significantly reduces boilerplate, enforces type safety, simplifies protocol adherence.
- **Low-Level SDK Handlers (AVOID unless absolutely necessary):**
  - Manually using `server.setRequestHandler(SchemaObject, handler)` requires you to handle everything yourself and is prone to error.
  - **CRITICAL WARNING:** **Do NOT mix high-level and low-level approaches for the _same capability type_ (e.g., tools).** This will lead to unexpected errors.

---

## III. Code Quality and Documentation Mandates

**JSDoc:** Every file shall begin with a `@fileoverview` and `@module` block. All exported functions, types, and classes shall have complete JSDoc comments.

**LLM-Facing Descriptions:** The tool's `title`, `description`, and all parameter descriptions defined in Zod schemas (`.describe()`) are transmitted directly to the LLM. These descriptions must be written with the LLM as the primary audience. They must be descriptive, concise, and explicitly state any requirements, constraints, or expected formats.

**Clarity and Intent:** Code shall be self-documenting. Variable and function names must be explicit and unambiguous. Brevity is secondary to clarity.

**Immutability:** Functional approaches and immutable data structures are the required standard to prevent side effects. State mutation must be justified and localized.

**Formatting:** All code must be formatted using Prettier (`npm run format`) prior to being committed.

---

## IV. Security Mandates

**Input Sanitization:** All input from any external source (tool arguments, API responses) shall be treated as untrusted and validated with Zod. Use sanitization utilities for explicit sanitization where Zod parsing is insufficient.

**Secrets Management:** Hardcoding secrets is a direct violation of this standard. All secrets (API keys, credentials) shall be loaded exclusively from environment variables via the `config` module.

**Authentication & Authorization:** The server's authentication mode is configured via the `MCP_AUTH_MODE` environment variable.

**Rate Limiting:** To prevent abuse, handlers for public-facing or resource-intensive tools shall be protected by the centralized `rateLimiter`.

---

## V. Testing Mandates

A `tests/` directory should exist at the project root and mirror the `src/` directory structure. All tests shall be written using Vitest.

**INTEGRATION TESTING FIRST PRINCIPLE:** Tests shall prioritize **integration testing over mocked unit testing**. The goal is to test real interactions between components. Heavy mocking is explicitly discouraged.

- **Real Dependencies:** Use actual service instances and real data flows instead of mocks wherever possible.
- **Error Flow Testing:** Test actual error conditions by triggering real failure states, not by mocking errors.
- **Surgical Mocking:** When mocking is necessary, it must be **surgical and justified**, primarily for truly external, uncontrollable dependencies.

---

## VI. Obsidian MCP Server Cheatsheet

This section provides quick references for common patterns, utilities, and configuration specific to the `obsidian-mcp-server`.

### 1. Instructions for Development

1.  **Review this file** to understand the architectural mandates and project specifics.
2.  When creating new tools, review existing implementations like `obsidianUpdateNoteTool` and `obsidianGlobalSearchTool` as concrete examples of the principles above.
3.  Consult the service documentation below, especially `obsidianRestAPI` and `vaultCache`.
4.  Keep this cheatsheet section updated to accurately reflect the state of the codebase.

### 2. Server Transports & Configuration

The server runs on different transports configured via environment variables.

- **`MCP_TRANSPORT_TYPE`**: `"stdio"` (default) or `"http"`.
- **`MCP_HTTP_PORT`**: Port for HTTP server (Default: `3010`).
- **`MCP_HTTP_HOST`**: Host for HTTP server (Default: `127.0.0.1`).
- **`MCP_ALLOWED_ORIGINS`**: Comma-separated list of allowed origins for CORS.
- **`MCP_LOG_LEVEL`**: Logging level (Default: "info").
- **`MCP_AUTH_MODE`**: Authentication strategy: `"jwt"`, `"oauth"`, or `"none"` (default).
- **`MCP_AUTH_SECRET_KEY`**: **Required if `MCP_AUTH_MODE=jwt`**. Secret key (min 32 chars).
- **`OAUTH_ISSUER_URL`**: **Required if `MCP_AUTH_MODE=oauth`**.
- **`OAUTH_AUDIENCE`**: **Required if `MCP_AUTH_MODE=oauth`**.
- **`OBSIDIAN_API_KEY`**: **Required.**
- **`OBSIDIAN_BASE_URL`**: **Required.** (e.g., `http://127.0.0.1:27123`).
- **`OBSIDIAN_VERIFY_SSL`**: Set to `"false"` to disable SSL verification. Defaults to `true`.
- **`OBSIDIAN_ENABLE_CACHE`**: Set to `"true"` (default) to enable the vault cache.
- **`OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN`**: Cache refresh interval in minutes (Default: `10`).

### 3. Running the Server

- **Stdio**: `npm run start:stdio`
- **HTTP**: `npm run start:http` (Ensure all required `OBSIDIAN_` and auth environment variables are set).

### 4. Key Services & Utilities

#### Obsidian REST API Service (`src/services/obsidianRestAPI/`)

- **Purpose**: Encapsulates all communication with the Obsidian Local REST API plugin.
- **Key Takeaway**: Use the methods provided by `ObsidianRestApiService` for all interactions with the Obsidian vault. Do not make direct HTTP calls.

#### Vault Cache Service (`src/services/obsidianRestAPI/vaultCache/`)

- **Purpose**: Provides an in-memory cache of the vault's file content and metadata to improve performance and provide an API fallback for search operations.
- **Usage**: Instantiated in `src/index.ts` and passed as a dependency to tools. Tools should check `isReady()` before relying on the cache.

#### Agent Instructions for API Connection Help

If the user asks for help connecting to the Obsidian API, follow these steps:

1.  **Acknowledge the two connection methods**: HTTPS (default) and HTTP.
2.  **Recommend the HTTP Method for Simplicity**: Advise enabling the "Enable Non-encrypted (HTTP) Server" option in the plugin's settings and provide the corresponding `OBSIDIAN_BASE_URL` (e.g., `http://127.0.0.1:27123`).
3.  **Explain the HTTPS Method**: If the user prefers HTTPS, explain that it uses a self-signed certificate and requires setting the `OBSIDIAN_VERIFY_SSL` environment variable to `"false"`.

### 5. Key File Locations

- **Main Entry**: `src/index.ts`
- **Server Setup**: `src/mcp-server/server.ts`
- **Configuration**: `src/config/index.ts`
- **Obsidian Service**: `src/services/obsidianRestAPI/`
- **Global Types**: `src/types-global/`
- **Utilities**: `src/utils/`
- **Tools**: `src/mcp-server/tools/`

### 6. Directory Structure

# mcp-ts-template - Directory Structure

Generated on: 2025-07-29 20:05:41

```
mcp-ts-template
├── .github
│   ├── workflows
│   │   └── publish.yml
│   └── FUNDING.yml
├── .vscode
│   └── settings.json
├── coverage
├── docs
│   ├── api-references
│   │   ├── duckDB.md
│   │   ├── jsdoc-standard-tags.md
│   │   └── typedoc-reference.md
│   ├── best-practices.md
│   └── tree.md
├── scripts
│   ├── clean.ts
│   ├── fetch-openapi-spec.ts
│   ├── make-executable.ts
│   ├── README.md
│   └── tree.ts
├── src
│   ├── config
│   │   └── index.ts
│   ├── mcp-server
│   │   ├── resources
│   │   │   └── echoResource
│   │   │       ├── echoResourceLogic.ts
│   │   │       ├── index.ts
│   │   │       └── registration.ts
│   │   ├── tools
│   │   │   ├── catFactFetcher
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── echoTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   └── imageTest
│   │   │       ├── index.ts
│   │   │       ├── logic.ts
│   │   │       └── registration.ts
│   │   ├── transports
│   │   │   ├── auth
│   │   │   │   ├── lib
│   │   │   │   │   ├── authContext.ts
│   │   │   │   │   ├── authTypes.ts
│   │   │   │   │   └── authUtils.ts
│   │   │   │   ├── strategies
│   │   │   │   │   ├── authStrategy.ts
│   │   │   │   │   ├── jwtStrategy.ts
│   │   │   │   │   └── oauthStrategy.ts
│   │   │   │   ├── authFactory.ts
│   │   │   │   ├── authMiddleware.ts
│   │   │   │   └── index.ts
│   │   │   ├── core
│   │   │   │   ├── baseTransportManager.ts
│   │   │   │   ├── honoNodeBridge.ts
│   │   │   │   ├── statefulTransportManager.ts
│   │   │   │   ├── statelessTransportManager.ts
│   │   │   │   └── transportTypes.ts
│   │   │   ├── http
│   │   │   │   ├── httpErrorHandler.ts
│   │   │   │   ├── httpTransport.ts
│   │   │   │   ├── httpTypes.ts
│   │   │   │   ├── index.ts
│   │   │   │   └── mcpTransportMiddleware.ts
│   │   │   └── stdio
│   │   │       ├── index.ts
│   │   │       └── stdioTransport.ts
│   │   └── server.ts
│   ├── services
│   │   ├── duck-db
│   │   │   ├── duckDBConnectionManager.ts
│   │   │   ├── duckDBQueryExecutor.ts
│   │   │   ├── duckDBService.ts
│   │   │   └── types.ts
│   │   ├── llm-providers
│   │   │   └── openRouterProvider.ts
│   │   └── supabase
│   │       └── supabaseClient.ts
│   ├── storage
│   │   └── duckdbExample.ts
│   ├── types-global
│   │   └── errors.ts
│   ├── utils
│   │   ├── internal
│   │   │   ├── errorHandler.ts
│   │   │   ├── index.ts
│   │   │   ├── logger.ts
│   │   │   └── requestContext.ts
│   │   ├── metrics
│   │   │   ├── index.ts
│   │   │   └── tokenCounter.ts
│   │   ├── network
│   │   │   ├── fetchWithTimeout.ts
│   │   │   └── index.ts
│   │   ├── parsing
│   │   │   ├── dateParser.ts
│   │   │   ├── index.ts
│   │   │   └── jsonParser.ts
│   │   ├── scheduling
│   │   │   ├── index.ts
│   │   │   └── scheduler.ts
│   │   ├── security
│   │   │   ├── idGenerator.ts
│   │   │   ├── index.ts
│   │   │   ├── rateLimiter.ts
│   │   │   └── sanitization.ts
│   │   └── index.ts
│   ├── index.ts
│   └── README.md
├── tests
│   ├── mcp-server
│   │   ├── tools
│   │   │   ├── catFactFetcher
│   │   │   │   ├── logic.test.ts
│   │   │   │   └── registration.test.ts
│   │   │   ├── echoTool
│   │   │   │   ├── logic.test.ts
│   │   │   │   └── registration.test.ts
│   │   │   └── imageTest
│   │   │       ├── logic.test.ts
│   │   │       └── registration.test.ts
│   │   ├── transports
│   │   │   ├── auth
│   │   │   │   ├── lib
│   │   │   │   │   └── authUtils.test.ts
│   │   │   │   ├── strategies
│   │   │   │   │   ├── jwtStrategy.test.ts
│   │   │   │   │   └── oauthStrategy.test.ts
│   │   │   │   └── auth.test.ts
│   │   │   └── stdio
│   │   │       └── stdioTransport.test.ts
│   │   └── server.test.ts
│   ├── mocks
│   │   ├── handlers.ts
│   │   └── server.ts
│   ├── services
│   │   ├── duck-db
│   │   │   ├── duckDBConnectionManager.test.ts
│   │   │   ├── duckDBQueryExecutor.test.ts
│   │   │   └── duckDBService.test.ts
│   │   ├── llm-providers
│   │   │   └── openRouterProvider.test.ts
│   │   └── supabase
│   │       └── supabaseClient.test.ts
│   ├── utils
│   │   ├── internal
│   │   │   ├── errorHandler.test.ts
│   │   │   ├── logger.test.ts
│   │   │   └── requestContext.test.ts
│   │   ├── metrics
│   │   │   └── tokenCounter.test.ts
│   │   ├── network
│   │   │   └── fetchWithTimeout.test.ts
│   │   ├── parsing
│   │   │   ├── dateParser.test.ts
│   │   │   └── jsonParser.test.ts
│   │   ├── scheduling
│   │   │   └── scheduler.test.ts
│   │   └── security
│   │       ├── idGenerator.test.ts
│   │       ├── rateLimiter.test.ts
│   │       └── sanitization.test.ts
│   └── setup.ts
├── .clinerules
├── .dockerignore
├── .env.example
├── .gitignore
├── .ncurc.json
├── CHANGELOG.md
├── CLAUDE.md
├── Dockerfile
├── eslint.config.js
├── LICENSE
├── package-lock.json
├── package.json
├── README.md
├── repomix.config.json
├── smithery.yaml
├── tsconfig.json
├── tsconfig.typedoc.json
├── tsconfig.vitest.json
├── tsdoc.json
├── typedoc.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

---
name: migrate-mcp-ts-template
description: >
  Migrate an existing mcp-ts-template fork to use @cyanheads/mcp-ts-core as a package dependency. Use when a project was cloned/forked from github.com/cyanheads/mcp-ts-template and carries framework source code in its own src/ — this skill rewrites those internal imports to package subpath imports and removes the bundled framework files.
metadata:
  author: cyanheads
  version: "2.2"
  audience: external
  type: workflow
---

## Context

Before `@cyanheads/mcp-ts-core` was published as a package, users built servers by forking/cloning the `mcp-ts-template` repo. Those forks carry the full framework source code in their `src/` and use `@/` path aliases to import framework internals alongside their own server code.

This skill converts such a project to use `@cyanheads/mcp-ts-core` as a dependency — rewriting framework imports to package subpaths and removing the bundled framework files, while leaving server-specific code (tools, resources, prompts, services) untouched.

For the full exports catalog, see `CLAUDE.md` → Exports Reference.

## Steps

1. **Install the package**: `bun add @cyanheads/mcp-ts-core`
2. **Search for all `@/` imports** across `src/` that reference framework internals
3. **Rewrite each import** using the mapping table below
4. **Identify framework source files** now provided by the package (see candidates below) — review each for server-specific additions before cleaning up
5. **Update entry point** (`src/index.ts`) to use `createApp()` from the package and the project's chosen registration pattern (fresh scaffold default: direct imports in `src/index.ts`)
6. **Update build configs**:
   - `tsconfig.json` extends `@cyanheads/mcp-ts-core/tsconfig.base.json`
   - `biome.json` extends `@cyanheads/mcp-ts-core/biome`
   - `vitest.config.ts` spreads from `@cyanheads/mcp-ts-core/vitest.config`
7. **Run `bun run devcheck`** to verify no broken imports remain
8. **Verify no `@/` imports** point to framework files that are no longer local

## Import mapping

These are the actual `@/` import paths used in framework source. Rewrite any that appear in server-specific files (tools, resources, services, config).

### Core

| Old `@/` import | New package import |
|:----------------|:-------------------|
| `@/config/index.js` | `@cyanheads/mcp-ts-core/config` |
| `@/context.js` or `@/core/context.js` | `@cyanheads/mcp-ts-core` |
| `@/core/worker.js` | `@cyanheads/mcp-ts-core/worker` |
| `@/types-global/errors.js` | `@cyanheads/mcp-ts-core/errors` |
| `@/storage/core/StorageService.js` | `@cyanheads/mcp-ts-core/storage` |
| `@/storage/core/IStorageProvider.js` | `@cyanheads/mcp-ts-core/storage/types` |
| `@/mcp-server/transports/auth/lib/checkScopes.js` | `@cyanheads/mcp-ts-core/auth` |
| `@/testing/index.js` | `@cyanheads/mcp-ts-core/testing` |

### Definition types

| Old `@/` import | New package import |
|:----------------|:-------------------|
| `@/mcp-server/tools/utils/toolDefinition.js` | `@cyanheads/mcp-ts-core/tools` or `@cyanheads/mcp-ts-core` (for `tool()` builder) |
| `@/mcp-server/resources/utils/resourceDefinition.js` | `@cyanheads/mcp-ts-core/resources` or `@cyanheads/mcp-ts-core` (for `resource()` builder) |
| `@/mcp-server/prompts/utils/promptDefinition.js` | `@cyanheads/mcp-ts-core/prompts` or `@cyanheads/mcp-ts-core` (for `prompt()` builder) |
| `@/mcp-server/tasks/utils/taskToolDefinition.js` | `@cyanheads/mcp-ts-core/tasks` |

### Utils

| Old `@/` import | New package import |
|:----------------|:-------------------|
| `@/utils/internal/logger.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/internal/requestContext.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/internal/error-handler/errorHandler.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/internal/runtime.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/internal/encoding.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/formatting/*.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/parsing/*.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/security/*.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/network/*.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/pagination/pagination.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/types/guards.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/scheduling/*.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/telemetry/*.js` | `@cyanheads/mcp-ts-core/utils` |
| `@/utils/metrics/*.js` | `@cyanheads/mcp-ts-core/utils` |

### Services

| Old `@/` import | New package import |
|:----------------|:-------------------|
| `@/services/llm/*.js` | `@cyanheads/mcp-ts-core/services` |
| `@/services/speech/*.js` | `@cyanheads/mcp-ts-core/services` |
| `@/services/graph/*.js` | `@cyanheads/mcp-ts-core/services` |

## Framework file candidates

After rewriting imports, these directories and files are candidates for cleanup — they contain framework code now provided by the package. **Review each before acting**: the server may have added custom files alongside framework code in any of these directories. Preserve anything server-specific.

**Preserve:** server-specific code under `mcp-server/tools/definitions/`, `mcp-server/resources/definitions/`, `mcp-server/prompts/definitions/`, the server's own `services/`, and `config/server-config.ts`.

Framework directories (typically safe to clean up in full — verify no server-specific files were added):

- `src/core/` (app, context, worker)
- `src/cli/`
- `src/types-global/`
- `src/storage/`
- `src/utils/`
- `src/testing/`
- `src/services/llm/`, `src/services/speech/`, `src/services/graph/` (framework-provided services — the server's own service directories are separate)

Framework files within directories that contain server code:

- `src/config/index.ts` (the framework config loader — `server-config.ts` is server-specific, keep it)
- `src/mcp-server/server.ts`
- `src/mcp-server/transports/` (entire directory)
- `src/mcp-server/roots/` (entire directory)
- `src/mcp-server/tasks/` (core task infra — tool definitions using `task: true` are server code)
- `src/mcp-server/tools/utils/`, `src/mcp-server/tools/tool-registration.ts`
- `src/mcp-server/resources/utils/`, `src/mcp-server/resources/resource-registration.ts`
- `src/mcp-server/prompts/utils/`, `src/mcp-server/prompts/prompt-registration.ts`

## Entry point rewrite

Replace the fork's `src/index.ts` with the scaffold-default direct-registration pattern:

```ts
#!/usr/bin/env node
import { createApp } from '@cyanheads/mcp-ts-core';
import { echoTool } from './mcp-server/tools/definitions/echo.tool.js';
import { echoResource } from './mcp-server/resources/definitions/echo.resource.js';
import { echoPrompt } from './mcp-server/prompts/definitions/echo.prompt.js';

await createApp({
  tools: [echoTool],
  resources: [echoResource],
  prompts: [echoPrompt],
});
```

Add `setup()` if the server initializes services:

```ts
await createApp({
  tools: [echoTool],
  resources: [echoResource],
  prompts: [echoPrompt],
  setup(core) {
    initMyService(core.config, core.storage);
  },
});
```

If the migrated project already has `definitions/index.ts` barrels and you want to keep them, that is fine. The important part is removing imports from framework internals and registering definitions consistently.

## Checklist

- [ ] `@cyanheads/mcp-ts-core` installed as a dependency
- [ ] All framework `@/` imports rewritten to `@cyanheads/mcp-ts-core/*` subpaths
- [ ] No `@/` imports point to framework files that are no longer local
- [ ] `src/index.ts` uses `createApp()` from the package
- [ ] `tsconfig.json` extends `@cyanheads/mcp-ts-core/tsconfig.base.json`
- [ ] `biome.json` extends `@cyanheads/mcp-ts-core/biome`
- [ ] `vitest.config.ts` spreads from `@cyanheads/mcp-ts-core/vitest.config`
- [ ] Framework source files cleaned up from `src/`
- [ ] Server-specific `@/` imports (own tools, services) still work
- [ ] `bun run devcheck` passes

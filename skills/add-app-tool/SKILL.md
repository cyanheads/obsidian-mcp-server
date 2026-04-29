---
name: add-app-tool
description: >
  Scaffold an MCP App tool + UI resource pair. Use when the user asks to add a tool with interactive UI, create an MCP App, or build a visual/interactive tool.
metadata:
  author: cyanheads
  version: "1.3"
  audience: external
  type: reference
---

## Context

MCP Apps extend the standard tool pattern with an interactive HTML UI rendered in a sandboxed iframe by the host. Each MCP App consists of two definitions:

1. **App tool** (`.app-tool.ts`) — uses `appTool()` builder, declares `resourceUri` pointing to the UI resource
2. **App resource** (`.app-resource.ts`) — uses `appResource()` builder, serves the bundled HTML

Both builders are exported from `@cyanheads/mcp-ts-core`. They handle `_meta.ui.resourceUri`, the compat key (`ui/resourceUri`), and the correct MIME type (`text/html;profile=mcp-app`) automatically.

For the full API, Context interface, and error codes, read `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md`.

## Steps

1. **Ask the user** for the tool's name, purpose, input/output shape, and what the UI should display
2. **Choose a URI** — convention: `ui://{{tool-name}}/app.html`
3. **Create the app tool** at `src/mcp-server/tools/definitions/{{tool-name}}.app-tool.ts`
4. **Create the app resource** at `src/mcp-server/resources/definitions/{{tool-name}}-ui.app-resource.ts`
5. **Register both** in the project's existing `createApp()` arrays (directly in `src/index.ts` for fresh scaffolds, or via barrels if the repo already has them)
6. **Run `bun run devcheck`** — the linter validates `_meta.ui` and cross-checks tool/resource pairing
7. **Smoke-test** with `bun run dev:stdio` or `dev:http`

## App Tool Template

```typescript
/**
 * @fileoverview {{TOOL_DESCRIPTION}}
 * @module mcp-server/tools/definitions/{{TOOL_NAME}}.app-tool
 */

import { appTool, z } from '@cyanheads/mcp-ts-core';

const UI_RESOURCE_URI = 'ui://{{tool-name}}/app.html';

export const {{TOOL_EXPORT}} = appTool('{{tool_name}}', {
  resourceUri: UI_RESOURCE_URI,
  title: '{{TOOL_TITLE}}',
  description: '{{TOOL_DESCRIPTION}}',
  annotations: { readOnlyHint: true },
  input: z.object({
    // All fields need .describe(). Only JSON-Schema-serializable Zod types allowed.
  }),
  output: z.object({
    // All fields need .describe(). Only JSON-Schema-serializable Zod types allowed.
  }),
  // auth: ['tool:{{tool_name}}:read'],

  async handler(input, ctx) {
    ctx.log.info('Processing', { /* relevant input fields */ });
    return { /* output */ };
  },

  // format() serves dual purpose for app tools:
  // 1. First text block: JSON for the UI (app.ontoolresult parses it)
  // 2. Subsequent blocks: human-readable, content-complete fallback for non-app hosts and LLM context
  format(result) {
    return [
      { type: 'text', text: JSON.stringify(result) },
      { type: 'text', text: '/* human-readable summary with all LLM-needed fields */' },
    ];
  },
});
```

## App Resource Template

```typescript
/**
 * @fileoverview UI resource for {{TOOL_NAME}}.
 * @module mcp-server/resources/definitions/{{TOOL_NAME}}-ui.app-resource
 */

import { appResource, z } from '@cyanheads/mcp-ts-core';

const ParamsSchema = z.object({}).describe('No parameters. Returns the static HTML app.');

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{TOOL_TITLE}}</title>
  <style>/* your styles */</style>
</head>
<body>
  <!-- your UI markup -->

  <script type="module">
    // Prefer a bundled or inlined SDK for the final shipped HTML. Leaving a live
    // CDN import in the served ui:// resource is not the recommended default.
    import {
      App,
      applyDocumentTheme,
      applyHostFonts,
      applyHostStyleVariables,
    } from "https://unpkg.com/@modelcontextprotocol/ext-apps@1/app-with-deps";

    const app = new App({ name: "{{TOOL_TITLE}}", version: "1.0.0" });

    function applyHostContext(hostContext) {
      if (hostContext?.theme) {
        applyDocumentTheme(hostContext.theme);
      }
      if (hostContext?.styles?.variables) {
        applyHostStyleVariables(hostContext.styles.variables);
      }
      if (hostContext?.styles?.css?.fonts) {
        applyHostFonts(hostContext.styles.css.fonts);
      }
    }

    // Receive initial tool result from the host
    app.ontoolresult = (result) => {
      const text = result.content?.find(c => c.type === "text")?.text;
      if (!text) return;
      const data = JSON.parse(text);
      // render data into the DOM
    };
    app.onhostcontextchanged = applyHostContext;

    // Proactively call tools from the UI
    document.getElementById("action-btn").addEventListener("click", async () => {
      const result = await app.callServerTool({
        name: "{{tool_name}}",
        arguments: { /* input */ },
      });
      // handle result
    });

    app.connect().then(() => {
      const hostContext = app.getHostContext();
      if (hostContext) applyHostContext(hostContext);
    });
  </script>
</body>
</html>`;

export const {{RESOURCE_EXPORT}} = appResource('ui://{{tool-name}}/app.html', {
  name: '{{tool-name}}-ui',
  title: '{{TOOL_TITLE}} UI',
  description: 'Interactive HTML app for {{tool_name}}.',
  params: ParamsSchema,
  // auth: ['resource:{{tool-name}}-ui:read'],
  _meta: {
    ui: {
      csp: { resourceDomains: ['https://unpkg.com'] },
    },
  },

  handler(_params, ctx) {
    ctx.log.debug('Serving app UI.', { resourceUri: ctx.uri?.href });
    return APP_HTML;
  },

  list: () => ({
    resources: [
      {
        uri: 'ui://{{tool-name}}/app.html',
        name: '{{TOOL_TITLE}}',
        description: 'Interactive UI for {{tool_name}}.',
      },
    ],
  }),
});
```

## UI Design Notes

- **Bundling:** Prefer Vite + `vite-plugin-singlefile` for any UI that uses `@modelcontextprotocol/ext-apps`. The served `ui://` HTML should ideally be self-contained. The inline template literal pattern is fine for zero-dependency UIs or when you inline the SDK yourself.
- **Client-side SDK:** Author against `@modelcontextprotocol/ext-apps`, but ship a bundled or inlined artifact when possible. Avoid relying on a live CDN import as the default final pattern for portable host compatibility.
- **CSP:** MCP Apps iframes run under deny-by-default CSP. With `appResource()`, put `_meta.ui.csp.resourceDomains` on the definition and the builder will mirror it into returned `resources/read` content items. With plain `resource()`, you still need to attach `_meta.ui` yourself in `format()`.
- **App resource `format()`:** `appResource()` already preserves raw HTML for the default app MIME type and mirrors definition `_meta.ui` into content items. Add a custom `format()` only when you need extra per-read metadata or non-default content shaping.
- **format() for app tools:** The first `text` content block is typically JSON that the UI parses via `ontoolresult`. Additional blocks provide a human-readable fallback that non-app hosts and LLMs consume. Do not rely on the JSON block alone for model-visible detail; the fallback blocks still need to render the fields the LLM must reason about.

## Registration

```typescript
// src/index.ts (fresh scaffold default)
import { createApp } from '@cyanheads/mcp-ts-core';
import { {{TOOL_EXPORT}} } from './mcp-server/tools/definitions/{{tool-name}}.app-tool.js';
import { {{RESOURCE_EXPORT}} } from './mcp-server/resources/definitions/{{tool-name}}-ui.app-resource.js';

await createApp({
  tools: [{{TOOL_EXPORT}}],
  resources: [{{RESOURCE_EXPORT}}],
  prompts: [/* existing prompts */],
});
```

If the repo already uses `definitions/index.ts` barrels, update those instead of changing the registration pattern.

## Checklist

- [ ] App tool created at `src/mcp-server/tools/definitions/{{tool-name}}.app-tool.ts` using `appTool()`
- [ ] App resource created at `src/mcp-server/resources/definitions/{{tool-name}}-ui.app-resource.ts` using `appResource()`
- [ ] `resourceUri` matches between tool and resource (`ui://{{tool-name}}/app.html`)
- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types
- [ ] `format()` renders JSON first block (for UI) + human-readable, content-complete fallback blocks (for non-app hosts and LLMs)
- [ ] App resource `_meta.ui.csp` covers any external iframe dependencies, or a custom `format()` adds equivalent per-read metadata
- [ ] UI bundles or inlines the client SDK for the shipped HTML, and handles `app.ontoolresult`
- [ ] UI applies host context updates via `app.onhostcontextchanged`
- [ ] Both registered in the project's existing `createApp()` arrays (directly or via barrels)
- [ ] `bun run devcheck` passes (linter validates `_meta.ui` and tool/resource pairing)
- [ ] Smoke-tested with `bun run dev:stdio` or `dev:http`

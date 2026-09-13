---
name: add-app-tool
description: >
  Scaffold an MCP App tool + UI resource pair. Use when the user asks to add a tool with interactive UI, create an MCP App, or build a visual/interactive tool.
metadata:
  author: cyanheads
  version: "1.5"
  audience: external
  type: reference
---

## When to Use

App tools are **rarely the right choice**. Reach for one only when all of the following hold:

1. A *human* will actively interact with the result in real time — not just an LLM consuming text.
2. The target deployment runs in a client that supports MCP Apps. Many clients (Claude Code, Cursor, most chat UIs) are tool-only and will only ever see the `format()` text fallback you have to maintain anyway.
3. The interaction the UI enables — scrubbing a dense table, approving a multi-step plan, filling a structured form — is core to the workflow, not nice-to-have rendering.

App tools cost more than standard tools: an iframe + CSP setup, `app.ontoolresult` / `callServerTool` plumbing, host-context wiring (theme, fonts, styles), and a `format()` text path that has to be content-complete because most clients see only that. Two surfaces to keep in sync, two failure modes per change.

Default to `add-tool`. This skill is the how-to once that bar is cleared — the "whether to" decision belongs in `design-mcp-server`.

## Context

MCP Apps extend the standard tool pattern with an interactive HTML UI rendered in a sandboxed iframe by the host. Each MCP App consists of two definitions:

1. **App tool** (`.app-tool.ts`) — uses `appTool()` builder, declares `resourceUri` pointing to the UI resource
2. **App resource** (`.app-resource.ts`) — uses `appResource()` builder, serves the bundled HTML

Both builders are exported from `@cyanheads/mcp-ts-core`. They handle `_meta.ui.resourceUri`, the compat key (`ui/resourceUri`), and the correct MIME type (`text/html;profile=mcp-app`) automatically.

For the full API, Context interface, and error codes, read the framework's `CLAUDE.md`/`AGENTS.md` (loaded at session start).

## Steps

1. **Confirm the three conditions** in "When to Use" apply — if any is uncertain, default to `add-tool` instead. Then **gather** the tool's name, purpose, input/output shape, and what the UI should display from the user's request — ask only if genuinely absent
2. **Choose a URI** — convention: `ui://{{tool-name}}/app.html`
3. **Create the app tool** at `src/mcp-server/tools/definitions/{{tool-name}}.app-tool.ts`
4. **Create the app resource** at `src/mcp-server/resources/definitions/{{tool-name}}-ui.app-resource.ts`
5. **Register both** in the project's existing `createApp()` arrays (directly in `src/index.ts` for fresh scaffolds, or via barrels if the repo already has them)
6. **Run `bun run devcheck`** — the linter validates `_meta.ui` and cross-checks tool/resource pairing
7. **Smoke-test** with `bun run rebuild && bun run start:stdio` (or `start:http`)

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
    // PROTOTYPING ONLY — replace before shipping. Bundle via Vite +
    // vite-plugin-singlefile or inline the SDK. Live CDN imports require
    // CSP whitelisting, add supply-chain risk, and break offline use.
    // See UI Notes below.
    import {
      App,
      applyDocumentTheme,
      applyHostFonts,
      applyHostStyleVariables,
    } from "https://unpkg.com/@modelcontextprotocol/ext-apps@2/app-with-deps";

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

## UI Notes

- **Ship self-contained HTML.** Author with Vite + `vite-plugin-singlefile` or inline the SDK. Live CDN imports in a `ui://` resource are a CSP footgun (every domain has to be whitelisted on `_meta.ui.csp.resourceDomains`), a supply-chain footgun (third-party JS executes inside the host's iframe), and a runtime footgun (every render needs network). The `unpkg` line in the template is for prototyping only.
- **CSP.** MCP Apps iframes run under deny-by-default CSP. With `appResource()`, put `_meta.ui.csp.resourceDomains` on the definition; the builder mirrors it into returned `resources/read` content items. With plain `resource()`, attach `_meta.ui` yourself in `format()`.
- **Adopt the host's visual identity, don't impose your own.** App UIs render inside the host's iframe alongside its native UI. Three host hooks layer on top of your CSS:
  - `applyDocumentTheme(hostContext.theme)` — sets `color-scheme` and a `data-theme` attribute on `<html>`
  - `applyHostStyleVariables(hostContext.styles.variables)` — installs host CSS custom properties on `:root` (host decides the names, e.g. `--mcp-color-bg-primary`)
  - `applyHostFonts(hostContext.styles.css.fonts)` — installs `@font-face` rules for the host's font stack

  Author CSS to *consume* these via `var(--mcp-color-bg-primary, /* fallback */ #fff)`. Don't hardcode brand colors that fight the host.
- **Pre-connect baseline.** `app.connect()` is async — host context arrives a frame or two after first paint. Without a baseline, the UI flashes unstyled or wrong-themed on light hosts. Ship a `prefers-color-scheme`-aware default so the first frame is sensible:

  ```css
  :root { color-scheme: light dark; --bg: #fff; --fg: #111; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0d12; --fg: #ededef; } }
  body { background: var(--bg); color: var(--fg); }
  ```

  Host vars override these once `onhostcontextchanged` fires.
- **`format()` for app tools.** The first `text` content block is typically JSON that the UI parses via `ontoolresult`. Additional blocks are the human-readable fallback that non-app hosts and LLMs consume — they must render every field the LLM needs to reason about. JSON-only payloads leave model-visible context blind.
- **App resource `format()`.** `appResource()` already preserves raw HTML for the default app MIME type and mirrors definition `_meta.ui` into content items. Add a custom `format()` only when you need extra per-read metadata or non-default content shaping.

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
- [ ] `format()` first block is `JSON.stringify(result)` — the full output object for the UI to parse via `app.ontoolresult`. Subsequent blocks are human-readable, content-complete fallback for non-app hosts and LLMs
- [ ] App resource `_meta.ui.csp.resourceDomains` lists every external domain loaded by the UI
- [ ] UI bundles or inlines the client SDK for the shipped HTML, and handles `app.ontoolresult`
- [ ] UI applies host context updates via `app.onhostcontextchanged`
- [ ] App resource has a `list` callback returning at least one URI so resource-aware clients can discover it
- [ ] Both registered in the project's existing `createApp()` arrays (directly or via barrels)
- [ ] Handler tested directly via `createMockContext()`, or `add-test` skill run to scaffold the test file
- [ ] `bun run devcheck` passes (linter validates `_meta.ui` and tool/resource pairing)
- [ ] Smoke-tested with `bun run rebuild && bun run start:stdio` (or `start:http`)

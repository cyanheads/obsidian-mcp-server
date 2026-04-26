/**
 * @fileoverview UI resource for the echo MCP App.
 * Serves a self-contained HTML application that renders echo results
 * and lets users send new echo requests from the UI.
 * @module mcp-server/resources/definitions/echo-app-ui.app-resource
 */

import { appResource, z } from '@cyanheads/mcp-ts-core';

const ParamsSchema = z.object({}).describe('No parameters. Returns the static HTML app.');

// ─── HTML Application ─────────────────────────────────────────────────────────

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Echo App</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a; color: #e2e8f0;
      padding: 1.5rem; min-height: 100vh;
      display: flex; flex-direction: column; align-items: center; gap: 1rem;
    }
    h1 { font-size: 1.25rem; font-weight: 600; }
    .card {
      background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem;
      padding: 1rem 1.25rem; width: 100%; max-width: 480px;
    }
    .label { font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
    .value { font-size: 1rem; margin-top: 0.25rem; word-break: break-word; }
    .controls { display: flex; gap: 0.5rem; width: 100%; max-width: 480px; }
    input[type="text"] {
      flex: 1; padding: 0.5rem 0.75rem; background: #1e293b; border: 1px solid #334155;
      border-radius: 0.375rem; color: #e2e8f0; font-size: 0.875rem; outline: none;
    }
    input[type="text"]:focus { border-color: #3b82f6; }
    button {
      padding: 0.5rem 1rem; background: #3b82f6; color: #fff; border: none;
      border-radius: 0.375rem; font-size: 0.875rem; cursor: pointer;
    }
    button:hover { background: #2563eb; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <h1>Echo App</h1>
  <div class="card">
    <div class="label">Message</div>
    <div class="value" id="message">Waiting for data…</div>
  </div>
  <div class="card">
    <div class="label">Timestamp</div>
    <div class="value" id="timestamp">—</div>
  </div>
  <div class="controls">
    <input type="text" id="input" placeholder="Type a message…" />
    <button id="send">Echo</button>
  </div>

  <script type="module">
    import {
      App,
      applyDocumentTheme,
      applyHostFonts,
      applyHostStyleVariables,
    } from "https://unpkg.com/@modelcontextprotocol/ext-apps@1/app-with-deps";

    const app = new App({ name: "Echo App", version: "1.0.0" });
    const messageEl = document.getElementById("message");
    const timestampEl = document.getElementById("timestamp");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");

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

    function render(content) {
      const text = content?.find(c => c.type === "text")?.text;
      if (!text) return;
      try {
        const data = JSON.parse(text);
        messageEl.textContent = data.message ?? "—";
        timestampEl.textContent = data.timestamp ?? "—";
      } catch { /* ignore malformed */ }
    }

    // Receive initial tool result pushed by the host
    app.ontoolresult = (result) => render(result.content);
    app.onhostcontextchanged = applyHostContext;

    // Send new echo from the UI
    sendBtn.addEventListener("click", async () => {
      const msg = inputEl.value.trim();
      if (!msg) return;
      sendBtn.disabled = true;
      try {
        const result = await app.callServerTool({
          name: "template_echo_app",
          arguments: { message: msg },
        });
        render(result.content);
        inputEl.value = "";
      } catch (err) {
        console.error("Echo failed:", err);
      } finally {
        sendBtn.disabled = false;
      }
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendBtn.click();
    });

    app.connect().then(() => {
      const hostContext = app.getHostContext();
      if (hostContext) applyHostContext(hostContext);
    });
  </script>
</body>
</html>`;

// ─── Definition ───────────────────────────────────────────────────────────────

export const echoAppUiResource = appResource('ui://template-echo-app/app.html', {
  name: 'echo-app-ui',
  title: 'Echo App UI',
  description:
    'Interactive HTML app for the echo app tool. Displayed as a sandboxed iframe ' +
    'by MCP Apps-capable hosts.',
  params: ParamsSchema,
  auth: ['resource:echo-app-ui:read'],
  _meta: {
    ui: {
      csp: { resourceDomains: ['https://unpkg.com'] },
    },
  },

  handler(_params, ctx) {
    ctx.log.debug('Serving echo app UI.', { resourceUri: ctx.uri?.href });
    return APP_HTML;
  },
});

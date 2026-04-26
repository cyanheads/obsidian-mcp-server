/**
 * @fileoverview MCP App tool — interactive echo with a UI component.
 * Demonstrates the MCP Apps extension: the tool returns structured data,
 * and the linked UI resource renders it as an interactive HTML interface.
 * Hosts without MCP Apps support receive the plain text fallback from format().
 * @module mcp-server/tools/definitions/echo-app.app-tool
 */

import { appTool, z } from '@cyanheads/mcp-ts-core';

/** The UI resource URI that hosts fetch and render as a sandboxed iframe. */
const UI_RESOURCE_URI = 'ui://template-echo-app/app.html';

export const echoAppTool = appTool('template_echo_app', {
  resourceUri: UI_RESOURCE_URI,
  title: 'Echo App',
  description:
    'Echoes a message with an interactive UI. Demonstrates MCP Apps — hosts that support ' +
    'the extension render an HTML interface; others receive a text fallback.',
  annotations: { readOnlyHint: true },
  input: z.object({
    message: z.string().describe('The message to echo.'),
  }),
  output: z.object({
    message: z.string().describe('The echoed message.'),
    timestamp: z.string().describe('ISO 8601 timestamp of the echo.'),
  }),

  handler(input, ctx) {
    ctx.log.debug('Echo app called.', { message: input.message });
    return {
      message: input.message,
      timestamp: new Date().toISOString(),
    };
  },

  format(result) {
    // First block: JSON for the MCP App UI (ontoolresult parses first text block)
    const jsonBlock = JSON.stringify(result);

    // Second block: human-readable fallback for non-app hosts / LLM context
    const textBlock = `**Echo:** ${result.message}\n**Time:** ${result.timestamp}`;

    return [
      { type: 'text', text: jsonBlock },
      { type: 'text', text: textBlock },
    ];
  },
});

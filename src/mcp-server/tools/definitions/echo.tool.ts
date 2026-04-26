/**
 * @fileoverview Echo tool — a minimal starting point for building MCP tools.
 * @module mcp-server/tools/definitions/echo.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

// Tool names are snake_case, prefixed with your server name to avoid collisions across servers.
// e.g. for a "tasks" server: tasks_fetch_list, tasks_create_item.
export const echoTool = tool('template_echo_message', {
  description: 'Echoes a message back. Replace this with your first real tool.',
  annotations: { readOnlyHint: true },
  input: z.object({
    message: z.string().describe('The message to echo back.'),
  }),
  output: z.object({
    message: z.string().describe('The echoed message.'),
  }),

  handler(input) {
    return { message: input.message };
  },

  // format() populates MCP content[] — the markdown twin of structuredContent.
  // Different clients read different surfaces (Claude Code → structuredContent,
  // Claude Desktop → content[]); both must carry the same data.
  // This echo tool is trivial; real tools should render every relevant field.
  format: (result) => [{ type: 'text', text: result.message }],
});

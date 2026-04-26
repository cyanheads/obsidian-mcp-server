/**
 * @fileoverview Echo prompt — a minimal starting point for building MCP prompts.
 * @module mcp-server/prompts/definitions/echo.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

// Prompts are pure message templates — no Context, no auth, no side effects.
// They generate conversation messages that clients can use to start interactions.
export const echoPrompt = prompt('template_echo_message', {
  description: 'Generates a simple echo message. Replace this with your first real prompt.',
  args: z.object({
    message: z.string().describe('The message to echo.'),
  }),
  generate: (args) => [{ role: 'user', content: { type: 'text', text: `Echo: ${args.message}` } }],
});

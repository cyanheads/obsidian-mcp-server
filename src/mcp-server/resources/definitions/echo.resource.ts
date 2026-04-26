/**
 * @fileoverview Echo resource — a minimal starting point for building MCP resources.
 * @module mcp-server/resources/definitions/echo.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';

// Resource URI templates use RFC 6570 syntax. Params are extracted from {placeholders}.
// Like tools, prefix names with your server name: template-echo, tasks-status, etc.
export const echoResource = resource('echo://{message}', {
  name: 'template-echo-resource',
  description: 'Echoes a message from the URI. Replace this with your first real resource.',
  mimeType: 'application/json',
  params: z.object({
    message: z.string().describe('The message to echo back.'),
  }),
  output: z.object({
    message: z.string().describe('The echoed message.'),
  }),

  handler(params) {
    return { message: params.message };
  },

  list: () => ({
    resources: [{ uri: 'echo://hello', name: 'Echo Hello' }],
  }),
});

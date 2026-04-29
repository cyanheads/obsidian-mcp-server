/**
 * @fileoverview obsidian://status — reachability + auth check for the Obsidian
 * Local REST API plugin. Issues an anonymous probe (so the resource still
 * works when the key is wrong) and a separate authenticated probe so the
 * `authenticated` field reflects whether the configured key is accepted.
 * @module mcp-server/resources/definitions/obsidian-status.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianStatus = resource('obsidian://status', {
  name: 'obsidian-status',
  description:
    'Server reachability, plugin version, and auth status of the Obsidian Local REST API. Reports the unauthenticated reachability info even when the API key is misconfigured; `authenticated` reflects whether the configured key is accepted by an authenticated probe.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    status: z.string().describe('Upstream reported status string.'),
    service: z.string().describe('Service identifier returned by the plugin.'),
    authenticated: z
      .boolean()
      .describe(
        'True when the configured OBSIDIAN_API_KEY is accepted by an authenticated probe to /vault/.',
      ),
    versions: z
      .object({
        obsidian: z.string().optional().describe('Obsidian app version, when reported.'),
        self: z.string().optional().describe('Local REST API plugin version, when reported.'),
      })
      .optional()
      .describe('Version information from the plugin, when present.'),
    manifest: z
      .object({
        id: z.string().describe('Plugin manifest ID.'),
        name: z.string().describe('Plugin display name.'),
        version: z.string().describe('Plugin version.'),
      })
      .optional()
      .describe('Plugin manifest, when reported.'),
  }),
  auth: ['resource:obsidian-status:read'],

  async handler(_params, ctx) {
    const svc = getObsidianService();
    const [status, authenticated] = await Promise.all([
      svc.getStatus(ctx),
      svc.probeAuthenticated(ctx),
    ]);
    return { ...status, authenticated };
  },
});

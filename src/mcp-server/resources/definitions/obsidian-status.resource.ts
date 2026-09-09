/**
 * @fileoverview obsidian://status — reachability, auth, and capability report
 * for the Obsidian Local REST API plugin. One authenticated `GET /`: the route
 * answers `200` whatever the key is and self-reports whether it was accepted,
 * so a misconfigured key still yields the full reachability payload, and
 * `apiExtensions` — which the plugin omits from the unauthenticated response —
 * comes back on the same request.
 * @module mcp-server/resources/definitions/obsidian-status.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';

export const obsidianStatus = resource('obsidian://status', {
  name: 'obsidian-status',
  description:
    'Server reachability, plugin version, auth status, and registered API extensions of the Obsidian Local REST API. Still reports reachability when the API key is misconfigured; `authenticated` reflects whether the plugin accepted the configured key. Check `apiExtensions` before using a `periodic` note target — on plugin v5.0.2 and later those routes are served only when `local-rest-api-periodic-notes` is registered.',
  mimeType: 'application/json',
  params: z.object({}),
  output: z.object({
    status: z.string().describe('Upstream reported status string.'),
    service: z.string().describe('Service identifier returned by the plugin.'),
    authenticated: z
      .boolean()
      .describe('True when the plugin accepted the configured OBSIDIAN_API_KEY on this request.'),
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
    apiExtensions: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe(
                'Extension manifest ID, e.g. `local-rest-api-periodic-notes` for the extension that serves `/periodic/` routes on plugin v5.0.2 and later.',
              ),
            name: z.string().optional().describe('Extension display name, when reported.'),
            version: z.string().optional().describe('Extension version, when reported.'),
          })
          .describe('One registered API extension.'),
      )
      .optional()
      .describe(
        'API extensions registered against the plugin. An empty array means none are registered; the field is absent when the plugin did not report it at all, which it does only for a request whose API key was accepted.',
      ),
  }),
  auth: ['resource:obsidian-status:read'],

  async handler(_params, ctx) {
    return await getObsidianService().getStatus(ctx);
  },
});

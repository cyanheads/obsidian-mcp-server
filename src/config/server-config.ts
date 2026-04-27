/**
 * @fileoverview Server-specific config for obsidian-mcp-server.
 * Loads OBSIDIAN_* env vars used by the Obsidian Local REST API service layer.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const envBoolean = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const str = val.toLowerCase().trim();
    return str === 'true' || str === '1';
  }
  return val;
}, z.boolean());

const ServerConfigSchema = z.object({
  apiKey: z
    .string()
    .min(1)
    .describe(
      'Bearer token for the Obsidian Local REST API plugin (Settings → Community Plugins → Local REST API).',
    ),
  baseUrl: z
    .string()
    .url()
    .default('https://127.0.0.1:27124')
    .describe(
      'Base URL of the Obsidian Local REST API. HTTPS on 27124 (self-signed) is the default; switch to http://127.0.0.1:27123 for the insecure HTTP port.',
    ),
  verifySsl: envBoolean
    .default(false)
    .describe(
      "Whether to verify the TLS certificate on the Obsidian endpoint. Defaults to false because the plugin uses a self-signed cert. When false, the service sets `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide — Bun's runtime ignores undici's per-dispatcher option and that's the only reliable opt-out.",
    ),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Per-request timeout in milliseconds.'),
  enableCommands: envBoolean
    .default(false)
    .describe(
      'Opt-in flag for obsidian_execute_command. Off by default — Obsidian commands are opaque and can be destructive.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'OBSIDIAN_API_KEY',
    baseUrl: 'OBSIDIAN_BASE_URL',
    verifySsl: 'OBSIDIAN_VERIFY_SSL',
    requestTimeoutMs: 'OBSIDIAN_REQUEST_TIMEOUT_MS',
    enableCommands: 'OBSIDIAN_ENABLE_COMMANDS',
  });
  return _config;
}

/** Test hook to reset the cached config. Not used at runtime. */
export function resetServerConfig(): void {
  _config = undefined;
}

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

/**
 * Comma-separated path-list preprocessor. Semantics (see issue #40):
 * - undefined / `''` / whitespace-only → undefined (treat as unset; default = full vault)
 * - `,` / `,,,` (separators only, no path content) → throw ZodError → ConfigurationError
 * - mixed empties (`a,,b`) → drop empties → `['a', 'b']`
 * - absolute path / `..` traversal → throw
 * - valid: lower-case + trim trailing slash + dedupe (preserves first occurrence order)
 */
const envPathList = z
  .preprocess(
    (val) => {
      if (val === undefined || val === null) return;
      if (Array.isArray(val)) return val;
      if (typeof val !== 'string') return val;
      if (val.trim() === '') return;
      const parts = val
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return parts;
    },
    z
      .array(z.string())
      .optional()
      .transform((parts, ctx) => {
        if (parts === undefined) return;
        if (parts.length === 0) {
          ctx.addIssue({
            code: 'custom',
            message: 'contained separators but no valid paths after trimming',
          });
          return z.NEVER;
        }
        const seen = new Set<string>();
        const out: string[] = [];
        for (const raw of parts) {
          if (raw.startsWith('/') || raw.startsWith('\\')) {
            ctx.addIssue({
              code: 'custom',
              message: `must be vault-relative; got absolute path '${raw}'`,
            });
            return z.NEVER;
          }
          const segments = raw.split(/[\\/]/);
          if (segments.includes('..')) {
            ctx.addIssue({
              code: 'custom',
              message: `must not contain '..' traversal; got '${raw}'`,
            });
            return z.NEVER;
          }
          const normalized = raw.toLowerCase().replace(/[\\/]+$/, '');
          if (normalized.length === 0) continue;
          if (seen.has(normalized)) continue;
          seen.add(normalized);
          out.push(normalized);
        }
        return out.length > 0 ? out : undefined;
      }),
  )
  .describe(
    'Comma-separated list of vault-relative folder prefixes. Empty/whitespace falls back to unset.',
  );

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
    .default('http://127.0.0.1:27123')
    .describe(
      'Base URL of the Obsidian Local REST API. Defaults to http://127.0.0.1:27123 — enable "Non-encrypted (HTTP) Server" in the plugin settings to match. Use https://127.0.0.1:27124 to hit the always-on HTTPS port (self-signed cert; pair with OBSIDIAN_VERIFY_SSL=false).',
    ),
  verifySsl: envBoolean
    .default(false)
    .describe(
      "Whether to verify the TLS certificate on the Obsidian endpoint. Defaults to false because the plugin uses a self-signed cert. On Node, the dispatcher's `rejectUnauthorized` option handles this without any process-wide change. On Bun, the runtime ignores that option, so the service additionally sets `NODE_TLS_REJECT_UNAUTHORIZED=0` — that fallback is scoped to Bun only.",
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
      'Opt-in flag for the command-palette pair (`obsidian_list_commands` + `obsidian_execute_command`). Off by default — Obsidian commands are opaque and can be destructive.',
    ),
  readPaths: envPathList.describe(
    'Optional vault-relative folder allowlist for read operations. Comma-separated; prefix-based with implicit recursion; case-insensitive; trailing slashes normalized. Unset = full vault.',
  ),
  writePaths: envPathList.describe(
    'Optional vault-relative folder allowlist for write operations. Same syntax as OBSIDIAN_READ_PATHS. Write paths are implicitly readable. Unset = full vault.',
  ),
  readOnly: envBoolean
    .default(false)
    .describe(
      'Global kill switch. When true, denies every write regardless of OBSIDIAN_WRITE_PATHS, and suppresses the OBSIDIAN_ENABLE_COMMANDS pair (commands can mutate). Defaults to false.',
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
    readPaths: 'OBSIDIAN_READ_PATHS',
    writePaths: 'OBSIDIAN_WRITE_PATHS',
    readOnly: 'OBSIDIAN_READ_ONLY',
  });
  return _config;
}

/** Test hook to reset the cached config. Not used at runtime. */
export function resetServerConfig(): void {
  _config = undefined;
}

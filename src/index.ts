#!/usr/bin/env node
/**
 * @fileoverview obsidian-mcp-server entry point. Initializes the Obsidian
 * Local REST API service in `setup()` so handlers can reach it via
 * `getObsidianService()`.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { allPromptDefinitions } from '@/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import {
  commandToolDefinitions,
  readToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';
import { initObsidianService } from '@/services/obsidian/obsidian-service.js';
import { PathPolicy } from '@/services/obsidian/path-policy.js';

const config = getServerConfig();
const policy = new PathPolicy(config);

/**
 * Build the server-level `instructions` string sent on every `initialize`.
 * Provides baseline orientation about the server and then layers in
 * deployment-specific lines (read-only mode, scoped paths, command-palette
 * toggle) when those flags are active.
 */
function buildInstructions(): string {
  const sections: string[] = [
    'Obsidian vault MCP server backed by the Local REST API plugin. Use `obsidian_*` tools to search, read, and edit vault notes. Notes are addressed by vault-relative path including the file extension (e.g. `Folder/Note.md`). Tags support hierarchical `parent/child` notation; counts roll up to parents.',
  ];
  if (config.readOnly) {
    sections.push(
      'Read-only mode is active (OBSIDIAN_READ_ONLY=true): every write tool rejects every path with `path_forbidden` / `read_only_mode`.',
    );
  } else if (!policy.isUnrestricted) {
    const { readPaths, writePaths } = policy.describe();
    const render = (scope: readonly string[] | string): string =>
      typeof scope === 'string' ? scope : scope.map((p) => `'${p}'`).join(', ');
    sections.push(
      `Vault path policy is enforced. Readable: ${render(readPaths)}. Writable: ${render(writePaths)}. Paths outside scope reject with \`path_forbidden\` — error data carries the active scope so you can self-correct.`,
    );
  }
  if (config.enableCommands && !config.readOnly) {
    sections.push(
      'Command-palette tools (`obsidian_list_commands`, `obsidian_execute_command`) are enabled and can fire any Obsidian command. Commands are opaque and may be destructive — prefer dedicated tools when one fits.',
    );
  }
  return sections.join('\n\n');
}

const writeTools = config.readOnly
  ? writeToolDefinitions.map((def) =>
      disabledTool(def, {
        reason: 'Disabled by OBSIDIAN_READ_ONLY=true.',
        hint: 'Unset OBSIDIAN_READ_ONLY (or set it to false) to enable write tools.',
      }),
    )
  : writeToolDefinitions;

const commandTools =
  config.enableCommands && !config.readOnly
    ? commandToolDefinitions
    : commandToolDefinitions.map((def) =>
        disabledTool(def, {
          reason: config.readOnly
            ? 'Disabled by OBSIDIAN_READ_ONLY=true (commands can mutate).'
            : 'Disabled by default — Obsidian commands are opaque and can be destructive.',
          hint: config.readOnly
            ? 'Unset OBSIDIAN_READ_ONLY to allow commands; OBSIDIAN_ENABLE_COMMANDS=true is also required.'
            : 'Set OBSIDIAN_ENABLE_COMMANDS=true to enable obsidian_list_commands and obsidian_execute_command.',
        }),
      );

const tools = [...readToolDefinitions, ...writeTools, ...commandTools];

const { services } = await createApp({
  tools,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: buildInstructions(),
  setup() {
    initObsidianService(config);
  },
});

/**
 * Startup banner — emitted after createApp() returns so the framework's
 * `logger.initialize()` has run; calls inside `setup()` happen pre-init and
 * are dropped. Operators check this against their config to verify the active
 * path policy. The active scope on `path_forbidden` errors echoes the same
 * data so the LLM (or operator) can self-correct without scrolling the log.
 */
const bannerCtx = requestContextService.createRequestContext({
  operation: 'startup',
  ...policy.describe(),
  enableCommands: config.enableCommands && !config.readOnly,
});
services.logger.info('Path policy', bannerCtx);
if (policy.readOnlyShadowsWritePaths) {
  services.logger.warning(
    'OBSIDIAN_WRITE_PATHS is set but ignored because OBSIDIAN_READ_ONLY=true. Unset one of the two to remove the conflict.',
    bannerCtx,
  );
}

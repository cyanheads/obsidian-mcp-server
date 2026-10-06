#!/usr/bin/env node
/**
 * @fileoverview obsidian-mcp-server entry point. Initializes the Obsidian
 * Local REST API service at module load so the Omnisearch probe can run
 * before tools are constructed — `obsidian_search_notes` is built via a
 * factory that takes Omnisearch reachability as input, so the `omnisearch`
 * mode appears in the tool schema only when the plugin is actually reachable.
 * @module index
 */

import { createApp, disabledTool } from '@cyanheads/mcp-ts-core';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { allPromptDefinitions } from '@/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import {
  buildDeleteNoteTool,
  buildSearchNotesTool,
  commandToolDefinitions,
  readToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';
import { getObsidianService, initObsidianService } from '@/services/obsidian/obsidian-service.js';
import { PathPolicy } from '@/services/obsidian/path-policy.js';

const config = getServerConfig();
const policy = new PathPolicy(config);

/**
 * Init the service at module load (rather than inside `setup()`) so the
 * Omnisearch probe can run before tool construction. `setup()` runs after
 * tools are passed into `createApp()`, which is too late to influence the
 * search-notes schema.
 */
initObsidianService(config);
const obsidian = getObsidianService();
const omnisearchReachable = await obsidian.probeOmnisearch();

const searchNotesTool = buildSearchNotesTool({ omnisearchReachable });

/**
 * Build the server-level `instructions` string sent on every `initialize`.
 * Provides baseline orientation about the server and then layers in
 * deployment-specific lines (read-only mode, scoped paths, command-palette
 * toggle, Omnisearch availability) when those flags are active.
 */
function buildInstructions(): string {
  const sections: string[] = [
    'Use the `obsidian_*` tools to access the Obsidian vault via the Local REST API plugin: search, read, write, and patch notes, including targeted edits to headings, blocks, and YAML frontmatter. Notes are addressed by vault-relative path including the file extension (e.g. `Folder/Note.md`); tags support hierarchical `parent/child` notation, and counts roll up to parents.',
  ];
  if (config.readOnly) {
    sections.push(
      'Read-only mode is active (OBSIDIAN_READ_ONLY=true): every write tool rejects every path with `path_forbidden` / `read_only_mode`. `obsidian_open_in_ui` still opens notes that exist, but rejects an open against a missing path — Obsidian would create the file.',
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
  if (omnisearchReachable) {
    sections.push(
      '`obsidian_search_notes` includes an `omnisearch` mode: BM25-ranked, typo-tolerant, with PDF/OCR coverage (via the Text Extractor plugin). Results cap at 50 upstream — narrow the query (quoted phrases, `-exclusion`, `path:` / `ext:` filters) to surface more.',
    );
  }
  return sections.join('\n\n');
}

const writeToolSet = [
  ...writeToolDefinitions,
  buildDeleteNoteTool({ elicitation: config.deleteElicitation }),
];

/**
 * The delete confirmation can run only when `obsidian_delete_note` is
 * registered: `OBSIDIAN_READ_ONLY=true` disables it below, so the gate — and
 * the session it needs — exists only with elicitation on and writes allowed.
 */
const deleteGateActive = config.deleteElicitation && !config.readOnly;

const writeTools = config.readOnly
  ? writeToolSet.map((def) =>
      disabledTool(def, {
        reason: 'Disabled by OBSIDIAN_READ_ONLY=true.',
        hint: 'Unset OBSIDIAN_READ_ONLY (or set it to false) to enable write tools.',
      }),
    )
  : writeToolSet;

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

const tools = [...readToolDefinitions, searchNotesTool, ...writeTools, ...commandTools];

const { services } = await createApp({
  name: 'obsidian-mcp-server',
  title: 'obsidian-mcp-server',
  tools,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  instructions: buildInstructions(),
  /**
   * With `OBSIDIAN_DELETE_ELICITATION=true` (and writes allowed),
   * `obsidian_delete_note` confirms through `ctx.requestInput`, which a
   * 2025-era HTTP client can only answer on a stateful session — under
   * stateless HTTP the tool would be unusable for them. Required, not just
   * defaulted, in that mode: over HTTP, a resolved `stateless` mode (an
   * explicit `MCP_SESSION_MODE=stateless`) fails startup with a
   * `ConfigurationError`. With the confirmation off, or the tool disabled by
   * `OBSIDIAN_READ_ONLY=true`, nothing needs a session and `stateful` is only
   * the default. stdio is never refused; `MCP_SESSION_MODE` has no effect there.
   */
  sessionMode: deleteGateActive
    ? { default: 'stateful', require: 'stateful' }
    : { default: 'stateful' },
  teardown: () => obsidian.close(),
});

/**
 * Startup banner — emitted after createApp() returns so the framework's
 * `logger.initialize()` has run; calls inside `setup()` happen pre-init and
 * are dropped. Operators check this against their config to verify the active
 * path policy and whether `obsidian_delete_note` asks before deleting
 * (`deleteElicitation`, false under read-only like `enableCommands`, since
 * the tool is disabled there). The active scope on `path_forbidden` errors echoes
 * the same data so the LLM (or operator) can self-correct without scrolling
 * the log.
 */
const bannerCtx = requestContextService.createRequestContext({
  operation: 'startup',
  additionalContext: {
    ...policy.describe(),
    enableCommands: config.enableCommands && !config.readOnly,
    deleteElicitation: deleteGateActive,
    omnisearchUrl: obsidian.omnisearchUrl,
    omnisearchReachable,
  },
});
services.logger.info('Path policy', bannerCtx);
services.logger.info(
  omnisearchReachable
    ? `Omnisearch reachable at ${obsidian.omnisearchUrl} — \`omnisearch\` mode enabled on \`obsidian_search_notes\`.`
    : `Omnisearch not reachable at ${obsidian.omnisearchUrl} — \`omnisearch\` mode omitted from \`obsidian_search_notes\`. Set OBSIDIAN_OMNISEARCH_URL or enable the Omnisearch plugin's HTTP server to use it.`,
  bannerCtx,
);
if (policy.readOnlyShadowsWritePaths) {
  services.logger.warning(
    'OBSIDIAN_WRITE_PATHS is set but ignored because OBSIDIAN_READ_ONLY=true. Unset one of the two to remove the conflict.',
    bannerCtx,
  );
}

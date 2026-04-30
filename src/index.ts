#!/usr/bin/env node
/**
 * @fileoverview obsidian-mcp-server entry point. Initializes the Obsidian
 * Local REST API service in `setup()` so handlers can reach it via
 * `getObsidianService()`.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { allPromptDefinitions } from '@/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import {
  commandToolDefinitions,
  readOnlyToolDefinitions,
  writeToolDefinitions,
} from '@/mcp-server/tools/definitions/index.js';
import { initObsidianService } from '@/services/obsidian/obsidian-service.js';

const config = getServerConfig();
const tools = [
  ...readOnlyToolDefinitions,
  ...(config.readOnly ? [] : writeToolDefinitions),
  ...(config.enableCommands && !config.readOnly ? commandToolDefinitions : []),
];

await createApp({
  tools,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  setup() {
    initObsidianService(config);
  },
});

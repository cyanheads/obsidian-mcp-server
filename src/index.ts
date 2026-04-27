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
  baseToolDefinitions,
  obsidianExecuteCommand,
} from '@/mcp-server/tools/definitions/index.js';
import { initObsidianService } from '@/services/obsidian/obsidian-service.js';

const config = getServerConfig();
const tools = config.enableCommands
  ? [...baseToolDefinitions, obsidianExecuteCommand]
  : baseToolDefinitions;

await createApp({
  tools,
  resources: allResourceDefinitions,
  prompts: allPromptDefinitions,
  setup() {
    initObsidianService(config);
  },
});

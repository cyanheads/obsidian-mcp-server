#!/usr/bin/env node
/**
 * @fileoverview obsidian-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { echoPrompt } from './mcp-server/prompts/definitions/echo.prompt.js';
import { echoResource } from './mcp-server/resources/definitions/echo.resource.js';
import { echoAppUiResource } from './mcp-server/resources/definitions/echo-app-ui.app-resource.js';
import { echoTool } from './mcp-server/tools/definitions/echo.tool.js';
import { echoAppTool } from './mcp-server/tools/definitions/echo-app.app-tool.js';

await createApp({
  tools: [echoTool, echoAppTool],
  resources: [echoResource, echoAppUiResource],
  prompts: [echoPrompt],
});

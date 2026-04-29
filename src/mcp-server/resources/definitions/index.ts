/**
 * @fileoverview Resource registration barrel for obsidian-mcp-server.
 * @module mcp-server/resources/definitions/index
 */

import { obsidianStatus } from './obsidian-status.resource.js';
import { obsidianTags } from './obsidian-tags.resource.js';
import { obsidianVaultNote } from './obsidian-vault-note.resource.js';

export const allResourceDefinitions = [obsidianVaultNote, obsidianTags, obsidianStatus];

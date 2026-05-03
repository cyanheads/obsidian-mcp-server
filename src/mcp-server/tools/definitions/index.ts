/**
 * @fileoverview Tool registration barrel. Tools are split into read-only and
 * write groups so the entry point can wrap the write set with `disabledTool()`
 * when `OBSIDIAN_READ_ONLY=true`. The command-palette pair is exported
 * separately so the entry point wraps it with `disabledTool()` when either
 * `OBSIDIAN_ENABLE_COMMANDS=false` or `OBSIDIAN_READ_ONLY=true` — keeping this
 * module free of eager config reads.
 * @module mcp-server/tools/definitions/index
 */

import { obsidianAppendToNote } from './obsidian-append-to-note.tool.js';
import { obsidianDeleteNote } from './obsidian-delete-note.tool.js';
import { obsidianExecuteCommand } from './obsidian-execute-command.tool.js';
import { obsidianGetNote } from './obsidian-get-note.tool.js';
import { obsidianListCommands } from './obsidian-list-commands.tool.js';
import { obsidianListNotes } from './obsidian-list-notes.tool.js';
import { obsidianListTags } from './obsidian-list-tags.tool.js';
import { obsidianManageFrontmatter } from './obsidian-manage-frontmatter.tool.js';
import { obsidianManageTags } from './obsidian-manage-tags.tool.js';
import { obsidianOpenInUi } from './obsidian-open-in-ui.tool.js';
import { obsidianPatchNote } from './obsidian-patch-note.tool.js';
import { obsidianReplaceInNote } from './obsidian-replace-in-note.tool.js';
import { obsidianSearchNotes } from './obsidian-search-notes.tool.js';
import { obsidianWriteNote } from './obsidian-write-note.tool.js';

/** Read-only tools — always registered, even with `OBSIDIAN_READ_ONLY=true`. */
export const readToolDefinitions = [
  obsidianGetNote,
  obsidianListNotes,
  obsidianListTags,
  obsidianSearchNotes,
  obsidianOpenInUi,
];

/** Write tools — wrapped with `disabledTool()` when `OBSIDIAN_READ_ONLY=true`. */
export const writeToolDefinitions = [
  obsidianWriteNote,
  obsidianAppendToNote,
  obsidianPatchNote,
  obsidianReplaceInNote,
  obsidianManageFrontmatter,
  obsidianManageTags,
  obsidianDeleteNote,
];

/** Combined base set — preserves the previous registration order. */
export const baseToolDefinitions = [...readToolDefinitions, ...writeToolDefinitions];

/** Command-palette tools — opt-in via `OBSIDIAN_ENABLE_COMMANDS=true`; suppressed by `OBSIDIAN_READ_ONLY=true`. */
export const commandToolDefinitions = [obsidianListCommands, obsidianExecuteCommand];

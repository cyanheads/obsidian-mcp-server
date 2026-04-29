/**
 * @fileoverview Tool registration barrel. The command-palette pair
 * (`obsidian_list_commands` + `obsidian_execute_command`) is exported
 * separately so callers can decide whether to register them based on the
 * `OBSIDIAN_ENABLE_COMMANDS` flag — keeping this module free of eager
 * config reads.
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

/** Tools registered unconditionally on every server. */
export const baseToolDefinitions = [
  obsidianGetNote,
  obsidianListNotes,
  obsidianListTags,
  obsidianSearchNotes,
  obsidianWriteNote,
  obsidianAppendToNote,
  obsidianPatchNote,
  obsidianReplaceInNote,
  obsidianManageFrontmatter,
  obsidianManageTags,
  obsidianDeleteNote,
  obsidianOpenInUi,
];

/** Command-palette tools — registered only when `OBSIDIAN_ENABLE_COMMANDS=true`. */
export const commandToolDefinitions = [obsidianListCommands, obsidianExecuteCommand];

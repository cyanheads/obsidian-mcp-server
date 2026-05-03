# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [3.1.2](changelog/3.1.x/3.1.2.md) — 2026-05-03

Folder-scoped read/write permissions and a global read-only kill switch — three opt-in env vars (OBSIDIAN_READ_PATHS, OBSIDIAN_WRITE_PATHS, OBSIDIAN_READ_ONLY) gate every path-taking tool and resource, with a new path_forbidden error reason.

## [3.1.1](changelog/3.1.x/3.1.1.md) — 2026-04-29

Adopt the mcp-ts-core 0.8.6 recovery-hint contract — every error declares a recovery, ObsidianService threads it onto the wire, and a new periodic_disabled reason distinguishes a disabled period from a missing periodic note.

## [3.1.0](changelog/3.1.x/3.1.0.md) — 2026-04-29

obsidian_write_note refuses to clobber existing notes by default — opt in with overwrite:true; obsidian_list_commands moves behind OBSIDIAN_ENABLE_COMMANDS alongside obsidian_execute_command.

## [3.0.0](changelog/3.0.x/3.0.0.md) — 2026-04-28 · ⚠️ Breaking

Full rewrite on @cyanheads/mcp-ts-core. 14 tools and 3 resources expose the Obsidian Local REST API as a typed, declarative MCP surface — section-aware editing, three-mode search, and tag reconciliation.

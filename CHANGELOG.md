# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [3.1.11](changelog/3.1.x/3.1.11.md) — 2026-05-16 · 🛡️ Security

Path-traversal hardening on the URL boundary + Windows-style separator parity across `PathPolicy` and `envPathList`. `obsidian_list_tags` gains an optional `nameRegex` filter with ReDoS guards.

## [3.1.10](changelog/3.1.x/3.1.10.md) — 2026-05-16

Server-level `instructions` on `initialize` surfaces deployment-specific orientation (path policy, read-only mode, command-palette toggle) to spec-compliant clients. Framework bump to `@cyanheads/mcp-ts-core ^0.9.1`.

## [3.1.9](changelog/3.1.x/3.1.9.md) — 2026-05-11

Section extractor and outgoing-link parser respect fenced code blocks and inline code — markdown-about-markdown notes stop yielding false-positive headings, block refs, and links. Adds `ambiguous_path` to the typed-error contract.

## [3.1.8](changelog/3.1.x/3.1.8.md) — 2026-05-11

POST/PATCH bypass `withRetry` — prevents double-apply when a successful upstream write loses its response. Adds a 13-test regression suite covering the retry policy across every method.

## [3.1.7](changelog/3.1.x/3.1.7.md) — 2026-05-10

Every mutating tool now reports `previousSizeInBytes` + `currentSizeInBytes`; `obsidian_append_to_note` gains the `created` upsert flag. Resolves [#48](https://github.com/cyanheads/obsidian-mcp-server/issues/48).

## [3.1.6](changelog/3.1.x/3.1.6.md) — 2026-05-09

Pick up `mcp_tool_scopes` claim + `MCP_AUTH_DISABLE_SCOPE_CHECKS` bypass from `@cyanheads/mcp-ts-core` 0.8.20 — resolves [#47](https://github.com/cyanheads/obsidian-mcp-server/issues/47) for OIDC providers that can't override `scope`.

## [3.1.5](changelog/3.1.x/3.1.5.md) — 2026-05-06

Bump @cyanheads/mcp-ts-core ^0.8.15 → ^0.8.18 and document the auth requirement for HTTP deployments beyond loopback.

## [3.1.4](changelog/3.1.x/3.1.4.md) — 2026-05-05

Error contracts catch up to wire reality — obsidian://vault, obsidian_append_to_note, obsidian_write_note declare failure reasons (path_forbidden, note_missing, no_active_file, periodic_*, section_target_missing) the service already throws.

## [3.1.3](changelog/3.1.x/3.1.3.md) — 2026-05-04

obsidian_get_note grows an opt-in includeLinks flag that surfaces the note's outgoing wikilinks and markdown links; tool descriptions, schema defaults, and recovery hints tightened across the surface.

## [3.1.2](changelog/3.1.x/3.1.2.md) — 2026-05-03

Folder-scoped read/write permissions and a global read-only kill switch — three opt-in env vars (OBSIDIAN_READ_PATHS, OBSIDIAN_WRITE_PATHS, OBSIDIAN_READ_ONLY) gate every path-taking tool and resource, with a new path_forbidden error reason.

## [3.1.1](changelog/3.1.x/3.1.1.md) — 2026-04-29

Adopt the mcp-ts-core 0.8.6 recovery-hint contract — every error declares a recovery, ObsidianService threads it onto the wire, and a new periodic_disabled reason distinguishes a disabled period from a missing periodic note.

## [3.1.0](changelog/3.1.x/3.1.0.md) — 2026-04-29

obsidian_write_note refuses to clobber existing notes by default — opt in with overwrite:true; obsidian_list_commands moves behind OBSIDIAN_ENABLE_COMMANDS alongside obsidian_execute_command.

## [3.0.0](changelog/3.0.x/3.0.0.md) — 2026-04-28 · ⚠️ Breaking

Full rewrite on @cyanheads/mcp-ts-core. 14 tools and 3 resources expose the Obsidian Local REST API as a typed, declarative MCP surface — section-aware editing, three-mode search, and tag reconciliation.

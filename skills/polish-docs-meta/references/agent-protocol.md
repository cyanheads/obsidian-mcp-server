# Finalizing the Agent Protocol File

Guide for updating the project's `CLAUDE.md` or `AGENTS.md` to reflect the actual server. The file may still contain scaffolded template content (onboarding blocks, generic examples) or may have been partially updated — review the current state and address what's stale or missing.

## What to Update

### 1. Clean Up the "First Session" Block (if present)

The scaffolded template includes a `## First Session` section with one-time onboarding steps. If this section is still present and the onboarding is complete, it can be safely removed (header through the `---` separator after it). If it's already gone, skip this step.

**What it looks like:**

```markdown
## First Session

> **Remove this section** from CLAUDE.md / AGENTS.md after completing these steps.

1. **Read the framework API** — ...
2. **Run the `setup` skill** — ...
3. **Design the server** — ...

---
```

### 2. Replace Example Patterns and Stale Framework References

Check the Patterns section for generic template examples (e.g., `searchItems`, `itemData`, `reviewCode`). If still present, replace them with actual tool/resource/prompt definitions from the server — or the most representative ones if there are many. If the examples already reflect real definitions, verify they're still accurate.

Also check for stale framework references — servers migrated from `mcp-ts-template` may still reference the old package name. Replace with `@cyanheads/mcp-ts-core`. Check the "Built on" line, import examples, and any framework pointers.

Pick examples that:

- Show the most common or important capability
- Demonstrate any non-trivial patterns the server uses (e.g., `ctx.state`, `ctx.elicit`, `task: true`, services)
- Include a handler with real business logic, not just passthrough

Keep 1-2 examples per primitive type (tool, resource, prompt). Don't list every definition — the README handles that.

### 3. Update the Structure Diagram

Compare the structure diagram against the actual directory layout. If it still reflects the generic template or has fallen out of date:

- Add directories/files that exist but aren't listed (e.g., `config/server-config.ts`, service directories, `worker.ts`)
- Remove entries for directories that don't exist (e.g., if no prompts were added, remove the prompts line)
- Verify nesting and naming match reality

### 4. Update the Context Table

Review the `ctx` feature table. Remove rows for features the server doesn't use (e.g., `ctx.elicit`, `ctx.sample` if no tools call them). Add any custom context usage that's become important. The table should reflect what this server actually uses, not the full framework surface.

### 5. Update Server Config Example

If the server has a `server-config.ts`, check whether the Patterns section still shows a generic config example. If so, replace it with the actual schema (or a representative subset). If the server has no custom config, remove the config example entirely.

### 6. Update the Skills Table

Check for server-specific skills added to `skills/` that aren't in the table yet. Add any missing entries. Remove framework skills the server doesn't use (rare — most are useful).

### 7. Update the Commands Table

Compare the commands table against `package.json` scripts. Add any custom scripts that are missing. Remove or rename entries that no longer match. The table should reflect the current `scripts` block.

### 8. Update the Checklist

Review the checklist for completeness. Add server-specific items that are missing (e.g., required env vars, external service dependencies, custom naming conventions). Remove items that don't apply to this server.

## What to Preserve

These sections should remain intact unless you have a specific reason to change them:

- **Core Rules** — universal to all servers built on the framework
- **Errors section** — "handlers throw, framework catches" is universal
- **Imports section** — keep unless the alias convention was changed
- **Framework reference pointer** — the line directing agents to `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md`

## Pitfalls

- Don't duplicate the full framework CLAUDE.md into the project file. The project file covers server-specific conventions; the framework file covers the API. The pointer at the top connects them.
- Don't remove `## Core Rules` even if it seems obvious — agents read this fresh each session.
- Don't add implementation details that change frequently. The agent protocol file should be stable — update it when the server's shape changes, not on every commit.
- Don't assume this is a one-time pass. The protocol file should be revisited whenever the server's surface area changes (tools added/removed, new services, config changes).

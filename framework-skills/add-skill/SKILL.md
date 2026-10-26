---
name: add-skill
description: >
  Author a skill the server publishes to the agents that use it — a root `skills/<name>/SKILL.md` per the Agent Skills specification, validated by `lint:packaging`, discovered by plugin hosts, shipped in the MCPB bundle, and optionally served over MCP. Use when the user asks to add, write, or publish a skill, agent guide, or usage guide for the server's tools, or when the design calls for one.
metadata:
  author: cyanheads
  version: "1.0"
  audience: external
  type: reference
---

## Context

A server has two skill trees, written for different readers:

| Tree | Reader | Written by |
|:-----|:-------|:-----------|
| `framework-skills/` | The agent building the server | `init` and the `maintenance` sync, plus any development skills of the server's own |
| `skills/` (root) | The agent that installed the server and is calling its tools | The author, deliberately |

Root `skills/` is absent by default; `init` and `maintenance` never write it. Claude Code always scans a plugin's root `skills/` ([Agent Plugins 1.0.0](https://agent-plugins.org/specification) fixes discovery there), so no `skills` field is needed in `.claude-plugin/plugin.json`. Each `SKILL.md` follows the [Agent Skills specification](https://agentskills.io/specification); a host skips one that doesn't, without a word, which is why `lint:packaging` validates the tree.

## No skill by default

Publish one only when an agent calling the tools needs something `instructions` and tool descriptions cannot carry: a multi-hop identifier chain, a gate that prevents a wrong call or a wrong conclusion, a query syntax. Overview skills that restate the tool list, generic "how to use this server" workflows, and skills for hypothetical tasks do not ship.

## Authoring rules

- **Perspective.** The reader is the agent calling the server's tools in the middle of a multi-step task, not the maintainer. Walk a realistic workflow against the tool surface and write down what that agent needs at each hop.
- **One skill per server, split by trigger.** The description stays resident in every session; the body loads only on invocation, so workflows belong inside the one skill, not in a second with the same trigger. A second skill earns its place only when a distinct trigger vocabulary routes to a materially different workflow. Two is the cap; three when day-to-day use of the server proves it.
- **Naming.** Default `<package short name>-guide` (`pubmed-guide` for `pubmed-mcp-server`). The description names the tool prefix (`pubmed_*`) so the agent binds the skill to the tools it sees.
- **Layering.** Tool `.describe()` text carries the per-tool contract; `instructions` carries a one-paragraph orientation (canonical chain, identifier types, rate posture); MCP prompts stay user-invoked task templates. The skill carries what none of those can: when to reach for the server and when not to, where each opaque identifier comes from, gates, branching workflows, and syntax references. It never restates `instructions`.
- **Gates** are the section a skill exists for. Each is an imperative the agent satisfies before acting or concluding: a precondition (resolve a name to an ID before filtering, where an unresolved filter returns the global set), a stop rule (confirm coverage before reporting a record absent), or a confirmation gate (ask the user before a tool that sends, writes, or deletes). Verified facts only, sourced from `instructions`, the design doc's Workflow Analysis and Known Limitations, tool descriptions, or closed issues — nothing invented. Cut any fact that would not change what the agent does.
- **Drift.** Name tools in prose; never list their parameters — the schemas own them.
- **Budget.** `SKILL.md` under 150 lines (the specification's 500 is a ceiling, not a target); the description under 500 characters, since it is resident in every session. Long material goes to `references/`.

## Skeleton

Sections in this order, so skills read alike across servers. Omit a section with nothing to say.

| Section | Carries |
|:--------|:--------|
| Scope | What the server covers and doesn't; keyless or which key. A sibling server may appear as a composition line, never as a dependency |
| Identifiers | Each opaque ID type and the tool that yields it |
| Gates | Preconditions, stop rules, confirmation gates |
| Core chain | Only when the canonical path is two or more hops |
| Workflows | Only when the surface branches, has modes, or registers the dataframe tools (paragraph below) |
| References | `references/*.md` links, only for long syntax or vocabulary material |

A server that registers the DataCanvas tools ships this paragraph under Workflows, prefix substituted:

> Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `<prefix>_dataframe_describe` with it for the staged table and column names before writing SQL, then `<prefix>_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas.

## Layout and frontmatter

```text
skills/
└── my-server-guide/
    ├── SKILL.md
    └── references/
        └── query-syntax.md
```

```markdown
---
name: my-server-guide
description: Chain my_server_search → my_server_get and resolve item IDs. Use when the agent needs a my_server_* record it only knows by name.
license: Apache-2.0
metadata:
  author: owner
  version: "1.0"
---

## Scope
…
```

`name` equals the directory name. Every `metadata` value is a quoted string. Never set `metadata.audience` — `external` is the marker `init` and the skills sync use to recognize framework-managed skills. Host-specific fields beyond the specification (`disable-model-invocation`) are accepted.

## Validation — `lint:packaging`

Runs when root `skills/` exists (inside `devcheck`) and skips cleanly when it doesn't. The specification rules come from the MCP SDK's strict skill loader through `validateSkillTree()` (`@cyanheads/mcp-ts-core/linter`), the loader the server serves with, so a tree that passes is served whole. Each failure names the file and field:

- `name` missing, not a string, not the directory name, over 64 characters, or outside `^[a-z0-9]+(-[a-z0-9]+)*$`
- `description` missing, empty, or over 1024 characters (project rule: 500); `compatibility` empty, not a string, or over 500
- a `metadata` value that is not a string (`version: 1.0` unquoted); `allowed-tools` that is not a string
- frontmatter outside the SDK's YAML subset — a multi-line quoted value, an anchor, a tag
- a symlink anywhere in a skill; a skill over 512 files or 16 MiB
- a `SKILL.md` directly under `skills/`; a `skills/<name>/` with no `SKILL.md`; a `SKILL.md` deeper than `skills/<name>/` (plugin hosts discover immediate children only)
- a `SKILL.md` over 150 lines; `metadata.audience: external`
- an `.mcpbignore` pattern that strips a file of the tree from the bundle — a pre-0.13 `.mcpbignore` may still carry `/skills/`

## Delivery

| Channel | What carries the tree |
|:--------|:----------------------|
| Plugin install (Claude Code, Codex) | The repository tree — root `skills/` is scanned by default |
| MCPB bundle | Bundle root `skills/`, which the Claude Directory surfaces as Skills; `.mcpbignore` must not exclude it, and `clean-mcpb` strips `skills/` only under `node_modules/` |
| npm (`npx`) | `package.json` `files` lists `"skills/"` (scaffold default) |
| Docker | The template Dockerfile creates `skills/` in the build stage and copies it into the production stage |

A project scaffolded before these defaults adds the `files` entry and the two Dockerfile lines from `node_modules/@cyanheads/mcp-ts-core/templates/` before relying on npm or Docker delivery.

## Serving over MCP (opt-in)

Plugin delivery reaches only agents that install the server as a plugin. To reach MCP clients through the SEP-2640 Skills extension:

```ts
await createApp({ tools: allToolDefinitions, skills: 'skills' });
```

A relative path resolves against the application root, so a stdio server launched from a client's project serves its own tree. The folder is read once at startup: a missing or unreadable folder fails startup with a `ConfigurationError` naming the resolved path; a skill the SDK rejects is skipped with a `Skill problem in <path>` warning and the rest are served. Opting in advertises `io.modelcontextprotocol/skills` under `capabilities.extensions`, adds `skills/list`, `skills/get`, and `resources/directory/read`, lists each `SKILL.md` in `resources/list`, and registers the `skill://{+path}` template, on both protocol eras; `tools/list` and `instructions` are unchanged. The `Core services constructed` log record's `skills` field lists the names served. Skill resources are served by the SDK: transport auth applies, per-definition `auth` scopes do not.

A Worker has no filesystem, so `createWorkerHandler` takes the files as a record built from Wrangler `Text` module imports — the record form and the Wrangler rule are in `api-workers`.

## Keep `instructions` lean

Once the skill exists, move extended workflows into it and keep `instructions` to its paragraph. Essential identifier, auth, and call-order requirements stay in `instructions` and the schemas anyway: a client connecting directly may never install the plugin or load the skill.

## Verify before shipping

`field-test` reads the published skill and checks every gate and identifier claim against live tool behavior. A claim that does not hold is fixed or cut.

## Checklist

- [ ] The skill clears the bar: a gate, a multi-hop identifier chain, or a query syntax that `instructions` and tool descriptions cannot carry
- [ ] `skills/<name>/SKILL.md` created; `name` equals the directory, default `<package short name>-guide`
- [ ] Description under 500 characters, names the tool prefix and the trigger
- [ ] Sections follow the skeleton order; empty sections omitted; the canvas paragraph present when the dataframe tools are registered
- [ ] Every gate and identifier claim traced to `instructions`, the design doc, a tool description, or a closed issue
- [ ] Tools named in prose only, no parameter lists; nothing restated from `instructions`
- [ ] `SKILL.md` under 150 lines; long material in `references/`
- [ ] No `metadata.audience`; every `metadata` value quoted
- [ ] `.mcpbignore` does not exclude `/skills/`; `package.json` `files` lists `skills/`; the Dockerfile copies it
- [ ] `instructions` trimmed to its paragraph, essential requirements kept
- [ ] **If serving over MCP:** `createApp({ skills: 'skills' })` (or the Worker record) set; the `Core services constructed` record's `skills` field lists the skill
- [ ] `bun run lint:packaging` passes
- [ ] `field-test` verified every gate and identifier claim against live behavior

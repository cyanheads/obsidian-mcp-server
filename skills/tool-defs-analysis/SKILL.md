---
name: tool-defs-analysis
description: >
  Read-only audit of MCP definition language across an existing surface — tools, resources, prompts. Walks every definition file and checks 10 categories the LLM reads to decide whether and how to call: voice & tense, internal leaks, audience leaks, defaults, recovery hints, output descriptions, cross-references, sparsity, examples, structure. Produces grouped findings with file:line citations and a numbered options list. Use during polish, after a refactor, or before a release. Complements `field-test` (behavior testing) and `security-pass` (security audit).
metadata:
  author: cyanheads
  version: "1.0"
  audience: external
  type: audit
---

## Context

Every string in a tool/resource/prompt definition is part of an LLM-facing API contract. The model reads the description, every parameter `.describe()`, the output schema, the recovery hints — and decides what to call and how. Definition language drifts: an internal mapping leaks into a parameter doc during a fix, a self-referential output description survives a refactor, a default that suited the developer at scaffold time stays after the typical call shape changes.

This skill is the **review-time pass** for that drift. Read each definition the way a mid-tier model with no project context would — can it pick the tool, fill the fields, and recover from errors using only the rendered schema?

| Skill | Lens |
|:---|:---|
| `design-mcp-server` | Authoring rules at write-time |
| `field-test` | Behavior testing + a narrow 3-category leak audit |
| `security-pass` | Injection, scopes, input sinks |
| `tool-defs-analysis` (this) | LLM-facing language across the existing surface |

`field-test` already audits descriptions for implementation leaks, meta-coaching, and consumer-aware phrasing during its catalog step — that's a fast shallow pass alongside live tool calls. This skill is the deeper review: 10 categories, every field, every recovery hint, every default value, with file:line citations.

**Read-only.** This skill produces a report; the maintainer applies fixes. While running it, do not run git, do not stage or commit, do not update the changelog, do not run `devcheck`, do not invoke wrapup or release workflows. Fixes flow through the normal authoring path (edit the definition, then re-run this skill if you want to verify).

## When to Use

- After a polish session or refactor that touched definitions
- Before a release, alongside `polish-docs-meta` and `security-pass`
- When the user says "review my tool definitions", "audit descriptions", "are my tool descriptions any good"
- After scaffolding a new server but before it ships

Skip during initial authoring — `add-tool` and `design-mcp-server` cover that. Skip diff-only review — read each file in full so drift across the whole definition surfaces.

## Inputs

Gather before starting. Ask if unclear:

1. **Scope** — whole server, specific definitions, or a single directory?
2. **Severity floor** — all findings (default), or skip nits?
3. **Known concerns** — anything the user already wants emphasized?

## Steps

### 1. Build the inventory

```bash
find src/mcp-server/tools/definitions     -type f -name "*tool.ts"     2>/dev/null | sort
find src/mcp-server/resources/definitions -type f -name "*resource.ts" 2>/dev/null | sort
find src/mcp-server/prompts/definitions   -type f -name "*.prompt.ts"  2>/dev/null | sort
```

The `*tool.ts` / `*resource.ts` patterns also catch `*.app-tool.ts` / `*.app-resource.ts`. If the server's definitions live elsewhere (`examples/`, a packages workspace, …), audit those paths too.

Use `TaskCreate` — one task per file. Mark each complete after its findings are captured.

### 2. Walk the 10 categories per file

Read each definition file in full. Apply every category — most files trip more than one. Capture each hit with `file:line`, the offending excerpt, and a one-line fix.

#### 1. Voice & tense

**Look in:** tool / resource / prompt `description`.

**Check:** imperative present-tense. "Search for trials" beats "Searches for trials" or "This tool will search trials".

**Smell:** "Allows you to…", "This tool…", "Provides functionality to…", "Searches for…", "Fetches…", "Will return…".

(Parameter `.describe()` text describes the *value*, not the tool — it doesn't need imperative voice.)

#### 2. Internal leaks

**Look in:** every `description` and `.describe()`.

**Check:** internal API routes, endpoint paths, API call counts, internal parameter mappings, sibling service names, version notes, TODOs.

**Smell:** "/api/v2/by-state", "Adds a second API call", "API requires `two_year_period`", "(deprecated; use bar_v2)", "TODO: support batch mode", "Used internally by FooService".

Prior art: #25.

#### 3. Audience leaks

**Look in:** every `description` and `.describe()`.

**Check:** reader-naming or meta-coaching directed at the LLM rather than describing the tool.

**Smell:** "suitable for LLM consumption", "Treat the returned ID as the canonical Y", "Agents should…", "Callers should…", "When you call this tool…", any reference to "LLM", "agent", "Claude", "the model".

Prior art: #74. Field-test catches this in its leak audit; this skill is the more thorough pass.

#### 4. Defaults

**Look in:** every `.default(...)` call in input schemas.

**Check:** the default matches the typical caller's case. A default that suited the developer at scaffold time often skews real calls — `limit: 1` makes default-args searches useless, `verbose: true` floods context, `dryRun: false` on a destructive op invites an irreversible accident.

**Smell:** dev-convenience values that survived the schema's first draft, dangerous defaults on destructive operations, defaults that contradict the description's framing of typical use.

#### 5. Recovery hints

**Look in:** `errors: [{ recovery: '…' }]` arrays, `data.recovery.hint` at throw sites in handler bodies.

**Check:** the hint directs the *agent* to its next action, not the developer to debugging. "Call `pubmed_search` with a narrower query" beats "Verify the configuration is correct" or "Internal error".

**Smell:** "Check the logs", "See documentation", "Contact admin", "Try again later" (with no condition), generic non-actionable text, hints that name internal classes, files, or env vars.

#### 6. Output descriptions

**Look in:** every field `.describe()` inside `output: z.object({ ... })`.

**Check:** the description tells the agent what the *value* is — not just the field name restated, not silent on dynamic shapes.

**Smell:**

- `name: z.string().describe('Name')` — tautology
- `description: z.string().describe('Description.')` — tautology
- `metadata: z.record(z.string(), z.unknown()).describe('Metadata')` — opaque dynamic shape with no hint about keys/values
- Optional fields with no note on when they're absent
- Enum fields with no `.describe()` on the variants

#### 7. Cross-references

**Look in:** tool descriptions, prompt content, recovery hints.

**Check:** when one tool/resource is mentioned, *when* to reach for it is explained — and the references cover the relevant siblings, not a partial sample.

**Smell:** "Use `foo_search` to find IDs" (no when); a prompt naming 3 of 7 landscape-relevant tools; a tool description listing one sibling but not the others that fit the same workflow.

#### 8. Sparsity

**Look in:** `output` schemas (especially fields wrapping external API data), `format()` rendering.

**Check:** optional upstream fields are acknowledged as such — not implied to always be present. `format()` doesn't print fabricated values for missing fields.

**Smell:**

- `pmid: z.string().describe('PubMed ID')` when only ~60% of records have one (should be `.optional()` and noted)
- `format()` printing `**PMID:** undefined`
- A required field in `output` for an upstream value the API doesn't always return

#### 9. Examples

**Look in:** parameter `.describe()` text containing "e.g.,", "(e.g. ...)", `.example(...)` calls.

**Check:** examples are domain-realistic — real-shaped IDs, real query strings, real values from the upstream domain. One example is usually enough.

**Smell:** `.describe('Item ID (e.g., "abc123")')` when real IDs have structure (`NCT12345678`); toy values ("foo", "bar"); padding multiple toy examples instead of one realistic one.

#### 10. Structure

**Look in:** tool / resource / prompt `description`.

**Check:** single cohesive paragraph. No bullet lists, no blank-line-separated sections, no markdown headers inside the description.

**Smell:** blank lines (`\n\n`) inside a description string, `- bullet` lines, `## Header` lines, "Operations:\n- foo: …" duplicating an enum's `.describe()` text.

Prior art: #33.

### 3. Report

Three sections.

#### Summary (1 paragraph)

Definitions reviewed, categories with findings, total finding count. One sentence on the single most material finding.

#### Findings

Group by category. Within each category, list each finding:

```
**<file>:<line> — <category> — (material|nit)**
Excerpt: `<the offending text>`
Issue: <one line: what's wrong>
Fix: <one line: what to change to>
```

Two-level severity:

- **material** — affects agent decisions (will mis-select tool, mis-fill input, mis-handle output, swallow an irrecoverable error)
- **nit** — polish (style, voice consistency, minor phrasing)

Skip categories with no findings — don't list empty headers.

#### Options

Numbered, cherry-pickable. Map each item to a concrete change in a single file.

```
1. Tighten `metadata` description in `pubmed_fetch.tool.ts:42` — explain the dynamic shape (finding #3, material)
2. Drop bullet list from `clinicaltrials_get_field_definitions.tool.ts:18` description — single paragraph (finding #5, material)
3. Replace toy "abc123" example in `inventory_search.tool.ts:27` with real shape (finding #8, nit)
```

End with:

> Pick by number (e.g. "do 1, 3, 5" or "expand on 2").

## Checklist

- [ ] Scope confirmed (whole server / module / specific files)
- [ ] Inventory built — every `*.tool.ts`, `*.app-tool.ts`, `*.resource.ts`, `*.app-resource.ts`, `*.prompt.ts` listed
- [ ] Each file walked through all 10 categories (per-file, not 10 separate passes)
- [ ] **Read-only:** no git, no commits, no changelog edits, no `devcheck`, no wrapup invoked during the audit
- [ ] Findings carry file:line citation, excerpt, issue, fix
- [ ] Report: summary → grouped-by-category findings → numbered options

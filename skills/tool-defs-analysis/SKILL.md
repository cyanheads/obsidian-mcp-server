---
name: tool-defs-analysis
description: >
  Read-only audit of MCP definition language across an existing surface — tools, resources, prompts, server instructions. Walks every definition file and checks 15 categories the LLM reads to decide whether and how to call: voice & tense, internal leaks, audience leaks, defaults, recovery hints, field descriptions, cross-references, sparsity, examples, structure, mutator observability, unit-bearing numeric names, validator-enforced constraints, annotations truthfulness, single-line strings — then a cross-surface pass: naming taxonomy, parameter vocabulary, tool overlap, instructions drift, length outliers. Produces grouped findings with file:line citations and a numbered options list. Use during polish, after a refactor, or before a release. Complements `field-test` (behavior testing) and `security-pass` (security audit).
metadata:
  author: cyanheads
  version: "1.4"
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

`field-test` already audits descriptions for implementation leaks, meta-coaching, and consumer-aware phrasing during its catalog step — that's a fast shallow pass alongside live tool calls. This skill is the deeper review: 15 categories, every field, every recovery hint, every default value, with file:line citations — plus a cross-surface pass for the drift no single file shows.

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

The `*tool.ts` / `*resource.ts` patterns also catch `*.app-tool.ts` / `*.app-resource.ts`. If the server's definitions live elsewhere (`examples/`, a packages workspace, …), audit those paths too. Also locate the server-level `instructions` string if the server sets one (the `createApp` option — `grep -rn "instructions" src/ --include="*.ts"`); it's audited in the cross-surface pass.

Use `TaskCreate` — one task per file. Mark each complete after its findings are captured.

### 2. Walk the 15 categories per file

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

#### 3. Audience leaks

**Look in:** every `description` and `.describe()`.

**Check:** reader-naming or meta-coaching directed at the LLM rather than describing the tool.

**Smell:** "suitable for LLM consumption", "Treat the returned ID as the canonical Y", "Agents should…", "Callers should…", "When you call this tool…", any reference to "LLM", "agent", "Claude", "the model".

Field-test catches this in its leak audit; this skill is the more thorough pass.

#### 4. Defaults

**Look in:** every `.default(...)` call in input schemas.

**Check:** the default matches the typical caller's case. A default that suited the developer at scaffold time often skews real calls — `limit: 1` makes default-args searches useless, `verbose: true` floods context, `dryRun: false` on a destructive op invites an irreversible accident.

**Smell:** dev-convenience values that survived the schema's first draft, dangerous defaults on destructive operations, defaults that contradict the description's framing of typical use.

#### 5. Recovery hints

**Look in:** `errors: [{ recovery: '…' }]` arrays, `data.recovery.hint` at throw sites in handler bodies.

**Check:** the hint directs the *agent* to its next action, not the developer to debugging. "Call `pubmed_search` with a narrower query" beats "Verify the configuration is correct" or "Internal error".

**Smell:** "Check the logs", "See documentation", "Contact admin", "Try again later" (with no condition), generic non-actionable text, hints that name internal classes or files.

#### 6. Field descriptions

**Look in:** every field in `input` and `output` schemas; resource URI template variables.

**Check:** every field carries a `.describe()`, and it tells the agent what the *value* is — not just the field name restated, not silent on dynamic shapes. Enum variants — especially operation discriminators — are explained.

**Smell:**

- An input field with no `.describe()` at all
- `name: z.string().describe('Name')` — tautology
- `operation: z.enum([...])` whose variants are never explained
- `metadata: z.record(z.string(), z.unknown()).describe('Metadata')` — opaque dynamic shape with no hint about keys/values
- Optional fields with no note on when they're absent
- Paging fields (`total`, `hasMore`, `nextCursor`) with semantics unstated — or a `limit` param that doesn't say whether it caps the page or the whole result
- A URI template variable (`{cid}`) never described anywhere

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

#### 11. Mutator observability

**Look in:** mutator tools — any tool that writes, updates, deletes, appends, or patches (i.e., definitions without `annotations.readOnlyHint: true`).

**Check:** `output` carries a state-change discriminator (`created`, `updated`, `mutated`, `unchanged`) or before/after observable state the agent can use to confirm intent-effect match. The server reports what it observed; the agent decides whether it matches what it meant.

**Smell:** mutator output is `{ path, ok }` or `{ success: true }` — no pre/post state, no discriminator. Server-side defensive throws on synthetic deltas (`file shrunk`, `count decreased`) the server can't authoritatively classify as bugs.

#### 12. Unit-bearing numeric names

**Look in:** every `z.number()` field in `output` schemas.

**Check:** the field name carries a unit when not pinned by context — `sizeInBytes`, `durationInMs`, `priceInCents`, `latencyInMs`. The `.describe()` drops in summarization or gets truncated; the field name persists into the JSON the agent reads. Scores, ratios, and percentages carry their range the same way — in the name or as the first thing in the describe (`0–1`).

**Smell:** `size`, `duration`, `price`, `latency` — bare names that force the agent to guess units; `score`/`confidence` with no stated range (0.87 and 87 both pass the schema). Exempt: `index`, `position`, `page`, `offset`, `limit`, `totalCount`, `itemCount` (dimensionless).

#### 13. Constraints in validators

**Look in:** input schemas — every field whose `.describe()` states a format, range, length, or pattern.

**Check:** stated constraints are machine-enforced in the schema (`.regex()`, `.min()`/`.max()`, `.int()`, `.length()`, an enum) so they emit into the JSON Schema the client renders — a constraint living only in prose reaches a weaker model unreliably and burns retries on malformed input. Opaque-ID params also say how to *obtain* the value (which sibling tool returns it), not just its shape.

**Smell:** `.describe('Date in YYYY-MM-DD format')` on a bare `z.string()`; "max 100" in prose with no `.max(100)`; an ID param whose describe gives the format but never the tool that produces it.

#### 14. Annotations truthfulness

**Look in:** the `annotations` block on every tool.

**Check:** hints match what the handler actually does — clients gate confirmation prompts and retry policy on them. A purely-read tool carries `readOnlyHint: true`; deletes and overwrites aren't marked `destructiveHint: false`; retry-safe mutators carry `idempotentHint: true`; tools calling external services carry `openWorldHint: true`. If `annotations.title` is set, it still matches the tool's current name and behavior.

**Smell:** `readOnlyHint: true` on anything that writes; a read-only tool with no `readOnlyHint` (clients assume it can mutate); `destructiveHint: false` on a delete; a stale `title` surviving a rename.

#### 15. Single-line strings

**Look in:** every `description`, `.describe()`, and error `recovery` / `when` string in a definition file.

**Check:** each is a single-line string literal. NEVER split one across lines with `+` concatenation (`'part one ' + 'part two'`), and never line-wrap a description into a `\n`-bearing template literal. The formatter does not break string literals, so a long single-line string passes formatting untouched — the line-width limit is not a reason to concatenate.

**Why it's not cosmetic:** `+`-concatenation forces every fragment to hand-carry its boundary whitespace, and a dropped trailing space silently fuses two words in the rendered schema the model reads (`'…table_name. ' + 'Columns…'` renders as `table_name.Columns`). Correct output is byte-identical to the single-line form, so the concatenation buys nothing and adds a class of silent contract corruption.

**Smell:** a string literal ending in `' +` or `" +` at end of line; a `description:` value spanning multiple quoted fragments; a multi-line template literal inside a description (also a Structure finding, #10).

**Fix:** collapse to one single-line string literal.

### 3. Cross-surface pass

The per-file walk misses drift that only shows between files. After it, sweep the whole surface:

- **Naming taxonomy** — verb prefixes mean one thing each across the surface (`search_` / `find_` / `get_` / `list_` / `lookup_`); the same verb carrying different semantics on different tools is a finding.
- **Parameter vocabulary** — one name per concept everywhere: `query` vs `q`, `limit` vs `maxResults`, `nctId` vs `nct_id` on sibling tools is a finding.
- **Tool overlap** — for any pair with adjacent scope, the two descriptions alone must answer "when X vs Y." If an agent can't pick, that's material.
- **Instructions drift** — if the server sets `instructions`: every tool it names exists, workflow guidance reflects the current surface (new tools that belong in it, renamed or removed ones purged), and nothing contradicts a per-tool description.
- **Length outliers** — a description several times longer than its siblings (attention drag), or a one-liner that underspecifies (selection risk).

Cross-surface findings use the same finding format, cited at the file:line you'd change (the `instructions` string is a citable location).

### 4. Report

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

Excerpts are verbatim copy-paste from the file as read, line numbers from that read — re-verify any finding written from memory before it enters the report.

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
- [ ] Severity floor applied — nits suppressed if user requested
- [ ] Inventory built — every `*.tool.ts`, `*.app-tool.ts`, `*.resource.ts`, `*.app-resource.ts`, `*.prompt.ts` listed; server `instructions` located if set
- [ ] Each file walked through all 15 categories (per-file, not 15 separate passes)
- [ ] Cross-surface pass run — naming taxonomy, parameter vocabulary, tool overlap, instructions drift, length outliers
- [ ] **Read-only:** no git, no commits, no changelog edits, no `devcheck`, no wrapup invoked during the audit
- [ ] Findings carry file:line citation, excerpt, issue, fix — excerpts verbatim, line numbers verified
- [ ] Report: summary → grouped-by-category findings → numbered options
- [ ] Options section produced — numbered, each single-file-scoped, severity tagged, cherry-pickable
- [ ] If no findings: summary states "no findings"; Findings and Options sections omitted

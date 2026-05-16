---
name: design-mcp-server
description: >
  Design the tool surface, resources, and service layer for a new MCP server. Use when starting a new server, planning a major feature expansion, or when the user describes a domain/API they want to expose via MCP. Produces a design doc at docs/design.md that drives implementation.
metadata:
  author: cyanheads
  version: "2.11"
  audience: external
  type: workflow
---

## When to Use

- User says "I want to build a ___ MCP server"
- User has an API, database, or system they want to expose to LLMs
- User wants to plan tools before scaffolding
- Existing server needs a new capability area (design the addition, not just a single tool)

Do NOT use for single-tool additions — use `add-tool` directly.

## Inputs

Gather before designing. Ask the user if not obvious from context:

1. **Domain** — what system, API, or capability is this server wrapping? Or is the server providing internal capability with no external dependency (computation, text/code utilities, in-memory state)?
2. **Data sources / source of truth** — APIs, databases, file systems, external services? Or is the server itself the source (in-memory state, pure computation, local-only utility, embedded model)?
3. **Target users** — what will the LLM (and its human) be trying to accomplish?
4. **Scope constraints** — read-only? write access? admin operations? what's off-limits?

If the domain has a public API, read its docs before designing. For internal-only servers, skip API research and go straight to user goals. Don't design from vibes either way.

## Steps

### 1. Research External Dependencies

**Applies when:** the server wraps an external API or service. Skip for internal-only servers (computation, local file ops, in-memory state, code analysis utilities) and jump to Step 2.

Before designing, verify the APIs and services the server will wrap. Read the docs, then **hit the API** — real requests reveal what docs omit.

Research inline by default — fetch docs, read SDK readmes, confirm assumptions before committing them to the design. For each external dependency:

- Fetch API docs, confirm endpoint availability, auth methods, rate limits
- Check for official SDKs or client libraries (npm packages)
- Note any API quirks, pagination patterns, or data format considerations

When research is genuinely parallelizable (multiple independent APIs, several SDKs to evaluate), spawn background agents for the independent legs while you proceed with domain mapping. Skip the overhead for a single API — just read it yourself.

**Live API probing.** After reading docs, make real requests against the API to verify assumptions:

- **Response shapes** — confirm actual field names, nesting, and types. Docs frequently lag or omit fields.
- **Batch/filter endpoints** — look for `filter.ids`, bulk GET, or query-by-multiple-IDs patterns. A single batch request replaces N individual fetches and eliminates serial-request bottlenecks and rate-limit accumulation.
- **Field selection** — check if the API supports `fields` or `select` parameters to request only the data you need. This reduces payload size dramatically for large objects.
- **Pagination behavior** — verify token format, page size limits, and what happens when results exceed one page.
- **Error shapes** — trigger real 400/404/429 responses to see the actual error format, not just what docs claim.

This step prevents building a service layer against assumed response shapes that don't match reality.

### 2. Map User Goals, Then Domain Operations

Start with **user goals**, not endpoints. Enumerate the outcomes an agent (and its human) will actually try to accomplish with this server — usually 3–10, scaled to domain size. These drive the workflow tools that form the spine of the surface. Endpoint-inventory-first design produces 1:1 API mirrors; goal-first design produces tools agents reach for. For internal-only servers, goals map to capabilities rather than endpoints — e.g., "format markdown to GFM," "tokenize text by model," "compute file hash."

Example user goals for a project management server:

- Find tasks I'm assigned to that are due soon
- Create a task in a project, assign it, and notify the owner
- Mark a task complete and log the outcome
- Audit a project's overdue work

Then enumerate the underlying **domain operations** the system supports, grouped by noun. These are the raw material workflow tools compose and single-action tools back-fill where workflows don't cover an edge case.

| Noun | Operations |
|:-----|:-----------|
| Project | list, get, create, archive |
| Task | list (by project), get, create, update status, assign, comment |
| User | list, get current |

The user-goal list shapes the tool surface; the operation list fills in the gaps. Not every operation becomes a tool.

### 3. Classify into MCP Primitives

**Tools are the primary interface.** Not all MCP clients expose resources — many are tool-only (Claude Code, Cursor, most chat UIs). Design the tool surface to be self-sufficient: an agent with only tool access should be able to do everything the server is built for. Resources add convenience for clients that support them (injectable context, stable URIs), but are not a reliable access path.

| Primitive | Use when | Examples |
|:----------|:---------|:--------|
| **Tool** | The default. Any operation or data access an agent needs to accomplish the server's purpose. | Search, create, update, analyze, fetch-by-ID, list reference data |
| **App Tool** | **Rare — default to a standard tool.** Only when a human will actively interact with the result in real time *and* the target client supports MCP Apps. Most clients are tool-only and most agent workflows are read-by-LLM, not viewed-by-human. App tools add an iframe + CSP, `app.ontoolresult`/`callServerTool` plumbing, host-context wiring, and a `format()` text twin that still has to be content-complete (since most clients only see that). Two surfaces to keep in sync, two failure modes per change. | Dense tabular state a human scrubs through; form-based human approval in an MCP Apps-capable client |
| **Resource** | *Additionally* expose as a resource when the data is addressable by stable URI, read-only, and useful as injectable context. | Config, schemas, status, entity-by-ID lookups |
| **Prompt** | Reusable message template that structures how the LLM approaches a task | Analysis framework, report template, review checklist |
| **Neither** | Internal detail, admin-only, not useful to an LLM | Token refresh, webhook setup, migrations |

What the tool surface needs to cover depends on the server: a read-only research server has different economics than a CRUD project management server. Consider the domain, the expected agent workflows, whether it wraps one API or many, and what data relationships exist. The test is: can a tool-only agent accomplish everything this server is for?

**Common traps:**

- **Data locked behind resources**: If something an agent needs is only accessible via a resource, it's invisible to tool-only clients. That data might warrant its own tool, or it might already be covered by an existing tool's output — but it needs a tool path somewhere.
- **CRUD explosion**: Don't map every REST endpoint to a tool. Related operations on the same noun often belong in one tool with an `operation`/`mode` parameter (see Step 4).
- **1:1 endpoint mirroring**: API endpoints are designed for programmatic consumers. LLM tools should be designed for workflows — what an agent is *trying to accomplish*, not what HTTP calls happen under the hood.

**Irreversible operations stay in the UI.** The "Neither" bucket above covers operations that aren't useful to an LLM. There's a second, sharper reason to exclude something from the tool surface: operations whose failure mode is catastrophic and unrecoverable. Examples span domains — dropping a production database table (data loss across every row), force-emptying a versioned cloud-storage bucket (no recovery once the lifecycle policy fires), revoking the workspace's last admin role (locks everyone out, recovery requires vendor support), GDPR permanent-delete on a customer profile (un-restorable by design), purging an analytics warehouse partition older than the retention window (auditable history gone), or deleting the single audience on a free-plan email platform (nukes every subscriber and historical report in one call). These are useful to an LLM *in principle*, but the blast radius of a mis-call is disproportionate to any agent workflow. Humans do these in the vendor UI, where confirmation dialogs and undo paths exist. Agents shouldn't have the tool at all.

This is distinct from `destructiveHint` — that annotation is for operations that are destructive but recoverable (deleting a task, reverting a commit) and agents should still have them. The "stays in the UI" line applies only to operations whose failure is both catastrophic *and* irreversible.

### 4. Design Tools

This is the highest-leverage step. Tool definitions — names, descriptions, parameters, output schemas — are the **entire interface contract** the LLM reads to decide whether and how to call a tool. Every field is context. Design accordingly.

#### Tool shapes you'll encounter

Most tools follow the `{server}_{verb}_{noun}` default — one focused responsibility, one clear verb, often (but not always) one upstream call. API-wrapping examples: `pubmed_search_articles`, `pubmed_fetch_articles`. Internal-only examples: `markdown_format_text`, `regex_test_pattern`, `tokens_count_text` — same naming convention, no external dep. Two variants warrant explicit design pressures of their own:

| Shape | Purpose | Typical form | Examples |
|:------|:--------|:-------------|:---------|
| **Workflow** | Multi-step orchestration that replaces a common agent chain | N upstream calls (often parallelized); may elicit confirmation; may need mid-flow cleanup | `clinicaltrials_find_studies` (search → filter → rank) |
| **Instruction** | State-aware procedural guidance — advice, not action | Static markdown + a few live-state fetches, `readOnlyHint: true`, outputs `nextToolSuggestions` pre-filling the recommended follow-up. No writes. | `git_wrapup_instructions` |

These aren't boxes every tool must fit into — some blend shapes — but the design pressures differ enough that naming them helps avoid re-discovering the patterns per server. The subsections below cover considerations specific to each — workflow framing applies broadly, instruction tools and workflow safety are their own subsections.

#### Think in workflows, not endpoints

The unit of a tool is a *useful action*, not an API call. Ask: "What is the agent trying to accomplish?" — not "What endpoints does the API have?"

A single tool can call multiple APIs internally, apply local filtering, reshape data, and return enriched results. The LLM doesn't know or care about the underlying calls.

```ts
// Workflow tool — search + local filter pipeline, not a raw API proxy
const findStudies = tool('clinicaltrials_find_studies', {
  description: 'Matches patient demographics and medical profile to eligible clinical trials. Filters by age, sex, conditions, location, and healthy volunteer status. Returns ranked list of matching studies with eligibility explanations.',
  // handler: listStudies() → filter by eligibility → rank by location proximity → slice
});
```

> **Tip — mode consolidation.** When a tool has several related operations on the same noun, you can consolidate them under one tool with a `mode`/`operation` enum. This affects both naming (noun-led, e.g., `github_pull_request`) and handler design (dispatch by mode). Use when it tightens the surface; skip when ops diverge enough to warrant separate tools.

There is no fixed ceiling on tool count — tools need to earn their keep, but don't artificially limit the surface. If the domain genuinely has 20 distinct workflows, expose 20 tools.

#### Cut the surface

After mapping tools, review the full list critically. A tool that covers a niche use case, serves a tiny fraction of agents, or duplicates what another tool already handles is a candidate for deferral. Drop it from the design and note it as a future addition if demand warrants. Every tool in the surface is cognitive load for tool selection — a tight surface outperforms a comprehensive one.

#### Instruction tools

**Applies when:** the domain has recurring "how do I do X well given my current state" questions worth merging with static procedural content. Skip otherwise.

Some domains benefit from a tool whose output is **guidance, not data** — a markdown playbook tailored by live account state, with pre-filled next-step tool calls. These sit between Prompts (static templates, client-invokable) and action tools (do work, return data): they return advice, but the advice is worth more than static text because it merges procedural content with the agent's actual situation.

Characteristics:

- **Output is markdown guidance**, not structured data (though the output schema still has fields — typically `guidance`, `diagnostics`, and `nextToolSuggestions`)
- **Merges static procedural content with live state** — the value is the tailoring. "You have 12 staged files spanning 4 unrelated changes — split them into separate commits before pushing" beats a generic best-practices article. The same shape works in other domains: "Your slowest query is 2.3s on `orders.customer_id` — add the index before tuning the planner" (database advisor), "Error rate spiked 4× at 14:32 UTC, 4 minutes after the `web@a3f9c2` deploy — roll back before chasing the upstream provider" (incident triage).
- **`readOnlyHint: true`, `openWorldHint: false`** — no writes, deterministic given the same inputs and account state
- **Outputs `nextToolSuggestions`** — an array of recommended follow-up tool calls with arguments **pre-filled** from the diagnostics, not just tool names. The agent consumes the playbook, then executes steps with other tools.
- **Consolidate by `topic` enum** — what could be N separate per-topic tools collapses into one

```ts
const wrapupInstructions = tool('git_wrapup_instructions', {
  description: 'Procedural guidance tailored to current repo state. Returns best-practice markdown merged with live diagnostics (staged/unstaged files, branch info, recent commits) and pre-filled follow-up tool calls. Read-only; the agent then executes steps with other tools.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    topic: z.enum(['review-changes', 'stage-and-commit', 'push-to-remote'])
      .describe('Playbook topic. Determines which static guidance is returned and which live state is fetched for tailoring.'),
  }),
  output: z.object({
    guidance: z.string()
      .describe('Markdown playbook content, tailored to current account state.'),
    diagnostics: z.record(z.unknown())
      .describe('Live state used to tailor the guidance (e.g., staged file count, branch divergence, recent commit cadence).'),
    nextToolSuggestions: z.array(z.object({
      toolName: z.string().describe('Tool to call next.'),
      reason: z.string().describe('Why this step is recommended given current state.'),
      args: z.record(z.unknown()).describe('Arguments pre-filled from diagnostics.'),
    })).describe('Recommended follow-up calls with arguments already populated.'),
  }),
});
```

Prior art: [`git_wrapup_instructions`](https://github.com/cyanheads/git-mcp-server) walks through staging, commit, and push with repo state inspected. If a server has recurring "how do I do X well given my state" questions, an instruction tool typically beats N topic-specific tools and duplicating guidance in tool descriptions.

#### Workflow tool safety

**Applies when:** a tool performs multi-step mutations with destructive modes (`send`/`apply`/`promote`) that benefit from human confirmation before the irreversible step fires. Skip for read-only or idempotent workflows.

Tools that perform multi-step mutations (the Workflow shape) have two safety considerations beyond single-call tools. Both are about giving the agent — and the human behind it — a chance to catch a bad invocation before it commits.

**Elicit-guarded destructive modes with annotation fallback.** When a workflow's `mode` parameter switches between safe and destructive arms (`draft` vs `send`, `plan` vs `apply`), gate the destructive arm behind `ctx.elicit` when the client supports it, so a human confirms before the irreversible step fires. Elicitation isn't universally available — headless stdio sessions and many non-interactive clients don't expose it. Fall back on `destructiveHint: true` in annotations so those clients' approval flows still surface the risk. Document the fallback in the handler so maintainers don't assume elicit always runs:

```ts
annotations: { destructiveHint: true },        // fallback for clients without elicit
// ...
async handler(input, ctx) {
  if (input.mode === 'apply' && ctx.elicit) {
    const confirm = await ctx.elicit(
      `Apply migration affecting ${affectedRowCount} rows in production? Cannot be rolled back automatically.`,
      z.object({ confirmed: z.literal(true).describe('Type true to apply.') }),
    );
    if (confirm.action !== 'accept') throw new Error('Migration cancelled by user.');
  }
  // destructive step proceeds; destructiveHint covers clients that skipped elicit
}
```

**Safe defaults on parameters that determine blast radius.** When a workflow accepts a parameter that controls how far-reaching a mutation is, default to the safer value. A bulk file-update tool defaulting `mode: 'preview'` (no writes) means a sloppy agent call shows a diff rather than blasting changes; an apply-plan tool defaulting `dryRun: true` means a misread plan previews rather than executes; an object-delete tool requiring an explicit `confirmCount` matching the result-set size means an unscoped query can't silently nuke a million rows. Agents that genuinely want the destructive behavior have to name it explicitly, which surfaces intent in the tool call and in logs.

#### Tool descriptions

The description is the LLM's primary signal for tool selection. It must answer: *what does this do, and when should I use it?*

- **Be concrete about capability.** "Search for clinical trial studies using queries and filters" beats "Interact with studies."
- **Include operational guidance when it matters.** If the tool has prerequisites, constraints, or gotchas the LLM needs to know, say so in the description. Don't add boilerplate workflow hints when the tool is self-explanatory.
- **Prefer a single cohesive paragraph.** Pack operational guidance into prose sentences (separated by periods or em-dashes) rather than bullet lists or blank-line-separated sections. Descriptions render inline in most clients, and bullet structure reads as visual noise rather than signal. Operation-by-operation bullets also duplicate info that already lives in the `operation` enum's `.describe()`.
- **Don't leak.** Descriptions are for the consumer, not the author. Three categories to audit against:
    - *Implementation details* — endpoint paths, API call counts, internal parameter mappings, routing logic. Describe what the tool does and when to use it, not how it's wired up.
    - *Meta-coaching* — directives about how to use the output. "Treat X as the canonical Y", "callers should…", "the LLM should…". The description sells the tool; it doesn't coach the reader.
    - *Consumer-aware phrasing* — references to "LLM", "agent", "Claude", or any specific reader. The description shouldn't name who's reading it.

```ts
// Good — describes a prerequisite the LLM must know
description: 'Set the session working directory for all git operations. This allows subsequent git commands to omit the path parameter.'

// Good — self-explanatory, no workflow hints needed
description: 'Show the working tree status including staged, unstaged, and untracked files.'

// Good — warns about constraints
description: 'Fetches trial results data for completed studies. Only available for studies where hasResults is true.'
```

Descriptions should be as long as needed — concise but complete. Don't artificially truncate, and don't pad with filler.

#### Parameter descriptions

Every `.describe()` is prompt text the LLM reads. Parameters should convey: what the value is, what it affects, and (where non-obvious) how to use it well.

- **Constrain the type.** Enums and literals over free strings. Regex validation for formatted IDs. Ranges for numeric bounds.
- **Use JSON-Schema-serializable types only.** The MCP SDK serializes schemas to JSON Schema for `tools/list`. Types like `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()` throw at runtime. Use structural equivalents (e.g., `z.string().describe('ISO 8601 date')` instead of `z.date()`).
- **Explain costs and tradeoffs** when a parameter choice has meaningful consequences.
- **Name alternative approaches** when a simpler path exists.
- **Include format patterns** for structured values, but don't pad descriptions with redundant examples.

```ts
// Good — explains cost, recommends action, names the alternative
fields: z.array(z.string()).optional()
  .describe('Specific fields to return (reduces payload size). Without this, the full study record (~70KB each) is returned. Use full data only when you need detailed eligibility criteria, locations, or results.'),

// Good — explains what the flag does AND how to override
autoExclude: z.boolean().default(true)
  .describe('Automatically exclude lock files and generated files from diff output to reduce context bloat. Set to false if you need to inspect these files.'),

// Good — names the format and gives one example
nctIds: z.union([z.string(), z.array(z.string()).max(5)])
  .describe('A single NCT ID (e.g., "NCT12345678") or an array of up to 5 NCT IDs to fetch.'),
```

#### Output design

The output schema and `format` function control what the LLM reads back. Design for the agent's *next decision*, not for a UI or an API consumer. See the `add-tool` skill's **Tool Response Design** section for implementation-level patterns (partial success, empty results, metadata, context budget).

**Principles:**

- **Server reports what only the server can know; agent decides what only the agent can know.** Schema, scopes, rate limits, and raw observable state belong to the server. Semantic correctness, intent-vs-effect matching, and recovery choice belong to the agent. For mutators, this means surfacing pre/post observable state rather than throwing on synthetic deltas the server can't authoritatively classify — `file shrunk` could be deliberate truncation or a bug; only the agent knows. See `add-tool` skill's **Mutator response design**.
- **Include IDs and references for chaining.** If the agent might act on a result, return the identifiers it needs for follow-up tool calls.
- **Curate vs. pass-through depends on domain.** Medical/scientific data — don't trim fields that could alter correctness. CRUD responses — return what the agent needs, not the full API payload. Match fidelity to consequence.
- **Surface what was done, not just results.** After a write operation, include the post-state so the LLM can chain without an extra round trip.
- **Seed orientation context alongside the primary result.** When a tool's call position makes the agent's next moves predictable, attaching a compact snapshot of relevant state — recent activity, tracked state, a couple of reference items — both saves round-trips *and* **primes the LLM on the project's patterns**. Surfacing recent commits teaches the commit-message style the agent should match when it later writes one; recent tags teach the versioning convention; reference records teach the naming format. Common fits: tools that open or close a session (set working dir, wrap-up), state-changing verbs where the caller wants post-action confirmation (commit, push, merge), entry points that drop the agent into a new scope (clone, checkout). Gather sub-operations in parallel with `Promise.allSettled` so a single failure degrades to a warning rather than tanking the outer call.
- **Communicate filtering.** If the tool silently excluded content, tell the LLM what was excluded and how to get it back. The agent can't act on what it doesn't know about.

```ts
// git_diff — when lock files are filtered, the output tells the LLM
output: z.object({
  diff: z.string().describe('Unified diff output.'),
  excludedFiles: z.array(z.string()).optional()
    .describe('Files automatically excluded from the diff (e.g., lock files). Call again with autoExclude=false to include them.'),
}),
```

- **Truncate large output with counts.** When a list exceeds a reasonable display size, show the top N and append "...and X more". Don't silently drop results.
- **Spill big tabular results to a queryable surface.** When a tool's row set can exceed any reasonable context budget — paginated APIs, streamed exports, big query results — pair an inline preview with a `DataCanvas` table holding the full set, returned as a token the agent can SQL. Compute distributions or refinement hints across the full result, not the preview, so aggregate signal stays honest. See `api-canvas` for the `spillover()` helper.
- **`format()` is the markdown twin of `structuredContent` — make both content-complete.** Different MCP clients forward different surfaces to the model: some (e.g., Claude Code) read `structuredContent` from `output`, others (e.g., Claude Desktop) read `content[]` from `format()`. Both must carry the same data so every client sees the same picture — `format()` just dresses it up with markdown. A thin `format()` that returns only a count or title leaves `content[]`-only clients blind to data that `structuredContent` clients can see. Render all fields the LLM needs, with structured markdown (headers, bold labels, lists) for readability.

#### Batch input design

**Applies when:** the upstream API supports batch requests (filter-by-IDs, bulk GET) OR agents commonly need multiple items per call. Skip for inherently single-target operations.

Some tools naturally operate on multiple items — fetching several entities, updating a set of records, running checks across a list. Decide during design whether a tool accepts single items, arrays, or both.

**When to accept array input:**

| Accept array | Keep single-item | Separate batch tool |
|:-------------|:-----------------|:--------------------|
| The upstream API supports batch requests (fetch-by-IDs, bulk update) | The operation is inherently single-target (read a file, run a query) | Batch has fundamentally different output shape or error semantics |
| Reduces N+1 round trips for a common workflow | Array input adds complexity with no backend efficiency gain | Single-item tool is simple; batch version needs progress, partial failure handling |
| Agent commonly needs multiple items in one step | The tool already returns a collection (search results) | |

**If a tool accepts arrays, design for partial success.** When 3 of 5 items succeed, the agent needs to know which succeeded, which failed, and why — not just a success/failure boolean. Plan the output schema to report per-item results:

```ts
output: z.object({
  succeeded: z.array(ItemResultSchema).describe('Items that completed successfully.'),
  failed: z.array(z.object({
    id: z.string().describe('Item ID that failed.'),
    error: z.string().describe('What went wrong and how to resolve it.'),
  })).describe('Items that failed with per-item error details.'),
}),
```

Single-item tools don't need this — they either succeed or throw. The partial success question only arises when the tool can partially complete.

**Telemetry:** The framework automatically detects partial success — when a handler returns a result with a non-empty `failed` array, the span gets `mcp.tool.partial_success`, `mcp.tool.batch.succeeded_count`, and `mcp.tool.batch.failed_count` attributes. No manual instrumentation needed.

#### Convenience shortcuts for complex inputs

**Applies when:** a tool wraps a structured query language or filter system where the 80% case is a simple string. Skip when the primary input is already simple.

When a tool wraps a complex query language or filter system, provide a simple shortcut parameter for the 80% case alongside the full-power escape hatch. This keeps simple queries simple while preserving full expressiveness.

```ts
// text_search handles the common case; query handles everything else
text_search: z.string().optional()
  .describe('Convenience shortcut: full-text search across title and abstract. For structured filters or field-specific matching, use the query parameter instead.'),
query: z.record(z.unknown()).optional()
  .describe('Full query object for structured filters. Supports operators: _eq, _gt, _and, _or, ...'),
```

The pattern: name the shortcut for what it does (`text_search`, `name_search`), document what it expands to, and point to the full parameter for advanced use. Validate that at least one of the two is provided.

#### Error design

Errors are part of the tool's interface — design them during the design phase, not as an afterthought. Three aspects: **the contract** (which failures are public), **classification** (what error code), and **messaging** (what the LLM reads).

**Declare a typed contract for domain failures.** When a tool has known failure modes the agent should plan around (`no_match`, `queue_full`, `vendor_down`), enumerate them as `errors: [{ reason, code, when, retryable? }]` on the definition. The framework types `ctx.fail(reason, …)` against the declared reason union (typos become TS errors) and auto-populates `data.reason` on the thrown error for stable observability. The error reaches clients with parity across both surfaces — `structuredContent.error` (Claude Code) and `content[]` text (Claude Desktop). Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble from anywhere and don't need to be enumerated. See `api-errors` skill for the full pattern.

**Classify errors by origin.** Different error sources need different codes and different recovery guidance. Map the failure modes for each tool during design:

| Origin | Examples | Error code | Agent can recover? |
|:-------|:---------|:-----------|:-------------------|
| **Client input** | Bad ID format, invalid params, missing required field, out-of-range value | `InvalidParams` | Yes — fix the input and retry |
| **Upstream API** | 5xx, rate limit (429), timeout, network error | `ServiceUnavailable` | Maybe — retry later, or the upstream is down |
| **Not found** | Valid ID format but entity doesn't exist | `NotFound` (or `InvalidParams` if ambiguous) | Yes — check the ID, try a search |
| **Auth/permissions** | Insufficient scopes, expired token | `Forbidden` / `Unauthorized` | Maybe — escalate or re-auth |
| **Server internal** | Parse failure, missing config, unexpected state | `InternalError` | No — server-side issue |

The framework auto-classifies many of these at runtime (HTTP status codes, JS error types, common patterns), but explicit classification in the handler gives better error messages. For declared contract failures, throw via `ctx.fail('reason', …)`. For ad-hoc throws outside the contract, use error factories (`notFound()`, `validationError()`, etc.) when the code matters; plain `throw new Error()` when the framework's auto-classification is good enough.

**Write error messages as recovery instructions.** The message is the agent's only signal for what to do next.

```ts
// Bad — dead end, no recovery path
throw new Error('Not found');

// Good — names both resolution options
"No session working directory set. Please specify a 'path' or use 'git_set_working_dir' first."

// Good — structured hint in error data using the canonical `data.recovery.hint` shape.
// The framework auto-mirrors `data.recovery.hint` into the content[] text as
// `Recovery: <hint>` so format()-only clients (Claude Desktop) see the same
// guidance structuredContent clients (Claude Code) read from `error.data.recovery.hint`.
throw forbidden(
  "Cannot perform 'reset --hard' on protected branch 'main' without explicit confirmation.",
  {
    branch: 'main',
    operation: 'reset --hard',
    recovery: { hint: 'Set the confirmed parameter to true to proceed.' },
  },
);

// Good — upstream error with actionable context
throw notFound(`Paper '${id}' not found on arXiv. Verify the ID format (e.g., '2401.12345' or '2401.12345v2').`);
```

**During design, list the expected failure modes for each tool** with the reason, code, and when-clause that will land in the contract. Include these in the tool's section of the design doc — they become the literal `errors: [...]` entries during scaffolding and inform recovery messaging. Not every failure needs a contract entry; baseline infrastructure errors (5xx, timeouts, validation) are fine to let bubble.

#### Design table

Summarize each tool:

| Aspect | Decision |
|:-------|:---------|
| **Name** | Lowercase snake_case with a canonical server prefix. **3 segments is the strong default** (`{server}_{verb}_{noun}` — e.g., `pubmed_search_articles`, `clinicaltrials_find_studies`). **2 is fine when the operation name is canonical** and no noun adds signal (`git_pull`, `git_status` — "pull" already implies the remote). Don't invent a word to pad to 3. **4 is fine when the noun is inherently two words** (`patentsview_search_patent_families`) or the prefix is multi-part. Use the canonical platform/brand name as prefix, not abbreviations (`patentsview_` not `patents_`, `clinicaltrials_` not `ct_`). The verb+noun pair should be unambiguous within the server — if two tools could plausibly share a name, the noun isn't specific enough (`read_fulltext` not `read_text` when structured metadata is a separate concept). **Treat name length as a scope smell only when** the extra segment is the *verb* overreaching (e.g., `foo_create_and_send_notification` → split or use modes). |
| **Granularity** | Scope each tool to one coherent agent action. The implementation can be a single API call (`pubmed_search_articles`), a multi-step workflow, or internal-only — match the unit to the work, don't constrain by call count. |
| **Description** | Concrete capability statement. Add operational guidance (prerequisites, constraints, gotchas) when non-obvious. |
| **Input schema** | `.describe()` on every field. Constrained types (enums, literals, regex). Explain costs/tradeoffs of parameter choices. |
| **Output schema** | Designed for the LLM's next action. Include chaining IDs. Communicate filtering. Post-write state where useful. |
| **Errors** | Declare domain failure modes as a typed contract (`errors: [{ reason, code, when, retryable? }]`) so `ctx.fail` is type-checked and capable clients can preview failures via `tools/list`. Error messages name what went wrong and what the LLM should do about it. |
| **Annotations** | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Helps clients auto-approve safely. |
| **Auth scopes** | `tool:<snake_tool_name>:<verb>` or `resource:<kebab-resource-name>:<verb>` (e.g., `tool:inventory_search:read`, `resource:echo-app-ui:read`). Domain-led `<domain>:<verb>` (e.g., `inventory:read`) is an acceptable alternative — pick one convention per server and stay consistent. Skip for read-only or stdio-only servers. |

### 5. Design Resources

Resources are supplementary — a convenience for clients that support injectable context via stable URIs. Since many clients are tool-only, verify that any data exposed via resources is also reachable through the tool surface. This doesn't require a 1:1 resource-to-tool mapping — the data might be covered by an existing tool's output, bundled into a broader tool, or warrant its own dedicated tool, depending on the server's purpose and how agents will use it.

For each resource:

| Aspect | Decision |
|:-------|:---------|
| **URI template** | `scheme://{param}/path`. Server domain as scheme. Keep shallow. |
| **Params** | Minimal — typically just an identifier. Complex queries belong in tools. |
| **Pagination** | Needed if lists exceed ~50 items. Opaque cursors via `extractCursor`/`paginateArray`. |
| **list()** | Provide if discoverable. Top-level categories or recent items, not exhaustive dumps. |
| **Tool coverage** | Verify the data is reachable via tools — either a dedicated tool, included in another tool's output, or not needed for tool-only agents. |

### 6. Design Prompts (if needed)

Optional. Use when the server has recurring interaction patterns worth structuring:

- Analysis frameworks, report templates, multi-step workflows

Skip for purely data/action-oriented servers.

### 7. Plan Services and Config

**Services** — one per external dependency. Init/accessor pattern. Skip if all tools are thin wrappers with no shared state.

**Server-as-service.** When the server IS the source of truth (knowledge graph, in-memory task tracker, local scratchpad, embedded inference wrapper), the resilience table below doesn't apply — there's no upstream to retry. The design questions shift to state management: what's tenant-scoped vs. global, what TTLs apply, what survives a restart, what the storage backend is. Plan persistence via `ctx.state` for tenant-scoped KV (auto-namespaced by `tenantId`), or use a `StorageService` provider directly when data must cross tenants. Service init still happens in `setup()`, accessed via `getMyService()` at request time. Calls within the server are local and synchronous-ish — the API-efficiency table below also doesn't apply.

**Tabular API servers: DataCanvas is one option.** For servers that fetch tabular data and want to expose a SQL/analytical workspace — register tables, run cross-table queries, export results — the framework's optional `DataCanvas` primitive (Tier 3, opt-in via `CANVAS_PROVIDER_TYPE=duckdb`) handles lifecycle, ID generation, eviction, and export wiring so you don't design your own. If you opt in, surface `canvas_id` as an optional input on register/query/export tools; the framework mints on omit and resolves on match. Tools access it via `ctx.core.canvas?` (undefined when disabled or running on Workers — DuckDB has no V8-isolate build). See `api-canvas` for the full reference.

For services wrapping external APIs, plan the resilience layer.

| Concern | Decision |
|:--------|:---------|
| **Retry boundary** | Service method wraps full pipeline (fetch + parse), not just the network call. Use `withRetry` from `/utils`. |
| **Backoff calibration** | Match base delay to upstream recovery time: 200–500ms (ephemeral), 1–2s (rate-limited), 2–5s (degraded). |
| **HTTP status check** | `fetchWithTimeout` already handles this — non-OK → `ServiceUnavailable`. |
| **Parse failure classification** | Response handler detects HTML error pages and throws transient errors, not `SerializationError`. |
| **Exhausted retry messaging** | `withRetry` enriches the final error with attempt count automatically. |

For API efficiency, design the service methods to minimize upstream calls:

| Concern | Decision |
|:--------|:---------|
| **Batch over N+1** | If the API supports filter-by-IDs or bulk-GET endpoints, use a single batch request instead of N individual fetches. Cross-reference the response against requested IDs to detect missing items. |
| **Field selection** | If the API supports `fields`/`select` parameters, request only the fields the tool needs. A full study record might be 70KB; selecting 4 fields might be 5KB. |
| **Request consolidation** | When a tool needs data from multiple related endpoints, check if a single endpoint with broader field selection can serve the same data in one round trip. |
| **Pagination awareness** | If a batch request might exceed the API's page size, either paginate internally or assert/throw when results are truncated so callers aren't silently missing data. |

**Config** — list env vars (API keys, base URLs). Goes in `src/config/server-config.ts` as a separate Zod schema.

### 8. Write the Design Doc

Create `docs/design.md` with the structure below. The MCP surface (tools, resources, prompts) goes first — it's what matters most and what the developer will reference during implementation.

```markdown
# {{Server Name}} — Design

## MCP Surface

### Tools
| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|

### Resources
| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|

### Prompts
| Name | Description | Args |
|:-----|:------------|:-----|

## Overview

What this server does, what system it wraps, who it's for.

## Requirements

- Bullet list of capabilities and constraints
- Auth requirements, rate limits, data access scope

## Services
| Service | Wraps | Used By |
|:--------|:------|:--------|

## Config
| Env Var | Required | Description |
|:--------|:---------|:------------|

## Implementation Order

1. Config and server setup
2. Services (external API clients)
3. Read-only tools
4. Write tools
5. Resources
6. Prompts

Each step is independently testable.

<!-- Optional sections for API-wrapping servers: -->
## Domain Mapping          <!-- nouns × operations → API endpoints -->
## Workflow Analysis        <!-- how tools chain for real tasks -->
## Design Decisions         <!-- rationale for consolidation, naming, tradeoffs -->
## Known Limitations        <!-- inherent API/data constraints the server can't solve -->
## API Reference            <!-- query language, pagination, rate limits -->
```

Keep it concise. The design doc is a working reference, not a spec document — enough to orient a developer (or agent) implementing the server, not more.

**Workflow Analysis example.** For multi-step workflow tools, document the upstream call sequence in a table — it drives several downstream decisions during implementation: the service-layer method shape, retry boundaries, where cleanup or elicit belongs, and what post-action state to fetch for the response.

`deploy_release` (5–8 upstream calls, plus elicit):

| # | Call | Purpose | Mode gate |
|:--|:-----|:--------|:----------|
| 0 | `ctx.elicit` confirmation | Human approval before promote | `promote` (when available) |
| 1 | `POST /releases` | Create release record | always |
| 2 | `PUT /releases/{id}/artifacts` | Attach build artifacts | always |
| 3 | `GET /releases/{id}/preflight` | Health checks, smoke tests | always |
| 4 | `POST /releases/{id}/canary` | Deploy to 5% of traffic | `canary` |
| 5 | `POST /releases/{id}/promote` | Roll out to 100% | `promote` |
| 6 | `POST /releases/{id}/rollback` | Restore previous version | `rollback` |
| 7 | `GET /releases/{id}` | Post-action state for response | always |
| — | `DELETE /releases/{id}/canary-traffic` | Cleanup canary if mid-flow error | on error + `cleanupOnError` |

The table surfaces design questions early: should the elicit happen before or after the artifacts are attached? Does cleanup drop the canary on any failure, or only failures past the promote step? What does the response body need from the final GET — version, traffic percentage, health summary? Answering these during design is far cheaper than mid-implementation.

### 9. Confirm and Proceed

If the user has already authorized implementation (e.g., "build me a ___ server"), proceed directly to scaffolding using the design doc as the plan. Otherwise, present the design doc to the user for review before implementing.

## After Design

Execute the plan using the scaffolding skills:

1. `add-service` for each service
2. `add-tool` for each standard tool
3. `add-resource` for each standalone resource
4. `add-prompt` for each prompt
5. `add-app-tool` *only if any app tools survived the design step* (rare — see the App Tool row in Step 3)
6. `devcheck` after each addition

## Checklist

Items without an `If …:` prefix apply to every design. Conditional items only apply when the trigger fires — otherwise skip them.

- [ ] External APIs/dependencies researched and verified (docs fetched, SDKs identified)
- [ ] User goals enumerated first (3–10 outcomes agents will accomplish, scaled to domain size), then domain operations mapped as raw material
- [ ] Each operation classified as tool, resource, prompt, or excluded
- [ ] Catastrophically irreversible operations excluded from the tool surface (stay in vendor UI) — not just `destructiveHint`
- [ ] Tool surface audited — niche, overlapping, or low-value tools cut or deferred
- [ ] Tool surface is self-sufficient — a tool-only agent can accomplish everything the server is for
- [ ] Workflow and Instruction variants considered where they add value (single-action tools are the default)
- [ ] Tool descriptions are concrete and include operational guidance where non-obvious
- [ ] Parameter `.describe()` text explains what the value is, what it affects, and tradeoffs
- [ ] Input schemas use constrained types (enums, literals, regex) over free strings
- [ ] Output schemas designed for LLM's next action — chaining IDs, post-write state, filtering communicated
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data, not just a count or title
- [ ] Error messages guide recovery — name what went wrong and what to do next
- [ ] **If a tool has known domain failure modes:** typed error contract declared (`errors: [{ reason, code, when, retryable? }]`) so `ctx.fail` is type-checked and capable clients see failures via `tools/list`
- [ ] Annotations set correctly (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
- [ ] Design doc written to `docs/design.md`
- [ ] Design confirmed with user (or user pre-authorized implementation)
- [ ] **If ops share a noun:** related operations consolidated under one tool with `mode`/`operation` enum
- [ ] **If the server has workflow tools:** call-flow documented (upstream sequence + mode arms) in design doc's Workflow Analysis
- [ ] **If state-aware procedural guidance adds value:** instruction tool considered with `nextToolSuggestions` pre-filled from diagnostics
- [ ] **If workflow tools have destructive modes:** destructive arm guarded by `ctx.elicit` when available, with `destructiveHint` annotation as fallback for non-interactive clients
- [ ] **If a parameter determines blast radius:** safe default set (e.g., `mode: 'preview'`, `dryRun: true`, `confirmCount` required)
- [ ] **App tools default to no.** If one was proposed, verified there's a real human-in-the-loop in an MCP Apps-capable client justifying the iframe/CSP/`format()`-twin maintenance cost — otherwise dropped in favor of a standard tool
- [ ] **If the server exposes resources:** URIs use `{param}` templates, pagination planned for large lists
- [ ] **If the server has external deps or shared state:** service layer planned (or explicitly skipped with reasoning)
- [ ] **If services wrap external APIs:** resilience planned (retry boundary, backoff, parse classification)
- [ ] **If exposing a SQL/analytical workspace over tabular data is in scope:** DataCanvas considered (`api-canvas` skill) as one option before designing custom analytical state — register / query / export tools accepting an optional `canvas_id`, with `ctx.core.canvas?` reads
- [ ] **If the server needs runtime config:** env vars identified in `server-config.ts`

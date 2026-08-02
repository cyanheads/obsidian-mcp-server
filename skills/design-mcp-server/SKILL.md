---
name: design-mcp-server
description: >
  Design the tool surface, resources, and service layer for a new MCP server. Use when starting a new server, planning a major feature expansion, or when the user describes a domain/API they want to expose via MCP. Produces a design doc at docs/design.md that drives implementation.
metadata:
  author: cyanheads
  version: "2.20"
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

### Server scope and audience

Before committing to a server boundary, answer: **what workflow does this server serve, and who is the audience?**

The unit of a server is a *user workflow*, not an API. A single rich API can earn its own server when the audience is large and the API surface supports a full workflow (PubMed for literature research, SEC EDGAR for financial analysis, Shodan for internet-wide device intelligence). Multiple APIs should collapse into one server when they serve the same workflow from different angles — a "threat intelligence" server that aggregates VirusTotal, AbuseIPDB, and GreyNoise is more useful than three separate servers because the user's goal is "assess this indicator," not "query VirusTotal."

**Don't default to one-API-one-server.** That's the right call when the API is deep enough and the audience is large enough, but it's not the starting point. The starting point is the workflow:

| Signal | Server boundary |
|:-------|:----------------|
| Single API with rich surface, large audience | Standalone server named for the platform (`pubmed-mcp-server`, `secedgar-mcp-server`) |
| Multiple APIs serving the same workflow | One server named for the workflow (`threat-intel-mcp-server`), APIs are internal sources |
| Domain with distinct sub-audiences | Consider splitting — a pentester and a SOC analyst have different workflows even in the same domain |
| Pure computation, no external deps | Standalone server named for the capability (`calculator-mcp-server`, `redteam-mcp-server`) |

When multiple APIs collapse into one server, the tool surface is organized around what the user is doing, not which API gets called. The agent says "investigate this domain" and the server routes to the best available source internally. Individual APIs become service-layer implementation details, not tool-surface identities.

## Server Naming

The server name (repo name, npm package, public identity) must communicate what it does at a glance. The test: can a human or agent scanning a server list tell what this server does from the name alone?

- **Use the canonical platform/brand name, not abbreviations.** `libofcongress-mcp-server` not `loc-mcp-server` ("loc" reads as lines-of-code or location). `federal-reserve-mcp-server` not `fred-mcp-server` ("fred" reads as a person's name).
- **Add a descriptive suffix when the base name is a non-obvious acronym.** Pattern: `{acronym}-{domain}-mcp-server` — e.g., `eia-energy-mcp-server`, `bls-labor-mcp-server`, `nhtsa-vehicle-safety-mcp-server`. Skip when the name is already self-descriptive (`earthquake-mcp-server`, `wikidata-mcp-server`).
- **The name becomes the tool prefix.** Every tool is `{prefix}_{verb}_{noun}`, so the server name shows up in every tool call an agent sees. A descriptive name gives agents domain context without reading the server's instructions.

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
- **Unknown-param behavior** — send one deliberately misspelled parameter. If the API silently ignores it (plausible but unfiltered results instead of an error), every typo'd or unverified param name becomes a silent-wrongness bug — the service layer then needs a strict allowlist of confirmed spellings, and new filters require a probe before they ship.
- **Omission semantics** — for each major optional parameter, check what omitting it actually returns. Some APIs default to the intuitive scope; others silently widen (all historical versions, all statuses, global instead of regional). A default that changes result *meaning* becomes a server-side default plus an echoed output field, not something left to the agent.

**Stopping condition:** at minimum, probe one list/search endpoint, one single-item GET, one error case (force a 404 or 400), and one unknown-param request. For large APIs with many resource types, add one probe per major noun. Stop when the response shapes and error envelope are confirmed.

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

The user-goal list shapes the tool surface; the operation list fills in the gaps. Not every operation becomes a tool — an operation stays as raw material (not its own tool) when it's already fully covered by an existing tool's output, or when the only agents who'd use it are in scenarios outside this server's stated purpose.

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
| **Reference** | Decode opaque domain vocabulary — codes, enums, identifier formats, coverage windows — so agents can build valid inputs for the rest of the surface | Static tables or one cached fetch (often zero upstream calls); consolidate N lists under one `topic` enum; `readOnlyHint: true`, `openWorldHint: false` when offline | `medcode_list_systems`, `osv_list_ecosystems` |

These aren't boxes every tool must fit into — some blend shapes — but the design pressures differ enough that naming them helps avoid re-discovering the patterns per server. The subsections below cover considerations specific to each — workflow framing applies broadly; instruction tools, reference tools, and workflow safety are their own subsections.

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

#### Multi-source tools and fallback chains

**Applies when:** a server aggregates multiple data sources for the same workflow, and the "best" source varies by input type, availability, or coverage. Skip for single-API servers.

When a tool's goal can be served by multiple sources, design it as a **multi-source tool** — the agent calls one tool, the handler routes to the best source (or fans out to several) internally. This is the difference between a "PubMed wrapper" and a "literature research server": `pubmed_search_articles` tries PubMed first, falls back to EuropePMC for broader coverage, then Unpaywall for open access. The agent doesn't choose which API to hit — the server makes that decision based on what works.

Two patterns:

**Source fallback chains** — try sources in priority order, fall through on failure or empty results. Best when sources cover the same data with different depth or availability. The output should indicate which source provided the data so the agent (and human) can assess provenance.

```ts
// Handler pseudocode — not a real implementation
async handler(input, ctx) {
  // Primary: PubMed E-utilities (authoritative, best metadata)
  const result = await pubmedService.search(input.query);
  if (result.items.length > 0) return { ...result, source: 'pubmed' };

  // Fallback: EuropePMC (broader coverage, includes preprints)
  const epmcResult = await epmcService.search(input.query);
  if (epmcResult.items.length > 0) return { ...epmcResult, source: 'europepmc' };

  return { items: [], source: 'none', message: 'No results from any source.' };
}
```

**Multi-source fan-out** — query multiple sources in parallel, merge results. Best when sources provide complementary data about the same entity. Use `Promise.allSettled` so one failing source doesn't tank the whole call.

```ts
// Handler pseudocode — indicator enrichment across threat intel sources
async handler(input, ctx) {
  const [vt, abuse, greynoise] = await Promise.allSettled([
    vtService.lookup(input.indicator),
    abuseIpService.check(input.indicator),
    greynoiseService.query(input.indicator),
  ]);
  return {
    indicator: input.indicator,
    sources: {
      virustotal: vt.status === 'fulfilled' ? vt.value : { error: vt.reason.message },
      abuseipdb: abuse.status === 'fulfilled' ? abuse.value : { error: abuse.reason.message },
      greynoise: greynoise.status === 'fulfilled' ? greynoise.value : { error: greynoise.reason.message },
    },
    // Server synthesizes a verdict from available data — the agent gets a conclusion, not raw API dumps
    assessment: synthesizeVerdict(vt, abuse, greynoise),
  };
}
```

In both patterns, the tool surface is organized around what the user is doing. Sources are service-layer details — the agent sees `threat_enrich_indicator`, not `virustotal_lookup` + `abuseipdb_check` + `greynoise_query`. Mode-based dispatch by input type (e.g., `indicator_type: 'ip' | 'domain' | 'hash'`) naturally routes to different source chains per mode, since different sources cover different indicator types.

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

#### Reference tools

**Applies when:** the domain speaks in opaque vocabulary — enum codes, classification systems, identifier formats, per-source coverage windows — that agents must supply as inputs elsewhere. Skip when inputs are self-evident (free text, ISO dates, well-known formats).

A reference tool is the surface's decoder ring: which codes exist, what they mean, what format each identifier takes, what each source covers. Consolidate what could be N per-list tools under one `topic` enum, and serve it from static tables or a cached fetch so it stays cheap to call. Its second job is structural: it is the standing **target of recovery routing** — error `recovery` strings, zero-hit notices, and resolver guidance across the surface end with "consult the reference tool, topic X" (see Error design), which only works when the tool exists. Implement it first — it usually has no service dependency, and it grounds field-testing for every other tool.

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

- **Empty results are a designed surface, not a fallthrough.** For every search/list tool, spec the zero-hit behavior at design time: zero hits are success + an `enrichment` notice, never an error, and the notice is composed from condition → fragment pairs (too-narrow filter, a defaulted date window, a syntax trap), each routing to a concrete next call — relax a named filter, switch to the named sibling tool, or consult the reference tool. Relatedly, when the server applies a default that changes result *semantics* (an as-of date, an implicit status filter), echo the applied value in the output — an agent can't reason about a filter it can't see.
- **Capped lists disclose truncation.** When a tool accepts a cap-like input (`limit`, `per_page`, `page_size`, `max_results`, `max_items`) and returns an array, the handler must disclose when the cap was hit. Standard fields: `truncated: true`, `shown`, `cap` in the `enrichment` block via `ctx.enrich.truncated({ shown, cap })`. `ctx.enrich.total(n)` (writes `totalCount`) is also recognized. Silent caps leave the agent treating a partial set as complete. The `capped-list-no-truncation` lint rule enforces this; see `api-linter` and `api-context`'s `ctx.enrich.truncated()` section.
- **Truncate large output with counts.** When a list exceeds a reasonable display size, show the top N and append "...and X more". Don't silently drop results.
- **Spill big *analytical* results to a queryable surface.** When a tool's row set is something an agent would run SQL over (aggregate, group, join) *and* can exceed any reasonable context budget — paginated APIs, streamed exports, big query results — pair an inline preview with a `DataCanvas` table holding the full set. **Two rules gate this:** (1) it must earn its keep on *shape, not size* — a discovery/search surface of categorical metadata (titles, IDs) is not analytical and doesn't get a canvas regardless of row count; for name→ID resolution over a bounded list use [MCP-side list filtering](#mcp-side-list-filtering); (2) the `canvas_id` is reachable only if the same server **also exposes a `dataframe_query` tool** — emit one without the other and the handle is dead output. Compute distributions or refinement hints across the full result, not the preview, so aggregate signal stays honest. See `api-canvas` for the `spillover()` helper and both rules in full.
- **Outline one large *document* into sections.** When a single tool call returns one document-shaped record (not many rows) that can exceed context — a ~130KB FDA drug label, a big API entity dominated by a few fat fields — return a section *outline* (top-level keys + per-section byte size) instead of truncating, and let the agent re-call with `sections: [...]` to pull only what it needs. The `outlineOnOverflow()` helper (`@cyanheads/mcp-ts-core/utils`) measures the payload and returns a `full | outline` result; declare the tool's `output` as a flat `z.object` with a `kind` discriminator and presence-based optional arms (folding in `OUTLINE_VARIANT.shape.sections` / `.notice`) — `tool()` rejects a `z.discriminatedUnion` output — so `format()`-parity holds when each arm renders on field presence. Pure measure + key-slice — Workers-portable, unlike canvas-bound `spillover()`. Distinct from spillover on *shape*: spillover splits a row collection, this outlines one fat record. See the `techniques` skill's `outline-on-overflow` reference.
- **Mirror a bulk upstream instead of paginating it live.** When the server wraps a large or slow API whose corpus is queried far more than it changes, sync it once into a persistent local index and query that as the primary data path — not the live API per request. Match the backend to corpus size: ≲ tens of thousands of rows → an in-memory index (server-level, no primitive); ~10⁴–10⁷ → the `MirrorService` (embedded SQLite + FTS5; declare a schema + a `sync` ingester via `defineMirror`/`sqliteMirrorStore`, then `runSync`/`query`, see `api-mirror`); ≳ 10⁸ → an external store. Distinct lifecycle from DataCanvas: a mirror is long-lived and cross-session, refreshed on a schedule; canvas is ephemeral and per-session.
- **`format()` is the markdown twin of `structuredContent` — make both content-complete.** Different MCP clients forward different surfaces to the model: some (e.g., Claude Code) read `structuredContent` from `output`, others (e.g., Claude Desktop) read `content[]` from `format()`. Both must carry the same data so every client sees the same picture — `format()` just dresses it up with markdown. A thin `format()` that returns only a count or title leaves `content[]`-only clients blind to data that `structuredContent` clients can see. Render all fields the LLM needs, with structured markdown (headers, bold labels, lists) for readability.
- **Agent-facing context must reach both client surfaces — put it in `enrichment`.** `structuredContent` (from `output`) and `content[]` (from `format()`) are read by different clients. Empty-result notices, the query/filter as the server parsed it, and pagination totals — the context the agent *reasons with*, distinct from the domain payload — reach only `content[]` if hand-authored into `format()` text alone, leaving `structuredContent`-only clients (Claude Code) blind. (The reverse can't happen: `format-parity` drags every `output` field into `format()`, so `output`-authored context already reaches both.) An `enrichment` block — the success-path counterpart to `errors[]`, populated via `ctx.enrich(...)` — reaches both automatically: merged into `structuredContent`, advertised as `output.extend(enrichment)`, mirrored into a `content[]` trailer, no `format()` entry needed. How each field renders in that trailer is a per-tool call — a kind-tag (`notice`/`total`/`echo`/`delta`) when a canonical form fits, a domain key like `totalFound` otherwise, and an `enrichmentTrailer.render` for any structured (object/array) field so it doesn't ship as a JSON blob. See `add-tool`'s **Tool Response Design**.

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

#### MCP-side list filtering

**Applies when:** an upstream API has no native search, the relevant set is bounded (fits one or a few fetches), and an agent needs to resolve a name → opaque ID. Skip when the API already searches, or when the set is unbounded (bills, votes, filings) — that belongs in the DataCanvas dataframe layer (`*_dataframe_query`), not an in-memory filter.

Two params, two behaviors — keep them named distinctly:

- **`query`** → **upstream** full-text search. The API does the work; it may honor operators and ranking.
- **a local filter param** → **fetched-then-filtered on our side**. Name it for the mechanic: `filter` or `nameContains` (the latter self-documents the local, name-keyed half of the split). Don't overload `query` for it — the two have different semantics and different cost.

**Earns-its-keep gate — all must hold:** bounded set; no native upstream search; real scan pain (opaque IDs, a large/unordered list, or a default page that hides relevant rows); and it filters the natural lookup key (name/title). When any fails, skip it — paginate, or send the agent to upstream `query`.

**Correctness: filter the *complete* bounded set, not the current page.** Fetch up to the cap (or page through) before filtering — filtering one page returns a misleading partial slice.

**Matching: strict token match is the default.** Normalize (lowercase, strip punctuation/diacritics) and require every query token to appear, so word order and missing interior words still match. That strict core is the ~90% case, needs no fuzzy library, and is too small to centralize (~6 lines — guidance, not a shared helper). Add a fuzzy fallback **only when a caller genuinely needs typo tolerance** (an LLM caller rarely does): fire it only when the strict match is empty, score against the best-matching *token* in each name (not the whole string) and **cap** the results — or one short query clears the threshold against dozens of long multi-word names — and label its hits `approximate`. Often a bare "no match — call the unfiltered list to browse" beats an `approximate` guess: it lets the model self-correct instead of committing to the wrong record. See `add-tool` for the param + handler implementation.

#### Error design

Errors are part of the tool's interface — design them during the design phase, not as an afterthought. Three aspects: **the contract** (which failures are public), **classification** (what error code), and **messaging** (what the LLM reads).

**Declare a typed contract for domain failures.** When a tool has known failure modes the agent should plan around (`no_match`, `queue_full`, `vendor_down`), enumerate them as `errors: [{ reason, code, when, recovery, retryable? }]` on the definition. `recovery` is required metadata — the agent's next move when this failure fires (≥ 5 words, lint-validated; spread `ctx.recoveryFor('reason')` into the throw-site `data` to send it on the wire as `data.recovery.hint`). The framework types `ctx.fail(reason, …)` against the declared reason union (typos become TS errors) and auto-populates `data.reason` on the thrown error for stable observability. The error reaches clients with parity across both surfaces — `structuredContent.error` (Claude Code) and `content[]` text (Claude Desktop). Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble from anywhere and don't need to be enumerated. See `api-errors` skill for the full pattern.

**Classify errors by origin.** Different error sources need different codes and different recovery guidance. Map the failure modes for each tool during design:

| Origin | Examples | Error code | Agent can recover? |
|:-------|:---------|:-----------|:-------------------|
| **Client input** | Bad ID format, invalid params, missing required field, out-of-range value | `ValidationError` | Yes — fix the input and retry |
| **Upstream API** | 5xx, rate limit (429), timeout, network error | `ServiceUnavailable` | Maybe — retry later, or the upstream is down |
| **Not found** | Valid ID format but entity doesn't exist | `NotFound` (or `ValidationError` if ambiguous) | Yes — check the ID, try a search |
| **Auth/permissions** | Insufficient scopes, expired token | `Forbidden` / `Unauthorized` | Maybe — escalate or re-auth |
| **Server internal** | Parse failure, missing config, unexpected state | `InternalError` | No — server-side issue |

(`InvalidParams` also exists — the SDK emits it when input fails Zod schema validation before the handler runs. Anything the handler itself throws about inputs uses `ValidationError`.)

The framework auto-classifies many of these at runtime (HTTP status codes, JS error types, common patterns), but explicit classification in the handler gives better error messages. For declared contract failures, throw via `ctx.fail('reason', …)`. For ad-hoc throws outside the contract, use error factories (`notFound()`, `validationError()`, etc.) when the code matters; plain `throw new Error()` when the framework's auto-classification is good enough.

**Expected misses are results, not errors.** When a tool's whole job is resolving one identifier — a citation, a code, a name → ID — a no-match is an expected outcome the agent must reason about, not a failure. Return `{ found: false, guidance }` instead of throwing, and treat `guidance` as a first-class recovery surface: per miss outcome, say what didn't parse or resolve and route to the named tool that can recover (the broader search tool, the reference tool). Agents self-correct better from a structured miss than from a throw — a throw reads as "something broke," a miss result reads as "adjust and retry."

**Write error messages as recovery instructions.** The message is the agent's only signal for what to do next — and the strongest recovery instruction ends in a named tool call, never a bare "check your input."

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

**During design, settle the full contract for each tool** — reason, code, when-clause, *and the verbatim `recovery` string* — in the tool's section of the design doc; they become the literal `errors: [...]` entries during scaffolding. Hold every recovery string (and zero-hit notice, and resolver `guidance`) to the **no-dead-ends rule: it names the concrete next tool call**, with the reference tool as the most common routing target. Settled at design time these stay sharp; left to implementation they degrade into "check your input." Not every failure needs a contract entry; baseline infrastructure errors (5xx, timeouts, validation) are fine to let bubble.

#### Design table

Summarize each tool:

| Aspect | Decision |
|:-------|:---------|
| **Name** | Lowercase snake_case with a canonical server prefix. **3 segments is the strong default** (`{server}_{verb}_{noun}` — e.g., `pubmed_search_articles`, `clinicaltrials_find_studies`). **2 is fine when the operation name is canonical** and no noun adds signal (`git_pull`, `git_status` — "pull" already implies the remote). Don't invent a word to pad to 3. **4 is fine when the noun is inherently two words** (`patentsview_search_patent_families`) or the prefix is multi-part. Use the canonical platform/brand name as prefix, not abbreviations (`patentsview_` not `patents_`, `clinicaltrials_` not `ct_`). The verb+noun pair should be unambiguous within the server — if two tools could plausibly share a name, the noun isn't specific enough (`read_fulltext` not `read_text` when structured metadata is a separate concept). **Treat name length as a scope smell only when** the extra segment is the *verb* overreaching (e.g., `foo_create_and_send_notification` → split or use modes). |
| **Granularity** | Scope each tool to one coherent agent action. The implementation can be a single API call (`pubmed_search_articles`), a multi-step workflow, or internal-only — match the unit to the work, don't constrain by call count. |
| **Description** | Concrete capability statement. Add operational guidance (prerequisites, constraints, gotchas) when non-obvious. |
| **Input schema** | `.describe()` on every field. Constrained types (enums, literals, regex). Explain costs/tradeoffs of parameter choices. |
| **Output schema** | Designed for the LLM's next action. Include chaining IDs. Communicate filtering. Post-write state where useful. |
| **Errors** | Declare domain failure modes as a typed contract (`errors: [{ reason, code, when, recovery, retryable? }]`) so `ctx.fail` is type-checked and capable clients can preview failures via `tools/list`. Every `recovery` string follows the no-dead-ends rule — it names the next tool call. |
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

**Services** — one per external dependency (or per source, for multi-source servers). Init/accessor pattern. Skip if all tools are thin wrappers with no shared state. For multi-source servers, each upstream API gets its own service with its own auth, rate limits, and retry config — tools compose across services internally, agents never see the service boundary.

**Server-as-service.** When the server IS the source of truth (knowledge graph, in-memory task tracker, local scratchpad, embedded inference wrapper), the resilience table below doesn't apply — there's no upstream to retry. The design questions shift to state management: what's tenant-scoped vs. global, what TTLs apply, what survives a restart, what the storage backend is. Plan persistence via `ctx.state` for tenant-scoped KV (auto-namespaced by `tenantId`), or use a `StorageService` provider directly when data must cross tenants. Service init still happens in `setup()`, accessed via `getMyService()` at request time. Calls within the server are local and synchronous-ish — the API-efficiency table below also doesn't apply.

**Analytical API servers: DataCanvas is one option.** For servers that fetch **analytical** data — result sets an agent runs SQL over (aggregate, group, join, time-series) — and want to expose a SQL workspace, the framework's optional `DataCanvas` primitive (Tier 3, opt-in via `CANVAS_PROVIDER_TYPE=duckdb`) handles lifecycle, ID generation, eviction, and export wiring so you don't design your own. **It earns its keep on shape, not size:** a discovery/search surface returning categorical metadata (titles, IDs, types) — where the workflow is find-the-record-then-drill-in — does *not* qualify even when the result is large; resolve names over a bounded set with [MCP-side list filtering](#mcp-side-list-filtering) instead. **If you opt in, the consumer tools are mandatory:** a tool that emits a `canvas_id` MUST be paired with a `dataframe_query` (and `dataframe_describe`) tool in the same surface — a `canvas_id` with no query tool is dead output the agent can't reach. Surface `canvas_id` as an optional input on register/query/export tools; the framework mints on omit and resolves on match. Tools access it via `ctx.core.canvas?` (undefined when disabled or running on Workers — DuckDB has no V8-isolate build). See `api-canvas` for the full reference.

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

## User Goals

1. Numbered outcomes agents will accomplish (from Step 2) — every tool in the surface traces back to one

## Tools — detail

One subsection per tool: a param table (param | type | maps-to | notes), the output field
list, the error contract table (reason | code | when | recovery — verbatim strings), and
zero-hit notice fragments for search tools. This is the section implementation reads
tool-by-tool.

## Services
| Service | Wraps | Used By |
|:--------|:------|:--------|

## Config
| Env Var | Required | Description |
|:--------|:---------|:------------|

## Server Instructions

Draft `instructions` string for `createApp()` — the orientation every client sees at
initialize: canonical workflow chain, identifier semantics, rate-limit posture. A short
paragraph; tool descriptions carry the rest.

## Implementation Order

1. Config and server setup
2. Services (external API clients)
3. Reference tool (static, no service dependency — grounds field-testing for everything else)
4. Read-only tools
5. Write tools
6. Resources
7. Prompts

Each step is independently testable.

<!-- Optional sections — include when the trigger fires: -->
## Domain Mapping          <!-- nouns × operations → API endpoints; include when ≥3 nouns each with ≥3 operations -->
## Workflow Analysis        <!-- how tools chain for real tasks; include when any tool makes ≥3 upstream calls -->
## Design Decisions         <!-- rationale for consolidation, naming, tradeoffs; include when a choice would otherwise be opaque -->
## Known Limitations        <!-- inherent API/data constraints the server can't solve; include when a constraint visibly caps utility -->
## API Reference            <!-- query language, pagination, rate limits; include when worth documenting -->
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

If the user has already authorized implementation — any message that contains both a design request and a build/implement verb in the same clause (e.g., "build me a ___ server", "design and implement a ___") — proceed directly to scaffolding using the design doc as the plan. Otherwise, present the design doc to the user for review before implementing.

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

- [ ] Server scope decided — workflow identified, audience sized, boundary drawn (standalone single-API vs. multi-source aggregation vs. internal-only)
- [ ] **If multi-source:** tool surface organized around user workflows, not API identity. Sources are service-layer details.
- [ ] External APIs/dependencies researched and verified (docs fetched, SDKs identified)
- [ ] **If wrapping an external API:** live API probed (at minimum: one list/search, one single-item GET, one error case)
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
- [ ] Error messages guide recovery — name what went wrong and the next tool call (no dead ends)
- [ ] **If a tool has known domain failure modes:** typed error contract declared (`errors: [{ reason, code, when, recovery, retryable? }]`) with verbatim `recovery` strings settled in the design doc, each naming the next tool call
- [ ] **If the server has search/list tools:** zero-hit notices specced (condition → fragment, each routing to a named next call); server-applied defaults that change result semantics echoed in output
- [ ] **If a tool resolves a single identifier:** no-match returns `{ found: false, guidance }` — a result, not a throw — with guidance routing per miss outcome
- [ ] **If the domain has opaque vocabulary (codes, identifier formats, coverage windows):** reference tool designed (`topic` enum), implemented first, and used as the routing target in recovery strings and notices
- [ ] Annotations set correctly (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
- [ ] Server-level `instructions` string drafted — workflow chain, identifier semantics, rate-limit posture (ships via `createApp()` on every initialize)
- [ ] Design doc written to `docs/design.md`
- [ ] Design confirmed with user (or user pre-authorized implementation)
- [ ] **If ops share a noun:** related operations consolidated under one tool with `mode`/`operation` enum
- [ ] **If an upstream API has no native search but the relevant set is bounded:** MCP-side list filtering considered — a distinct local filter param (`filter`/`nameContains`, not `query`), filtering the full set, strict token match (fuzzy only when a caller needs typo tolerance)
- [ ] **If the server has workflow tools:** call-flow documented (upstream sequence + mode arms) in design doc's Workflow Analysis
- [ ] **If state-aware procedural guidance adds value:** instruction tool considered with `nextToolSuggestions` pre-filled from diagnostics
- [ ] **If workflow tools have destructive modes:** destructive arm guarded by `ctx.elicit` when available, with `destructiveHint` annotation as fallback for non-interactive clients
- [ ] **If a parameter determines blast radius:** safe default set (e.g., `mode: 'preview'`, `dryRun: true`, `confirmCount` required)
- [ ] **App tools default to no.** If one was proposed, verified there's a real human-in-the-loop in an MCP Apps-capable client justifying the iframe/CSP/`format()`-twin maintenance cost — otherwise dropped in favor of a standard tool
- [ ] **If the server exposes resources:** URIs use `{param}` templates, pagination planned for large lists
- [ ] **If the server is itself the source of truth (no external API):** state lifecycle planned — tenant-scoped vs. global, TTLs, what survives restart, storage backend chosen
- [ ] **If the server has external deps or shared state:** service layer planned (or explicitly skipped with reasoning)
- [ ] **If services wrap external APIs:** resilience planned (retry boundary, backoff, parse classification)
- [ ] **If multi-source server:** each source has its own service with independent auth/retry/rate-limit config. Fallback chains or fan-out strategy documented per tool. Output includes source provenance.
- [ ] **If exposing a SQL/analytical workspace is in scope:** DataCanvas considered (`api-canvas` skill), and it earns its keep on *analytical* fit (an agent would SQL it), not row count — a discovery/search surface of categorical metadata doesn't qualify. Any tool emitting a `canvas_id` is paired with a `dataframe_query` (+ `dataframe_describe`) tool in the same surface — a token with no query tool is dead output
- [ ] **If the server needs runtime config:** env vars identified in `server-config.ts`

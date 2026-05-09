---
name: security-pass
description: >
  Review an MCP server for common security gaps: LLM-facing surfaces as injection vector (tools, resources, prompts, descriptions), scope blast radius, destructive ops without consent, upstream auth shape, input sinks (URL / path / roots / shell / sampling / schema strictness / ReDoS), tenant isolation, leakage through errors and telemetry, unbounded resources, and HTTP-mode deployment surface. Use before a release, after a batch of handler changes, or when the user asks for a security review, audit, or hardening pass. Produces grouped findings and a numbered options list.
metadata:
  author: cyanheads
  version: "1.4"
  audience: external
  type: audit
---

## Context

An MCP server is a new attack surface with unique properties — tool output feeds back into the LLM's context, scopes gate what the model can do on the user's behalf, and per-request state must stay tenant-scoped. This skill walks a server through eight axes shaped around what the server builder actually controls. Framework-level concerns (transport, JSON-RPC parsing, auto-correlation, error classification) are out of scope — `mcp-ts-core` handles those.

**Read the code. Don't trust patterns from memory.**

## When to Use

- Before a release
- After adding or modifying a batch of handlers or services
- Periodically (quarterly-ish)
- User asks for a "security review", "audit", "hardening pass", or similar

## Inputs

Gather before starting. Ask if unclear:

1. **Scope** — whole server, specific module, or recent diff?
2. **Known concerns** — anything the user already suspects?
3. **Deployment context** — multi-tenant? public network? auth mode? (stdio / local-http / public-http behave differently)
4. **Severity floor** — report all findings, or skip medium/low?

## Steps

### 1. Build the map

Surface what you're auditing before diving in. Paths below assume the `mcp-ts-core` layout — adjust to your repo.

```bash
find src/mcp-server/tools/definitions -name "*.tool.ts" | sort
find src/mcp-server/resources/definitions -name "*.resource.ts" 2>/dev/null | sort
find src/mcp-server/prompts/definitions -name "*.prompt.ts" 2>/dev/null | sort
find src/services -maxdepth 1 -mindepth 1 -type d | sort
```

Note: tool / resource / prompt counts, auth mode, storage provider, upstream APIs, which tools have `destructiveHint`, which handlers use `ctx.sample` or `ctx.elicit`, which services hold module-scope state, whether the server reads `roots`.

**If transport is streamable HTTP or SSE**, also capture:

- Bind address (`127.0.0.1` for local, or `0.0.0.0` / public interface?)
- Origin allowlist (DNS rebinding mitigation) — configured, or wildcard / missing?
- Session ID source (framework CSPRNG, or builder-supplied?) and binding to auth identity
- Any unauthenticated routes (`/healthz`, `/sse`, metadata endpoints) — do they leak tool lists or tenant hints?
- MCP Authorization spec: if implemented, PKCE enforced, token audience (`aud`) checked, resource indicators used

**If `CANVAS_PROVIDER_TYPE=duckdb` is set**, also capture:

- Auth mode — canvas in `MCP_AUTH_MODE=none` collapses the composite `(tenantId, canvasId)` scope to `('default', canvasId)`, where the ID is the only differentiator
- `CANVAS_MAX_CANVASES_PER_TENANT`, `CANVAS_TTL_MS`, `CANVAS_ABSOLUTE_CAP_MS`, `CANVAS_EXPORT_PATH` values
- Whether external rate limiting (CDN, reverse proxy, WAF) fronts the deployment — required to keep the ~10¹⁸ canvasId keyspace operationally infeasible to brute-force

Use `TaskCreate` — one task per axis. Mark complete as you go.

**Run `fuzzTool` in parallel.** `@cyanheads/mcp-ts-core/testing/fuzz` catches crashes, memory leaks, and prototype pollution automatically on each tool — start it now so results are ready when you reach Axis 5.

### 2. Walk the eight axes

#### Axis 1 — LLM-facing surfaces as injection vector

Anything the server sends to the client that reaches the LLM's context is a potential injection surface: tool output, resource content, prompt text, and the metadata the LLM reads to decide what to call. Relayed upstream content (tickets, scraped text, emails, DB rows) can carry adversarial instructions even when your code is honest.

**Look in:**

- Every `*.tool.ts` — `output` schema + `format()`
- Every `*.resource.ts` — content returned from `resources/read`
- Every `*.prompt.ts` — templated message content
- Every definition file — `description`, `title`, `annotations`, and `inputSchema` field descriptions (templated from untrusted data?)

**Check:**

- Handlers that return raw upstream text / DB rows without structural framing?
- Does `format()` wrap untrusted content in delimiters (blockquote, fenced code, `<data>` tags)?
- Output schema distinguishes "data" fields from free-form text?
- Resource content (`resources/read`) framed the same way tool output is?
- Prompt templates interpolate untrusted data without escaping — treating tenant-controlled strings as trusted instructions?
- Tool / resource / prompt **descriptions** templated from runtime data? Static strings are safer; templated descriptions enable "tool poisoning" (adversarial metadata steering the LLM toward a dangerous tool).
- Descriptions mutated mid-session? Rug-pull surface: client approved the v1 description, server now advertises v2 behavior.

**Smell:** `return { body: await fetch(url).then(r => r.text()) }` rendered directly in `format()`. Or: `description: \`Look up ${tenant.customLabel}\`` where `customLabel` is tenant-supplied.

#### Axis 2 — Scope granularity

Every `auth: [...]` entry is a blast-radius dial.

**Look in:** every `*.tool.ts` — `auth:` array.

```bash
grep -rn "auth: \[" src/mcp-server/tools/definitions/
```

**Check:**

- Tools with `['admin']`, `['*']`, or `[]`?
- A single scope covering two capabilities that should be separated (read vs write)?
- Read-only tools never require write scopes?
- `MCP_AUTH_DISABLE_SCOPE_CHECKS=true` set in production? When on, both `withRequiredScopes` and `checkScopes` early-return — every authenticated user gets every tool, and runtime tenant patterns like `team:${input.teamId}:write` no longer guard. Acceptable only when paired with a real server-side ACL (path filter, allowlist, upstream API enforcement).

**Smell:** every tool shares the same scope string. Or: `MCP_AUTH_DISABLE_SCOPE_CHECKS=true` set without a documented compensating ACL — confirm the deployment relies on a meaningful access control layer below the framework before approving.

#### Axis 3 — Destructive ops without elicit

`ctx.elicit` moves consent off the LLM and onto the user. Destructive tools without it trust the LLM not to be tricked.

**Look in:** handlers with `destructiveHint: true` or side-effecting verbs in names (`delete_*`, `send_*`, `pay_*`, `publish_*`, `drop_*`).

```bash
grep -rn "destructiveHint" src/mcp-server/tools/definitions/
grep -rn "ctx.elicit" src/mcp-server/tools/definitions/
```

**Check:**

- Each destructive handler calls `ctx.elicit` before the side effect?
- Fallback when client doesn't support elicit — refuses, not silently proceeds?
- Elicit **response** validated against a Zod schema before use? The returned payload is LLM-mediated, not user-direct — "user confirmed" does not mean "user authored these exact fields."
- Consent is scoped to the specific target (e.g., record ID rendered in the prompt), not a generic "proceed?"

**Smell:** `destructiveHint: true` file with no `ctx.elicit?.(...)` in it. Or: `const { confirmed } = await ctx.elicit(...)` without a schema — `confirmed` could be anything.

#### Axis 4 — Upstream auth shape

What credentials the server holds, and the blast radius if one leaks.

**Look in:** `src/services/*`, `src/config/server-config.ts`.

**Check:**

- Each upstream API key scoped to minimum required? (No admin keys for read workflows.)
- Services re-mint downstream tokens with correct `aud`, or passthrough the caller's?
- Server holds OAuth for N services × M tenants — what does one-tenant compromise expose?
- Per-tenant rate limits on upstream calls?

**Smell:** one global `API_KEY` used across all tenants + retry loop with no upper bound.

#### Axis 5 — Input sinks

LLM-supplied inputs feel internal but aren't. Classic sinks apply, amplified. Sampling responses and roots-derived paths are MCP-specific sinks that look internal but carry LLM/client trust.

**Look in:** all handlers.

```bash
# URL sinks — SSRF
grep -rn "z.string().url()" src/

# Path sinks — traversal
grep -rn "readFile\|writeFile\|readdirSync\|createReadStream\|statSync" src/

# Shell sinks — command injection
grep -rnE "\b(exec|spawn|execSync|spawnSync)\b" src/

# Merges — prototype pollution
grep -rn "Object.assign\b\|structuredClone" src/

# Sampling — LLM-generated content flowing back into server logic
grep -rn "ctx.sample\|sampling/createMessage" src/

# Roots — client-shared filesystem
grep -rn "roots/list\|ctx.roots" src/

# Schema laxity — fields sneaking past validation
grep -rn "\.passthrough()\|\.catchall(" src/mcp-server/
```

**Check:**

- URL-taking tools block private IPs, `file://`, `ftp://`, `localhost`, DNS rebind?
- Path-taking tools canonicalize (`path.resolve` + assert `startsWith(root + sep)`)?
- Roots-derived paths: resolved result stays within *one* declared root (iterate and assert), not assumed-safe because "the client said so"?
- Shell-using tools use an allowlist (never string-concat)?
- Regex / glob / filter inputs bounded (length cap, complexity limits, execution timeout) — ReDoS-safe?
- User-JSON merges reject `__proto__`, `constructor`, `prototype` keys?
- **Input schemas `.strict()`** — unknown fields rejected, not silently passed to downstream code that destructures with `...rest`?
- **Output schemas without `.passthrough()` / `.catchall()`** — no accidental exfiltration of fields your schema didn't declare?
- Sampling responses (`ctx.sample` result) treated as untrusted input — schema-validated before reaching any other sink, never concatenated into prompts, shells, or queries?

**Smell:** `z.string().url()` with no allowlist; `readFile(input.path)` with no canonicalization; `await ctx.sample(...)` result interpolated into a shell, SQL, or URL.

#### Axis 6 — Tenant isolation

`ctx.state` is tenant-scoped. Module-scope state is not.

**Look in:** `src/services/*`.

```bash
grep -rnE "^(const|let) .* = new (Map|Set|WeakMap|Array)" src/services/
grep -rn "^let " src/services/
```

**Check:**

- Module-scope `Map` / `Set` / cache near tenant-handling code?
- Upstream connections pooled per-tenant or shared?
- Any code path uses the global `logger` while carrying per-tenant data (bypassing auto-correlated `ctx.log`)?
- Could tenant B, served after tenant A, read tenant A's cached data?

**Smell:** service file with top-level `const cache = new Map()`.

#### Axis 7 — Leakage back

What accidentally reaches the LLM, user, or observability sinks.

**Look in:** `throw new McpError(...)` and `ctx.fail(reason, msg, data)` sites, error factory calls (`notFound`, `httpErrorFromResponse`, …), `McpError.data` fields (the `data` arg flows through both paths), output schemas, and every logging / telemetry surface — not just `ctx.log`.

```bash
grep -rnE "new McpError|ctx\.fail\(|httpErrorFromResponse\(" src/
grep -rnE "\b(ctx\.log|console\.(log|info|warn|error|debug)|logger\.)" src/
grep -rnE "(Sentry\.|captureException|setTag|setContext|addBreadcrumb)" src/
grep -rnE "(setAttribute|setAttributes|span\.)" src/  # OpenTelemetry
```

**Check:**

- Error `data` fields (whether passed via `ctx.fail(reason, msg, data)`, `new McpError(code, msg, data)`, or factory calls) carry upstream response bodies, auth headers, stack traces?
- `httpErrorFromResponse` body capture sweeping in too much (default 500-byte cap is fine for most APIs but consider `captureBody: false` when the upstream returns auth-bearing payloads)?
- Output schemas include token prefixes, internal IDs, session identifiers?
- `format()` renders fields that shouldn't leave the server?
- `ctx.log.info(msg, body)` where `body` is the raw request (may contain secrets)?
- `console.*` calls near auth / token / request-body handling — bypasses structured redaction?
- OpenTelemetry span attributes / Sentry breadcrumbs carry tokens, PII, or full request bodies?
- Secret / token / HMAC comparisons use `===` or `==` instead of constant-time (`timingSafeEqual` / `crypto.timingSafeEqual`) — leaks length and prefix via timing?

**Smell:** `throw new McpError(code, upstream.message, { raw: upstream.body })` or `throw ctx.fail('upstream_failed', e.message, { raw: e.response.body })`. Or: `if (apiKey === expected)` on a request-auth path.

#### Axis 8 — Resource bounds

Unbounded = DoS of self, upstream, or the LLM's context window (billing-DoS is real).

**Look in:** handlers with loops, pagination, retries, or inputs that feed `JSON.parse` / schema validation.

```bash
grep -rnE "while\s*\(|for\s*\(.*of" src/mcp-server/tools/definitions/
grep -rn "cursor\|nextPage\|paginate" src/
grep -rn "JSON.parse\b" src/
```

**Check:**

- Pagination loops have a total-items cap?
- Retry logic has max attempts + exponential backoff?
- Output size proportional to input — is there a ceiling?
- Tools callable in a loop fail-fast on degenerate input (empty string, `0`, `null`)?
- `JSON.parse` / Zod `.parse()` inputs have a size + nesting-depth limit applied before parse?
- **Per-tenant per-tool** call rate limit (a single tenant looping `delete_record` 10k/sec hits you before it hits upstream)?
- Concurrency cap on long-running tools so one tenant can't starve the event loop?

**Smell:** `while (cursor) { results.push(...); cursor = next; }` with no max count. Or: `JSON.parse(await req.text())` with no `Content-Length` check upstream.

#### Axis 9 — Canvas (only if `CANVAS_PROVIDER_TYPE=duckdb`)

DataCanvas is opt-in and deliberately trades isolation for cross-agent token-shareable working sets — designed for public-data tabular servers (BrAPI, OpenAlex, etc.) where session-pinning isn't desired. The trade only holds when the deployment matches that assumption. Skip this axis entirely when canvas is disabled (`CANVAS_PROVIDER_TYPE=none`, the default).

**Look in:** `src/config/server-config.ts`, every tool reading `ctx.core.canvas?`, deployment config (wrangler / Dockerfile / proxy).

**Check:**

- Data registered on canvases is **already public** or already-shared-out-of-band. The composite `(tenantId, canvasId)` scope collapses to `('default', canvasId)` in `MCP_AUTH_MODE=none` — anyone with the `canvasId` attaches.
- External rate limiting (CDN, reverse proxy, WAF) fronts the deployment so the ~10¹⁸ keyspace can't be brute-forced. Without it, the entropy assumption breaks and discovery becomes feasible.
- `CANVAS_MAX_CANVASES_PER_TENANT` sized for the memory budget — default 100 is the floor; raising it lets a single tenant exhaust memory faster.
- `CANVAS_TTL_MS` / `CANVAS_ABSOLUTE_CAP_MS` not absurdly long. Defaults (24 h sliding / 7 d absolute) are reasonable; longer widens the window an unreferenced `canvasId` stays guessable.
- `CANVAS_EXPORT_PATH` doesn't point into a shared mount, the repo, or a directory another service serves from. The path-sandbox blocks `..` traversal but doesn't prevent the configured root from being a bad choice.
- Axis 1 (description templating from canvas-supplied content), Axis 5 (no parallel service runs raw SQL outside the canvas API and bypasses `assertReadOnlyQuery`), and Axis 7 (errors from canvas operations don't leak the failed SQL string back through `McpError.data`) all apply.

**Smell:** `MCP_AUTH_MODE=none` deployment registering per-user data (recent activity, account state, cart contents) onto a canvas. Or: `CANVAS_EXPORT_PATH=/srv/static` with a static file server pointing at the same root.

### 3. Quick sanity pass

Fast, sometimes high-leverage. Outside the eight axes.

- `bun audit` — any direct high/critical?
- `package.json` — `postinstall` / lifecycle scripts on added deps?
- New deps have npm provenance? `npm view <pkg> --json | jq .dist.attestations` — missing attestation on a security-critical dep is a yellow flag
- `.env.example` — placeholder values only, never real?
- Server-specific `ConfigSchema` — fails loudly on missing required keys (not silent defaults)?
- Any `process.env.*` reads outside the config parser (bypasses validation)?
- Collect `fuzzTool` results from Step 1 — triage crashes / leaks as Axis 5 / Axis 8 findings.

### 4. Report

Three sections. Summary → findings → numbered options.

#### Summary (1 paragraph)

Definitions reviewed, axes covered, count by severity, the single most important finding.

#### Findings

Group by severity. Each 3–5 lines.

| Severity | Meaning |
|:---------|:--------|
| **critical** | Exploitable now: auth bypass, exfiltration, arbitrary code/file/network access |
| **high** | Structural gap with clear attacker benefit even without immediate PoC (destructive op without elicit, admin scope on read tool, SSRF-capable URL input) |
| **medium** | Defense-in-depth gap weakening a boundary (missing per-tenant rate limit, error carries upstream response) |
| **low** | Hardening / polish (tighter output schema, narrower error data, minor comment) |

Format:

```
**<file_or_tool> — Axis <N> — <critical|high|medium|low>**
Issue: <one line: what's wrong>
Impact: <one line: what can go wrong>
Fix: <one line: the change>
```

#### Options

Numbered, cherry-pickable.

```
1. Add SSRF guard to `fetch_url.tool.ts` — block private IPs + non-http schemes (critical, #1)
2. Gate `delete_record.tool.ts` behind `ctx.elicit` (high, #3)
3. Split `admin` into `record:read` + `record:write` across 4 tools (high, #4)
4. Move `const tokenCache = new Map()` out of module scope in `auth-service.ts` (medium, #7)
5. Cap pagination loop in `list_all_tickets` at 1000 items (medium, #9)
6. Strip upstream response body from `McpError.data` in `sync-service.ts` (low, #11)
```

End with:

> Pick by number (e.g. "do 1, 3, 5" or "expand on 2").

## Checklist

- [ ] Scope confirmed (whole server / module / diff)
- [ ] Map built: tools / resources / prompts, services, upstream APIs, auth mode, sampling / elicit / roots usage
- [ ] Deployment surface reviewed (if HTTP): bind address, Origin allowlist, session ID, unauth routes, auth-spec compliance
- [ ] `fuzzTool` started in parallel
- [ ] Axis 1 — LLM-facing surfaces (tool / resource / prompt output + descriptions) framed and static
- [ ] Axis 2 — scope granularity audited
- [ ] Axis 3 — destructive ops verified to elicit, elicit response schema-validated
- [ ] Axis 4 — upstream auth + token passthrough reviewed
- [ ] Axis 5 — input sinks (URL / path / roots / shell / proto / sampling / schema strictness / ReDoS) checked
- [ ] Axis 6 — tenant isolation: module-scope state swept
- [ ] Axis 7 — leakage back: errors / outputs / `ctx.log` / `console.*` / telemetry / constant-time comparisons
- [ ] Axis 8 — resource bounds on loops / retries / pagination / parse size+depth / per-tenant rate
- [ ] **If `CANVAS_PROVIDER_TYPE=duckdb`:** Axis 9 — public-data assumption holds, external rate limiting in place, max-canvases-per-tenant + TTLs sized for the deployment, `CANVAS_EXPORT_PATH` doesn't escape into shared / served paths, `assertReadOnlyQuery` is the only SQL path
- [ ] Quick sanity pass: `bun audit`, lifecycle scripts, `.env.example`, config validation, new-dep provenance
- [ ] Report: summary → grouped findings → numbered options

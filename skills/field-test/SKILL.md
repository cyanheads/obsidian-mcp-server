---
name: field-test
description: >
  Exercise tools, resources, and prompts against a live HTTP server via MCP JSON-RPC over curl. Starts the server, surfaces the catalog, runs real and adversarial inputs, and produces a tight report with concrete findings and numbered follow-up options. Use after adding or modifying definitions, or when the user asks to test, try out, or verify their MCP surface.
metadata:
  author: cyanheads
  version: "2.6"
  audience: external
  type: debug
---

## Context

Unit tests (`add-test` skill) verify handler logic with mocked context. Field testing exercises the real HTTP transport with real JSON-RPC: starts the server, calls `initialize`, surfaces the catalog, runs inputs, and checks what a client actually sees. It catches what unit tests miss — awkward input shapes, unhelpful errors, missing format output, drift between `structuredContent` and `content[]`, edge-case surprises.

**Actively call the tools. Don't read code and guess.**

### Transport coverage

This skill drives an HTTP server because curl + JSON-RPC is the most reliable harness for shell-based agents. The same handlers run on both transports — only the framing differs — so HTTP exercises the full functional surface.

**Stdio coverage is a boot check only — run this before Step 1.** Run `bun run rebuild && bun run start:stdio`, confirm the startup logs look clean (banner, expected tool/resource counts, no errors/warnings, no missing-config gripes), then kill it. Pino logs go to stderr in stdio mode (stdout is reserved for JSON-RPC), so they print straight to the terminal when you run interactively. No need to call tools over stdio — the HTTP pass already covered handler behavior.

---

## Steps

### 1. Start the server

Generate a 10-character alphanumeric ID (e.g. `9DJ73-K103L`) and write the helper to `/tmp/<project-name>-field-test-<ID>.sh`. Use that exact path in every subsequent Bash call. **Two agents in the same project tree must pick different IDs** — that's what keeps their helper files, server logs, and call scratch from colliding.

The helper itself is **stateless** — every function takes the IDs it needs (server `pid`, server `url`, MCP `sid`, server log path) as positional args. `mcp_start` prints them; the agent threads them through every later call. No env vars, no shared state files.

```bash
# Pick your ID — example below uses 9DJ73-K103L. Substitute your own.
# (Helper path also encodes the project name so /tmp/ stays grep-friendly.)
cat > /tmp/<project-name>-field-test-9DJ73-K103L.sh <<'HELPER_EOF'
#!/bin/bash
# Field-test helper: stateless wrappers around an MCP HTTP server + JSON-RPC
# session. Every function takes the IDs it needs as positional args — the agent
# threads pid/url/sid/log through each call rather than relying on a state
# file or env vars (the Bash tool wipes shell state between calls, and a
# pointer file would race the same way two agents race on shared state).
# See https://github.com/cyanheads/mcp-ts-core/issues/90, #144.
#
# Surfaces failures aggressively — field test is for finding things that fail,
# so the helper auto-tails logs and prints HTTP status/body on errors instead
# of swallowing them.

# Usage: mcp_start /path/to/server
# Builds, starts the HTTP server in the background, waits for the listen line,
# and prints: ready pid=<n> url=<u> port=<n> log=<path>
# Capture these — every later helper takes them as args.
mcp_start() {
  local dir="${1:-$PWD}"
  local build_log; build_log=$(mktemp /tmp/mcp-field-test-build.XXXXXX)
  echo "building $dir ..." >&2
  if ! (cd "$dir" && bun run rebuild) >"$build_log" 2>&1; then
    echo "BUILD FAILED — last 30 lines of $build_log:" >&2
    tail -30 "$build_log" >&2
    return 1
  fi
  rm -f "$build_log"
  local server_log; server_log=$(mktemp /tmp/mcp-field-test-server.XXXXXX)
  echo "starting server ..." >&2
  (cd "$dir" && bun run start:http) >"$server_log" 2>&1 &
  local pid=$!
  local line=""
  for _ in $(seq 1 40); do
    line=$(grep -Eo 'listening at http://[^" ]+/mcp' "$server_log" | head -1)
    [ -n "$line" ] && break
    sleep 0.25
  done
  if [ -z "$line" ]; then
    echo "server failed to start within 10s — last 30 lines of $server_log:" >&2
    tail -30 "$server_log" >&2
    kill "$pid" 2>/dev/null
    rm -f "$server_log"
    return 1
  fi
  local url="${line#listening at }"
  local port; port=$(echo "$url" | sed -E 's|.*:([0-9]+)/.*|\1|')
  echo "ready pid=$pid url=$url port=$port log=$server_log"
}

# Usage: mcp_init <url>
# Runs `initialize`, sends `notifications/initialized`, prints: ready sid=<id>
mcp_init() {
  local url="$1"
  [ -z "$url" ] && { echo "usage: mcp_init <url>" >&2; return 1; }
  local hdr; hdr=$(mktemp)
  local body_file; body_file=$(mktemp)
  local code
  code=$(curl -sS -D "$hdr" -o "$body_file" -w '%{http_code}' -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"field-test","version":"2.5"}}}')
  local sid; sid=$(grep -i '^mcp-session-id:' "$hdr" | awk '{print $2}' | tr -d '\r\n')
  if [ -z "$sid" ]; then
    echo "init failed — HTTP $code, no Mcp-Session-Id header returned" >&2
    echo "--- response body ---" >&2
    cat "$body_file" >&2
    echo "--- response headers ---" >&2
    cat "$hdr" >&2
    rm -f "$hdr" "$body_file"
    return 1
  fi
  curl -sS -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $sid" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
  rm -f "$hdr" "$body_file"
  echo "ready sid=$sid (HTTP $code)"
}

# Usage: mcp_call <url> <sid> <method> [JSON_PARAMS]
# Prints the JSON-RPC response. SSE framing is stripped when present; on
# non-SSE responses the raw body is printed instead so plain-JSON error
# replies (HTTP 4xx/5xx) still surface. Pipe to `jq`.
mcp_call() {
  local url="$1"; local sid="$2"; local method="$3"; local params="${4:-}"
  [ -z "$url" ] || [ -z "$sid" ] || [ -z "$method" ] && { echo "usage: mcp_call <url> <sid> <method> [params]" >&2; return 1; }
  local body
  if [ -z "$params" ]; then
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s"}' "$RANDOM" "$method")
  else
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s","params":%s}' "$RANDOM" "$method" "$params")
  fi
  local resp_file; resp_file=$(mktemp)
  local code
  code=$(curl -sS -o "$resp_file" -w '%{http_code}' -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $sid" \
    -d "$body")
  if [ "$code" -ge 400 ]; then
    echo "HTTP $code from $method — response:" >&2
    cat "$resp_file" >&2
    rm -f "$resp_file"
    return 1
  fi
  local sse; sse=$(sed -n 's/^data: //p' "$resp_file")
  if [ -n "$sse" ]; then
    printf '%s\n' "$sse"
  else
    cat "$resp_file"
  fi
  rm -f "$resp_file"
}

# Usage: mcp_log <server-log-path> [N]   (default: 50 lines)
# Tail the per-server log printed by mcp_start. Useful when a call surprises
# you — pino startup banner, definition lint diagnostics, request handler
# errors, upstream calls, and rate-limit warnings all land here.
mcp_log() {
  local log="$1"; local n="${2:-50}"
  [ -z "$log" ] && { echo "usage: mcp_log <log-path> [n]" >&2; return 1; }
  tail -n "$n" "$log"
}

# Usage: mcp_stop <pid> [server-log-path]
# Kills the background server. Removes the server log if a path is given.
mcp_stop() {
  local pid="$1"; local log="${2:-}"
  [ -z "$pid" ] && { echo "usage: mcp_stop <pid> [log-path]" >&2; return 1; }
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 12); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "PID $pid didn't exit on SIGTERM — sending SIGKILL"
    kill -9 "$pid" 2>/dev/null
    sleep 0.5
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "WARNING: PID $pid still alive after SIGKILL"
  else
    echo "stopped pid=$pid"
  fi
  [ -n "$log" ] && rm -f "$log"
}
HELPER_EOF

. /tmp/<project-name>-field-test-9DJ73-K103L.sh
mcp_start /absolute/path/to/server   # replace with the target server
```

Capture `pid`, `url`, `port`, `log` from the `mcp_start` output — every later call takes them as positional args. Two agents running concurrently in the same project tree each pick their own ID, so their helper paths, server logs, and call scratch never share a name.

**Notes**

- `MCP_HTTP_PORT` is a *starting* port — the server auto-increments if taken. Helper parses the real URL from the log (`HTTP transport listening at ...`).
- If `bun run rebuild` fails, stop. Don't field-test broken code — fix the build first.
- If a server is already listening on the project's port (`lsof -i :<port>`), confirm with the user before killing it; it may be their own session. If the user isn't available to confirm, abort the field test and surface the port conflict in your response.

### 2. Initialize the session

```bash
. /tmp/<project-name>-field-test-<ID>.sh
mcp_init <url-from-mcp_start>
```

Runs `initialize`, sends `notifications/initialized`, prints `sid=<id>` to capture for `mcp_call`.

### 3. Surface the catalog

```bash
. /tmp/<project-name>-field-test-<ID>.sh
mcp_call <url> <sid> tools/list     | jq '.result.tools[]     | {name, description, inputSchema, outputSchema}'
mcp_call <url> <sid> resources/list | jq '.result.resources[] | {uri, name, mimeType}'
mcp_call <url> <sid> prompts/list   | jq '.result.prompts[]   | {name, description, arguments}'
```

Present a compact catalog to the user: each definition's name + 1-line description. Flag vague or missing descriptions as you go — those feed into the report. Use this to build the test plan.

**Audit every description for leaks** — tool description, every parameter `.describe()` in `inputSchema`, and every field `.describe()` in `outputSchema` (the `outputSchema` projection above is what surfaces these; don't skim past it). Three categories:

- **Implementation details** — endpoint paths, API call counts, internal parameter mappings, routing logic. Describe *what the tool does*, not *how it's wired up*.
- **Meta-coaching** — directives about how to use the output. "Treat X as the canonical Y", "callers should…", "the LLM should…". The description sells the tool; it doesn't coach the reader.
- **Consumer-aware phrasing** — references to "LLM", "agent", "Claude", or any specific reader. The description shouldn't name who's reading it.

Treat any hit as a `ux` finding in the report. The authoring rule lives under *Tool descriptions* in `design-mcp-server/SKILL.md` — same categories, applied at review time.

### 4. Plan the test pass

**Budget.** Don't run every category against every definition — the cross-product is infeasible. Apply the **universal battery** to everything; apply **situational categories** only when the definition triggers them.

**Universal battery — run on every tool**

| Category | What to verify |
|:---------|:---------------|
| Happy path | One realistic input. Output shape matches schema. `content[]` text reads clearly to a human. |
| `structuredContent` ↔ `content[]` parity | Every field in `structuredContent` is surfaced in the text. Parity gap = client-specific blindness. |
| Input error | One invalid input (wrong type or missing required). Error text says *what*, *why*, *how to fix*. |

**Situational — add only when triggered**

| Trigger (look in input schema or `annotations`) | Add category |
|:------------------------------------------------|:-------------|
| `include` / `fields` / `expand` / `view` / `projection` parameter | Field selection: non-default value renders requested fields |
| Array return with `query` / `filter` inputs | Empty result: does response explain *why* (echo criteria, suggest broadening)? |
| Batch / bulk input (arrays of IDs, multi-item ops) | Partial success: mix valid + invalid items |
| `annotations.readOnlyHint: true` | Confirm no mutation happened |
| `annotations.idempotentHint: true` | Call twice with same input — safe? |
| Hits external API / live upstream | One call that exercises upstream; note rate-limit / timeout / transient-failure behavior |
| Chained with other tools (search → detail → act) | Run one representative chain end-to-end; does each step return the IDs/cursors the next needs? |
| `cursor` / `offset` / `limit` params | Pagination: second page, end-of-list |
| Tool declared an `errors: [...]` contract | Error contract (tool): trigger ≥1 declared failure mode. Verify `result.structuredContent.error.code` matches the contract entry, `result.structuredContent.error.data.reason` is the declared reason (only present when the handler threw an `McpError` — `ctx.fail` always does, plain `throw new Error(...)` does not), and `content[0].text` is actionable. Reasons declared but unreachable from any input are dead contract entries. |
| Resource declared an `errors: [...]` contract | Error contract (resource): trigger ≥1 declared failure mode by reading a URI that exercises it. Resources re-throw errors at the JSON-RPC level — verify `error.code` matches the contract entry and `error.data.reason` is the declared reason. (Resources don't use the `result.isError` envelope — they fail the request itself.) |
| Mutator (write/update/delete/append/patch verbs, or `destructiveHint: true`) | Mutator response observability: run an intentionally-ambiguous input (typo path, wrong ID, already-deleted target). Confirm the response carries enough state (pre/post values, state-change discriminator) for the agent to detect intent-effect divergence without re-fetching. |

**Resources.** Happy path, not-found URI (use a syntactically valid but non-existent ID — e.g., substitute a fake ID into the URI template), `list` if defined, pagination if used.
**Prompts.** Happy path, defaults omitted, skim message quality.

**Sampling for large servers.** If more than 15 tools, run the universal battery on all, but pick roughly 30–40% for situational testing. Weight toward: write-shaped tools, complex schemas, external deps. List which ones you skipped in the report.

**Auth & external state.**

- If a tool needs real API keys and they're not set, note `skipped — requires $VAR` and move on. Don't fabricate inputs.
- Tools that write to real external systems (third-party APIs, shared DBs): confirm with the user before running, or use a dry-run input if one exists.

### 5. Execute

Use `TaskCreate` — one task per definition. Mark complete as you go. Don't batch.

For each call, capture: input sent, response (trim huge payloads to files), whether `isError: true` appeared, anything surprising (slow response, parity drift, unhelpful text, crash).

When a call surprises you — slow, hangs, returns terse output, surfaces an unhelpful error — run `. /tmp/<project-name>-field-test-<ID>.sh && mcp_log <log>` to tail the server log. The pino startup banner, request handler errors, upstream API call traces, and rate-limit warnings all land in the per-server log (read via `mcp_log`) rather than coming back through `mcp_call`. Don't guess at runtime behavior from response text alone.

**Interpreting responses**

- Tool domain errors return `{result: {content: [...], isError: true}}` — they live in `result`, not `error`. Check `isError`, not the JSON-RPC error field.
- **Tool error code/reason** rides on `result.structuredContent.error.{code, message, data?.reason}` — inspect that, not just the text. `data` is only spread when the handler threw an `McpError` (or `ZodError`); plain `throw new Error(...)` won't populate `data.reason`. Use `ctx.fail`-thrown errors when the contract reason matters. The text in `result.content[0].text` mirrors the message and includes `Recovery: <hint>` when `data.recovery.hint` is present.
- **Resource errors** are JSON-RPC-level — they appear in the top-level `error.{code, data.reason}` field, not inside `result`. Resource handlers re-throw rather than producing an `isError` envelope.
- JSON-RPC `error` only appears for protocol issues (bad session, malformed envelope, unknown method).
- `mcp_call` already strips SSE framing. Pipe to `jq` for readability.

### 6. Tear down

```bash
. /tmp/<project-name>-field-test-<ID>.sh
mcp_stop <pid> <log>
rm -f /tmp/<project-name>-field-test-<ID>.sh
```

Kills the background server, removes the server log, then removes the helper script itself. Do this *before* writing the report so nothing leaks into the next session. If `mcp_stop` warns the PID is still alive after SIGKILL, note it in the report and proceed — don't block on a zombie process.

### 7. Report

Three sections. Tight. The user should be able to skim the summary, read details only for what matters, and act on numbered options.

#### Summary (1 paragraph)

One paragraph. How many definitions exercised, how many passed clean, how many have issues, and the single most important finding. No tables, no lists.

#### Findings

Only include definitions with issues. Group by severity. Each finding is 2–4 lines unless it genuinely needs more.

| Severity | Meaning |
|:---------|:--------|
| **bug** | Broken: crash, wrong output, `isError: true` on valid input, data loss, schema violation |
| **ux** | Works but degrades the user/LLM experience: vague description, leaky description (implementation details, meta-coaching, consumer-aware phrasing), unhelpful error text, missing `format()`, parity drift, annotation mismatches behavior |
| **nit** | Polish: phrasing, inconsistent tone, minor doc gaps |

Format:

```
**<tool_name> — <bug|ux|nit>**
Input: `<short input>` → <what happened>
Expected: <what should happen>
Fix: <one sentence>
```

#### Options

Numbered, actionable, cherry-pickable. Each item maps to a concrete change.

```
1. Fix empty-result message in `pubmed_search_articles` — echo criteria (finding #2)
2. Add `format()` to `pubmed_lookup_mesh` — currently returns raw JSON (finding #5)
3. Tighten `ids` description in `pubmed_fetch_articles` — silent on PMID vs DOI (finding #8)
```

End with:

> Pick by number (e.g. "do 1, 3, 5" or "expand on 2").

---

## Checklist

- [ ] Stdio boot check completed — `bun run rebuild && bun run start:stdio` shows clean startup (banner, expected counts, no errors)
- [ ] HTTP server built and started; real port parsed from log
- [ ] Session initialized; `notifications/initialized` sent
- [ ] Catalog surfaced and presented; descriptions audited for leaks (implementation details, meta-coaching, consumer-aware phrasing)
- [ ] Universal battery run on every definition (happy path, parity, input error)
- [ ] Situational categories applied only when triggered
- [ ] **If >15 tools:** sampled 30–40% for situational testing; skipped definitions listed in report
- [ ] **If a tool declared an `errors: [...]` contract:** ≥1 declared failure mode triggered; `result.structuredContent.error.code` and `data.reason` verified against the contract entry
- [ ] **If a resource declared an `errors: [...]` contract:** ≥1 declared failure mode triggered; top-level JSON-RPC `error.code` and `error.data.reason` verified against the contract entry
- [ ] External-state / auth-gated tools handled explicitly (run, skip, or confirm)
- [ ] Server stopped; server log and helper script removed
- [ ] Report: summary paragraph → grouped findings → numbered options

---
name: field-test
description: >
  Exercise tools, resources, and prompts against a live HTTP server via MCP JSON-RPC over curl. Starts the server, surfaces the catalog, runs real and adversarial inputs, and produces a tight report with concrete findings and numbered follow-up options. Use after adding or modifying definitions, or when the user asks to test, try out, or verify their MCP surface.
metadata:
  author: cyanheads
  version: "2.4"
  audience: external
  type: debug
---

## Context

Unit tests (`add-test` skill) verify handler logic with mocked context. Field testing exercises the real HTTP transport with real JSON-RPC: starts the server, calls `initialize`, surfaces the catalog, runs inputs, and checks what a client actually sees. It catches what unit tests miss — awkward input shapes, unhelpful errors, missing format output, drift between `structuredContent` and `content[]`, edge-case surprises.

**Actively call the tools. Don't read code and guess.**

### Transport coverage

This skill drives an HTTP server because curl + JSON-RPC is the most reliable harness for shell-based agents. The same handlers run on both transports — only the framing differs — so HTTP exercises the full functional surface.

**Stdio coverage is a boot check only.** Run `bun run rebuild && bun run start:stdio`, confirm the startup logs look clean (banner, expected tool/resource counts, no errors/warnings, no missing-config gripes), then kill it. Pino logs go to stderr in stdio mode (stdout is reserved for JSON-RPC), so they print straight to the terminal when you run interactively. No need to call tools over stdio — the HTTP pass already covered handler behavior.

---

## Steps

### 1. Start the server

Write the helper to `/tmp/mcp-field-test.sh` once, then source it in every subsequent Bash call. Helper keeps PID / URL / session id in a per-`$PWD` state file (`/tmp/mcp-field-test-<hash>.env`) so state survives across tool invocations and concurrent field-tests in different project trees don't clobber each other.

```bash
cat > /tmp/mcp-field-test.sh <<'HELPER_EOF'
#!/bin/bash
# Field-test helper: manage an MCP HTTP server + JSON-RPC session across shell calls.
# Surfaces failures aggressively — field test is for finding things that fail,
# so the helper auto-tails logs and prints HTTP status/body on errors instead
# of swallowing them.
#
# State and log paths are namespaced by an 8-char hash of $PWD so concurrent
# field-tests across different project trees don't clobber each other (see
# https://github.com/cyanheads/mcp-ts-core/issues/90).
PREFIX="/tmp/mcp-field-test-$(printf '%s' "$PWD" | shasum | cut -c1-8)"
STATE_FILE="${PREFIX}.env"
BUILD_LOG="${PREFIX}-build.log"
SERVER_LOG="${PREFIX}-server.log"
[ -f "$STATE_FILE" ] && . "$STATE_FILE"

mcp_start() {
  local dir="${1:-$PWD}"
  echo "building $dir ..."
  if ! (cd "$dir" && bun run rebuild) >"$BUILD_LOG" 2>&1; then
    echo "BUILD FAILED — last 30 lines of $BUILD_LOG:"
    tail -30 "$BUILD_LOG"
    return 1
  fi
  echo "starting server ..."
  (cd "$dir" && bun run start:http) >"$SERVER_LOG" 2>&1 &
  local pid=$!
  local line=""
  for _ in $(seq 1 40); do
    line=$(grep -Eo 'listening at http://[^" ]+/mcp' "$SERVER_LOG" | head -1)
    [ -n "$line" ] && break
    sleep 0.25
  done
  if [ -z "$line" ]; then
    echo "server failed to start within 10s — last 30 lines of $SERVER_LOG:"
    tail -30 "$SERVER_LOG"
    kill "$pid" 2>/dev/null
    return 1
  fi
  local url="${line#listening at }"
  local port; port=$(echo "$url" | sed -E 's|.*:([0-9]+)/.*|\1|')
  cat > "$STATE_FILE" <<EOF
export MCP_PID=$pid
export MCP_URL=$url
export MCP_PORT=$port
EOF
  . "$STATE_FILE"
  echo "ready pid=$pid url=$url"
}

mcp_init() {
  [ -z "$MCP_URL" ] && { echo "run mcp_start first"; return 1; }
  local hdr="${PREFIX}-init-headers.txt"
  local body_file="${PREFIX}-init-body.txt"
  local status
  status=$(curl -sS -D "$hdr" -o "$body_file" -w '%{http_code}' -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"field-test","version":"2.3"}}}')
  local sid; sid=$(grep -i '^mcp-session-id:' "$hdr" | awk '{print $2}' | tr -d '\r\n')
  if [ -z "$sid" ]; then
    echo "init failed — HTTP $status, no Mcp-Session-Id header returned"
    echo "--- response body ---"
    cat "$body_file"
    echo "--- response headers ---"
    cat "$hdr"
    return 1
  fi
  cat > "$STATE_FILE" <<EOF
export MCP_PID=$MCP_PID
export MCP_URL=$MCP_URL
export MCP_PORT=$MCP_PORT
export MCP_SID=$sid
EOF
  . "$STATE_FILE"
  curl -sS -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $sid" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
  echo "session=$sid (HTTP $status)"
}

# Usage: mcp_call METHOD [JSON_PARAMS]
# Prints the JSON-RPC response. SSE framing is stripped when present; on
# non-SSE responses the raw body is printed instead so plain-JSON error
# replies (HTTP 4xx/5xx) still surface. Pipe to `jq`.
mcp_call() {
  [ -z "$MCP_SID" ] && { echo "run mcp_init first"; return 1; }
  local method="$1"; local params="${2:-}"
  local body
  if [ -z "$params" ]; then
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s"}' "$RANDOM" "$method")
  else
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s","params":%s}' "$RANDOM" "$method" "$params")
  fi
  local resp_file="${PREFIX}-call-body.txt"
  local status
  status=$(curl -sS -o "$resp_file" -w '%{http_code}' -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $MCP_SID" \
    -d "$body")
  if [ "$status" -ge 400 ]; then
    echo "HTTP $status from $method — response:" >&2
    cat "$resp_file" >&2
    return 1
  fi
  local sse; sse=$(sed -n 's/^data: //p' "$resp_file")
  if [ -n "$sse" ]; then
    printf '%s\n' "$sse"
  else
    cat "$resp_file"
  fi
}

# Tail the server log. Useful when a call surprises you — pino startup banner,
# definition lint diagnostics, request handler errors, upstream calls, and
# rate-limit warnings live in the per-session server log.
# Usage: mcp_log [N]   (default: 50 lines)
mcp_log() {
  local n="${1:-50}"
  tail -n "$n" "$SERVER_LOG"
}

mcp_stop() {
  if [ -z "$MCP_PID" ]; then
    rm -f "$STATE_FILE"
    echo "no PID to stop"
    return 0
  fi
  kill "$MCP_PID" 2>/dev/null
  for _ in $(seq 1 12); do
    kill -0 "$MCP_PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$MCP_PID" 2>/dev/null; then
    echo "PID $MCP_PID didn't exit on SIGTERM — sending SIGKILL"
    kill -9 "$MCP_PID" 2>/dev/null
    sleep 0.5
  fi
  if kill -0 "$MCP_PID" 2>/dev/null; then
    echo "WARNING: PID $MCP_PID still alive after SIGKILL"
  else
    echo "stopped pid=$MCP_PID"
  fi
  rm -f "$STATE_FILE"
}
HELPER_EOF

. /tmp/mcp-field-test.sh
mcp_start /absolute/path/to/server   # replace with the target server
```

**Notes**

- `MCP_HTTP_PORT` is a *starting* port — the server auto-increments if taken. Helper parses the real URL from the log (`HTTP transport listening at ...`).
- If `bun run rebuild` fails, stop. Don't field-test broken code — fix the build first.
- If a server is already listening on the project's port (`lsof -i :<port>`), confirm with the user before killing it; it may be their own session.

### 2. Initialize the session

```bash
. /tmp/mcp-field-test.sh
mcp_init
```

Runs `initialize`, captures the session id, sends `notifications/initialized`.

### 3. Surface the catalog

```bash
. /tmp/mcp-field-test.sh
mcp_call tools/list     | jq '.result.tools[]     | {name, description, inputSchema, outputSchema}'
mcp_call resources/list | jq '.result.resources[] | {uri, name, mimeType}'
mcp_call prompts/list   | jq '.result.prompts[]   | {name, description, arguments}'
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

**Resources.** Happy path, not-found URI, `list` if defined, pagination if used.
**Prompts.** Happy path, defaults omitted, skim message quality.

**Sampling for large servers.** If more than 15 tools, run the universal battery on all, but pick roughly 30–40% for situational testing. Weight toward: write-shaped tools, complex schemas, external deps. List which ones you skipped in the report.

**Auth & external state.**

- If a tool needs real API keys and they're not set, note `skipped — requires $VAR` and move on. Don't fabricate inputs.
- Tools that write to real external systems (third-party APIs, shared DBs): confirm with the user before running, or use a dry-run input if one exists.

### 5. Execute

Use `TaskCreate` — one task per definition. Mark complete as you go. Don't batch.

For each call, capture: input sent, response (trim huge payloads to files), whether `isError: true` appeared, anything surprising (slow response, parity drift, unhelpful text, crash).

When a call surprises you — slow, hangs, returns terse output, surfaces an unhelpful error — run `. /tmp/mcp-field-test.sh && mcp_log` to tail the server log. The pino startup banner, request handler errors, upstream API call traces, and rate-limit warnings all land in the per-session server log (read via `mcp_log`) rather than coming back through `mcp_call`. Don't guess at runtime behavior from response text alone.

**Interpreting responses**

- Tool domain errors return `{result: {content: [...], isError: true}}` — they live in `result`, not `error`. Check `isError`, not the JSON-RPC error field.
- **Tool error code/reason** rides on `result.structuredContent.error.{code, message, data?.reason}` — inspect that, not just the text. `data` is only spread when the handler threw an `McpError` (or `ZodError`); plain `throw new Error(...)` won't populate `data.reason`. Use `ctx.fail`-thrown errors when the contract reason matters. The text in `result.content[0].text` mirrors the message and includes `Recovery: <hint>` when `data.recovery.hint` is present.
- **Resource errors** are JSON-RPC-level — they appear in the top-level `error.{code, data.reason}` field, not inside `result`. Resource handlers re-throw rather than producing an `isError` envelope.
- JSON-RPC `error` only appears for protocol issues (bad session, malformed envelope, unknown method).
- `mcp_call` already strips SSE framing. Pipe to `jq` for readability.

### 6. Tear down

```bash
. /tmp/mcp-field-test.sh
mcp_stop
```

Kills the background server, clears state. Do this *before* writing the report so nothing leaks into the next session.

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

- [ ] Server built and started; real port parsed from log
- [ ] Session initialized; `notifications/initialized` sent
- [ ] Catalog surfaced and presented; descriptions audited for leaks (implementation details, meta-coaching, consumer-aware phrasing)
- [ ] Universal battery run on every definition
- [ ] Situational categories applied only when triggered
- [ ] **If a tool declared an `errors: [...]` contract:** ≥1 declared failure mode triggered; `result.structuredContent.error.code` and `data.reason` verified against the contract entry
- [ ] **If a resource declared an `errors: [...]` contract:** ≥1 declared failure mode triggered; top-level JSON-RPC `error.code` and `error.data.reason` verified against the contract entry
- [ ] External-state / auth-gated tools handled explicitly (run, skip, or confirm)
- [ ] Server stopped; state file removed
- [ ] Report: summary paragraph → grouped findings → numbered options

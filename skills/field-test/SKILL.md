---
name: field-test
description: >
  Exercise tools, resources, and prompts against a live HTTP server via MCP JSON-RPC over curl. Starts the server, surfaces the catalog, runs real and adversarial inputs, and produces a tight report with concrete findings and numbered follow-up options. Use after adding or modifying definitions, or when the user asks to test, try out, or verify their MCP surface.
metadata:
  author: cyanheads
  version: "2.0"
  audience: external
  type: debug
---

## Context

Unit tests (`add-test` skill) verify handler logic with mocked context. Field testing exercises the real HTTP transport with real JSON-RPC: starts the server, calls `initialize`, surfaces the catalog, runs inputs, and checks what a client actually sees. It catches what unit tests miss — awkward input shapes, unhelpful errors, missing format output, drift between `structuredContent` and `content[]`, edge-case surprises.

**Actively call the tools. Don't read code and guess.**

---

## Steps

### 1. Start the server

Write the helper to `/tmp/mcp-field-test.sh` once, then source it in every subsequent Bash call. Helper keeps PID / URL / session id in `/tmp/mcp-field-test.env` so state survives across tool invocations.

```bash
cat > /tmp/mcp-field-test.sh <<'HELPER_EOF'
#!/bin/bash
# Field-test helper: manage an MCP HTTP server + JSON-RPC session across shell calls.
STATE_FILE="/tmp/mcp-field-test.env"
[ -f "$STATE_FILE" ] && . "$STATE_FILE"

mcp_start() {
  local dir="${1:-$PWD}"
  echo "building $dir ..."
  (cd "$dir" && bun run rebuild) >/tmp/mcp-build.log 2>&1 \
    || { echo "BUILD FAILED — see /tmp/mcp-build.log"; return 1; }
  echo "starting server ..."
  (cd "$dir" && bun run start:http) >/tmp/mcp-server.log 2>&1 &
  local pid=$!
  local line=""
  for _ in $(seq 1 40); do
    line=$(grep -Eo 'listening at http://[^" ]+/mcp' /tmp/mcp-server.log | head -1)
    [ -n "$line" ] && break
    sleep 0.25
  done
  if [ -z "$line" ]; then
    echo "server failed to start — see /tmp/mcp-server.log"
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
  local hdr="/tmp/mcp-init-headers.txt"
  curl -sS -D "$hdr" -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"field-test","version":"2.0"}}}' >/dev/null
  local sid; sid=$(grep -i '^mcp-session-id:' "$hdr" | awk '{print $2}' | tr -d '\r\n')
  [ -z "$sid" ] && { echo "no session id returned"; return 1; }
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
  echo "session=$sid"
}

# Usage: mcp_call METHOD [JSON_PARAMS]
# Prints the JSON-RPC response (SSE framing stripped). Pipe to `jq`.
mcp_call() {
  [ -z "$MCP_SID" ] && { echo "run mcp_init first"; return 1; }
  local method="$1"; local params="${2:-}"
  local body
  if [ -z "$params" ]; then
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s"}' "$RANDOM" "$method")
  else
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s","params":%s}' "$RANDOM" "$method" "$params")
  fi
  curl -sS -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $MCP_SID" \
    -d "$body" | sed -n 's/^data: //p'
}

mcp_stop() {
  [ -n "$MCP_PID" ] && kill "$MCP_PID" 2>/dev/null
  rm -f "$STATE_FILE"
  echo "stopped"
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

**Resources.** Happy path, not-found URI, `list` if defined, pagination if used.
**Prompts.** Happy path, defaults omitted, skim message quality.

**Sampling for large servers.** If more than 15 tools, run the universal battery on all, but pick roughly 30–40% for situational testing. Weight toward: write-shaped tools, complex schemas, external deps. List which ones you skipped in the report.

**Auth & external state.**

- If a tool needs real API keys and they're not set, note `skipped — requires $VAR` and move on. Don't fabricate inputs.
- Tools that write to real external systems (third-party APIs, shared DBs): confirm with the user before running, or use a dry-run input if one exists.

### 5. Execute

Use `TaskCreate` — one task per definition. Mark complete as you go. Don't batch.

For each call, capture: input sent, response (trim huge payloads to files), whether `isError: true` appeared, anything surprising (slow response, parity drift, unhelpful text, crash).

**Interpreting responses**

- Tool domain errors return `{result: {content: [...], isError: true}}` — they live in `result`, not `error`. Check `isError`, not the JSON-RPC error field.
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
- [ ] External-state / auth-gated tools handled explicitly (run, skip, or confirm)
- [ ] Server stopped; state file removed
- [ ] Report: summary paragraph → grouped findings → numbered options

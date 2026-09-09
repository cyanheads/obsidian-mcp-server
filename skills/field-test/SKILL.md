---
name: field-test
description: >
  Exercise tools, resources, and prompts against a live HTTP server via MCP JSON-RPC over curl. Starts the server, surfaces the catalog, runs real and adversarial inputs, measures every call (bytes, token estimate, wall-clock) and weighs the catalog, and produces a tight report with concrete findings and numbered follow-up options. Use after adding or modifying definitions, or when the user asks to test, try out, or verify their MCP surface.
metadata:
  author: cyanheads
  version: "2.12"
  audience: external
  type: debug
---

## Context

Unit tests (`add-test` skill) verify handler logic with mocked context. Field testing exercises the real HTTP transport with real JSON-RPC: starts the server, calls `initialize`, surfaces the catalog, runs inputs, and checks what a client actually sees. It catches what unit tests miss — awkward input shapes, unhelpful errors, missing format output, drift between `structuredContent` and `content[]`, edge-case surprises.

**Actively call the tools. Don't read code and guess.**

### Transport coverage

This skill drives an HTTP server because curl + JSON-RPC is the most reliable harness for shell-based agents. The same handlers run on both transports — only the framing differs — so HTTP exercises the full functional surface. Both HTTP session modes are covered: a durable `Mcp-Session-Id` session, and the sessionless initialization a `MCP_SESSION_MODE=stateless` server performs.

**Stdio coverage is a boot check only — run this before Step 1.** Run `bun run rebuild && bun run start:stdio`, confirm the startup logs look clean (banner, expected tool/resource counts, no errors/warnings, no missing-config gripes), then kill it. Pino logs go to stderr in stdio mode (stdout is reserved for JSON-RPC), so they print straight to the terminal when you run interactively. No need to call tools over stdio — the HTTP pass already covered handler behavior.

---

## Steps

### 1. Start the server

Generate a 10-character alphanumeric ID (e.g. `9DJ73-K103L`) and write the helper to `/tmp/<project-name>-field-test-<ID>.sh`. Use that exact path in every subsequent Bash call. **Two agents in the same project tree must pick different IDs** — that's what keeps their helper files, server logs, and call scratch from colliding.

The helper itself is **stateless** — every function takes the IDs it needs (server `pid`, `url`, `port`, MCP `sid`, server log path) as positional args. `mcp_start` prints them; the agent threads them through every later call. No env vars, no shared state files.

```bash
# Pick your ID — example below uses 9DJ73-K103L. Substitute your own.
# (Helper path also encodes the project name so /tmp/ stays grep-friendly.)
cat > /tmp/<project-name>-field-test-9DJ73-K103L.sh <<'HELPER_EOF'
#!/bin/bash
# Field-test helper: stateless wrappers around an MCP HTTP server + JSON-RPC
# session. Every function takes the IDs it needs as positional args — the agent
# threads pid/url/port/sid/log through each call rather than relying on a state
# file or env vars (the Bash tool wipes shell state between calls, and a
# pointer file would race the same way two agents race on shared state).
# See https://github.com/cyanheads/mcp-ts-core/issues/90, #144.
#
# Surfaces failures aggressively — field test is for finding things that fail,
# so the helper auto-tails logs and prints HTTP status/body on errors instead
# of swallowing them. It also measures: every mcp_call prints a one-line
# size/latency reading on stderr, and mcp_catalog_size weighs tools/list.

# Usage: mcp_start /path/to/server [startup-timeout-seconds]   (default: 30)
# Builds, starts the HTTP server in the background, waits for the listen line,
# and prints: ready pid=<n> url=<u> port=<n> log=<path>
# Capture these — every later helper takes them as args. Raise the timeout for
# servers that build a local index at boot.
mcp_start() {
  local dir="${1:-$PWD}"
  local timeout="${2:-30}"
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
  local waited=0
  while [ "$waited" -lt "$((timeout * 4))" ]; do
    line=$(grep -Eo 'listening at http://[^" ]+/mcp' "$server_log" | head -1)
    [ -n "$line" ] && break
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "server exited during startup — last 30 lines of $server_log:" >&2
      tail -30 "$server_log" >&2
      rm -f "$server_log"
      return 1
    fi
    sleep 0.25
    waited=$((waited + 1))
  done
  if [ -z "$line" ]; then
    echo "server failed to start within ${timeout}s — last 30 lines of $server_log:" >&2
    tail -30 "$server_log" >&2
    kill "$pid" 2>/dev/null
    rm -f "$server_log"
    return 1
  fi
  local url="${line#listening at }"
  local port; port=$(echo "$url" | sed -E 's|.*:([0-9]+)/.*|\1|')
  echo "ready pid=$pid url=$url port=$port log=$server_log"
}

# Internal: report a failed initialize with the raw exchange, then clean up.
_mcp_init_fail() {
  local msg="$1"; local body_file="$2"; local hdr="$3"
  echo "init failed — $msg" >&2
  echo "--- response body ---" >&2
  if [ -s "$body_file" ]; then cat "$body_file" >&2; else echo "(empty)" >&2; fi
  echo "--- response headers ---" >&2
  if [ -s "$hdr" ]; then cat "$hdr" >&2; else echo "(none)" >&2; fi
  rm -f "$hdr" "$body_file"
  return 1
}

# Usage: mcp_init <url>
# Runs `initialize`, sends `notifications/initialized`, prints:
#   ready sid=<id-or-empty> protocol=<negotiated-version> requested=<want> instructions=<bytes>B (HTTP <code>)
# `instructions=` is the byte size of the server's `instructions` string — it
# loads into every client session alongside tools/list, so it is the other half
# of the per-session context tax mcp_catalog_size weighs.
# The initialize *result* is what decides success — a session ID is optional.
# A server started with MCP_SESSION_MODE=stateless mints none, and the session
# header is then omitted from every later request. Capture BOTH `sid` and
# `protocol`: mcp_call takes the protocol as its 5th arg, which is what carries
# the negotiated revision when there is no session to carry it.
# A negotiated version older than the requested one means the server capped it
# — note that in the report; you are then testing an older protocol than a
# current client would use.
mcp_init() {
  local url="$1"
  [ -z "$url" ] && { echo "usage: mcp_init <url>" >&2; return 1; }
  local want="${MCP_FIELD_TEST_PROTOCOL:-2025-11-25}"
  local hdr; hdr=$(mktemp)
  local body_file; body_file=$(mktemp)
  local code curl_rc
  code=$(curl -sS -D "$hdr" -o "$body_file" -w '%{http_code}' -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$want\",\"capabilities\":{},\"clientInfo\":{\"name\":\"field-test\",\"version\":\"1.0.0\"}}}")
  curl_rc=$?
  if [ "$curl_rc" -ne 0 ] || [ -z "$code" ] || [ "$code" = "000" ]; then
    _mcp_init_fail "transport failure — curl exit $curl_rc, http_code '${code:-none}'; nothing listening at $url" "$body_file" "$hdr"
    return 1
  fi
  [ "$code" -ge 400 ] && { _mcp_init_fail "HTTP $code" "$body_file" "$hdr"; return 1; }
  # Unwrap SSE framing when present; a plain JSON body is used as-is.
  local payload; payload=$(sed -n 's/^data: //p' "$body_file")
  [ -z "$payload" ] && payload=$(cat "$body_file")
  local reply; reply=$(printf '%s\n' "$payload" | grep -E '"(result|error)"' | head -1)
  [ -z "$reply" ] && reply="$payload"
  if printf '%s' "$reply" | grep -q '"error"'; then
    _mcp_init_fail "server returned a JSON-RPC error" "$body_file" "$hdr"
    return 1
  fi
  if ! printf '%s' "$reply" | grep -q '"result"'; then
    _mcp_init_fail "HTTP $code but no JSON-RPC result in the body" "$body_file" "$hdr"
    return 1
  fi
  local got; got=$(printf '%s' "$reply" | grep -o '"protocolVersion":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$got" ]; then
    _mcp_init_fail "initialize result declares no protocolVersion" "$body_file" "$hdr"
    return 1
  fi
  local instr; instr=$(printf '%s' "$reply" | jq -r '.result.instructions // "" | utf8bytelength' 2>/dev/null || echo 0)
  local sid; sid=$(grep -i '^mcp-session-id:' "$hdr" | awk '{print $2}' | tr -d '\r\n')
  local init_headers=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: $got")
  [ -n "$sid" ] && init_headers+=(-H "Mcp-Session-Id: $sid")
  curl -sS -X POST "$url" "${init_headers[@]}" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
  rm -f "$hdr" "$body_file"
  echo "ready sid=$sid protocol=$got requested=$want instructions=${instr}B (HTTP $code)"
}

# Internal: one stderr line per call — reply bytes, the content/structured
# split, a token estimate, wall-clock. Bytes are the reply as delivered (SSE
# framing stripped). `content` is every text block's bytes, `structured` is
# structuredContent serialized. The token figure is bytes/4 — an estimate, not
# a tokenizer. Wall-clock is curl's time_total for the whole exchange.
_mcp_measure() {
  local method="$1"; local params="$2"; local reply="$3"; local code="$4"; local secs="$5"
  local total; total=$(printf '%s' "$reply" | wc -c | tr -d ' ')
  local ms; ms=$(awk -v s="$secs" 'BEGIN { printf "%d", s * 1000 }')
  local label="$method"
  local split=""
  case "$method" in
    tools/call)
      local name; name=$(printf '%s' "$params" | jq -r '.name // empty' 2>/dev/null)
      [ -n "$name" ] && label="$method $name"
      split=$(printf '%s' "$reply" | jq -r '
        (.result // {}) as $r
        | ([$r.content[]? | select(.type == "text") | .text] | join("") | utf8bytelength) as $c
        | (if $r.structuredContent == null then "none" else ($r.structuredContent | tojson | utf8bytelength | tostring) end) as $s
        | "content \($c) · structured \($s)"' 2>/dev/null)
      ;;
    resources/read)
      split=$(printf '%s' "$reply" | jq -r '
        "text \([.result.contents[]? | .text // ""] | join("") | utf8bytelength)"' 2>/dev/null)
      ;;
  esac
  local tok; tok=$(awk -v b="$total" 'BEGIN { if (b >= 1000) printf "~%.1fk", b / 4000; else printf "~%d", b / 4 }')
  echo "⏱ $label · HTTP $code · ${total} B${split:+ ($split)} · $tok tok · ${ms} ms" >&2
}

# Usage: mcp_call <url> <sid> <method> [JSON_PARAMS] [protocol]
# Prints the JSON-RPC response. SSE framing is stripped when present, and only
# the reply is emitted (a single POST can also carry progress notifications, so
# emitting every event would break `| jq .result`). A transport failure or an
# HTTP >= 400 prints the details and returns non-zero — it never returns 0 with
# empty output. Pipe to `jq`.
# Every call also prints one measurement line on stderr, e.g.
#   ⏱ tools/call gbif_search_species · HTTP 200 · 18412 B (content 9100 · structured 8900) · ~4.6k tok · 812 ms
# Read it on every call — it is the size/latency evidence the report cites.
# `sid` may be empty ('') for a stateless server; the session header is then
# omitted. Pass the `protocol` mcp_init printed as the 5th arg — with no
# session carrying the negotiation, MCP-Protocol-Version is what tells the
# server which revision the request speaks.
mcp_call() {
  local url="$1"; local sid="$2"; local method="$3"; local params="${4:-}"; local protocol="${5:-}"
  [ -z "$url" ] || [ -z "$method" ] && { echo "usage: mcp_call <url> <sid> <method> [params] [protocol]" >&2; return 1; }
  local body
  if [ -z "$params" ]; then
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s"}' "$RANDOM" "$method")
  else
    body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"%s","params":%s}' "$RANDOM" "$method" "$params")
  fi
  local resp_file; resp_file=$(mktemp)
  local stats code secs curl_rc
  local headers=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
  [ -n "$sid" ] && headers+=(-H "Mcp-Session-Id: $sid")
  [ -n "$protocol" ] && headers+=(-H "MCP-Protocol-Version: $protocol")
  stats=$(curl -sS -o "$resp_file" -w '%{http_code} %{time_total}' -X POST "$url" "${headers[@]}" -d "$body")
  curl_rc=$?
  read -r code secs <<< "$stats"
  if [ "$curl_rc" -ne 0 ] || [ -z "$code" ] || [ "$code" = "000" ]; then
    echo "TRANSPORT FAILURE calling $method — curl exit $curl_rc, http_code '${code:-none}'." >&2
    echo "Server not reachable at $url (check it is still running: mcp_log <log>)." >&2
    rm -f "$resp_file"
    return 1
  fi
  if [ "$code" -ge 400 ]; then
    echo "HTTP $code from $method — response:" >&2
    cat "$resp_file" >&2
    rm -f "$resp_file"
    return 1
  fi
  local reply
  local sse; sse=$(sed -n 's/^data: //p' "$resp_file")
  if [ -n "$sse" ]; then
    reply=$(printf '%s\n' "$sse" | grep -E '"(result|error)"')
    reply="${reply:-$sse}"
  else
    reply=$(cat "$resp_file")
  fi
  rm -f "$resp_file"
  _mcp_measure "$method" "$params" "$reply" "$code" "$secs"
  printf '%s\n' "$reply"
}

# Usage: mcp_catalog_size <url> <sid> [protocol]
# Weighs the catalog: the bytes of the tools/list reply — what every client
# loads into context per session before a single call — then each tool's
# serialized entry, largest first, split into description / inputSchema /
# outputSchema so the row says WHERE the weight is. A fat outputSchema costs as
# much as a fat description and is the usual surprise. Prints:
#   catalog: 12 tools · 48210 B · ~12.1k tok
#   <bytes>  <~tok>  <name>  desc <b> · input <b> · output <b|none>   (one row per tool)
mcp_catalog_size() {
  local url="$1"; local sid="$2"; local protocol="${3:-}"
  [ -z "$url" ] && { echo "usage: mcp_catalog_size <url> <sid> [protocol]" >&2; return 1; }
  local reply; reply=$(mcp_call "$url" "$sid" tools/list '' "$protocol") || return 1
  printf '%s' "$reply" | jq -r '
    def tok: if . >= 1000 then "~\(. / 4000 * 10 | round / 10)k" else "~\(. / 4 | floor)" end;
    def bytes_or_none: if . == null then "none" else (tojson | utf8bytelength | tostring) end;
    (.result.tools // []) as $t
    | (. | tojson | utf8bytelength) as $total
    | "catalog: \($t | length) tools · \($total) B · \($total | tok) tok",
      ($t
       | map({name, b: (tojson | utf8bytelength),
              d: ((.description // "") | utf8bytelength),
              i: (.inputSchema | bytes_or_none),
              o: (.outputSchema | bytes_or_none)})
       | sort_by(-.b) | .[]
       | "\(.b)\t\(.b | tok)\t\(.name)\tdesc \(.d) · input \(.i) · output \(.o)")'
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

# Usage: mcp_stop <pid> [server-log-path] [port]
# Kills the background server and the `bun run` child that actually holds the
# port (SIGKILL is not forwarded, so the child must be signalled directly or it
# survives as an orphaned listener). Pass the port from mcp_start to have the
# stop confirmed against the socket rather than against the wrapper PID.
# Removes the server log if a path is given.
mcp_stop() {
  local pid="$1"; local log="${2:-}"; local port="${3:-}"
  [ -z "$pid" ] && { echo "usage: mcp_stop <pid> [log-path] [port]" >&2; return 1; }
  local kids; kids=$(pgrep -P "$pid" 2>/dev/null)
  kill "$pid" $kids 2>/dev/null
  for _ in $(seq 1 12); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "PID $pid didn't exit on SIGTERM — sending SIGKILL"
    kill -9 "$pid" $kids 2>/dev/null
    sleep 0.5
  fi
  local held=""
  [ -n "$port" ] && held=$(lsof -ti tcp:"$port" 2>/dev/null | tr '\n' ' ')
  if [ -n "$held" ]; then
    echo "WARNING: port $port still held by PID(s) $held after stopping $pid — kill those before re-running"
  elif kill -0 "$pid" 2>/dev/null; then
    echo "WARNING: PID $pid still alive after SIGKILL"
  else
    echo "stopped pid=$pid${port:+ (port $port free)}"
  fi
  [ -n "$log" ] && rm -f "$log"
  return 0
}
HELPER_EOF

. /tmp/<project-name>-field-test-9DJ73-K103L.sh
mcp_start /absolute/path/to/server   # replace with the target server
```

Capture `pid`, `url`, `port`, `log` from the `mcp_start` output — every later call takes them as positional args. Two agents running concurrently in the same project tree each pick their own ID, so their helper paths, server logs, and call scratch never share a name.

**Notes**

- `MCP_HTTP_PORT` is a *starting* port — the server auto-increments if taken. Helper parses the real URL from the log (`HTTP transport listening at ...`).
- If `bun run rebuild` fails, stop. Don't field-test broken code — fix the build first.
- Startup wait defaults to 30s. A server that builds or loads a local index at boot can need more — pass a second arg (`mcp_start /path 90`) rather than reading the timeout as a real startup failure.
- `pid` is the `bun run` wrapper; the process that actually holds the port is its child. `mcp_stop` signals both — that's why it takes the port.
- If a server is already listening on the project's port (`lsof -i :<port>`), confirm with the user before killing it; it may be their own session. If the user isn't available to confirm, abort the field test and surface the port conflict in your response.

### 2. Initialize the session

```bash
. /tmp/<project-name>-field-test-<ID>.sh
mcp_init <url-from-mcp_start>
```

Runs `initialize`, sends `notifications/initialized`, prints the `sid` and `protocol` to capture for `mcp_call`, plus `instructions=` — the byte size of the server's `instructions` string, which every client loads per session alongside the catalog (record it with the catalog total in Step 3). Success is decided by the initialize *result*, so a transport failure, a non-2xx status, a JSON-RPC error, a malformed body, or a result with no `protocolVersion` all fail loudly with the raw exchange.

The helper requests the newest `initialize`-negotiated revision the SDK supports (`2025-11-25`). **If `protocol=` comes back older than `requested=`, the server capped it** — every call after that exercises an older protocol than a current client would negotiate. Note it as a `bug` finding and check the pinned `@modelcontextprotocol/server` version; don't quietly test the downgraded surface. To deliberately test an older version, set `MCP_FIELD_TEST_PROTOCOL`.

**`sid=` may come back empty — that is a pass, not a failure.** Under `MCP_SESSION_MODE=stateless` the server mints no `Mcp-Session-Id`, and the helper then omits the session header from every later request. Thread the empty value through positionally and pass the negotiated protocol, which is what identifies the revision when no session carries it:

```bash
mcp_call <url> '' tools/list '' <protocol-from-mcp_init>
```

To exercise both session modes, start the server twice — once with the project's default, once with `MCP_SESSION_MODE=stateless` — and run the same calls against each.

Both modes exercise the **2025-era arm**: `initialize` negotiates the revision, and the session (when there is one) carries it. The [2026-07-28 revision](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) is a different thing from a sessionless 2025 handshake — it does not initialize at all, and is selected per request by the `io.modelcontextprotocol/protocolVersion` key in the request's own `_meta` envelope. This helper does not reach it; exercise the per-request leg from a real 2026-era client or an integration test.

### 3. Surface the catalog

```bash
. /tmp/<project-name>-field-test-<ID>.sh
mcp_call <url> <sid> tools/list     | jq '.result.tools[]     | {name, description, inputSchema, outputSchema}'
mcp_call <url> <sid> resources/list | jq '.result.resources[] | {uri, name, mimeType}'
mcp_call <url> <sid> prompts/list   | jq '.result.prompts[]   | {name, description, arguments}'
mcp_catalog_size <url> <sid> <protocol>
```

**Weigh the catalog.** `mcp_catalog_size` prints the `tools/list` bytes — the context every client loads per session before a single call — and each tool's entry, largest first, split into description / `inputSchema` / `outputSchema`. Record the total alongside the `instructions=` bytes from Step 2; together they are the per-session tax. The split says where a heavy tool's weight lives: an `outputSchema` narrating every field of a 60-field record is the common surprise, an over-long description the obvious one. Hand the outliers to `tool-defs-analysis` (its length-outliers pass) rather than trimming blind.

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
| `structuredContent` ↔ `content[]` parity | Dump the whole array (`jq '.result.content'`) and check every `structuredContent` field is surfaced *somewhere* in it — enrichment lands in its own trailing block, not in `content[0]`. Parity gap = client-specific blindness. |
| Input error | One invalid input (wrong type or missing required). Error text says *what*, *why*, *how to fix*. |
| Size & latency | Read the `⏱` line `mcp_call` prints on every call. A happy-path response over **24,000 B** (the framework's `DEFAULT_OUTLINE_BUDGET_BYTES` — the line at which it would outline a document itself) with no truncation disclosure and no retrieval path (cursor, offset, `sections`, canvas handle) is a `ux` finding: the agent pays the whole payload with no way to ask for less. `content` ≈ `structured` with the text starting `{` means the JSON is on the wire twice — a missing `format()`. A call over ~5 s on a happy-path input is worth a `mcp_log` look before calling it upstream latency. |

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
| Output can be truncated, capped, or spilled (`maxLength`-style caps, outline-on-overflow, canvas/dataframe spill, "showing N of M") | Truncation retrievability: force a response that truncates, then confirm the response both *discloses* the truncation and hands back the means to reach the rest — a cursor, an offset, a document/section selector, a canvas handle. Truncated data with no retrieval path is a `bug`, not a `nit`. |
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

For each call, capture: input sent, the `⏱` line (bytes, split, ms), response (trim huge payloads to files), whether `isError: true` appeared, anything surprising (slow response, parity drift, unhelpful text, crash).

When a call surprises you — slow, hangs, returns terse output, surfaces an unhelpful error — run `. /tmp/<project-name>-field-test-<ID>.sh && mcp_log <log>` to tail the server log. The pino startup banner, request handler errors, upstream API call traces, and rate-limit warnings all land in the per-server log (read via `mcp_log`) rather than coming back through `mcp_call`. Don't guess at runtime behavior from response text alone.

**Interpreting responses**

- **`content[]` is an array of blocks — read all of them, never just `content[0]`.** A success result is assembled as `[...ctx.content media blocks, ...the format()/JSON domain render, ...the enrichment trailer]`. Everything the handler put on `ctx.enrich` — empty-result notices, totals, query echoes, truncation disclosure — renders in that trailer, a **separate trailing block**, not inside the `format()` block. Quoting `content[0].text` and reporting those fields as absent from `content[]` is a false parity gap; the suggested fix (render them in `format()` too) would double-render them. Dump `.result.content` in full before claiming drift.
- Tool domain errors return `{result: {content: [...], isError: true}}` — they live in `result`, not `error`. Check `isError`, not the JSON-RPC error field.
- **Tool error code/reason** rides on `result.structuredContent.error.{code, message, data?.reason}` — inspect that, not just the text. `data` is only spread when the handler threw an `McpError` (or `ZodError`); plain `throw new Error(...)` won't populate `data.reason`. Use `ctx.fail`-thrown errors when the contract reason matters. The text in `result.content[0].text` mirrors the message and includes `Recovery: <hint>` when `data.recovery.hint` is present.
- **Resource errors** are JSON-RPC-level — they appear in the top-level `error.{code, data.reason}` field, not inside `result`. Resource handlers re-throw rather than producing an `isError` envelope.
- JSON-RPC `error` only appears for protocol issues (bad session, malformed envelope, unknown method).
- `mcp_call` already strips SSE framing. Pipe to `jq` for readability.

### 6. Tear down

```bash
. /tmp/<project-name>-field-test-<ID>.sh
mcp_stop <pid> <log> <port>
rm -f /tmp/<project-name>-field-test-<ID>.sh
```

Kills the background server and its port-holding child, removes the server log, then removes the helper script itself. Do this *before* writing the report so nothing leaks into the next session. Pass the `port` — it's what turns "the wrapper PID is gone" into "the socket is actually free." If `mcp_stop` warns the port is still held or the PID survived SIGKILL, note it in the report and proceed — don't block on a zombie process, but do say which PID to kill.

### 7. Report

Four sections. Tight. The user should be able to skim the summary, scan the numbers, read details only for what matters, and act on numbered options.

#### Summary (1 paragraph)

One paragraph. How many definitions exercised, how many passed clean, how many have issues, and the single most important finding. No tables, no lists.

#### Size & latency

Per-session tax on its own line (`instructions` bytes + catalog bytes, with the heaviest tool named), then one row per tool exercised, sorted by happy-path bytes descending: tool · bytes · ~tok · ms. Over 15 tools, keep every row over 24,000 B plus the three slowest and fold the rest into one line ("N more under budget, median X B"). Numbers only — what they mean goes in Findings.

#### Findings

Only include definitions with issues. Group by severity. Each finding is 2–4 lines unless it genuinely needs more. A parity finding cites the full `content[]` dump as its evidence — a quote from one index doesn't establish drift.

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
- [ ] Session initialized (a stateless server returns an empty `sid` — still a pass); `notifications/initialized` sent; negotiated protocol version matches the requested one (a downgrade is a finding)
- [ ] Catalog surfaced and presented; descriptions audited for leaks (implementation details, meta-coaching, consumer-aware phrasing)
- [ ] Catalog weighed (`mcp_catalog_size`); total + `instructions=` bytes recorded for the report
- [ ] Every call's `⏱` line read; any happy-path response over 24,000 B with no disclosure + retrieval path filed as `ux`
- [ ] Universal battery run on every definition (happy path, parity against the full `content[]` array, input error)
- [ ] Situational categories applied only when triggered
- [ ] **If >15 tools:** sampled 30–40% for situational testing; skipped definitions listed in report
- [ ] **If a tool declared an `errors: [...]` contract:** ≥1 declared failure mode triggered; `result.structuredContent.error.code` and `data.reason` verified against the contract entry
- [ ] **If a resource declared an `errors: [...]` contract:** ≥1 declared failure mode triggered; top-level JSON-RPC `error.code` and `error.data.reason` verified against the contract entry
- [ ] **If any tool truncates, caps, or spills its output:** truncation forced; disclosure + a retrieval path (cursor, offset, selector, canvas handle) verified
- [ ] External-state / auth-gated tools handled explicitly (run, skip, or confirm)
- [ ] Server stopped (port confirmed free); server log and helper script removed
- [ ] Report: summary paragraph → size & latency table → grouped findings → numbered options

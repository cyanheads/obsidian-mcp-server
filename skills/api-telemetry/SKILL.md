---
name: api-telemetry
description: >
  Catalog of OpenTelemetry instrumentation built into framework `@cyanheads/mcp-ts-core` — spans, metrics, completion logs, env config, runtime caveats, custom instrumentation patterns, and cardinality rules. Use when enabling OTel export, adding custom spans or metrics in services, debugging missing telemetry, looking up attribute names, or deciding what's safe to put on a metric attribute vs. a span.
metadata:
  author: cyanheads
  version: "1.7"
  audience: external
  type: reference
---

## Overview

The framework auto-instruments every tool, resource, prompt, storage, LLM, speech, and graph call — each gets its own span and the standard counters/histograms. HTTP server requests pick up spans from `HttpInstrumentation` (all Node.js HTTP traffic, skips `/healthz`) plus `httpInstrumentationMiddleware` from `@hono/otel` on the MCP HTTP endpoint when installed (optional Tier 3 peer — `bun add @hono/otel`). On Bun, `HttpInstrumentation` silently no-ops and `@hono/otel` is the only HTTP coverage. Auth checks and session lifecycle are tracked as **metrics only** — auth decorates the active HTTP span with attributes, sessions emit counters.

`requestId`, `traceId`, and `tenantId` correlate automatically across spans, metrics, and logs. Pino logs get `trace_id`/`span_id` injected when a span is active.

A handler's `ctx.traceId` / `ctx.spanId` name the execution span it runs in — `tool_execution:<name>` or `resource_read:<name>` — not the enclosing HTTP request span. Under HTTP the trace ID is the request's, so handler logs join to the request; the span ID is the child execution's, so they join to that span's attributes and duration. On stdio, where no transport span exists, both are still populated from the execution span the framework opens. Both are `undefined` when telemetry is disabled: the non-recording span a disabled pipeline produces carries all-zero IDs, and the framework reports no correlation rather than IDs that correlate to nothing.

For the helper API surface (`withSpan`, `createCounter`, `createHistogram`, `buildTraceparent`, etc.) — see the `api-utils` skill, `Telemetry` section. This skill is the catalog of **what** is emitted; that one is the reference for **how** to emit your own.

---

## Enabling export

OTel is **off by default**. `OTEL_ENABLED=true` alone does nothing — you also need an OTLP endpoint. Without an endpoint the SDK is configured but nothing leaves the process.

| Env var | Default | Purpose |
|:--------|:--------|:--------|
| `OTEL_ENABLED` | `false` | Master switch. Must be `true` to start the SDK. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — | OTLP/HTTP traces endpoint (e.g. `http://localhost:4318/v1/traces`). |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | — | OTLP/HTTP metrics endpoint (e.g. `http://localhost:4318/v1/metrics`). |
| `OTEL_SERVICE_NAME` | `createApp` `name` → `package.json` `name` | `service.name` resource attribute. Seeded from `createApp({ name })` when unset; an env value wins. |
| `OTEL_SERVICE_VERSION` | `package.json` `version` | `service.version` resource attribute. |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | Trace sampling ratio (0–1) for `TraceIdRatioBasedSampler`. |
| `OTEL_LOG_LEVEL` | `INFO` | OTel diagnostic logger level (`NONE`/`ERROR`/`WARN`/`INFO`/`DEBUG`/`VERBOSE`/`ALL`). |

Metrics push via `PeriodicExportingMetricReader` every **15 seconds**. Traces use `BatchSpanProcessor`.

---

## Runtime support

| Runtime | Behavior |
|:--------|:---------|
| **Node.js / Bun** | Full `NodeSDK`. Auto-instrumentations: HTTP server (Node http hooks; skips `/healthz`), Pino logs (`trace_id`/`span_id` injection). On the HTTP transport, when OTel is enabled and `@hono/otel` is installed, `httpInstrumentationMiddleware` is also wired onto the MCP endpoint — fills the gap on Bun, where the Node http auto-instrumentation silently no-ops. Manual spans, custom metrics, and OTLP export work on Bun regardless. |
| **Cloudflare Workers / V8 isolates** | `NodeSDK` is unavailable. SDK init no-ops silently. `createCounter`/`createHistogram`/`withSpan` calls still work via the global OTel API but produce no output unless you wire a Worker-compatible exporter and `ctx.waitUntil()` for flush. |

Cloud platform detection auto-populates resource attributes:

| Detected | Attributes set |
|:---------|:--------------|
| Cloudflare Workers | `cloud.provider=cloudflare`, `cloud.platform=cloudflare_workers` |
| AWS Lambda | `cloud.provider=aws`, `cloud.platform=aws_lambda`, `cloud.region` from `AWS_REGION` |
| GCP Cloud Run / Functions | `cloud.provider=gcp`, `cloud.platform=gcp_cloud_run` (or `gcp_cloud_functions`), `cloud.region` from `GCP_REGION` |
| All | `deployment.environment.name` from `config.environment` |

---

## Flush at exit

Spans batch and metrics push on a 15-second cycle, so a process that exits between cycles takes its telemetry with it. `ServerHandle.shutdown()` is the drain: it stops the transport, then force-flushes traces and metrics through the OTLP exporters and closes the logger.

| Trigger | Path |
|:--------|:-----|
| `SIGTERM` / `SIGINT` | `shutdown(signal)` |
| `uncaughtException` / `unhandledRejection` | `shutdown(signal)`, then `process.exit(1)` |
| stdin EOF, stdio transport | `shutdown('STDIN_EOF')`, then `process.exit(0)` |
| `ServerHandle.shutdown()` called directly | the same drain, no exit |

**Stdin EOF is a disconnect.** A stdio host closing the pipe runs the cleanup a signal runs, exactly once — the shutdown detaches the signal handlers and the EOF watcher as it starts, so neither can re-enter it — and the process then exits explicitly instead of waiting to run out of handles. Two things follow: the OTLP export leaves the process, and a `setInterval` a service registered without `unref()` can no longer keep the server resident after its client is gone. The path writes nothing to stdout.

**The drain is bounded.** Shutdown-on-exit races a 10-second backstop, so a cleanup step that never settles still terminates the process. The logger bounds its own flush separately, per pino instance: a completing callback is awaited in full, and a runtime whose callback never arrives releases shutdown rather than hanging it.

Workers has no `ServerHandle` and no `NodeSDK` — flush whatever exporter you wired there yourself, via `ctx.waitUntil()`.

---

## Spans

Every handler call gets a span. Nested operations (storage, graph, LLM) become child spans on the same trace. All spans carry `code.function.name` and `code.namespace` for code-attribution. Errors are recorded via `span.recordException()` and `SpanStatusCode.ERROR`; `McpError` codes surface as the `*.error_code` attribute.

| Span name | Source | Key attributes |
|:----------|:-------|:---------------|
| `tool_execution:<tool>` | every tool call | `mcp.tool.input_bytes`, `mcp.tool.output_bytes`, `mcp.tool.duration_ms`, `mcp.tool.success`, `mcp.tool.error_code`, `mcp.tool.input_required`, `mcp.tool.partial_success`, `mcp.tool.batch.{succeeded,failed}_count` |
| `resource_read:<resource>` | every resource handler | `mcp.resource.uri`, `mcp.resource.mime_type`, `mcp.resource.size_bytes`, `mcp.resource.duration_ms`, `mcp.resource.success`, `mcp.resource.error_code`, `mcp.resource.input_required` |
| `prompt_generation:<prompt>` | every prompt handler | `mcp.prompt.input_bytes`, `mcp.prompt.output_bytes`, `mcp.prompt.message_count`, `mcp.prompt.duration_ms`, `mcp.prompt.success`, `mcp.prompt.error_code`, `mcp.prompt.input_required` |
| `storage:<op>` | `StorageService` (every call) | `mcp.storage.operation`, `mcp.storage.duration_ms`, `mcp.storage.success`, `mcp.storage.key_count` (batch ops) |
| `graph:<op>` | `GraphService` (every call) | `mcp.graph.operation`, `mcp.graph.duration_ms`, `mcp.graph.success` |
| `gen_ai.chat_completion` | OpenRouter LLM provider | `gen_ai.system=openrouter`, `gen_ai.request.model`, `gen_ai.request.{max_tokens,temperature,top_p,streaming}`, `gen_ai.response.model`, `gen_ai.usage.{input,output,total}_tokens` |
| `speech:tts` | ElevenLabs provider | `mcp.speech.provider`, `mcp.speech.operation`, `mcp.speech.input_bytes`, `mcp.speech.output_bytes`, `mcp.speech.duration_ms`, `mcp.speech.success` |
| `speech:stt` | Whisper provider | same as `speech:tts` |

A handler that ends its round with `ctx.requestInput(...)` closes its span `OK` with `mcp.*.input_required` set — no recorded exception, no error-counter increment. Multi-round-trip input is protocol control flow, so it never inflates error rates; split on that attribute to tell an incomplete round from a completed call.

### The measured region

A tool or resource call is measured from the start of the handler through the response pipeline that follows it: output-schema validation, `format()`, the enrichment merge, and the trailer render for tools; output-schema validation and `format()` for resources. Telemetry therefore records the outcome the client sees — a failure in any of those is an ERROR span, `success=false` counters, an error-counter increment, and `isSuccess: false` in the completion log, matching the `isError: true` the caller receives. Prompt generation has no post-handler pipeline, so its region is the generate function alone.

Two consequences worth knowing when reading a dashboard:

| Signal | What it covers |
|:-------|:---------------|
| `mcp.tool.duration` / `mcp.resource.duration` | The handler **plus** validation, formatting, and the enrichment merge — time to produce the result, not time spent in handler code. An expensive `format()` shows up here. |
| `mcp.tool.output_bytes` / `mcp.resource.output_bytes` | The handler's returned domain value, not the assembled result. `content[]` re-renders the data the structured payload already carries, so measuring the assembly would double-count it. Nothing is recorded for a call that fails after the handler. |

`mcp.tool.partial_success` and the `mcp.tool.batch.*` counts read the same domain value, so a batch envelope (`{ succeeded, failed }`) is still detected once the result has been assembled around it.

Trace context propagates across boundaries via W3C `traceparent` headers. See `api-utils` → `telemetry/trace` for `withSpan`, `buildTraceparent`, `extractTraceparent`, `createContextWithParentTrace`, `injectCurrentContextInto`, `runInContext` signatures.

---

## Metrics

All custom metrics are namespaced `mcp.*` (or `process.*` / `http.client.*` where standard semconv applies). Lazy-initialized on first emission; tool, resource, prompt, `http.client.request.duration`, heartbeat, session, auth, rate-limit, and error metrics are eagerly created at startup so series exist from the first export cycle. LLM, speech, graph, and storage instruments are lazy-initialized on first use.

### Tools, resources, prompts

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.tool.calls` | counter | `{calls}` | `mcp.tool.name`, `mcp.tool.success` |
| `mcp.tool.duration` | histogram | `ms` | `mcp.tool.name`, `mcp.tool.success` |
| `mcp.tool.errors` | counter | `{errors}` | `mcp.tool.name`, `mcp.tool.error_category` (`upstream`/`server`/`client`) |
| `mcp.tool.input_bytes` | histogram | `bytes` | `mcp.tool.name` |
| `mcp.tool.output_bytes` | histogram | `bytes` | `mcp.tool.name` (success only; the handler's returned value) |
| `mcp.tool.param.usage` | counter | `{uses}` | `mcp.tool.name`, `mcp.tool.param` (top-level keys supplied by caller) |
| `mcp.resource.reads` | counter | `{reads}` | `mcp.resource.name`, `mcp.resource.success` |
| `mcp.resource.duration` | histogram | `ms` | `mcp.resource.name`, `mcp.resource.success` |
| `mcp.resource.errors` | counter | `{errors}` | `mcp.resource.name` |
| `mcp.resource.output_bytes` | histogram | `bytes` | `mcp.resource.name` (success only; the handler's returned value) |
| `mcp.prompt.generations` | counter | `{generations}` | `mcp.prompt.name`, `mcp.prompt.success` |
| `mcp.prompt.duration` | histogram | `ms` | `mcp.prompt.name`, `mcp.prompt.success` |
| `mcp.prompt.errors` | counter | `{errors}` | `mcp.prompt.name`, `mcp.prompt.error_category` |
| `mcp.prompt.input_bytes` | histogram | `bytes` | `mcp.prompt.name` |
| `mcp.prompt.output_bytes` | histogram | `bytes` | `mcp.prompt.name` (success only) |
| `mcp.prompt.message_count` | histogram | `{messages}` | `mcp.prompt.name` |
| `mcp.requests.active` | up/down counter | `{requests}` | — (in-flight handler executions, all three types) |

### Storage, LLM, speech, graph

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.storage.operations` | counter | `{ops}` | `mcp.storage.operation`, `mcp.storage.success` |
| `mcp.storage.duration` | histogram | `ms` | `mcp.storage.operation`, `mcp.storage.success` |
| `mcp.storage.errors` | counter | `{errors}` | `mcp.storage.operation` |
| `mcp.llm.requests` | counter | `{requests}` | `gen_ai.system`, `gen_ai.request.model` |
| `mcp.llm.duration` | histogram | `ms` | `gen_ai.system`, `gen_ai.request.model` |
| `mcp.llm.errors` | counter | `{errors}` | `gen_ai.system`, `gen_ai.request.model` |
| `mcp.llm.tokens` | counter | `{tokens}` | `gen_ai.request.model`, `gen_ai.token.type` (`input`/`output`) |
| `mcp.speech.operations` | counter | `{ops}` | `mcp.speech.operation` (`tts`/`stt`), `mcp.speech.provider`, `mcp.speech.success` |
| `mcp.speech.duration` | histogram | `ms` | `mcp.speech.operation`, `mcp.speech.provider` |
| `mcp.speech.errors` | counter | `{errors}` | `mcp.speech.operation`, `mcp.speech.provider` |
| `mcp.graph.operations` | counter | `{ops}` | `mcp.graph.operation`, `mcp.graph.success` |
| `mcp.graph.duration` | histogram | `ms` | `mcp.graph.operation`, `mcp.graph.success` |
| `mcp.graph.errors` | counter | `{errors}` | `mcp.graph.operation` |

### Transport, auth, sessions

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.auth.attempts` | counter | `{attempts}` | `mcp.auth.outcome` (`success`/`failure`/`missing`), `mcp.auth.failure_reason` |
| `mcp.auth.duration` | histogram | `ms` | `mcp.auth.outcome`, `mcp.auth.failure_reason` |
| `mcp.sessions.events` | counter | `{events}` | `mcp.session.event` (`created`/`terminated`/`rejected`/`stale_cleanup`) |
| `mcp.session.duration` | histogram | `s` | — |
| `mcp.sessions.active` | observable gauge | `{sessions}` | — |
| `mcp.heartbeat.failures` | counter | `{failures}` | `mcp.connection.transport` (`stdio`/`http`) |

### Errors, rate limits, HTTP client

| Metric | Type | Unit | Attributes |
|:-------|:-----|:-----|:-----------|
| `mcp.errors.classified` | counter | `{errors}` | `mcp.error.classified_code` (JSON-RPC code), `operation` |
| `mcp.ratelimit.rejections` | counter | `{rejections}` | `mcp.rate_limit.key` |
| `http.client.request.duration` | histogram | `s` | `http.request.method`, `server.address`, `http.response.status_code` (when > 0; absent on network errors before a response is received) |

### Process

Auto-registered when `process.memoryUsage` / `process.uptime` / `perf_hooks` are available (Node/Bun, not Workers). The three memory gauges share a single `process.memoryUsage()` snapshot per collection cycle, refreshed at most every 100 ms.

| Metric | Type | Unit | Notes |
|:-------|:-----|:-----|:------|
| `process.memory.rss` | observable gauge | `bytes` | Resident set size |
| `process.memory.heap_used` | observable gauge | `bytes` | V8 heap used |
| `process.memory.heap_total` | observable gauge | `bytes` | V8 total heap |
| `process.uptime` | observable gauge | `s` | Process uptime |
| `process.event_loop.delay` | observable gauge | `ms` | p99 delay (`monitorEventLoopDelay` resolution=20) |
| `process.event_loop.utilization` | observable gauge | `1` | 0 = idle, 1 = saturated |

---

## Logs

Pino logs are auto-instrumented by `@opentelemetry/instrumentation-pino`. When a span is active, `trace_id` and `span_id` are injected into the record. Combined with the framework logger's automatic `requestId`/`tenantId` correlation, every log line is searchable by trace.

For domain logging inside handlers, use `ctx.log` (`debug`/`info`/`notice`/`warning`/`error`) — auto-includes `requestId`, `traceId`, `tenantId`, `spanId`. The completion log emitted at the end of every handler carries a `metrics` payload, with fields tuned to each surface:

| Handler | Log message | `metrics` fields |
|:--------|:------------|:-----------------|
| Tool | `Tool execution finished.` | `durationMs`, `isSuccess`, `errorCode`, `inputBytes`, `outputBytes`, plus `partialSuccess` / `batchSucceeded` / `batchFailed` when the result is a partial-success batch |
| Resource | `Resource read finished.` | `durationMs`, `isSuccess`, `errorCode`, `outputBytes`, `uri`, `mimeType` |
| Prompt | `Prompt generation finished.` (or `failed.`) | `durationMs`, `isSuccess`, `errorCode`, `inputBytes`, `outputBytes`, `messageCount` |

---

## Custom instrumentation

Need a span or metric for your own service? Use the helpers from `@cyanheads/mcp-ts-core/utils` (full signatures in `api-utils` → `Telemetry`):

```ts
import { withSpan, createCounter, createHistogram } from '@cyanheads/mcp-ts-core/utils';

const myOps = createCounter('myservice.operations', 'My service ops', '{ops}');
const myDuration = createHistogram('myservice.duration', 'My service duration', 'ms');

export async function doWork() {
  return withSpan('myservice.do_work', async (span) => {
    const t0 = performance.now();
    try {
      const result = await reallyDoWork();
      span.setAttribute('myservice.items', result.length);
      return result;
    } finally {
      myDuration.record(performance.now() - t0);
      myOps.add(1);
    }
  }, { 'myservice.region': 'us-west' });
}
```

Span context propagates automatically — `withSpan` calls inside a `tool_execution:*` span appear as children. `runInContext(ctx, fn)` carries the active OTel context across async boundaries (`setTimeout`, `queueMicrotask`).

For attribute keys, prefer the `ATTR_*` constants exported from `@cyanheads/mcp-ts-core/utils` (telemetry/attributes) over hand-typed strings — keeps you in step with framework conventions and avoids typos. Standard OTel semantic conventions (HTTP, cloud, service, network, etc.) are NOT re-exported — import those directly from `@opentelemetry/semantic-conventions`.

---

## Visualization

An example Grafana dashboard JSON and vendor-agnostic query recipes (Prometheus, Datadog, New Relic, Honeycomb) live at [`docs/telemetry/`](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) in the framework source — not bundled in the npm package, so consult the GitHub repo.

---

## Cardinality discipline

Series are cheap to emit but expensive to store and query. The framework deliberately keeps high-cardinality identifiers off metric attributes and on spans only. Follow the same rule when adding your own metrics.

| On metrics | On spans / logs only |
|:-----------|:---------------------|
| `mcp.resource.name` (URI template) | `mcp.resource.uri` (full URI with IDs) |
| `gen_ai.request.model` (bounded enum) | `mcp.tenant.id`, `mcp.client.id`, `mcp.auth.subject` |
| Bounded enum / template strings | Per-request unique IDs, free-form user input, opaque tokens |

When in doubt: if the attribute can take more than ~100 distinct values across a fleet's runtime, it belongs on the span, not the metric.

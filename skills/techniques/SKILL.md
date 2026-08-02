---
name: techniques
description: >
  Catalog of reusable response- and data-shaping techniques for MCP servers built on `@cyanheads/mcp-ts-core` — overflow handling, payload shaping, retrieval patterns. Use when a tool's payload is too large, awkwardly shaped, or expensive to retrieve and you want a proven pattern instead of inventing one. Each technique has a self-contained reference under `references/`.
metadata:
  author: cyanheads
  version: "0.2"
  audience: external
  type: reference
---

## Overview

A directory of cross-cutting techniques for shaping what a handler returns and how a client retrieves it — patterns that don't belong to a single API surface. Each entry is a self-contained reference under `references/`: the problem it solves, when to reach for it (and when not to), and how to apply it with current framework primitives.

These are **patterns, not new primitives** — they compose `tool()`, `output`/`format()` shaping, `ctx.state`, and the existing helpers. Where a technique has (or will have) a dedicated helper, its reference says so and links the tracking issue.

## Techniques

| Technique | Path | Use when |
|:----------|:-----|:---------|
| Outline-on-overflow | `references/outline-on-overflow.md` | A single tool call returns one **document-shaped** payload too big to inline (e.g. a ~130KB record), and you want an honest section outline + a re-call contract instead of truncating. |

## Adding a technique

One file under `references/`, one row above. A technique earns a place here when it's a reusable response/retrieval pattern that (a) spans more than one tool or server and (b) isn't already covered by an `api-*` reference. Keep the reference concise: problem → when-to-use → how-to with current primitives → helper status. Bump `metadata.version` on any change (skill-versioning policy).

## Related

- `design-mcp-server` — choosing the tool surface and output shapes up front.
- `add-tool` — the `tool()` builder, `format()` ⟷ `structuredContent` parity, matching response density to context budget.
- `api-canvas` — `spillover()`, the row-collection sibling of outline-on-overflow.

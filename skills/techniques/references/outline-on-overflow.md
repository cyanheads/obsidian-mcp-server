# Outline-on-overflow

Return a section **outline** when a single document-shaped payload is too big to inline, and let the agent re-call the same tool for only the sections it needs. The honest alternative to truncation for the *one fat document* case.

Ships as `outlineOnOverflow` + friends in `@cyanheads/mcp-ts-core/utils`.

## The problem

Some tools fetch one large **document-shaped** record. An FDA drug label is a single ~130KB / ~32K-token payload dominated by raw HTML sections. Returning it whole burns the agent's context; truncating it either hides data or — when only `format()` is trimmed — silently desyncs `content[]` from `structuredContent`. Neither is acceptable.

This is distinct from the other two overflow shapes:

| Shape | Technique |
|:--|:--|
| Many rows (tabular) | `spillover()` → DataCanvas SQL handle (see `api-canvas`) |
| Capped list | honest truncation disclosure |
| **One large document** | **outline-on-overflow (this file)** |

## Philosophy

**Never truncate to fit a budget.** When a payload is too big, return a complete, honest outline of what's available plus how to retrieve it — identically on `content[]` and `structuredContent`.

## The shape — a flat `output` with a `kind` discriminator

The outline is the payload the agent acts on, so it lands in the **main body** (`structuredContent` + `content[]`), as a variant of the tool's own `output`. Not the enrichment block — enrichment is *additive* (`output.extend(...)` merged after `output.parse(result)`), so it can add fields to the fat document but never replace it. Not a post-hoc framework swap either — that would emit a `structuredContent` shape the advertised `outputSchema` (`tools/list`) doesn't describe. A single `output` object carrying both modes — a `kind` discriminator plus presence-based optional arms — is the placement that replaces the payload, is advertised honestly, and holds `format()`-parity. (`tool()` requires `output` to be a `ZodObject`: the `schema-is-object` lint rule and the enrichment `.extend()` are both object-only, so a `z.discriminatedUnion` output is rejected — model the two modes as optional arms of one object, not union branches.)

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  OUTLINE_VARIANT,
  outlineOnOverflow,
  selectSections,
  formatOutline,
} from '@cyanheads/mcp-ts-core/utils';

const FullLabel = z.object({ /* every section field */ });

export const getLabel = tool('get_label', {
  description: 'Fetch a drug label. Returns the full record, or a section outline when it overflows.',
  input: z.object({
    query: z.string().describe('Label query'),
    sections: z
      .array(z.string())
      .optional()
      .describe('Sections to return. Omit for the full label (or an outline if it overflows).'),
  }),
  output: z.object({
    kind: z.enum(['full', 'outline']),
    ...FullLabel.partial().shape,                         // full arm — every field optional
    sections: OUTLINE_VARIANT.shape.sections.optional(),  // outline arm
    notice: OUTLINE_VARIANT.shape.notice.optional(),
  }),
  // Render each arm on field presence, independently — never branch on `kind` (see below).
  format: (r) => [
    ...(r.id ? renderLabel(r) : []),  // full arm — key on a full-only field
    ...(r.sections ? formatOutline({ kind: 'outline', sections: r.sections, notice: r.notice ?? '' }) : []),
  ],
  async handler(input) {
    const doc = await fetchLabel(input.query); // deterministic from query
    if (input.sections?.length) {
      // selection path — slice to requested keys plus always-kept metadata
      return { ...selectSections(doc, input.sections, { alwaysKeep: ['id', 'set_id'] }), kind: 'full' as const };
    }
    return outlineOnOverflow(doc, { budget: 24_000 }); // disclosure path → full | outline
  },
});
```

`format()`-parity holds because every terminal field in `output` must appear in the rendered text. With a flat object the linter builds **one** synthetic sample with every optional field populated at once, so render each arm on field presence, independently — a mutually-exclusive `if (kind === 'outline') … else …` renders only one arm against that all-fields sample and fails parity for the other. `formatOutline` is the shipped renderer for the `outline` arm; you supply the `full` renderer. That keeps the two client surfaces in lockstep.

## The helper

`@cyanheads/mcp-ts-core/utils` ships the whole pattern — pure measurement + key-slicing, no DuckDB, so it runs on stdio / HTTP / Workers alike:

| Export | Purpose |
|:--|:--|
| `outlineOnOverflow(doc, options?)` | Returns `{ kind: 'full', ...doc }` under budget (or with `< 2` sections), else `{ kind: 'outline', sections, notice }`. |
| `OUTLINE_VARIANT` | The reusable `outline`-arm Zod schema; fold `.shape.sections` / `.shape.notice` into your flat `output` object as optional arms. |
| `selectSections(doc, want, { alwaysKeep })` | Projects the document to requested keys plus always-kept metadata. The selection-path counterpart. |
| `formatOutline(outline)` | Renders the outline to `content[]` for `format()`. |
| `DEFAULT_OUTLINE_BUDGET_BYTES` | The default budget (`24_000`) when `options.budget` is omitted. |

`outlineOnOverflow` options:

- `budget` — serialized-byte threshold (default `DEFAULT_OUTLINE_BUDGET_BYTES`). A helper argument, **not** an env var: a deploy-tunable threshold would drift a tool's output *shape* across environments.
- `extract` — custom section extractor. Default: one section per top-level key, sized by `JSON.stringify(value).length`. Override only when "section" means something other than a top-level key.
- `notice` — custom re-call notice builder. Default names the three largest sections as examples.

The flow:

1. **Measure** the serialized payload (`JSON.stringify(doc).length`).
2. **Under budget** → `{ kind: 'full', ...doc }`.
3. **Over budget, ≥ 2 sections** → the outline (sections sorted largest-first). The agent re-calls with `sections: [...]`.
4. **Over budget, < 2 sections** → `full` anyway (nothing to pick between). A single section that *alone* exceeds budget is a known limitation — sub-section outlining is out of scope.

## Re-retrieval — why the selection call is stateless

The re-call is **self-contained**, so nothing is stored between the outline call and the selection call:

- The selection call sends the **same input** as the outline call, plus `sections: [...]`.
- The handler **re-fetches** the document — input-minus-`sections` is identical and the upstream query is deterministic, so it reproduces the exact same record — then applies `selectSections` (a pure projection: requested keys + `alwaysKeep` metadata).
- You **reconstruct rather than remember**. The agent holds the continuity (it passes `sections`); the upstream holds the document.

The only cost is the redundant fetch. For a **rate-limited or expensive upstream**, trade it for an optional cache:

```ts
const key = `label:${input.query}`;                          // NOTE: excludes `sections`
let doc = await ctx.state.get<Label>(key).catch(() => null); // best-effort read
if (!doc) {
  doc = await fetchLabel(input.query);
  await ctx.state.set(key, doc, { ttl: 300 }).catch(() => {}); // best-effort write, 5 min
}
```

- **Key excludes the `sections` selector** — otherwise the outline call and the selection call compute different keys and never share the doc.
- **Best-effort** — a miss or a read/write failure falls through to the stateless refetch, so correctness never depends on the cache.
- Rides `ctx.state` (the tenant-scoped KV abstraction), which is **independent of `MCP_SESSION_MODE`**. It does *not* require switching the server to stateful sessions and has no end-user-visible effect (a miss behaves exactly like the stateless path). Tenant-scoping isolates per-identity under `jwt`/`oauth`; the shared `default` tenant (stdio, HTTP + `none`) is benign because the cached value is a deterministic public-query → document map, not user state. If the upstream itself returns identity-scoped data, fold the auth principal into the key.

The framework ships no cache-key helper — the pattern above is one line and tool-specific (which fields key the doc, what TTL). **Default to stateless.** Reach for the cache only where the upstream cost is real.

## When to use

- A single tool result is one **document-shaped** record that can exceed a context-meaningful size.
- The record has addressable parts (top-level sections) the agent can choose among.

## When not to

- **Many rows** → `spillover()`. The document here is one row; spilling rows leaves the per-record size intact.
- **A capped list** → truncation disclosure.
- **No meaningful sub-structure** to outline → there's nothing to pick. Return it, or shrink it at the source (drop redundant fields before measuring).

# Graph Service (`services/graph`)

## `IGraphProvider` interface

Relationship-oriented graph operations — not vertex-CRUD:

| Method | Signature | Notes |
|:-------|:----------|:------|
| `relate` | `(from, edgeTable, to, context, options?) -> Promise<Edge>` | Create a directed relationship edge |
| `unrelate` | `(edgeId, context) -> Promise<boolean>` | Delete an edge by ID. Returns `true` if found. |
| `traverse` | `(startVertexId, context, options?) -> Promise<TraversalResult>` | Graph traversal from a starting vertex |
| `shortestPath` | `(from, to, context, options?) -> Promise<GraphPath \| null>` | Find lowest-cost path between two vertices |
| `getOutgoingEdges` | `(vertexId, context, edgeTypes?) -> Promise<Edge[]>` | All outgoing edges from a vertex |
| `getIncomingEdges` | `(vertexId, context, edgeTypes?) -> Promise<Edge[]>` | All incoming edges to a vertex |
| `pathExists` | `(from, to, context, maxDepth?) -> Promise<boolean>` | Reachability check (cheaper than `shortestPath`) |
| `getStats` | `(context) -> Promise<GraphStats>` | Aggregate vertex/edge counts and type breakdowns |
| `healthCheck` | `() -> Promise<boolean>` | Provider liveness check |

All methods that take `context` expect `RequestContext`, not unified `Context`.

## `GraphService` class

Thin facade over `IGraphProvider` — delegates all calls to the injected provider with debug logging. Same method signatures as `IGraphProvider`, plus:

| Method | Return |
|:-------|:-------|
| `getProvider()` | `IGraphProvider` — access the underlying provider |
| `healthCheck()` | `Promise<boolean>` — liveness check on the underlying provider |

Not auto-constructed — initialize in `setup()` with a provider.

## Types

```ts
interface Vertex {
  id: string;       // e.g., 'user:alice'
  table: string;    // e.g., 'user'
  data: Record<string, unknown>;
}

interface Edge {
  id: string;       // e.g., 'follows:1'
  table: string;    // e.g., 'follows'
  from: string;     // source vertex ID
  to: string;       // target vertex ID
  data: Record<string, unknown>;
}

type TraversalDirection = 'out' | 'in' | 'both';

interface TraversalOptions {
  direction?: TraversalDirection;  // default: 'out'
  maxDepth?: number;               // default: 1
  edgeTypes?: string[];            // filter by edge table
  vertexTypes?: string[];          // filter by vertex table
  where?: string;                  // provider-specific filter
}

interface TraversalResult {
  start: Vertex;
  paths: GraphPath[];
}

interface GraphPath {
  vertices: Vertex[];
  edges: Edge[];
  weight?: number;
}

interface PathOptions {
  algorithm?: 'dijkstra' | 'bfs' | 'dfs';  // default: 'bfs'
  maxLength?: number;
  weightFn?: (edge: Edge) => number;        // required for 'dijkstra'
}

interface RelateOptions {
  allowDuplicates?: boolean;  // default: false
  data?: Record<string, unknown>;
}

interface GraphStats {
  vertexCount: number;
  edgeCount: number;
  avgDegree: number;
  vertexTypes: Record<string, number>;
  edgeTypes: Record<string, number>;
}
```

## Usage

```ts
// Create a relationship
const edge = await graphService.relate(
  'user:alice', 'follows', 'user:bob', context,
  { data: { since: '2025-01-01' } },
);

// Delete a relationship
const deleted = await graphService.unrelate('follows:1', context);

// Traverse the graph
const result = await graphService.traverse('user:alice', context, {
  maxDepth: 2,
  edgeTypes: ['follows'],
  direction: 'out',
});

// Find shortest path
const path = await graphService.shortestPath('user:alice', 'user:charlie', context, {
  algorithm: 'bfs',
  maxLength: 4,
});
if (path) context.log.info(`${path.vertices.length} hops`);

// Check reachability
const connected = await graphService.pathExists('user:alice', 'user:charlie', context, 3);

// Get edges
const outgoing = await graphService.getOutgoingEdges('user:alice', context, ['follows']);
const incoming = await graphService.getIncomingEdges('user:bob', context, ['follows']);

// Stats
const stats = await graphService.getStats(context);
```

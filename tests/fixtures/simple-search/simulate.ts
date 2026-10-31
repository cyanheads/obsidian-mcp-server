/**
 * @fileoverview Real `POST /search/simple/` responses, and the upstream they
 * came from as a fake for the unscoped text path's tests.
 *
 * The captures in this directory are real Local REST API 5.2.0 responses on
 * Obsidian 1.14.5: one note per capture over `probe-body.md`, and in
 * `rule-captures.json` a set of notes that separate Obsidian's matching rule
 * from looser readings of it (a touching or overlapping repeat skipped, a
 * single-space split, a span across the basename and body dropped, offsets
 * that index the lower-cased text, ties in vault order).
 * `tests/services/simple-search-simulator.test.ts` pins the server's own port
 * (`SimpleSearch`) to every one of them, so `simulateSimpleSearch` can stand in
 * for the upstream where the unscoped path's response handling is under test.
 *
 * @module tests/fixtures/simple-search/simulate
 */

import { readFileSync } from 'node:fs';
import { SimpleSearch } from '@/services/obsidian/simple-search.js';

export interface RawSpan {
  context: string;
  match: { end: number; source?: 'filename' | 'content'; start: number };
}

export interface RawHit {
  filename: string;
  matches: RawSpan[];
  score?: number;
}

/** The ground truth for a span: which subject it indexes and where it sits in `context`. */
export interface SpanTruth {
  contextStart: number;
  subject: 'body' | 'filename';
}

export interface SimulatedNote {
  body: string;
  path: string;
}

const HERE = new URL('./', import.meta.url);

/** The vault path of the scratch note every per-query capture was taken against. */
export const PROBE_PATH = '_mcp-validate-117/vexquorn-probe.md';

/** The body of that note, byte for byte as the plugin read it back. */
export const PROBE_BODY = readFileSync(new URL('probe-body.md', HERE), 'utf8');

/** The query each per-query capture answered, all at the default `contextLength` of 100. */
export const CAPTURE_QUERIES = {
  adjacent: 'Vexquorn zorblatt:',
  'three-word': 'Vexquorn zorblatt: <script>',
  medium: 'Gradlefen prumbisk',
  far: 'Kelpwhist moxtrundle',
  repeated: 'echoplume',
  'dup-token': 'echoplume echoplume',
  surrogate: 'surrotok',
  keyrename: 'vexquorn probe',
  overlap: 'vex vexquorn',
} as const;

export type CaptureName = keyof typeof CAPTURE_QUERIES;

/** A captured upstream response, parsed. */
export function loadCapture(name: CaptureName): RawHit[] {
  return JSON.parse(readFileSync(new URL(`${name}.json`, HERE), 'utf8')) as RawHit[];
}

/**
 * `rule-captures.json`: its notes, bodies as `GET /vault/{path}` reads them
 * (the BOM note's leading U+FEFF stripped, as Obsidian's `cachedRead` strips
 * it), the plugin's vault order, and each query's response restricted to
 * those notes.
 */
export interface RuleCaptures {
  captures: Array<{ contextLength: number; query: string; response: RawHit[] }>;
  notes: SimulatedNote[];
  vaultOrder: string[];
}

export function loadRuleCaptures(): RuleCaptures {
  return JSON.parse(readFileSync(new URL('rule-captures.json', HERE), 'utf8')) as RuleCaptures;
}

/**
 * The response `POST /search/simple/` gives over `notes`, taken as the vault
 * order. `withSource: false` drops `match.source`, the shape a plugin older
 * than 5.0.3 sends. Each span's ground truth is returned alongside, in the
 * same order.
 */
export function simulateSimpleSearch(
  notes: SimulatedNote[],
  query: string,
  contextLength: number,
  opts: { withSource?: boolean } = {},
): { hits: RawHit[]; truth: Map<string, SpanTruth[]> } {
  const withSource = opts.withSource ?? true;
  const search = new SimpleSearch(query, contextLength);
  for (const note of notes) search.add(note.path, note.body);
  const hits: RawHit[] = [];
  const truth = new Map<string, SpanTruth[]>();
  for (const hit of search.hits()) {
    hits.push({
      filename: hit.filename,
      score: hit.score,
      matches: hit.matches.map(({ context, match }) => ({
        context,
        match: withSource ? match : { start: match.start, end: match.end },
      })),
    });
    truth.set(
      hit.filename,
      hit.matches.map((m) => ({
        subject: m.match.source === 'filename' ? 'filename' : 'body',
        contextStart: m.contextStart,
      })),
    );
  }
  return { hits, truth };
}

/** Deterministic PRNG (mulberry32) so a failing property run reproduces from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

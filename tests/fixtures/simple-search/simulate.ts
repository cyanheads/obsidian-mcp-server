/**
 * @fileoverview Test-side model of the Local REST API's `POST /search/simple/`
 * plus the real responses it was checked against.
 *
 * `simulateSimpleSearch` ports plugin 5.2.0's `simpleSearch`: Obsidian's
 * `prepareSimpleSearch` tokenizes the query on whitespace, requires every
 * token (case-insensitively), and reports one span per occurrence, coalescing
 * only spans that overlap or touch. The plugin runs it over
 * `basename + "\n\n" + body`: spans inside the basename come back with the
 * basename as `context`, body spans with a `contextLength` window widened by
 * one code unit per side rather than split a surrogate pair. The captures in
 * this directory are real 5.2.0 responses over `probe-body.md`, and
 * `simple-search-simulator.test.ts` pins the model to them.
 *
 * @module tests/fixtures/simple-search/simulate
 */

import { readFileSync } from 'node:fs';

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

/** The vault path of the scratch note every capture was taken against. */
export const PROBE_PATH = '_mcp-validate-117/vexquorn-probe.md';

/** The body of that note, byte for byte as the plugin read it back. */
export const PROBE_BODY = readFileSync(new URL('probe-body.md', HERE), 'utf8');

/** The query each capture answered, all at the default `contextLength` of 100. */
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

const basenameOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^./]+$/, '');

/**
 * Upstream's `widenToCodePointBoundaries`: grow `[start, end)` by at most one
 * code unit per side so neither edge splits a surrogate pair.
 */
function widen(text: string, start: number, end: number): [number, number] {
  let s = start;
  if (s > 0 && s < text.length) {
    const cu = text.charCodeAt(s);
    if (cu >= 0xdc00 && cu <= 0xdfff) s -= 1;
  }
  let e = end;
  if (e > 0 && e < text.length) {
    const cu = text.charCodeAt(e - 1);
    if (cu >= 0xd800 && cu <= 0xdbff) e += 1;
  }
  return [s, e];
}

/** Every occurrence of every token, overlapping or touching spans coalesced, in position order. */
function simpleSearchSpans(text: string, query: string): Array<[number, number]> | undefined {
  const lower = text.toLowerCase();
  const tokens = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (tokens.length === 0) return;
  const spans: Array<[number, number]> = [];
  for (const token of tokens) {
    let found = false;
    for (let i = lower.indexOf(token); i !== -1; i = lower.indexOf(token, i + 1)) {
      spans.push([i, i + token.length]);
      found = true;
    }
    if (!found) return;
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/**
 * Model `POST /search/simple/` over `notes`. `withSource: false` drops
 * `match.source`, the shape a plugin older than 5.0.3 sends. Each span's
 * ground truth is returned alongside, in the same order.
 */
export function simulateSimpleSearch(
  notes: SimulatedNote[],
  query: string,
  contextLength: number,
  opts: { withSource?: boolean } = {},
): { hits: RawHit[]; truth: Map<string, SpanTruth[]> } {
  const withSource = opts.withSource ?? true;
  const hits: RawHit[] = [];
  const truth = new Map<string, SpanTruth[]>();
  for (const note of notes) {
    const basename = basenameOf(note.path);
    const prefix = `${basename}\n\n`;
    const spans = simpleSearchSpans(prefix + note.body, query);
    if (!spans) continue;
    const matches: RawSpan[] = [];
    const truths: SpanTruth[] = [];
    for (const [s, e] of spans) {
      if (s < prefix.length && e <= prefix.length) {
        const end = Math.min(e, basename.length);
        matches.push({
          context: basename,
          match: { start: s, end, ...(withSource ? { source: 'filename' as const } : {}) },
        });
        truths.push({ subject: 'filename', contextStart: s });
      } else if (s >= prefix.length) {
        const start = s - prefix.length;
        const end = e - prefix.length;
        const [ws, we] = widen(note.body, Math.max(start - contextLength, 0), end + contextLength);
        matches.push({
          context: note.body.slice(ws, we),
          match: { start, end, ...(withSource ? { source: 'content' as const } : {}) },
        });
        truths.push({ subject: 'body', contextStart: start - ws });
      }
    }
    hits.push({ filename: note.path, score: -1, matches });
    truth.set(note.path, truths);
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

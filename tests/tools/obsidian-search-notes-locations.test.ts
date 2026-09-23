/**
 * @fileoverview Text-mode match locations for obsidian_search_notes. Upstream
 * reports one span per token occurrence, so each word of a phrase used to come
 * back as its own match with a near-identical context window. A multi-token
 * query now merges spans into locations; these cases pin the merge rule, the
 * offset invariant on every merged location, and the payload bound, all
 * through `output.parse()` and `format()`. Issue #117.
 * @module tests/tools/obsidian-search-notes-locations.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianSearchNotes } from '@/mcp-server/tools/definitions/obsidian-search-notes.tool.js';
import {
  CAPTURE_QUERIES,
  type CaptureName,
  loadCapture,
  PROBE_BODY,
  PROBE_PATH,
  type RawHit,
  type SimulatedNote,
  seededRandom,
  simulateSimpleSearch,
} from '../fixtures/simple-search/simulate.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();
const def = obsidianSearchNotes;

interface Location {
  context: string;
  match: { start: number; end: number; contextStart: number; contextEnd: number };
}
interface TextHit {
  filename: string;
  matches: Location[];
  totalMatches?: number | undefined;
  truncated?: boolean | undefined;
}
interface TextResult {
  hits: TextHit[];
  mode: 'text';
  nextCursor?: string | undefined;
  totalCount: number;
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const basenameOf = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^./]+$/, '');
const sliceOf = (m: Location) => m.context.slice(m.match.contextStart, m.match.contextEnd);

/** Both consumption surfaces of one result, and their combined size in bytes. */
function surfaces(result: TextResult) {
  const parsed = def.output.parse({ result });
  const text = (def.format?.(parsed) ?? [])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
  if (parsed.result.mode !== 'text') throw new Error('expected text branch');
  return {
    result: parsed.result as TextResult,
    text,
    bytes: bytes(JSON.stringify(parsed)) + bytes(text),
  };
}

async function search(hits: RawHit[], input: Record<string, unknown>) {
  harness
    .current()
    .pool.intercept({ path: (p) => p.startsWith('/search/simple/'), method: 'POST' })
    .reply(200, hits, { headers: { 'content-type': 'application/json' } });
  const out = await def.handler(
    def.input.parse({ mode: 'text', ...input }),
    createMockContext({ errors: def.errors }),
  );
  return surfaces(out.result as TextResult);
}

/**
 * The response as it was before locations: one match per upstream span, with
 * the ground-truth offsets. What a merged response must never exceed.
 */
function unmerged(notes: SimulatedNote[], query: string, contextLength: number): TextResult {
  const { hits, truth } = simulateSimpleSearch(notes, query, contextLength);
  return {
    mode: 'text',
    totalCount: hits.length,
    hits: hits.map((h) => ({
      filename: h.filename,
      matches: h.matches.map((m, i) => {
        const cs = truth.get(h.filename)?.[i]?.contextStart ?? Number.NaN;
        return {
          context: m.context,
          match: {
            start: m.match.start,
            end: m.match.end,
            contextStart: cs,
            contextEnd: cs + m.match.end - m.match.start,
          },
        };
      }),
    })),
  };
}

/**
 * #114's invariant, extended to a merged location: `context` is the
 * contiguous slice of its subject that `start - contextStart` addresses, and
 * `context.slice(contextStart, contextEnd)` is `subject.slice(start, end)`.
 */
function expectLocationInvariant(m: Location, subject: string) {
  const left = m.match.start - m.match.contextStart;
  expect(left).toBeGreaterThanOrEqual(0);
  expect(subject.slice(left, left + m.context.length)).toBe(m.context);
  expect(sliceOf(m)).toBe(subject.slice(m.match.start, m.match.end));
}

const PROBE_NOTE: SimulatedNote[] = [{ path: PROBE_PATH, body: PROBE_BODY }];
const PROBE_BASENAME = basenameOf(PROBE_PATH);

const spansOf = (r: TextResult) =>
  r.hits[0]?.matches.map((m) => [m.match.start, m.match.end, sliceOf(m)]);

describe('obsidian_search_notes / text locations — real upstream captures', () => {
  it('returns a phrase as one location and keeps the lone occurrences separate', async () => {
    const { result, text } = await search(loadCapture('adjacent'), {
      query: CAPTURE_QUERIES.adjacent,
    });
    expect(spansOf(result)).toEqual([
      [0, 8, 'vexquorn'],
      [337, 355, 'Vexquorn zorblatt:'],
      [1766, 1774, 'vexquorn'],
      [2087, 2096, 'zorblatt:'],
    ]);
    const phrase = result.hits[0]?.matches[1];
    if (!phrase) throw new Error('expected the phrase location');
    expectLocationInvariant(phrase, PROBE_BODY);
    expect(text).toContain('subject[337–355]');
    expect(text).toContain(phrase.context);
  });

  it('chains a three-token phrase into one location', async () => {
    const { result } = await search(loadCapture('three-word'), {
      query: CAPTURE_QUERIES['three-word'],
    });
    const matches = result.hits[0]?.matches ?? [];
    expect(spansOf(result)).toEqual([
      [0, 8, 'vexquorn'],
      [337, 364, 'Vexquorn zorblatt: <script>'],
      [1766, 1774, 'vexquorn'],
      [2087, 2096, 'zorblatt:'],
    ]);
    for (const m of matches.slice(1)) expectLocationInvariant(m, PROBE_BODY);
  });

  it('merges a 157-character gap at contextLength 100', async () => {
    const { result } = await search(loadCapture('medium'), { query: CAPTURE_QUERIES.medium });
    expect(spansOf(result)?.map(([s, e]) => [s, e])).toEqual([[1282, 1456]]);
    const [only] = result.hits[0]?.matches ?? [];
    if (!only) throw new Error('expected one location');
    expectLocationInvariant(only, PROBE_BODY);
  });

  it('keeps tokens more than 2 × contextLength apart as separate locations', async () => {
    const { result } = await search(loadCapture('far'), { query: CAPTURE_QUERIES.far });
    expect(spansOf(result)?.map(([s, e]) => [s, e])).toEqual([
      [625, 634],
      [1269, 1279],
    ]);
  });

  it('merges basename spans with basename spans only', async () => {
    const { result } = await search(loadCapture('keyrename'), {
      query: CAPTURE_QUERIES.keyrename,
    });
    const matches = result.hits[0]?.matches ?? [];
    expect(spansOf(result)).toEqual([
      [0, 14, 'vexquorn-probe'],
      [2, 7, 'Probe'],
      [337, 345, 'Vexquorn'],
      [1766, 1774, 'vexquorn'],
    ]);
    expect(matches[0]?.context).toBe(PROBE_BASENAME);
    if (matches[0]) expectLocationInvariant(matches[0], PROBE_BASENAME);
    for (const m of matches.slice(1)) expectLocationInvariant(m, PROBE_BODY);
  });

  it.each(['repeated', 'dup-token', 'surrogate', 'overlap'] as CaptureName[])(
    'returns exactly the per-span matches for a single distinct token: %s',
    async (name) => {
      const query = CAPTURE_QUERIES[name];
      const got = await search(loadCapture(name), { query });
      expect(got.result.hits).toEqual(surfaces(unmerged(PROBE_NOTE, query, 100)).result.hits);
    },
  );

  it.each([
    ['adjacent', 1],
    ['three-word', 2],
    ['medium', 1],
    ['keyrename', 1],
  ] as Array<[CaptureName, number]>)(
    'is smaller than the unmerged response on both surfaces: %s',
    async (name, absorbed) => {
      const query = CAPTURE_QUERIES[name];
      const merged = await search(loadCapture(name), { query });
      const before = surfaces(unmerged(PROBE_NOTE, query, 100));
      expect(
        (before.result.hits[0]?.matches.length ?? 0) - (merged.result.hits[0]?.matches.length ?? 0),
      ).toBe(absorbed);
      expect(merged.bytes).toBeLessThan(before.bytes);
      expect(bytes(merged.text)).toBeLessThan(bytes(before.text));
    },
  );

  it('leaves a far-apart pair byte-identical to the unmerged response', async () => {
    const merged = await search(loadCapture('far'), { query: CAPTURE_QUERIES.far });
    expect(merged.bytes).toBe(surfaces(unmerged(PROBE_NOTE, CAPTURE_QUERIES.far, 100)).bytes);
  });
});

describe('obsidian_search_notes / text locations — the merge rule', () => {
  const run = (body: string, query: string, contextLength: number, path = 'N.md') =>
    search(simulateSimpleSearch([{ path, body }], query, contextLength).hits, {
      query,
      contextLength,
    });

  it.each([
    { gap: 19, locations: 1 },
    { gap: 20, locations: 1 },
    { gap: 21, locations: 2 },
  ])(
    'the 2 × contextLength boundary: gap $gap at contextLength 10 → $locations',
    async ({ gap, locations }) => {
      const body = `${'x '.repeat(20)}alpha${' '.repeat(gap)}omega${' x'.repeat(20)}`;
      const { result } = await run(body, 'alpha omega', 10);
      const matches = result.hits[0]?.matches ?? [];
      expect(matches).toHaveLength(locations);
      for (const m of matches) expectLocationInvariant(m, body);
    },
  );

  it('holds at most one span per case-folded text, so a repeated phrase does not chain', async () => {
    const body = 'lead Foo bar foo BAR foo bar tail';
    const { result } = await run(body, 'foo bar', 50);
    expect(spansOf(result)?.map(([, , s]) => s)).toEqual(['Foo bar', 'foo BAR', 'foo bar']);
    for (const m of result.hits[0]?.matches ?? []) expectLocationInvariant(m, body);
  });

  it('chains five distinct tokens into one location', async () => {
    const body = `${'pad '.repeat(30)}one two three four five${' pad'.repeat(30)}`;
    const { result } = await run(body, 'one two three four five', 100);
    expect(spansOf(result)?.map(([, , s]) => s)).toEqual(['one two three four five']);
    const [only] = result.hits[0]?.matches ?? [];
    if (only) expectLocationInvariant(only, body);
  });

  it('never merges spans of a single distinct token, even of different text', async () => {
    // `aa` over `aa aaaa`: two spans, 'aa' and the coalesced 'aaaa'.
    const body = 'aa aaaa';
    const { result } = await run(body, 'aa', 10);
    expect(spansOf(result)).toEqual([
      [0, 2, 'aa'],
      [3, 7, 'aaaa'],
    ]);
  });

  it('counts a merged phrase once against maxMatchesPerHit', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `Vexquorn zorblatt: ${i}`).join(
      ` ${'z'.repeat(240)} `,
    );
    const { result, text } = await search(
      simulateSimpleSearch([{ path: 'N.md', body }], 'Vexquorn zorblatt:', 100).hits,
      { query: 'Vexquorn zorblatt:' },
    );
    const [hit] = result.hits;
    expect(hit?.matches).toHaveLength(10);
    expect(hit?.truncated).toBe(true);
    expect(hit?.totalMatches).toBe(12);
    for (const m of hit?.matches ?? []) {
      expect(sliceOf(m)).toBe('Vexquorn zorblatt:');
      expectLocationInvariant(m, body);
    }
    expect(text).toContain('showing first 10 of 12 locations');
  });

  it('refuses to stitch windows whose overlapping text disagrees', async () => {
    /**
     * Two spans 4 apart at contextLength 5 claim overlapping windows, but the
     * second window's text contradicts the first — a plugin whose offsets do
     * not line up with its windows. Stitching would fabricate note text.
     */
    const hits: RawHit[] = [
      {
        filename: 'N.md',
        matches: [
          { context: 'abcdealphaABCDE', match: { start: 10, end: 15, source: 'content' } },
          { context: 'QRSTUomegaVWXYZ', match: { start: 19, end: 24, source: 'content' } },
        ],
      },
    ];
    const { result } = await search(hits, { query: 'alpha omega', contextLength: 5 });
    expect(result.hits[0]?.matches).toEqual([
      {
        context: 'abcdealphaABCDE',
        match: { start: 10, end: 15, contextStart: 5, contextEnd: 10 },
      },
      {
        context: 'QRSTUomegaVWXYZ',
        match: { start: 19, end: 24, contextStart: 5, contextEnd: 10 },
      },
    ]);
  });

  it('paginates files of merged locations with the invariant intact on every page', async () => {
    const notes: SimulatedNote[] = Array.from({ length: 60 }, (_, i) => ({
      path: `Notes/n${String(i).padStart(2, '0')}.md`,
      body: `Vexquorn zorblatt: first ${'y'.repeat(300)} second Vexquorn zorblatt: #${i}`,
    }));
    const { hits } = simulateSimpleSearch(notes, 'Vexquorn zorblatt:', 100);
    const first = await search(hits, { query: 'Vexquorn zorblatt:' });
    const second = await search(hits, {
      query: 'Vexquorn zorblatt:',
      cursor: first.result.nextCursor,
    });
    expect(first.result.hits).toHaveLength(50);
    expect(second.result.hits).toHaveLength(10);
    expect(second.result.nextCursor).toBeUndefined();
    expect(second.result.totalCount).toBe(60);
    expect(second.result.hits[0]?.filename).toBe('Notes/n50.md');
    for (const page of [first, second]) {
      for (const hit of page.result.hits) {
        const body = notes.find((n) => n.path === hit.filename)?.body ?? '';
        expect(hit.matches.map(sliceOf)).toEqual(['Vexquorn zorblatt:', 'Vexquorn zorblatt:']);
        for (const m of hit.matches) expectLocationInvariant(m, body);
      }
    }
  });
});

/**
 * Random notes with astral characters, case variants, and a basename that
 * carries a token, at small `contextLength` so windows overlap constantly.
 * Every run checks the partition, bound, invariant, and payload properties
 * against the simulator's ground truth. The seed is in the test name.
 */
describe('obsidian_search_notes / text locations — properties', () => {
  const words = ['alpha', 'Alpha', 'beta', 'BETA', 'ab', 'gamma', 'x', '😀', 'é', '\n'];
  const queries = ['alpha beta', 'Beta alpha ab', 'ab alpha', 'alpha alpha', 'gamma', 'ab b'];

  it.each([11, 12, 13, 14])('seed %i', async (seed) => {
    const rand = seededRandom(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    for (let run = 0; run < 60; run++) {
      const notes: SimulatedNote[] = [0, 1].map((n) => {
        const parts: string[] = [];
        const count = 5 + Math.floor(rand() * 60);
        for (let i = 0; i < count; i++) parts.push(pick(words));
        return { path: `Dir/${n ? 'alpha beta ab' : 'plain'} ${n}.md`, body: parts.join(' ') };
      });
      const query = pick(queries);
      const contextLength = 1 + Math.floor(rand() * 25);
      const label = `seed ${seed} run ${run} query ${JSON.stringify(query)} L ${contextLength} notes ${JSON.stringify(notes)}`;
      const { hits, truth } = simulateSimpleSearch(notes, query, contextLength, {
        withSource: rand() < 0.7,
      });
      const merged = await search(hits, { query, contextLength, maxMatchesPerHit: 1000 });
      const before = surfaces(unmerged(notes, query, contextLength));
      const distinct = new Set(query.toLowerCase().split(/\s+/).filter(Boolean)).size;

      expect(merged.bytes, label).toBeLessThanOrEqual(before.bytes);
      if (distinct < 2) {
        expect(merged.result.hits, label).toEqual(before.result.hits);
        continue;
      }
      for (const hit of merged.result.hits) {
        const note = notes.find((n) => n.path === hit.filename);
        const spans = before.result.hits.find((h) => h.filename === hit.filename)?.matches ?? [];
        const subjects = truth.get(hit.filename) ?? [];
        let i = 0;
        for (const loc of hit.matches) {
          // Locations partition upstream's spans, in order, one subject each.
          const first = i;
          expect(spans[i]?.match.start, label).toBe(loc.match.start);
          while (i < spans.length && (spans[i]?.match.end ?? 0) < loc.match.end) i++;
          expect(spans[i]?.match.end, label).toBe(loc.match.end);
          const covered = spans.slice(first, i + 1);
          const kinds = new Set(subjects.slice(first, i + 1).map((t) => t.subject));
          expect(kinds.size, label).toBe(1);
          const texts = covered.map((s) => sliceOf(s).toLowerCase());
          expect(new Set(texts).size, label).toBe(texts.length);
          for (let k = 1; k < covered.length; k++) {
            const gap = (covered[k]?.match.start ?? 0) - (covered[k - 1]?.match.end ?? 0);
            expect(gap, label).toBeLessThanOrEqual(2 * contextLength);
          }
          const subject = kinds.has('filename') ? basenameOf(hit.filename) : (note?.body ?? '');
          expectLocationInvariant(loc, subject);
          i++;
        }
        expect(i, label).toBe(spans.length);
      }
    }
  });
});

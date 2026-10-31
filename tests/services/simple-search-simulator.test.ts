/**
 * @fileoverview Pins the server's port of `POST /search/simple/`
 * (`SimpleSearch`, which runs text searches under a read scope and stands in
 * for the upstream in the unscoped path's tests) to real Local REST API 5.2.0
 * responses on Obsidian 1.14.5: hits, order, scores, spans, and context
 * windows. Its scan is timed against the inputs that stress it.
 * @module tests/services/simple-search-simulator.test
 */

import { describe, expect, it } from 'vitest';
import { SimpleSearch } from '@/services/obsidian/simple-search.js';
import {
  CAPTURE_QUERIES,
  type CaptureName,
  loadCapture,
  loadRuleCaptures,
  PROBE_BODY,
  PROBE_PATH,
  type RawHit,
  seededRandom,
} from '../fixtures/simple-search/simulate.js';
import { expectLinearCost } from '../helpers.js';

/** The port's hits in the upstream's wire shape. */
function wire(search: SimpleSearch): RawHit[] {
  return search.hits().map((h) => ({
    filename: h.filename,
    score: h.score,
    matches: h.matches.map(({ match, context }) => ({ match, context })),
  }));
}

describe('SimpleSearch reproduces the captured upstream responses', () => {
  it.each(Object.keys(CAPTURE_QUERIES) as CaptureName[])('%s', (name) => {
    const search = new SimpleSearch(CAPTURE_QUERIES[name], 100);
    search.add(PROBE_PATH, PROBE_BODY);
    expect(wire(search)).toEqual(loadCapture(name));
  });

  const rules = loadRuleCaptures();
  const bodyOf = (path: string) => rules.notes.find((n) => n.path === path)?.body ?? '';
  const RULE = new Map([
    ['qxadj', 'skips an occurrence that touches the one before it'],
    ['qxovqxov', 'skips an occurrence that overlaps the one before it'],
    ['qxdot', 'indexes the lower-cased text, where İ is two characters, and cuts the original'],
    ['qxtab\tqxtail', 'splits on spaces only, so a tab stays inside its token'],
    ['qxadj qxtab', 'merges two tokens into one span list in position order'],
    ['probe\n\nadjacent', 'drops a span across the basename and the body, keeping the hit'],
    ['qxadj probe\n', 'clips a filename span that runs into the separator'],
    ['qxtie', 'orders by score, equal scores in vault order'],
    ['qxbom', 'reads the body without its BOM, CRLF kept'],
    ['QXADJ  qxadj', 'folds case, drops empty and repeated tokens, scores on the raw query length'],
  ]);

  it.each(rules.captures.map((c) => [RULE.get(c.query) ?? c.query, c] as const))(
    '%s',
    (_rule, { query, contextLength, response }) => {
      const search = new SimpleSearch(query, contextLength);
      for (const path of rules.vaultOrder) search.add(path, bodyOf(path));
      expect(wire(search)).toEqual(response);
      // `contextStart` places each span in its context: a body window sits in the body at start - contextStart.
      for (const hit of search.hits()) {
        for (const { context, contextStart, match } of hit.matches) {
          const subjectStart = match.start - contextStart;
          if (match.source === 'filename') expect(contextStart).toBe(match.start);
          else
            expect(bodyOf(hit.filename).slice(subjectStart, subjectStart + context.length)).toBe(
              context,
            );
        }
      }
    },
  );

  it('labels every rule capture', () => {
    expect(rules.captures.map((c) => c.query).sort()).toEqual([...RULE.keys()].sort());
  });

  it('returns nothing when any token is absent (AND across tokens)', () => {
    const search = new SimpleSearch('Kelpwhist zzqqnotpresent', 100);
    search.add(PROBE_PATH, PROBE_BODY);
    expect(search.hits()).toEqual([]);
  });

  it('matches every note, with no spans and a score of 0, when the query holds no token', () => {
    const search = new SimpleSearch('   ', 100);
    search.add('a.md', 'alpha');
    search.add('b.md', '');
    expect(wire(search)).toEqual([
      { filename: 'a.md', score: 0, matches: [] },
      { filename: 'b.md', score: 0, matches: [] },
    ]);
  });
});

/**
 * The budget is the plugin's own ceiling. `/search/simple/` answers through
 * Express's `res.json` with `json spaces` 2, so the plugin fails once
 * `JSON.stringify(hits, null, 2)` passes V8's longest string. The budget is
 * measured here against that string, built from the port's own hits.
 */
describe('SimpleSearch response budget', () => {
  type Notes = ReadonlyArray<readonly [path: string, body: string]>;

  /** The plugin's response over `notes`, serialized as its Express app serializes it. */
  const response = (query: string, contextLength: number, notes: Notes) => {
    const search = new SimpleSearch(query, contextLength);
    for (const [path, body] of notes) search.add(path, body);
    return JSON.stringify(wire(search), null, 2);
  };

  /** The same search under `budget`: the hits, or the error it failed with. */
  const outcome = (query: string, contextLength: number, notes: Notes, budget: number) => {
    const search = new SimpleSearch(query, contextLength, budget);
    try {
      for (const [path, body] of notes) search.add(path, body);
    } catch (err) {
      return { failed: err, hits: search.hits().length };
    }
    return { held: search.hits().length };
  };

  it('fails many small windows whose characters alone fit: each match also costs its offsets and framing', () => {
    // 1,000 matches of 'e' at contextLength 1: the windows hold under 3,000 characters, the response over 140,000.
    const notes: Notes = [['n.md', 'e '.repeat(1_000)]];
    const unbounded = new SimpleSearch('e', 1);
    unbounded.add('n.md', 'e '.repeat(1_000));
    const [hit] = unbounded.hits();
    expect(hit?.matches).toHaveLength(1_000);
    expect(hit?.matches.reduce((n, m) => n + m.context.length, 0)).toBeLessThan(3_000);
    expect(response('e', 1, notes).length).toBeGreaterThan(140_000);
    expect(outcome('e', 1, notes, 10_000).failed).toMatchObject({
      data: { reason: 'context_length_too_large', contextLength: 1 },
    });
  });

  it('holds a response of exactly the budget and fails the note that passes it, across notes', () => {
    const notes: Notes = [
      ['one.md', 'ab ab ab ab'],
      ['two.md', 'ab ab ab ab'],
    ];
    const exact = response('ab', 100, notes).length;
    expect(outcome('ab', 100, notes, exact)).toEqual({ held: 2 });
    const past = outcome('ab', 100, notes, exact - 1);
    expect(past.hits).toBe(1);
    expect(past.failed).toMatchObject({
      data: { reason: 'context_length_too_large', contextLength: 100 },
    });
    expect((past.failed as Error).message).toContain('contextLength 100');
  });

  it('counts a filename span with its basename as the context, escaped', () => {
    const notes: Notes = [['dir/no"te.md', 'body']];
    const exact = response('no', 100, notes);
    expect(exact).toContain('"context": "no\\"te"');
    expect(outcome('no', 100, notes, exact.length)).toEqual({ held: 1 });
    expect(outcome('no', 100, notes, exact.length - 1).failed).toMatchObject({
      data: { reason: 'context_length_too_large' },
    });
  });

  /**
   * Random notes over an alphabet that reaches every part of the count:
   * quotes, backslashes, controls with a short escape and without one, emoji
   * (surrogate pairs) and lone surrogates at window edges, a character that
   * lower-cases to two, filename spans, spans dropped across the basename and
   * the body (a hit with no match), and a query of no token (every hit with no
   * match). Each search must hold at its exact response length and fail one
   * character short of it.
   */
  it('counts every part of the response exactly, whatever the notes hold', () => {
    const ALPHABET = [
      'e',
      'e',
      'x',
      ' ',
      ' ',
      '"',
      '\\',
      '\n',
      '\r',
      '\t',
      '\b',
      '\f',
      '\u0001',
      '\u001f',
      '\u007f',
      'é',
      'İ',
      '😀',
      '\ud800',
      '\udc00',
    ];
    const NAME = ['e', 'x', ' ', '"', '\\', 'é'];
    const QUERIES = ['e', 'e x', 'x e e', 'ee', '   ', 'e\n', '😀', '\ud800', 'é'];
    const random = seededRandom(0x5eed);
    const pick = <T>(from: readonly T[]) => from[Math.floor(random() * from.length)] as T;
    const text = (from: readonly string[], max: number) =>
      Array.from({ length: Math.floor(random() * max) }, () => pick(from)).join('');
    let failedChecks = 0;
    for (let round = 0; round < 400; round++) {
      const notes: Notes = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => [
        `d/${text(NAME, 6)}${i}.md`,
        text(ALPHABET, 80),
      ]);
      const query = pick(QUERIES);
      const contextLength = Math.floor(random() * 7);
      const exact = response(query, contextLength, notes).length;
      expect(outcome(query, contextLength, notes, exact), JSON.stringify({ round })).toHaveProperty(
        'held',
      );
      // An empty response, `[]`, is never charged: it fits any budget the plugin can have.
      if (exact === 2) continue;
      expect(
        outcome(query, contextLength, notes, exact - 1).failed,
        JSON.stringify({ round }),
      ).toMatchObject({ data: { reason: 'context_length_too_large' } });
      failedChecks++;
    }
    expect(failedChecks).toBeGreaterThan(300);
  });
});

/**
 * The scan runs over caller-sized note text and a caller-written query, so
 * each shape below is timed from 5k to 320k characters (`expectLinearCost`).
 * Every shape carries both line-break forms: one long line ending in a break,
 * and breaks throughout. Each sample runs the search a fixed number of times so
 * the smallest size still spends measurable thread CPU, and the parsed span
 * count is checked at every size, so a search that matched nothing would fail
 * rather than time nothing.
 */
describe('SimpleSearch scan time', () => {
  const fill = (unit: string, size: number) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const shapes: Array<{
    label: string;
    query: string;
    /** Searches per sample: enough that the 5k sample spends a few ms of CPU. */
    runs: number;
    build: (size: number) => string;
    spans: (body: string) => number;
  }> = [];
  for (const [form, tail, sep] of [
    ['one long line', '\ny', ' '],
    ['breaks throughout', '', '\r\n'],
  ] as const) {
    shapes.push(
      {
        label: `a token repeated across the text, ${form}`,
        query: 'qx',
        runs: 16,
        build: (size) => fill(`qx${sep}`, size) + tail,
        spans: (body) => body.split('qx').length - 1,
      },
      {
        label: `repeated openers that fail one character short, ${form}`,
        query: 'aaaaaaab',
        runs: 400,
        build: (size) => `${fill(`aaaaaaa${sep}`, size)}aaaaaaab${tail}`,
        spans: () => 1,
      },
      {
        // Sizes are multiples of both unit lengths, so no cut unit leaves a stray 'a' or 'aa' span.
        label: `tokens that are prefixes of each other, ${form}`,
        query: 'a aa aab',
        runs: 16,
        build: (size) => fill(`aab${sep}`, size) + tail,
        spans: (body) => body.split('aab').length - 1,
      },
    );
  }

  it.each(shapes)('stays linear: $label', async ({ query, runs, build, spans }) => {
    await expectLinearCost(build, (body) => {
      let found = 0;
      for (let run = 0; run < runs; run++) {
        const search = new SimpleSearch(query, 10);
        search.add('n.md', body);
        found = search.hits()[0]?.matches.length ?? 0;
      }
      expect(found).toBe(spans(body));
    });
  });
});

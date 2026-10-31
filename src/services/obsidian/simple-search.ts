/**
 * @fileoverview The Local REST API's `POST /search/simple/` run in-server, for
 * text searches under a read scope: plugin 5.2.0's `simpleSearch` over
 * Obsidian 1.14.5's `prepareSimpleSearch`. The query is lower-cased and split
 * on single spaces; a note matches when every token occurs in its lower-cased
 * `basename + "\n\n" + body`. Each token's occurrences are found by `indexOf`,
 * resuming one character past the end of the last, so an occurrence that
 * touches or overlaps the previous one is skipped; the occurrences of every
 * token are sorted and merged where they overlap or touch. A merged range
 * inside the basename is a `filename` span whose context is the basename, one
 * inside the body a `content` span with a `contextLength` window either side,
 * widened one code unit rather than split a surrogate pair, and one across the
 * two is dropped. Offsets index the lower-cased text, and windows are cut from
 * the original, as the plugin cuts them. Hits are ordered by Obsidian's score,
 * highest first, ties in the order notes were added (the plugin's vault order).
 * @module services/obsidian/simple-search
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** A span as `/search/simple/` reports it, plus where `match.start` sits in `context`. */
export interface SimpleSearchSpan {
  context: string;
  contextStart: number;
  match: { end: number; source: 'content' | 'filename'; start: number };
}

/** A note's `/search/simple/` hit. */
export interface SimpleSearchHit {
  filename: string;
  matches: SimpleSearchSpan[];
  score: number;
}

/**
 * Lengths of the fixed parts of the plugin's response, which its Express app
 * writes with `res.json` under `json spaces` 2, so `JSON.stringify(hits,
 * null, 2)`:
 *
 * ```text
 * [
 *   {
 *     "filename": "Folder/Note.md",
 *     "score": -1.2,
 *     "matches": [
 *       {
 *         "match": {
 *           "start": 12,
 *           "end": 17,
 *           "source": "content"
 *         },
 *         "context": "…"
 *       }
 *     ]
 *   }
 * ]
 * ```
 *
 * A hit or a span counts its separator, line break, and indentation, and its
 * keys and braces. Its values are counted where they are known.
 */
const RESPONSE_FRAME = 2;
const HIT_FRAME = 58;
/** A `matches` array with no span is `[]`; one with spans adds a line break and indentation before its `]`. */
const EMPTY_MATCHES = 2;
const MATCHES_FRAME = 6;
const SPAN_FRAME = 128;

/**
 * The query's tokens as `prepareSimpleSearch` reads them: lower-cased, split
 * on single spaces (a tab or newline stays inside its token), empty pieces
 * dropped. Repeats are dropped too: Obsidian scans a repeated token again, but
 * its ranges coincide with the first scan's and merge away.
 */
export function simpleSearchTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(' ').filter(Boolean))];
}

/**
 * Obsidian's note basename (`TFile.basename`): the file name less its last
 * `.extension`, the whole name when its only dot leads or trails it.
 */
function noteBasename(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? name : name.slice(0, dot);
}

export const isHighSurrogate = (cu: number) => cu >= 0xd800 && cu <= 0xdbff;
export const isLowSurrogate = (cu: number) => cu >= 0xdc00 && cu <= 0xdfff;

/**
 * Upstream's `widenToCodePointBoundaries`: grow `[start, end)` by at most one
 * code unit per side so neither edge splits a surrogate pair.
 */
function widen(text: string, start: number, end: number): [number, number] {
  let from = start;
  if (from > 0 && from < text.length && isLowSurrogate(text.charCodeAt(from))) from -= 1;
  let to = end;
  if (to > 0 && to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to += 1;
  return [from, to];
}

/** Characters `JSON.stringify` writes for a whole number: its decimal digits. */
function digits(n: number): number {
  let count = 1;
  for (let power = 10; power <= n; power *= 10) count++;
  return count;
}

/**
 * Characters `JSON.stringify` adds escaping `text[i]`: one for `"`, `\`, and
 * the controls with a short escape (`\b \t \n \f \r`), five for any other
 * control or a lone surrogate (`\uXXXX`).
 */
function escapeOverhead(text: string, i: number): number {
  const cu = text.charCodeAt(i);
  if (cu === 0x22 || cu === 0x5c) return 1;
  if (cu < 0x20) return cu >= 0x08 && cu <= 0x0d && cu !== 0x0b ? 1 : 5;
  if (isHighSurrogate(cu)) return isLowSurrogate(text.charCodeAt(i + 1)) ? 0 : 5;
  if (isLowSurrogate(cu)) return isHighSurrogate(text.charCodeAt(i - 1)) ? 0 : 5;
  return 0;
}

/**
 * Characters `JSON.stringify` adds escaping the window `text.slice(from, to)`,
 * for windows given in note order, where neither edge moves back. Two running
 * sums of `escapeOverhead` over the characters scanned so far, one per edge,
 * give each window as their difference: what windows share is scanned once,
 * and what no window covers is skipped. `escapeOverhead` reads a surrogate's
 * partner in the note; an edge that cuts a pair the note holds whole (`widen`
 * stops one code unit short when surrogates run three or more in a row)
 * leaves that half lone in the window, escaped too.
 */
function windowEscapes(text: string): (from: number, to: number) => number {
  let left = 0;
  let leftSum = 0;
  let right = 0;
  let rightSum = 0;
  return (from, to) => {
    if (from >= to) return 0;
    if (from >= right) {
      left = right = from;
      leftSum = rightSum;
    }
    for (; left < from; left++) leftSum += escapeOverhead(text, left);
    for (; right < to; right++) rightSum += escapeOverhead(text, right);
    let sum = rightSum - leftSum;
    if (isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) {
      sum += 5;
    }
    if (isHighSurrogate(text.charCodeAt(to - 1)) && isLowSurrogate(text.charCodeAt(to))) sum += 5;
    return sum;
  };
}

/**
 * The merged ranges `prepareSimpleSearch` reports for `text`, and its score;
 * `undefined` when some token does not occur. With no tokens every text
 * matches, with no ranges and a score of 0.
 */
function prepareSimpleSearch(
  tokens: readonly string[],
  queryLength: number,
  text: string,
): { ranges: Array<[number, number]>; score: number } | undefined {
  const lower = text.toLowerCase();
  const found: Array<[number, number]> = [];
  for (const token of tokens) {
    const before = found.length;
    for (
      let at = lower.indexOf(token);
      at !== -1;
      at = lower.indexOf(token, at + token.length + 1)
    ) {
      found.push([at, at + token.length]);
    }
    if (found.length === before) return;
  }
  // Array sort is stable, and ranges sharing a start merge alike in any order.
  found.sort((a, b) => a[0] - b[0]);
  const ranges: Array<[number, number]> = [];
  for (const range of found) {
    const last = ranges.at(-1);
    if (last === undefined || last[1] < range[0]) ranges.push(range);
    else if (last[1] < range[1]) last[1] = range[1];
  }
  return { ranges, score: score(ranges, queryLength, text.length) };
}

/** Obsidian's simple-search score, with its operations in its order so the result is bit-identical. */
function score(ranges: Array<[number, number]>, queryLength: number, textLength: number): number {
  const first = ranges[0];
  const last = ranges.at(-1);
  if (first === undefined || last === undefined) return 0;
  let s = 0;
  s -= Math.max(0, ranges.length - 1);
  s -= (last[1] - first[0] + 1 - queryLength) / 100;
  s -= first[0] / 1e3;
  s -= textLength / 1e4;
  return s;
}

/**
 * One text search over notes added in vault order, holding each hit's context
 * windows. `maxResponseChars` bounds the plugin's response for those hits, its
 * length as `JSON.stringify(hits, null, 2)` (see `HIT_FRAME`): every hit's
 * filename and score, every span's offsets and escaped window, and the framing
 * around each. The count grows span by span as each note is added, so the
 * span that passes the bound fails the search with `context_length_too_large`
 * at once, and no more spans are held than a response the plugin could send.
 */
export class SimpleSearch {
  readonly #contextLength: number;
  readonly #hits: SimpleSearchHit[] = [];
  readonly #maxResponseChars: number;
  readonly #queryLength: number;
  #responseChars = RESPONSE_FRAME;
  /** The distinct non-empty tokens; a note matches only when it holds every one. */
  readonly tokens: readonly string[];

  constructor(query: string, contextLength: number, maxResponseChars = Number.POSITIVE_INFINITY) {
    this.tokens = simpleSearchTokens(query);
    this.#queryLength = query.length;
    this.#contextLength = contextLength;
    this.#maxResponseChars = maxResponseChars;
  }

  /** Match one note, `body` as Obsidian's `cachedRead` gives it. */
  add(path: string, body: string): void {
    const basename = noteBasename(path);
    const prefix = `${basename}\n\n`;
    const result = prepareSimpleSearch(this.tokens, this.#queryLength, prefix + body);
    if (!result) return;
    this.#charge(
      HIT_FRAME + JSON.stringify(path).length + String(result.score).length + EMPTY_MATCHES,
    );
    const basenameJson = JSON.stringify(basename).length;
    const escapes = windowEscapes(body);
    const matches: SimpleSearchSpan[] = [];
    const chargeSpan = (start: number, end: number, source: string, contextJson: number) =>
      this.#charge(
        (matches.length === 0 ? MATCHES_FRAME - EMPTY_MATCHES : 0) +
          SPAN_FRAME +
          digits(start) +
          digits(end) +
          source.length +
          2 +
          contextJson,
      );
    for (const [s, e] of result.ranges) {
      if (s < prefix.length && e <= prefix.length) {
        const end = Math.min(e, basename.length);
        chargeSpan(s, end, 'filename', basenameJson);
        matches.push({
          context: basename,
          contextStart: s,
          match: { start: s, end, source: 'filename' },
        });
      } else if (s >= prefix.length) {
        const start = s - prefix.length;
        const end = e - prefix.length;
        const [from, widened] = widen(
          body,
          Math.max(start - this.#contextLength, 0),
          end + this.#contextLength,
        );
        const to = Math.min(widened, body.length);
        const context = body.slice(from, to);
        chargeSpan(start, end, 'content', 2 + context.length + escapes(from, to));
        matches.push({
          context,
          contextStart: start - from,
          match: { start, end, source: 'content' },
        });
      }
    }
    this.#hits.push({ filename: path, score: result.score, matches });
  }

  /** Add `chars` to the response, failing the search once it passes `maxResponseChars`. */
  #charge(chars: number): void {
    this.#responseChars += chars;
    if (this.#responseChars <= this.#maxResponseChars) return;
    throw validationError(
      `The matches for this search (contextLength ${this.#contextLength}) would take more than ${this.#maxResponseChars.toLocaleString('en-US')} characters to send across the readable notes, more than one response can carry. Each match costs its context window plus about 150 characters of offsets and framing, so the total tracks the number of matches as well as contextLength.`,
      { reason: 'context_length_too_large', contextLength: this.#contextLength },
    );
  }

  /** The hits, highest score first; equal scores keep the order their notes were added. */
  hits(): SimpleSearchHit[] {
    return this.#hits.toSorted((a, b) => b.score - a.score);
  }
}

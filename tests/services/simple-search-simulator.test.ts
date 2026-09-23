/**
 * @fileoverview Pins the test-side `/search/simple/` model to real Local REST
 * API 5.2.0 responses, so the search fixtures built from it elsewhere carry
 * upstream's actual span and window shapes rather than a guess at them.
 * @module tests/services/simple-search-simulator.test
 */

import { describe, expect, it } from 'vitest';
import {
  CAPTURE_QUERIES,
  type CaptureName,
  loadCapture,
  PROBE_BODY,
  PROBE_PATH,
  simulateSimpleSearch,
} from '../fixtures/simple-search/simulate.js';

describe('simulateSimpleSearch reproduces the captured upstream responses', () => {
  it.each(Object.keys(CAPTURE_QUERIES) as CaptureName[])('%s', (name) => {
    const captured = loadCapture(name);
    const { hits } = simulateSimpleSearch(
      [{ path: PROBE_PATH, body: PROBE_BODY }],
      CAPTURE_QUERIES[name],
      100,
    );
    expect(hits.map((h) => ({ filename: h.filename, matches: h.matches }))).toEqual(
      captured.map((h) => ({ filename: h.filename, matches: h.matches })),
    );
  });

  it('returns nothing when any token is absent (AND across tokens)', () => {
    const { hits } = simulateSimpleSearch(
      [{ path: PROBE_PATH, body: PROBE_BODY }],
      'Kelpwhist zzqqnotpresent',
      100,
    );
    expect(hits).toEqual([]);
  });
});

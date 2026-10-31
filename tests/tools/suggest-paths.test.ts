/**
 * @fileoverview Unit tests for the path-resolution helpers used by
 * obsidian_get_note / obsidian_open_in_ui.
 * @module tests/tools/suggest-paths.test
 */

import { forbidden, JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  didYouMean,
  findCaseVariants,
  findSimilarPaths,
  withCaseFallback,
} from '@/mcp-server/tools/definitions/_shared/suggest-paths.js';
import type { NoteTarget } from '@/services/obsidian/types.js';
import { expectLinearCost, rejectionOf, setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('findSimilarPaths', () => {
  it('returns case-insensitive basename matches', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/', method: 'GET' })
      .reply(200, { files: ['mynote.md', 'other.md', 'sub/'] });

    const out = await findSimilarPaths(
      createMockContext(),
      harness.current().service,
      'Notes/MyNote.md',
    );
    expect(out).toEqual(['Notes/mynote.md']);
  });

  it('returns extension-insensitive matches', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['mynote.md', 'README.md'] });

    const out = await findSimilarPaths(createMockContext(), harness.current().service, 'mynote');
    expect(out).toEqual(['mynote.md']);
  });

  it('returns empty when no candidates match', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['totally-different.md'] });

    const out = await findSimilarPaths(createMockContext(), harness.current().service, 'mynote.md');
    expect(out).toEqual([]);
  });

  it('returns empty when the parent directory listing fails', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/missing/', method: 'GET' })
      .reply(404, { message: 'no such directory' });

    const out = await findSimilarPaths(
      createMockContext(),
      harness.current().service,
      'missing/note.md',
    );
    expect(out).toEqual([]);
  });

  it('orders exact case-insensitive matches before extension-stripped matches', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['Mynote', 'MYNOTE.md'] });

    const out = await findSimilarPaths(createMockContext(), harness.current().service, 'mynote.md');
    expect(out).toEqual(['MYNOTE.md', 'Mynote']);
  });

  it('skips directory entries', async () => {
    // `mynote.assets/` strips to `mynote` like a file would, so only the skip keeps it out.
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['mynote.assets/', 'mynote.md'] });

    const out = await findSimilarPaths(createMockContext(), harness.current().service, 'MyNote');
    expect(out).toEqual(['mynote.md']);
  });
});

describe('withCaseFallback', () => {
  const path = (p: string): NoteTarget => ({ type: 'path', path: p });

  it("passes a non-path target's NotFound through without a case fallback", async () => {
    const orig = notFound('No active file', { reason: 'no_active_file' });
    await expect(
      withCaseFallback(
        createMockContext(),
        harness.current().service,
        { type: 'active' },
        async () => {
          throw orig;
        },
      ),
    ).rejects.toBe(orig);
  });

  it('returns target.path when the exact path resolves on the first try', async () => {
    let calls = 0;
    const out = await withCaseFallback(
      createMockContext(),
      harness.current().service,
      path('N.md'),
      async () => {
        calls++;
        return 'body';
      },
    );
    expect(calls).toBe(1);
    expect(out).toEqual({ result: 'body', resolvedPath: 'N.md' });
  });

  it('re-throws non-NotFound errors verbatim, even when a case match exists', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['n.md'] });

    const orig = forbidden('nope', { reason: 'x' });
    await expect(
      withCaseFallback(createMockContext(), harness.current().service, path('N.md'), async (t) => {
        if (t.type === 'path' && t.path === 'N.md') throw orig;
        return 'body';
      }),
    ).rejects.toBe(orig);
  });

  it('retries with the canonical path when a single case-insensitive match exists', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['n.md'] });

    let calls = 0;
    const seen: string[] = [];
    const out = await withCaseFallback(
      createMockContext(),
      harness.current().service,
      path('N.md'),
      async (t) => {
        calls++;
        if (t.type !== 'path') throw new Error('expected path target');
        seen.push(t.path);
        if (t.path === 'N.md') throw notFound('Not found: N.md', { path: 'N.md' });
        return `body-${t.path}`;
      },
    );
    expect(calls).toBe(2);
    expect(seen).toEqual(['N.md', 'n.md']);
    expect(out).toEqual({ result: 'body-n.md', resolvedPath: 'n.md', requestedPath: 'N.md' });
  });

  it('reports requestedPath only when it substituted another path', async () => {
    const exact = await withCaseFallback(
      createMockContext(),
      harness.current().service,
      path('N.md'),
      async () => 'body',
    );
    const passThrough = await withCaseFallback(
      createMockContext(),
      harness.current().service,
      { type: 'active' },
      async () => 'ok',
    );
    expect(exact).not.toHaveProperty('requestedPath');
    expect(passThrough).toEqual({ result: 'ok', resolvedPath: undefined });
    expect(passThrough).not.toHaveProperty('requestedPath');
  });

  it('throws Conflict when more than one case-insensitive match exists', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['note.md', 'NOTE.md', 'unrelated.md'] });

    await expect(
      withCaseFallback(
        createMockContext(),
        harness.current().service,
        path('Note.md'),
        async () => {
          throw notFound('Not found: Note.md', { path: 'Note.md' });
        },
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      message: expect.stringContaining('Ambiguous case-insensitive matches'),
      data: {
        path: 'Note.md',
        reason: 'ambiguous_path',
        matches: ['note.md', 'NOTE.md'],
      },
    });
  });

  it('enriches NotFound with suggestions when only extension-stripped near-matches exist', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['MyNote'] });

    await expect(
      withCaseFallback(
        createMockContext(),
        harness.current().service,
        path('MyNote.md'),
        async () => {
          throw notFound('Not found: MyNote.md', { path: 'MyNote.md' });
        },
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Did you mean: "MyNote"?'),
      data: { path: 'MyNote.md', suggestions: ['MyNote'] },
    });
  });

  it('re-throws the original NotFound when nothing close exists in the parent dir', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['totally-different.md'] });

    const orig = notFound('Not found: missing.md', { path: 'missing.md' });
    await expect(
      withCaseFallback(
        createMockContext(),
        harness.current().service,
        path('missing.md'),
        async () => {
          throw orig;
        },
      ),
    ).rejects.toBe(orig);
  });

  it('re-throws the original NotFound when the parent listing itself fails', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(500, { message: 'upstream blew up' });

    const orig = notFound('Not found: N.md', { path: 'N.md' });
    await expect(
      withCaseFallback(createMockContext(), harness.current().service, path('N.md'), async () => {
        throw orig;
      }),
    ).rejects.toBe(orig);
  });
});

describe('didYouMean', () => {
  it.each([
    ['a bare message', 'Not found: a.md', 'Not found: a.md'],
    ['a closing period', 'Not found: a.md.', 'Not found: a.md'],
    ['a closing period and spaces', 'Not found: a.md.  ', 'Not found: a.md'],
    ['two closing marks, of which one goes', 'Not found: a.md!?', 'Not found: a.md!'],
    ['a period then a spaced period', 'x. . ', 'x. '],
    ['a space before the closing period', 'x . \t', 'x '],
    ['a trailing no-break space and line separator', 'x.\u{a0}\u{2028}', 'x'],
    ['an interior space run', 'Not found: a   b.md', 'Not found: a   b.md'],
    ['whitespace only', ' \n ', ''],
    ['an empty message', '', ''],
  ])('drops what `/[.!?]?\\s*$/` drops from %s', (_label, message, kept) => {
    expect(message.replace(/[.!?]?\s*$/, '')).toBe(kept);
    expect(didYouMean(message, ['b.md', 'c'])).toBe(`${kept}. Did you mean: "b.md", "c"?`);
  });
});

/**
 * The probes trim a caller-sized path and the error message that names it, so
 * each is timed from 5k to 320k characters (`expectLinearCost`): a slash run
 * inside the path, and a space run inside the message.
 */
describe('path probes / cost', () => {
  it('lists the parent of a path holding a long slash run in linear time', async () => {
    await expectLinearCost(
      (n) => `x${'/'.repeat(n)}y.md`,
      async (target) => {
        harness
          .current()
          .pool.intercept({ path: '/vault/x/', method: 'GET' })
          .reply(200, { files: ['Y.md'] });
        const out = await findCaseVariants(createMockContext(), harness.current().service, target);
        expect(out).toEqual({ exact: false, variants: [`${target.slice(0, -4)}Y.md`] });
      },
    );
  });

  it('suggests a near match for a path holding a long space run in linear time', async () => {
    await expectLinearCost(
      (n) => `a${' '.repeat(n)}b.md`,
      async (target) => {
        const near = target.slice(0, -3);
        harness
          .current()
          .pool.intercept({ path: '/vault/', method: 'GET' })
          .reply(200, { files: [near] });
        const err = await rejectionOf(
          withCaseFallback(
            createMockContext(),
            harness.current().service,
            { type: 'path', path: target },
            async () => {
              throw notFound(`Not found: ${target}`, { path: target });
            },
          ),
        );
        expect(err.message).toBe(`Not found: ${target}. Did you mean: "${near}"?`);
      },
    );
  });
});

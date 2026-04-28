/**
 * @fileoverview Unit tests for the path-resolution helpers used by
 * obsidian_get_note / obsidian_delete_note / obsidian_open_in_ui.
 * @module tests/tools/suggest-paths.test
 */

import { forbidden, JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  findSimilarPaths,
  withCaseFallback,
} from '@/mcp-server/tools/definitions/_shared/suggest-paths.js';
import type { NoteTarget } from '@/services/obsidian/types.js';
import { setupHarness } from '../helpers.js';

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
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['mynote/', 'mynote.md'] });

    const out = await findSimilarPaths(createMockContext(), harness.current().service, 'MyNote');
    expect(out).toEqual(['mynote.md']);
  });
});

describe('withCaseFallback', () => {
  const path = (p: string): NoteTarget => ({ type: 'path', path: p });

  it('passes through non-path targets without listing the parent', async () => {
    const out = await withCaseFallback(
      createMockContext(),
      harness.current().service,
      { type: 'active' },
      async () => 'ok',
    );
    expect(out).toEqual({ result: 'ok', resolvedPath: undefined });
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

  it('re-throws non-NotFound errors verbatim', async () => {
    const orig = forbidden('nope', { reason: 'x' });
    await expect(
      withCaseFallback(createMockContext(), harness.current().service, path('N.md'), async () => {
        throw orig;
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
    expect(out).toEqual({ result: 'body-n.md', resolvedPath: 'n.md' });
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
      data: { path: 'Note.md', matches: ['note.md', 'NOTE.md'] },
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

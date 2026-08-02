/**
 * @fileoverview Handler tests for obsidian_delete_note (with optional elicit confirmation).
 * @module tests/tools/obsidian-delete-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { obsidianDeleteNote } from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import { ObsidianService, setObsidianService } from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, setupHarness } from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

describe('obsidian_delete_note', () => {
  it('deletes the note when no elicit capability is present', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(1234));

    let deleteCalls = 0;
    pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
      deleteCalls++;
      return { statusCode: 200, data: '' };
    });

    const out = await obsidianDeleteNote.handler(
      obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
      createMockContext(),
    );
    expect(deleteCalls).toBe(1);
    expect(out).toEqual({
      path: 'N.md',
      deleted: true,
      previousSizeInBytes: 1234,
      currentSizeInBytes: 0,
    });
  });

  it('proceeds with delete when elicit returns accept + confirm: true', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(500));

    let deleteCalls = 0;
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });
    pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
      deleteCalls++;
      return { statusCode: 200, data: '' };
    });

    const out = await obsidianDeleteNote.handler(
      obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
      createMockContext({ elicit }),
    );
    expect(elicit).toHaveBeenCalledOnce();
    /** Prompt text surfaces the byte count so the operator sees the blast radius. */
    expect(elicit.mock.calls[0]?.[0]).toContain('500 bytes');
    expect(deleteCalls).toBe(1);
    expect(out).toEqual({
      path: 'N.md',
      deleted: true,
      previousSizeInBytes: 500,
      currentSizeInBytes: 0,
    });
  });

  it('throws cancelled (InvalidRequest) and skips DELETE when the user declines elicit', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(500));

    let deleteCalls = 0;
    const elicit = vi.fn().mockResolvedValue({ action: 'reject' });
    pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
      deleteCalls++;
      return { statusCode: 200, data: '' };
    });

    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
        createMockContext({ elicit, errors: obsidianDeleteNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'cancelled' },
    });
    expect(deleteCalls).toBe(0);
  });

  it('treats accept-without-confirm as a cancellation', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(500));

    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: false } });
    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
        createMockContext({ elicit, errors: obsidianDeleteNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'cancelled' },
    });
  });

  it('throws note_missing when the pre-delete HEAD returns 404', async () => {
    harness.current().pool.intercept({ path: '/vault/Gone.md', method: 'HEAD' }).reply(404, '');

    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'Gone.md' } }),
        createMockContext({ errors: obsidianDeleteNote.errors }),
      ),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ reason: 'note_missing' }),
    });
  });

  /**
   * `DELETE /vault/<dir>` succeeds upstream and removes the folder with
   * everything under it, so the pre-delete probe has to recognize a folder and
   * stop before the request is sent — the assertion that matters is that no
   * DELETE was issued.
   */
  it('refuses a path that names a folder and issues no DELETE', async () => {
    const requests: string[] = [];
    setObsidianService(
      new ObsidianService(makeTestConfig(), async (url, init) => {
        requests.push(`${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`);
        return new Response('', {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': '226' },
        });
      }),
    );

    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'Inbox' } }),
        createMockContext({ errors: obsidianDeleteNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_is_directory', path: 'Inbox' },
    });
    expect(requests).toEqual(['HEAD /vault/Inbox']);
  });

  it('rejects a dot-segment path with path_traversal before any request', async () => {
    const requests: string[] = [];
    setObsidianService(
      new ObsidianService(makeTestConfig(), async (url) => {
        requests.push(new URL(url).pathname);
        return new Response('', { status: 200 });
      }),
    );

    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: '../outside.md' } }),
        createMockContext({ errors: obsidianDeleteNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
    expect(requests).toEqual([]);
  });
});

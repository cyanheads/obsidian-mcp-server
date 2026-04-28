/**
 * @fileoverview Handler tests for obsidian_delete_note (with optional elicit confirmation).
 * @module tests/tools/obsidian-delete-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { obsidianDeleteNote } from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const noteJson = (path: string) => ({
  path,
  content: 'body',
  frontmatter: {},
  tags: [],
  stat: { ctime: 0, mtime: 0, size: 0 },
});

describe('obsidian_delete_note', () => {
  it('deletes the note when no elicit capability is present', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('N.md'), { headers: { 'content-type': 'application/json' } });
    let deleteCalls = 0;
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'DELETE' })
      .reply(() => {
        deleteCalls++;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianDeleteNote.handler(
      obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
      createMockContext(),
    );
    expect(deleteCalls).toBe(1);
    expect(out).toEqual({ path: 'N.md', deleted: true });
  });

  it('proceeds with delete when elicit returns accept + confirm: true', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('N.md'), { headers: { 'content-type': 'application/json' } });
    let deleteCalls = 0;
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'DELETE' })
      .reply(() => {
        deleteCalls++;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianDeleteNote.handler(
      obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
      createMockContext({ elicit }),
    );
    expect(elicit).toHaveBeenCalledOnce();
    expect(deleteCalls).toBe(1);
    expect(out.deleted).toBe(true);
  });

  it('throws Forbidden and skips DELETE when the user declines elicit', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('N.md'), { headers: { 'content-type': 'application/json' } });
    const elicit = vi.fn().mockResolvedValue({ action: 'reject' });

    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
        createMockContext({ elicit }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
  });

  it('treats accept-without-confirm as a cancellation', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('N.md'), { headers: { 'content-type': 'application/json' } });
    const elicit = vi.fn().mockResolvedValue({ action: 'accept', content: { confirm: false } });
    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } }),
        createMockContext({ elicit }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
  });

  it('resolves a case-mismatch path through the fallback before deleting', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/MyNote.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['mynote.md'] });
    harness
      .current()
      .pool.intercept({ path: '/vault/mynote.md', method: 'GET' })
      .reply(200, noteJson('mynote.md'), { headers: { 'content-type': 'application/json' } });
    let deletedPath = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/mynote.md', method: 'DELETE' })
      .reply((opts) => {
        deletedPath = opts.path;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianDeleteNote.handler(
      obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'MyNote.md' } }),
      createMockContext(),
    );
    expect(deletedPath).toBe('/vault/mynote.md');
    expect(out).toEqual({ path: 'mynote.md', deleted: true });
  });

  it('enriches a 404 NotFound with `did you mean` candidates when no case match exists', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/MyNote.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['MyNote'] });

    await expect(
      obsidianDeleteNote.handler(
        obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'MyNote.md' } }),
        createMockContext(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Did you mean: "MyNote"?'),
      data: { suggestions: ['MyNote'] },
    });
  });
});

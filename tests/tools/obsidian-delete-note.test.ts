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

describe('obsidian_delete_note', () => {
  it('deletes the note when no elicit capability is present', async () => {
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

  it('throws cancelled (InvalidRequest) and skips DELETE when the user declines elicit', async () => {
    let deleteCalls = 0;
    const elicit = vi.fn().mockResolvedValue({ action: 'reject' });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'DELETE' })
      .reply(() => {
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
});

/**
 * @fileoverview Handler tests for obsidian_delete_note (multi-round-trip
 * confirmation via `ctx.requestInput` / `ctx.inputs`).
 * @module tests/tools/obsidian-delete-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, expectInputRequired } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianDeleteNote } from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import { ObsidianService, setObsidianService } from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse, setupHarness } from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });
const target = () =>
  obsidianDeleteNote.input.parse({ target: { type: 'path', path: 'N.md' } as const });

describe('obsidian_delete_note', () => {
  /**
   * Round one on every client: the handler suspends with an embedded
   * confirmation request and issues no DELETE. A client that cannot fulfil the
   * request — no input capability, no legacy elicitation shim — stops here, so
   * this also pins that the note survives an unanswered confirmation.
   */
  it('asks for confirmation and issues no DELETE on the first round', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(500));

    let deleteCalls = 0;
    pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
      deleteCalls++;
      return { statusCode: 200, data: '' };
    });

    const asked = await expectInputRequired(() =>
      obsidianDeleteNote.handler(
        target(),
        createMockContext({ errors: obsidianDeleteNote.errors }),
      ),
    );

    /** Prompt text surfaces the byte count so the operator sees the blast radius. */
    expect(asked.inputRequests?.confirm).toMatchObject({
      method: 'elicitation/create',
      params: { message: expect.stringContaining('500 bytes') },
    });
    expect(deleteCalls).toBe(0);
  });

  it('deletes on the retry round when the user confirms, on both output surfaces', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(1234));

    let deleteCalls = 0;
    pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
      deleteCalls++;
      return { statusCode: 200, data: '' };
    });

    const out = await obsidianDeleteNote.handler(
      target(),
      createMockContext({
        errors: obsidianDeleteNote.errors,
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
      }),
    );

    expect(deleteCalls).toBe(1);
    /** structuredContent — what clients like Claude Code forward. */
    expect(out).toEqual({
      path: 'N.md',
      deleted: true,
      previousSizeInBytes: 1234,
      currentSizeInBytes: 0,
    });
    /** content[] — the markdown twin clients like Claude Desktop forward. */
    expect(obsidianDeleteNote.format!(out)).toEqual([
      { type: 'text', text: '**Deleted N.md** (size: 1234 → 0 bytes)' },
    ]);
  });

  it.each(['decline', 'cancel'] as const)(
    'throws cancelled (InvalidRequest) and skips DELETE when the user sends %s',
    async (action) => {
      const pool = harness.current().pool;
      pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(500));

      let deleteCalls = 0;
      pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
        deleteCalls++;
        return { statusCode: 200, data: '' };
      });

      await expect(
        obsidianDeleteNote.handler(
          target(),
          createMockContext({
            errors: obsidianDeleteNote.errors,
            inputResponses: { confirm: { action } },
          }),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { reason: 'cancelled' },
      });
      expect(deleteCalls).toBe(0);
    },
  );

  it('treats accept-without-confirm as a cancellation', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(500));

    await expect(
      obsidianDeleteNote.handler(
        target(),
        createMockContext({
          errors: obsidianDeleteNote.errors,
          inputResponses: { confirm: { action: 'accept', content: { confirm: false } } },
        }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'cancelled' },
    });
  });

  /**
   * Content that fails `DeleteConfirmation` reads as "not answered yet", so the
   * handler re-asks rather than deleting on an unparseable answer.
   */
  it('re-asks when the confirmation content fails schema validation', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(500));

    let deleteCalls = 0;
    pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
      deleteCalls++;
      return { statusCode: 200, data: '' };
    });

    const asked = await expectInputRequired(() =>
      obsidianDeleteNote.handler(
        target(),
        createMockContext({
          errors: obsidianDeleteNote.errors,
          inputResponses: { confirm: { action: 'accept', content: { confirm: 'yes' } } },
        }),
      ),
    );
    expect(asked.inputRequests?.confirm).toMatchObject({ method: 'elicitation/create' });
    expect(deleteCalls).toBe(0);
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
        return mockResponse('', {
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
        return mockResponse('', { status: 200 });
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

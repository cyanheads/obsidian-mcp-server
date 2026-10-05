/**
 * @fileoverview Handler tests for obsidian_delete_note — the consent gate.
 * The handler acts on an accepted `confirm` answer only when the round also
 * redeems the `ctx.state` record it stored when it asked, and that record
 * names this operation, this caller, this path, and the note's current
 * content. Every other round is a fresh prompt.
 * @module tests/tools/obsidian-delete-note.test
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, expectInputRequired } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { obsidianDeleteNote } from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse } from '../helpers.js';

type AuthContext = NonNullable<Context['auth']>;
type MockOptions = NonNullable<Parameters<typeof createMockContext>[0]>;

const errors = obsidianDeleteNote.errors;
const accept = { confirm: { action: 'accept', content: { confirm: true } } };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const byPath = (path: string) => obsidianDeleteNote.input.parse({ target: { type: 'path', path } });

/**
 * An in-memory vault behind a real `ObsidianService`: `GET` and `HEAD` answer
 * a note the way the Local REST API does (with `Content-Disposition` and
 * `Content-Length`), `DELETE` removes it. `deleted` records every path a
 * DELETE reached.
 */
function installVault(notes: Record<string, string>): { deleted: string[]; notes: typeof notes } {
  const deleted: string[] = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/vault\//, ''));
    const method = (init.method ?? 'GET').toUpperCase();
    const content = notes[path];
    if (content === undefined) {
      return mockResponse(JSON.stringify({ message: 'Not Found', errorCode: 40400 }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'DELETE') {
      delete notes[path];
      deleted.push(path);
      return mockResponse(null, { status: 204 });
    }
    const headers = {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${path}"`,
      'content-length': String(Buffer.byteLength(content)),
    };
    return mockResponse(method === 'HEAD' ? null : content, { status: 200, headers });
  };
  setObsidianService(new ObsidianService(makeTestConfig(), fetchImpl));
  return { deleted, notes };
}

/** Round one: the prompt, plus the record it stored under the id it sent. */
async function askFor(path: string, opts: MockOptions = {}) {
  const first = createMockContext({ errors, ...opts });
  const asked = await expectInputRequired(() => obsidianDeleteNote.handler(byPath(path), first));
  const id = asked.requestState;
  const record = id === undefined ? null : await first.state.get(`consent/${id}`);
  return { asked, id, record };
}

/** A round-two context carrying `id`, with `record` copied into its storage. */
async function answerWith(id: string | undefined, record: unknown, opts: MockOptions = {}) {
  const ctx = createMockContext({
    errors,
    inputResponses: accept,
    ...(id === undefined ? {} : { requestState: id }),
    ...opts,
  });
  if (id !== undefined && record !== null) await ctx.state.set(`consent/${id}`, record);
  return ctx;
}

afterEach(() => {
  setObsidianService(undefined);
});

describe('obsidian_delete_note consent gate', () => {
  let vault: ReturnType<typeof installVault>;
  beforeEach(() => {
    vault = installVault({ 'N.md': '# Note\n\nbody\n', 'Other.md': 'other' });
  });

  it('asks on the first round, storing a record whose id rides as requestState', async () => {
    const { asked, id, record } = await askFor('N.md');

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(record).toEqual({
      operation: 'obsidian_delete_note',
      clientId: '',
      subject: '',
      target: 'N.md',
      contentHash: sha256('# Note\n\nbody\n'),
    });
    /** The prompt quotes the byte count so the user sees what they are destroying. */
    expect(asked.inputRequests?.confirm).toMatchObject({
      method: 'elicitation/create',
      params: { message: expect.stringContaining('13 bytes') },
    });
    expect(vault.deleted).toEqual([]);
  });

  it('deletes on a round that redeems the matching record, and spends the record', async () => {
    const { id, record } = await askFor('N.md');
    const second = await answerWith(id, record);

    const out = await obsidianDeleteNote.handler(byPath('N.md'), second);

    expect(vault.deleted).toEqual(['N.md']);
    expect(await second.state.get(`consent/${id}`)).toBeNull();
    /** structuredContent — what clients like Claude Code forward. */
    expect(out).toEqual({
      path: 'N.md',
      deleted: true,
      previousSizeInBytes: 13,
      currentSizeInBytes: 0,
    });
    /** content[] — the markdown twin clients like Claude Desktop forward. */
    expect(obsidianDeleteNote.format!(out)).toEqual([
      { type: 'text', text: '**Deleted N.md** (size: 13 → 0 bytes)' },
    ]);
  });

  it('a replayed id and answer delete nothing and ask afresh', async () => {
    const { id, record } = await askFor('N.md');
    const second = await answerWith(id, record);
    await obsidianDeleteNote.handler(byPath('N.md'), second);
    /** Restore the note so the replay has something it could delete. */
    vault.notes['N.md'] = '# Note\n\nbody\n';

    const replay = await expectInputRequired(() =>
      obsidianDeleteNote.handler(byPath('N.md'), second),
    );

    expect(vault.deleted).toEqual(['N.md']);
    expect(replay.requestState).toBeDefined();
    expect(replay.requestState).not.toBe(id);
  });

  it('a pre-answered accept with no requestState deletes nothing and asks', async () => {
    const asked = await expectInputRequired(() =>
      obsidianDeleteNote.handler(
        byPath('N.md'),
        createMockContext({ errors, inputResponses: accept }),
      ),
    );

    expect(asked.inputRequests?.confirm).toMatchObject({ method: 'elicitation/create' });
    expect(vault.deleted).toEqual([]);
  });

  it.each([
    ['an id nothing stored', randomUUID()],
    ['an id of the wrong shape', '../../etc'],
  ])('a pre-answered accept carrying %s deletes nothing and asks', async (_label, id) => {
    const asked = await expectInputRequired(() =>
      obsidianDeleteNote.handler(
        byPath('N.md'),
        createMockContext({ errors, inputResponses: accept, requestState: id }),
      ),
    );

    expect(asked.requestState).not.toBe(id);
    expect(vault.deleted).toEqual([]);
  });

  describe('a record that does not match this call asks afresh and deletes nothing', () => {
    it('minted for another path', async () => {
      const { id, record } = await askFor('Other.md');
      const second = await answerWith(id, record);

      const asked = await expectInputRequired(() =>
        obsidianDeleteNote.handler(byPath('N.md'), second),
      );

      expect(asked.requestState).not.toBe(id);
      expect(vault.deleted).toEqual([]);
    });

    it('minted for another operation', async () => {
      const { id, record } = await askFor('N.md');
      const second = await answerWith(id, { ...(record as object), operation: 'other_tool' });

      await expectInputRequired(() => obsidianDeleteNote.handler(byPath('N.md'), second));

      expect(vault.deleted).toEqual([]);
    });

    it('minted for another caller', async () => {
      const alice: AuthContext = { clientId: 'app', sub: 'alice', scopes: [] };
      const bob: AuthContext = { clientId: 'app', sub: 'bob', scopes: [] };
      const { id, record } = await askFor('N.md', { auth: alice });
      const second = await answerWith(id, record, { auth: bob });

      await expectInputRequired(() => obsidianDeleteNote.handler(byPath('N.md'), second));

      expect(vault.deleted).toEqual([]);
    });

    it('minted before the note content changed', async () => {
      const { id, record } = await askFor('N.md');
      vault.notes['N.md'] = '# Note\n\nrewritten since the prompt\n';
      const second = await answerWith(id, record);

      const asked = await expectInputRequired(() =>
        obsidianDeleteNote.handler(byPath('N.md'), second),
      );

      expect(vault.deleted).toEqual([]);
      expect(await second.state.get(`consent/${asked.requestState}`)).toMatchObject({
        contentHash: sha256('# Note\n\nrewritten since the prompt\n'),
      });
    });
  });

  it.each(['decline', 'cancel'] as const)(
    'a %s on a matching round fails with cancelled instead of asking again',
    async (action) => {
      const { id, record } = await askFor('N.md');
      const second = await answerWith(id, record, { inputResponses: { confirm: { action } } });

      await expect(obsidianDeleteNote.handler(byPath('N.md'), second)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { reason: 'cancelled', path: 'N.md' },
      });
      expect(vault.deleted).toEqual([]);
    },
  );

  it('confirm: false on a matching round fails with cancelled', async () => {
    const { id, record } = await askFor('N.md');
    const second = await answerWith(id, record, {
      inputResponses: { confirm: { action: 'accept', content: { confirm: false } } },
    });

    await expect(obsidianDeleteNote.handler(byPath('N.md'), second)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'cancelled' },
    });
    expect(vault.deleted).toEqual([]);
  });

  /**
   * Content that fails `DeleteConfirmation` reads as "not answered", so the
   * handler asks again rather than deleting on an unparseable answer.
   */
  it('asks again when the answer fails schema validation', async () => {
    const { id, record } = await askFor('N.md');
    const second = await answerWith(id, record, {
      inputResponses: { confirm: { action: 'accept', content: { confirm: 'yes' } } },
    });

    await expectInputRequired(() => obsidianDeleteNote.handler(byPath('N.md'), second));
    expect(vault.deleted).toEqual([]);
  });

  it('throws note_missing before any prompt, storing no record', async () => {
    const ctx = createMockContext({ errors });

    await expect(obsidianDeleteNote.handler(byPath('Gone.md'), ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'note_missing' }),
    });
    expect((await ctx.state.list('consent/')).items).toEqual([]);
  });
});

describe('obsidian_delete_note path guards', () => {
  /**
   * `DELETE /vault/<dir>` succeeds upstream and removes the folder with
   * everything under it, so the pre-delete read has to recognize a folder and
   * stop before the request is sent — the assertion that matters is that no
   * DELETE was issued.
   */
  it('refuses a path that names a folder and issues no DELETE', async () => {
    const requests: string[] = [];
    setObsidianService(
      new ObsidianService(makeTestConfig(), async (url, init) => {
        requests.push(`${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`);
        return mockResponse('{"files":[]}', {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }),
    );

    await expect(
      obsidianDeleteNote.handler(byPath('Inbox'), createMockContext({ errors })),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_is_directory', path: 'Inbox' },
    });
    expect(requests.some((r) => r.startsWith('DELETE'))).toBe(false);
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
      obsidianDeleteNote.handler(byPath('../outside.md'), createMockContext({ errors })),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
    expect(requests).toEqual([]);
  });
});

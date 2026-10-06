/**
 * @fileoverview Handler tests for obsidian_delete_note in both modes of
 * `OBSIDIAN_DELETE_ELICITATION`.
 *
 * On (`buildDeleteNoteTool({ elicitation: true })`) — the consent gate. The
 * handler acts on an accepted `confirm` answer only when the round also
 * redeems the `ctx.state` record it stored when it asked, and that record
 * names this operation, this caller, this path, and the note's current
 * content. Every other round is a fresh prompt. Write scope is checked on the
 * resolved path before any prompt.
 *
 * Off (the default build, `obsidianDeleteNote`) — one call checks write scope,
 * reads the note, and deletes, with no prompt and nothing stored.
 * @module tests/tools/obsidian-delete-note.test
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { Headers } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  buildDeleteNoteTool,
  obsidianDeleteNote as defaultDeleteNote,
} from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import {
  contractErrorOf,
  makeTestConfig,
  mockResponse,
  noteJson,
  rejectionOf,
} from '../helpers.js';

type AuthContext = NonNullable<Context['auth']>;
type MockOptions = NonNullable<Parameters<typeof createMockContext>[0]>;

/**
 * The consent-gate suites below run against the confirming build — what
 * `OBSIDIAN_DELETE_ELICITATION=true` registers.
 */
const obsidianDeleteNote = buildDeleteNoteTool({ elicitation: true });

const errors = obsidianDeleteNote.errors;
const accept = { confirm: { action: 'accept', content: { confirm: true } } };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const byPath = (path: string) => obsidianDeleteNote.input.parse({ target: { type: 'path', path } });

interface VaultOptions {
  /** Vault path of the note open in Obsidian — what an `active` target resolves to. */
  active?: string;
  /**
   * Resolve raw-markdown reads and DELETEs case-insensitively, the way the
   * plugin's `adapter.stat` / `adapter.exists` / `adapter.remove` behave on a
   * case-insensitive filesystem (APFS, NTFS). `note+json` reads and folder
   * listings stay case-sensitive, as Obsidian's vault index is.
   */
  caseFolding?: boolean;
  /** Path-policy and other config for the service under test. */
  config?: Partial<ServerConfig>;
  /** Vault path of today's daily note — what a `periodic` daily target resolves to. */
  daily?: string;
  /**
   * Content `note+json` serves per path in place of the file's own bytes —
   * Obsidian's `cachedRead` before its file watcher has seen a change made
   * outside Obsidian (sync, git, another editor).
   */
  staleCache?: Record<string, string>;
}

/**
 * An in-memory vault behind a real `ObsidianService`: `GET` and `HEAD` answer
 * a note the way the Local REST API does (with `Content-Disposition` and
 * `Content-Length`, and as `note+json` when asked for it), `DELETE` removes
 * it, and `GET /vault/<dir>/` lists a folder. `deleted` records every path a
 * DELETE reached; `requests` records every request as `METHOD pathname`.
 * `/active/` and `/periodic/daily/` answer the note `active` / `daily` names.
 */
function installVault(
  notes: Record<string, string>,
  opts: VaultOptions = {},
): { deleted: string[]; notes: typeof notes; requests: string[] } {
  const deleted: string[] = [];
  const requests: string[] = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    const pathname = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push(`${method} ${pathname}`);
    const alias =
      pathname === '/active/' ? opts.active : pathname === '/periodic/daily/' ? opts.daily : null;
    if (alias !== null) {
      const aliased = alias === undefined ? undefined : notes[alias];
      if (alias === undefined || aliased === undefined) {
        return mockResponse(JSON.stringify({ message: 'Not Found', errorCode: 40400 }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Headers(init.headers).get('accept')?.includes('json')
        ? mockResponse(JSON.stringify(noteJson(alias, aliased)), {
            status: 200,
            headers: { 'content-type': 'application/vnd.olrapi.note+json' },
          })
        : mockResponse(aliased, {
            status: 200,
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
          });
    }
    const requested = decodeURIComponent(pathname.replace(/^\/vault\//, ''));
    const wantsJson = new Headers(init.headers).get('accept')?.includes('json') ?? false;
    if (requested.endsWith('/') || requested === '') {
      const files = Object.keys(notes)
        .filter((p) => p.startsWith(requested) && !p.slice(requested.length).includes('/'))
        .map((p) => p.slice(requested.length));
      return mockResponse(JSON.stringify({ files }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const folded =
      opts.caseFolding && !wantsJson
        ? Object.keys(notes).find((p) => p.toLowerCase() === requested.toLowerCase())
        : undefined;
    const path = folded ?? requested;
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
    const disposition = `attachment; filename="${path}"`;
    if (wantsJson) {
      return mockResponse(JSON.stringify(noteJson(path, opts.staleCache?.[path] ?? content)), {
        status: 200,
        headers: {
          'content-type': 'application/vnd.olrapi.note+json',
          'content-disposition': disposition,
        },
      });
    }
    const headers = {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': disposition,
      'content-length': String(Buffer.byteLength(content)),
    };
    return mockResponse(method === 'HEAD' ? null : content, { status: 200, headers });
  };
  setObsidianService(new ObsidianService(makeTestConfig(opts.config), fetchImpl));
  return { deleted, notes, requests };
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

    it("minted before a change Obsidian's metadata cache has not seen yet", async () => {
      const staleCache: Record<string, string> = {};
      vault = installVault({ 'N.md': '# Note\n\nbody\n' }, { staleCache });
      const { id, record } = await askFor('N.md');
      /** Rewritten outside Obsidian: the file changed, `cachedRead` still serves the old text. */
      staleCache['N.md'] = '# Note\n\nbody\n';
      vault.notes['N.md'] = '# Note\n\nrewritten outside Obsidian\n';
      const second = await answerWith(id, record);

      const asked = await expectInputRequired(() =>
        obsidianDeleteNote.handler(byPath('N.md'), second),
      );

      expect(vault.deleted).toEqual([]);
      expect(await second.state.get(`consent/${asked.requestState}`)).toMatchObject({
        contentHash: sha256('# Note\n\nrewritten outside Obsidian\n'),
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

const NOTE_PATH = 'Projects/N.md';
const NOTE_BODY = '# Note\n\nbody\n';

/** Every target form, each resolving to `NOTE_PATH` in the vault `installTargets` builds. */
const TARGETS = [
  ['path', { type: 'path', path: NOTE_PATH }],
  ['active', { type: 'active' }],
  ['periodic', { type: 'periodic', period: 'daily' }],
] as const;

/** One note, open in Obsidian and serving as today's daily note. */
const installTargets = (config: Partial<ServerConfig> = {}) =>
  installVault(
    { [NOTE_PATH]: NOTE_BODY, 'Inbox/Other.md': 'other' },
    { config, active: NOTE_PATH, daily: NOTE_PATH },
  );

describe('obsidian_delete_note with the confirmation on, other target types', () => {
  it.each(TARGETS)(
    'a %s target asks for the resolved path and deletes it on the redeeming round',
    async (_label, target) => {
      const vault = installTargets();
      const input = obsidianDeleteNote.input.parse({ target });
      const first = createMockContext({ errors });

      const asked = await expectInputRequired(() => obsidianDeleteNote.handler(input, first));
      const record = await first.state.get(`consent/${asked.requestState}`);
      expect(record).toMatchObject({ target: NOTE_PATH, contentHash: sha256(NOTE_BODY) });
      expect(vault.deleted).toEqual([]);

      const second = await answerWith(asked.requestState as string, record);
      const out = await obsidianDeleteNote.handler(input, second);

      expect(out).toEqual({
        path: NOTE_PATH,
        deleted: true,
        previousSizeInBytes: 13,
        currentSizeInBytes: 0,
      });
      expect(vault.deleted).toEqual([NOTE_PATH]);
    },
  );
});

describe('obsidian_delete_note with the confirmation on checks write scope before asking', () => {
  it.each(TARGETS)(
    'a readable %s target outside OBSIDIAN_WRITE_PATHS fails path_forbidden on the first call',
    async (label, target) => {
      const vault = installTargets({ writePaths: ['inbox'] });
      const ctx = createMockContext({ errors });

      await expect(
        obsidianDeleteNote.handler(obsidianDeleteNote.input.parse({ target }), ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
        data: {
          reason: 'path_forbidden',
          path: NOTE_PATH,
          op: 'write',
          subreason: 'outside_write_paths',
        },
      });
      expect((await ctx.state.list('consent/')).items).toEqual([]);
      expect(vault.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
      /** A path target needs no upstream call to know its scope; the others resolve once. */
      expect(vault.requests).toEqual(
        label === 'path' ? [] : [`GET ${label === 'active' ? '/active/' : '/periodic/daily/'}`],
      );
    },
  );
});

describe('obsidian_delete_note with the confirmation off (the default build)', () => {
  it('describes the mode it runs in', () => {
    expect(defaultDeleteNote.description).toBe(
      'Permanently delete a note from the vault. Deletes on the first call without asking the user to confirm. Recovery requires the local trash in Obsidian — there is no API-level undo.',
    );
    expect(obsidianDeleteNote.description).toBe(
      'Permanently delete a note from the vault. Asks the user to confirm before deleting — the call is answered with a confirmation request and retried with the answer. Recovery requires the local trash in Obsidian — there is no API-level undo.',
    );
  });

  it('declares `cancelled` only in the mode that can throw it', () => {
    const reasons = (def: { errors?: readonly { reason: string }[] }) =>
      (def.errors ?? []).map((e) => e.reason);
    expect(reasons(defaultDeleteNote)).not.toContain('cancelled');
    expect(reasons(obsidianDeleteNote)).toContain('cancelled');
    expect(reasons(defaultDeleteNote)).toEqual(
      reasons(obsidianDeleteNote).filter((r) => r !== 'cancelled'),
    );
  });

  it.each(TARGETS)(
    'a %s target is deleted in one call, with no prompt and nothing stored',
    async (_label, target) => {
      const vault = installTargets();
      const ctx = createMockContext({ errors: defaultDeleteNote.errors });

      const out = await defaultDeleteNote.handler(defaultDeleteNote.input.parse({ target }), ctx);

      expect(out).toEqual({
        path: NOTE_PATH,
        deleted: true,
        previousSizeInBytes: 13,
        currentSizeInBytes: 0,
      });
      expect(vault.deleted).toEqual([NOTE_PATH]);
      expect((await ctx.state.list('')).items).toEqual([]);
    },
  );

  it('ignores a pre-answered decline and a stray requestState, storing nothing', async () => {
    const vault = installTargets();
    const ctx = createMockContext({
      errors: defaultDeleteNote.errors,
      inputResponses: { confirm: { action: 'decline' } },
      requestState: randomUUID(),
    });

    await defaultDeleteNote.handler(
      defaultDeleteNote.input.parse({ target: { type: 'path', path: NOTE_PATH } }),
      ctx,
    );

    expect(vault.deleted).toEqual([NOTE_PATH]);
    expect((await ctx.state.list('')).items).toEqual([]);
  });

  it('returns the same result on structuredContent and content[]', async () => {
    installTargets();

    const res = await runToolContract(defaultDeleteNote, {
      target: { type: 'path', path: NOTE_PATH },
    });

    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toEqual({
      path: NOTE_PATH,
      deleted: true,
      previousSizeInBytes: 13,
      currentSizeInBytes: 0,
    });
    expect(res.content).toEqual([
      { type: 'text', text: '**Deleted Projects/N.md** (size: 13 → 0 bytes)' },
    ]);
  });

  it.each(TARGETS)(
    'a %s target outside OBSIDIAN_WRITE_PATHS fails path_forbidden and sends no DELETE',
    async (_label, target) => {
      const vault = installTargets({ writePaths: ['inbox'] });

      await expect(
        defaultDeleteNote.handler(
          defaultDeleteNote.input.parse({ target }),
          createMockContext({ errors: defaultDeleteNote.errors }),
        ),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'path_forbidden', path: NOTE_PATH, subreason: 'outside_write_paths' },
      });
      expect(vault.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
      expect(vault.notes[NOTE_PATH]).toBe(NOTE_BODY);
    },
  );

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
      defaultDeleteNote.handler(
        defaultDeleteNote.input.parse({ target: { type: 'path', path: 'Inbox' } }),
        createMockContext({ errors: defaultDeleteNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_is_directory', path: 'Inbox' },
    });
    expect(requests).toEqual(['GET /vault/Inbox']);
  });

  it('throws note_missing for a path that is already gone and sends no DELETE', async () => {
    const vault = installTargets();

    await expect(
      defaultDeleteNote.handler(
        defaultDeleteNote.input.parse({ target: { type: 'path', path: 'Gone.md' } }),
        createMockContext({ errors: defaultDeleteNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'note_missing' }),
    });
    expect(vault.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  });
});

/**
 * On a case-insensitive filesystem the plugin's raw-markdown read and its
 * v4.x `DELETE` (`adapter.exists` + `adapter.remove`) both case-fold, so a
 * wrong-case path would read the real note and then permanently remove it.
 * `note+json` resolves through Obsidian's case-sensitive vault index, so a
 * delete that reads through it stops before any DELETE is sent.
 */
describe('obsidian_delete_note on a case-folding filesystem', () => {
  const REAL = 'Projects/mcp-delcase.md';
  const WRONG = 'Projects/MCP-DelCase.md';

  it.each([
    ['off', defaultDeleteNote],
    ['on', obsidianDeleteNote],
  ] as const)(
    'with the confirmation %s, a wrong-case path fails note_missing naming the exact path and sends no DELETE',
    async (_mode, tool) => {
      const vault = installVault({ [REAL]: NOTE_BODY }, { caseFolding: true });
      const ctx = createMockContext({ errors: tool.errors });

      const err = await rejectionOf(
        (async () =>
          tool.handler(tool.input.parse({ target: { type: 'path', path: WRONG } }), ctx))(),
      );

      expect(err).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'note_missing', suggestions: [REAL] },
      });
      expect(err.message).toBe(`Not found: ${WRONG}. Did you mean: "${REAL}"?`);
      expect(vault.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
      expect(vault.notes[REAL]).toBe(NOTE_BODY);
      expect((await ctx.state.list('consent/')).items).toEqual([]);
    },
  );

  it('lists only near matches inside OBSIDIAN_READ_PATHS in suggestions', async () => {
    /** The scope is the one note; its folder also holds an out-of-scope extension-stripped match. */
    const vault = installVault(
      { [REAL]: NOTE_BODY, 'Projects/mcp-delcase.txt': 'private' },
      { caseFolding: true, config: { readPaths: ['projects/mcp-delcase.md'] } },
    );

    const err = await rejectionOf(
      (async () =>
        defaultDeleteNote.handler(
          defaultDeleteNote.input.parse({ target: { type: 'path', path: WRONG } }),
          createMockContext({ errors: defaultDeleteNote.errors }),
        ))(),
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'note_missing', suggestions: [REAL] },
    });
    expect(err.message).toBe(`Not found: ${WRONG}. Did you mean: "${REAL}"?`);
    expect(vault.requests).toContain('GET /vault/Projects/');
    expect(vault.requests.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  });

  it('the exact path still deletes in one call', async () => {
    const vault = installVault({ [REAL]: NOTE_BODY }, { caseFolding: true });

    const res = await runToolContract(defaultDeleteNote, {
      target: { type: 'path', path: REAL },
    });

    expect(res.structuredContent).toEqual({
      path: REAL,
      deleted: true,
      previousSizeInBytes: 13,
      currentSizeInBytes: 0,
    });
    expect(vault.deleted).toEqual([REAL]);
  });

  it('a wrong-case path carries the recovery hint on the wire', async () => {
    installVault({ [REAL]: NOTE_BODY }, { caseFolding: true });

    const error = await contractErrorOf(defaultDeleteNote, {
      target: { type: 'path', path: WRONG },
    });

    expect(error.data).toMatchObject({
      reason: 'note_missing',
      suggestions: [REAL],
      recovery: {
        hint: 'Verify the path with obsidian_list_notes or use obsidian_search_notes to locate the note. Deletes match the path exactly, letter case included; pass a path from `suggestions` as given.',
      },
    });
  });
});

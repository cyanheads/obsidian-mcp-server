/**
 * @fileoverview Service-level path-policy integration tests. Constructs
 * `ObsidianService` with custom path config and verifies that gated methods
 * throw `path_forbidden` before hitting the upstream, while in-scope paths
 * pass through.
 * @module tests/services/obsidian-service-path-policy.test
 */

import { Worker } from 'node:worker_threads';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { Headers } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { obsidianGetNote } from '@/mcp-server/tools/definitions/obsidian-get-note.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { PathPolicy } from '@/services/obsidian/path-policy.js';
import type { NoteTarget } from '@/services/obsidian/types.js';
import {
  CAPTURE_QUERIES,
  type CaptureName,
  loadCapture,
  loadRuleCaptures,
  PROBE_BODY,
  PROBE_PATH,
  type RawHit,
  simulateSimpleSearch,
} from '../fixtures/simple-search/simulate.js';
import {
  deepNoteFetch,
  jsonLogicVault,
  type MockResponse,
  makeTestConfig,
  mockResponse,
  NON_PATH_TARGETS,
  rejectionOf,
  type VaultNote,
} from '../helpers.js';

let ctx: Context;
let upstreamHits = 0;

beforeEach(() => {
  ctx = createMockContext();
  upstreamHits = 0;
});

afterEach(() => {
  setObsidianService(undefined);
  vi.restoreAllMocks();
});

function buildService(
  config: Partial<ServerConfig>,
  scriptedReplies?: Map<string, () => MockResponse>,
) {
  const fetchImpl: ObsidianFetch = async (url) => {
    upstreamHits++;
    const u = new URL(url);
    const reply = scriptedReplies?.get(u.pathname);
    if (reply) return reply();
    throw new Error(`No mock reply for ${u.pathname}`);
  };
  return new ObsidianService(makeTestConfig(config), fetchImpl);
}

describe('write tools — assertWritable before upstream', () => {
  it('blocks writeNote on a path outside writePaths without making an HTTP call', async () => {
    const svc = buildService({ writePaths: ['projects'] });
    await expect(
      svc.writeNote(ctx, { type: 'path', path: 'secret/foo.md' }, 'x'),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden', subreason: 'outside_write_paths' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('allows writeNote on a path inside writePaths', async () => {
    const replies = new Map<string, () => MockResponse>([
      ['/vault/projects/foo.md', () => mockResponse('', { status: 200 })],
    ]);
    const svc = buildService({ writePaths: ['projects'] }, replies);
    await svc.writeNote(ctx, { type: 'path', path: 'projects/foo.md' }, 'x');
    expect(upstreamHits).toBe(1);
  });

  it('blocks deleteNote on a path outside writePaths', async () => {
    const svc = buildService({ writePaths: ['projects'] });
    await expect(
      svc.deleteNote(ctx, { type: 'path', path: 'secret/foo.md' }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
    expect(upstreamHits).toBe(0);
  });

  it('READ_ONLY=true short-circuits writeNote with read_only_mode subreason', async () => {
    const svc = buildService({ readOnly: true });
    await expect(
      svc.writeNote(ctx, { type: 'path', path: 'projects/foo.md' }, 'x'),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden', subreason: 'read_only_mode' },
    });
    expect(upstreamHits).toBe(0);
  });
});

describe('read tools — assertReadable before upstream', () => {
  it('blocks getNoteContent on a path outside readPaths, echoing the caller path', async () => {
    const svc = buildService({ readPaths: ['public'] });
    await expect(
      svc.getNoteContent(ctx, { type: 'path', path: 'secret/foo.md' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      message: "Path 'secret/foo.md' is not readable: outside OBSIDIAN_READ_PATHS.",
      data: { reason: 'path_forbidden', subreason: 'outside_read_paths', path: 'secret/foo.md' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('blocks openInUi on a path outside readPaths', async () => {
    const svc = buildService({ readPaths: ['public'] });
    await expect(svc.openInUi(ctx, 'secret/foo.md')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
    expect(upstreamHits).toBe(0);
  });

  it('listFiles allows the vault root regardless of readPaths', async () => {
    const replies = new Map<string, () => MockResponse>([
      [
        '/vault/',
        () =>
          mockResponse(JSON.stringify({ files: ['projects/', 'secret/', 'note.md'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ],
    ]);
    const svc = buildService({ readPaths: ['projects'] }, replies);
    const out = await svc.listFiles(ctx);
    expect(out.files).toContain('projects/');
    /** Entries are filtered at the service level, so every consumer of a listing inherits the scope. */
    expect(out.files).not.toContain('secret/');
    expect(out.files).not.toContain('note.md');
  });

  it('listFiles blocks a non-root dir outside readPaths', async () => {
    const svc = buildService({ readPaths: ['projects'] });
    await expect(svc.listFiles(ctx, 'secret')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
    expect(upstreamHits).toBe(0);
  });
});

/** A nested scope `projects/work`: its parent folder is the path to it, nothing more. */
describe('listFiles — folders on the way to the read scope', () => {
  const listing = (files: string[]) => () =>
    mockResponse(JSON.stringify({ files }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('lists an ancestor folder, returning only the scoped child', async () => {
    const replies = new Map([['/vault/Projects/', listing(['Work/', 'Other/', 'readme.md'])]]);
    const svc = buildService({ readPaths: ['projects/work'] }, replies);
    expect(await svc.listFiles(ctx, 'Projects')).toEqual({ files: ['Work/'] });
    expect(upstreamHits).toBe(1);
  });

  it('refuses a sibling of the scope and a string-prefix folder before any upstream call', async () => {
    const svc = buildService({ readPaths: ['projects/work'] });
    for (const dir of ['Projects/Other', 'Proj']) {
      await expect(svc.listFiles(ctx, dir)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'path_forbidden', subreason: 'outside_read_paths' },
      });
    }
    expect(upstreamHits).toBe(0);
  });

  it('leaves listings untouched when OBSIDIAN_READ_PATHS is unset', async () => {
    const files = ['todo.md', 'Private/', 'Projects/'];
    const svc = buildService(
      { writePaths: ['projects/work'] },
      new Map([['/vault/', listing(files)]]),
    );
    expect(await svc.listFiles(ctx)).toEqual({ files });
  });
});

/**
 * The case-fallback probe in `obsidian_get_note` lists the requested note's
 * folder through `listFiles`. Under a file scope that folder is an ancestor,
 * so its listing must already be filtered — otherwise the probe would offer
 * out-of-scope siblings as "did you mean" suggestions.
 */
describe('case-fallback probe inherits the listFiles filter', () => {
  const SIBLINGS = ['plan.txt', 'salary.md', 'Sub/'];

  /** `Work/` holds `SIBLINGS`, plus `plan.md` when `planExists`. Scope: `work/plan.md`. */
  function probeService(planExists: boolean) {
    const paths: string[] = [];
    const fetchImpl: ObsidianFetch = async (url) => {
      const path = decodeURIComponent(new URL(url).pathname);
      paths.push(path);
      if (path === '/vault/Work/') {
        const files = planExists ? ['plan.md', ...SIBLINGS] : SIBLINGS;
        return mockResponse(JSON.stringify({ files }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (planExists && path === '/vault/Work/plan.md') {
        return mockResponse('# Plan', {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        });
      }
      return mockResponse(JSON.stringify({ message: 'Not Found', errorCode: 40400 }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work/plan.md'] }), fetchImpl);
    setObsidianService(svc);
    return paths;
  }

  const getNote = async (path: string) =>
    await obsidianGetNote.handler(
      obsidianGetNote.input.parse({ target: { type: 'path', path }, format: 'content' }),
      createMockContext({ errors: obsidianGetNote.errors }),
    );

  it('resolves a miscased in-scope note through the ancestor listing', async () => {
    const paths = probeService(true);
    const out = await getNote('Work/PLAN.md');
    expect(JSON.stringify(out)).toContain('# Plan');
    expect(paths).toEqual(['/vault/Work/PLAN.md', '/vault/Work/', '/vault/Work/plan.md']);
  });

  it('suggests no out-of-scope sibling for a missing in-scope note', async () => {
    const paths = probeService(false);
    const err = await rejectionOf<McpError>(getNote('Work/plan.md'));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.message).not.toMatch(/Did you mean/);
    expect(JSON.stringify(err.data ?? {})).not.toMatch(/plan\.txt|salary|Sub/);
    // The probe did list the folder — the filter, not a refused listing, kept the siblings out.
    expect(paths).toEqual(['/vault/Work/plan.md', '/vault/Work/']);
  });
});

/**
 * Per-note tag lists as the plugin's note context carries them: deduplicated
 * within a note, no `#`, no parent expansion. `Work/` is the read scope,
 * `Drafts/` a write-only scope.
 */
const TAGGED_NOTES = [
  { path: 'Work/a.md', tags: ['work/a', 'work/b', 'shared'] },
  { path: 'Work/b.md', tags: ['shared', 'work/a'] },
  { path: 'Work/untagged.md', tags: [] },
  { path: 'Private/a.md', tags: ['secret', 'shared', 'secret/deep'] },
  { path: 'todo.md', tags: ['root-only'] },
  { path: 'Drafts/d.md', tags: ['draft/idea'] },
];

const VAULT_TAGS = [
  { name: 'work', count: 3 },
  { name: 'work/a', count: 2 },
  { name: 'work/b', count: 1 },
  { name: 'shared', count: 3 },
  { name: 'secret', count: 2 },
  { name: 'secret/deep', count: 1 },
  { name: 'root-only', count: 1 },
  { name: 'draft', count: 1 },
  { name: 'draft/idea', count: 1 },
];

interface RecordedCall {
  body: string | undefined;
  contentType: string | undefined;
  method: string;
  path: string;
}

/** Serves `/tags/` and JsonLogic `/search/` from the fixtures above, recording every call. */
function tagService(config: Partial<ServerConfig>) {
  const calls: RecordedCall[] = [];
  const vault = jsonLogicVault(TAGGED_NOTES);
  const fetchImpl: ObsidianFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    calls.push({
      method: (init.method ?? 'GET').toUpperCase(),
      path,
      contentType: headers.get('content-type') ?? undefined,
      body: init.body == null ? undefined : String(init.body),
    });
    const json = (body: unknown) =>
      mockResponse(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/tags/') return json({ tags: VAULT_TAGS });
    if (path === '/search/') return vault.fetchImpl(url, init);
    throw new Error(`No mock reply for ${path}`);
  };
  return { svc: new ObsidianService(makeTestConfig(config), fetchImpl), calls };
}

describe('listTags — unscoped reads keep the single /tags/ call', () => {
  it.each([
    ['no policy', {}],
    ['write paths only', { writePaths: ['drafts'] }],
    ['read-only', { readOnly: true }],
    ['read-only with write paths', { readOnly: true, writePaths: ['drafts'] }],
  ] as Array<[string, Partial<ServerConfig>]>)(
    '%s → one GET /tags/, vault-wide occurrence counts',
    async (_label, config) => {
      const { svc, calls } = tagService(config);
      expect(await svc.listTags(ctx)).toEqual(VAULT_TAGS);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /tags/']);
    },
  );
});

describe('listTags — OBSIDIAN_READ_PATHS scopes the listing to readable notes', () => {
  it('makes one JsonLogic POST /search/ for the readable notes, without bodies, and no GET /tags/', async () => {
    const { svc, calls } = tagService({ readPaths: ['work'] });
    await svc.listTags(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/search/',
      contentType: 'application/vnd.olrapi.jsonlogic+json',
    });
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      if: [{ regexp: [expect.any(String), { var: 'path' }] }, { var: '' }, null],
    });
  });

  it('lists only tags carried by readable notes, counting notes with parents expanded once per note', async () => {
    const { svc } = tagService({ readPaths: ['work'] });
    expect(await svc.listTags(ctx)).toEqual([
      // Work/a.md carries work/a and work/b — it adds 1 to `work`, not 2.
      { name: 'work', count: 2 },
      { name: 'work/a', count: 2 },
      { name: 'work/b', count: 1 },
      // Private/a.md also carries `shared`; only the two readable carriers count.
      { name: 'shared', count: 2 },
    ]);
  });

  it('counts a write-path-only note as readable, and drops it under OBSIDIAN_READ_ONLY', async () => {
    const writable = await tagService({ readPaths: ['work'], writePaths: ['drafts'] }).svc.listTags(
      ctx,
    );
    expect(writable).toContainEqual({ name: 'draft', count: 1 });
    expect(writable).toContainEqual({ name: 'draft/idea', count: 1 });

    const readOnly = await tagService({
      readPaths: ['work'],
      writePaths: ['drafts'],
      readOnly: true,
    }).svc.listTags(ctx);
    expect(readOnly.map((t) => t.name)).toEqual(['work', 'work/a', 'work/b', 'shared']);
  });

  it('matches the read scope only at a segment boundary, returning no tags when no note is readable', async () => {
    // `wor` is a string prefix of `Work/` but not a folder on the way to it.
    expect(await tagService({ readPaths: ['wor'] }).svc.listTags(ctx)).toEqual([]);
  });

  it('lists the tags of a note too deep for the JSONLogic evaluator, which it never reaches', async () => {
    const svc = new ObsidianService(
      makeTestConfig({ readPaths: ['work'] }),
      deepNoteFetch('Work/deep.md', 100_000),
    );
    expect(await svc.listTags(ctx)).toEqual([{ name: 'deep', count: 1 }]);
  });

  it('expands every level of a deep hierarchical tag once per note', async () => {
    const { fetchImpl } = jsonLogicVault([
      { path: 'Work/x.md', tags: ['a/b/c/d', 'a/b/e'] },
      { path: 'Work/y.md', tags: ['a/b/c'] },
    ]);
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), fetchImpl);
    expect(await svc.listTags(ctx)).toEqual([
      { name: 'a', count: 2 },
      { name: 'a/b', count: 2 },
      { name: 'a/b/c', count: 2 },
      { name: 'a/b/c/d', count: 1 },
      { name: 'a/b/e', count: 1 },
    ]);
  });
});

describe('searchJsonLogic — OBSIDIAN_READ_PATHS evaluates over readable notes only', () => {
  const NOTES = [
    { path: 'Work/a.md', links: ['Drafts/d.md', 'Private/p.md'], unresolvedLinks: ['drafts/new'] },
    { path: 'Drafts/d.md', links: ['Work/a.md'] },
    { path: 'Private/p.md', links: ['Work/a.md'] },
  ];

  /** A note context as the plugin's `{ var: '' }` returns it, link fields included. */
  const context = (path: string) => ({
    tags: [],
    frontmatter: {},
    stat: { ctime: 0, mtime: 0, size: 0 },
    path,
    content: '',
  });

  /**
   * An upstream that ignores whatever tree it is sent and returns every
   * note's context, plus a field naming an out-of-scope note: the read-scope
   * filter, not the guard, must keep out-of-scope notes out.
   */
  function guardIgnoringService(config: Partial<ServerConfig>) {
    const fetchImpl: ObsidianFetch = async () =>
      mockResponse(
        JSON.stringify(
          NOTES.map((n) => ({
            filename: n.path,
            result: {
              ...context(n.path),
              links: n.links,
              backlinks: NOTES.filter((m) => m.links.includes(n.path)).map((m) => m.path),
              unresolvedLinks: n.unresolvedLinks ?? [],
              extra: ['Private/p.md'],
            },
          })),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    return new ObsidianService(makeTestConfig(config), fetchImpl);
  }

  it('gates the fetched contexts with the read scope, write paths included, and drops their link fields', async () => {
    const svc = guardIgnoringService({ readPaths: ['work'], writePaths: ['drafts'] });
    expect(await svc.searchJsonLogic(ctx, { var: '' })).toEqual([
      { filename: 'Work/a.md', result: context('Work/a.md') },
      { filename: 'Drafts/d.md', result: context('Drafts/d.md') },
    ]);
    // A computed key reaches no link field either: it reads null, so no note is a hit.
    expect(await svc.searchJsonLogic(ctx, { var: { cat: ['back', 'links'] } })).toEqual([]);
  });

  it('reads each readable body with one GET /vault/{path}, none out of scope, however many batches they span', async () => {
    const big = 'a'.repeat(17 * 1024 * 1024);
    const vault = jsonLogicVault([
      { path: 'Work/one.md', content: `${big}1` },
      { path: 'Private/p.md', content: 'secret' },
      { path: 'Work/two.md', content: `${big}2` },
      { path: 'Work/empty.md', content: '' },
    ]);
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    const hits = await svc.searchJsonLogic(ctx, {
      cat: [{ var: 'path' }, ':', { substr: [{ var: 'content' }, -1] }],
    });
    expect(hits).toEqual([
      { filename: 'Work/one.md', result: 'Work/one.md:1' },
      { filename: 'Work/two.md', result: 'Work/two.md:2' },
      { filename: 'Work/empty.md', result: 'Work/empty.md:' },
    ]);
    // One context search without bodies, then one read per readable note, in vault order.
    expect(vault.requests).toEqual([
      'POST /search/',
      'GET /vault/Work/one.md',
      'GET /vault/Work/two.md',
      'GET /vault/Work/empty.md',
    ]);
    expect(vault.bodies[0]).not.toContain('"content"');
  });

  /** Spy on every JSONLogic worker: the instances that took a batch, what each took, and which were terminated. */
  function spyOnWorkers() {
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    return {
      batches: () =>
        post.mock.calls.map(([request]) =>
          (request as { notes: Array<{ path: string }> }).notes.map((n) => n.path),
        ),
      workers: () => new Set(post.mock.contexts),
      terminated: () => new Set(terminate.mock.contexts),
    };
  }

  it('evaluates every batch of a search on one worker, terminated when the search answers', async () => {
    const big = 'a'.repeat(17 * 1024 * 1024);
    const vault = jsonLogicVault([
      { path: 'Work/one.md', content: `${big}1` },
      { path: 'Work/two.md', content: `${big}2` },
      { path: 'Work/three.md', content: 'three' },
    ]);
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    const workers = spyOnWorkers();
    expect(await svc.searchJsonLogic(ctx, { in: ['three', { var: 'content' }] })).toEqual([
      { filename: 'Work/three.md', result: true },
    ]);
    expect(workers.batches()).toEqual([['Work/one.md'], ['Work/two.md', 'Work/three.md']]);
    expect(workers.workers().size).toBe(1);
    expect(workers.terminated()).toEqual(workers.workers());
  });

  it('reads the next batch only once the current one has been evaluated, and none after it fails', async () => {
    const big = 'a'.repeat(17 * 1024 * 1024);
    const vault = jsonLogicVault([
      { path: 'Work/one.md', content: `${big}1` },
      { path: 'Work/two.md', content: `${big}2` },
      { path: 'Work/three.md', content: 'three' },
    ]);
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    const workers = spyOnWorkers();
    // An uncompilable pattern on the first batch's note fails the search there.
    const logic = {
      if: [
        { '==': [{ var: 'path' }, 'Work/one.md'] },
        { regexp: ['(', { var: 'content' }] },
        false,
      ],
    };
    const err = await rejectionOf<McpError>(svc.searchJsonLogic(ctx, logic));
    expect(err.data).toMatchObject({ reason: 'logic_invalid' });
    expect(vault.requests).toEqual(['POST /search/', 'GET /vault/Work/one.md']);
    expect(workers.terminated()).toEqual(workers.workers());
  });

  it('evaluates a note gone by the time its body is read with an empty body', async () => {
    const vault = jsonLogicVault([
      { path: 'Work/kept.md', content: 'alpha' },
      { path: 'Work/gone.md', content: 'alpha' },
    ]);
    // The note is deleted between the context search and the read of its body.
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), async (url, init) => {
      const res = await vault.fetchImpl(url, init);
      if (vault.requests.length === 1) vault.remove('Work/gone.md');
      return res;
    });
    expect(
      await svc.searchJsonLogic(ctx, { cat: [{ var: 'path' }, '=', { var: 'content' }] }),
    ).toEqual([
      { filename: 'Work/kept.md', result: 'Work/kept.md=alpha' },
      { filename: 'Work/gone.md', result: 'Work/gone.md=' },
    ]);
  });

  it("hands a tree each body exactly as the plugin's search would: CRLF and non-ASCII text intact", async () => {
    const body = '---\r\ntitle: Ünïcödé ✓\r\n---\r\nemoji 🧪 and 漢字\r\nlast';
    const vault = jsonLogicVault([{ path: 'Work/text.md', content: body }]);
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    expect(await svc.searchJsonLogic(ctx, { var: 'content' })).toEqual([
      { filename: 'Work/text.md', result: body },
    ]);
  });

  it('fails any other body read typed, and stops reading once it has', async () => {
    const vault = jsonLogicVault(
      Array.from({ length: 400 }, (_, i) => ({ path: `Work/n${i}.md`, content: 'x' })),
    );
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), async (url, init) => {
      if (new URL(url).pathname === '/vault/Work/n0.md') {
        vault.requests.push('GET /vault/Work/n0.md');
        return mockResponse('{"message":"denied"}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return vault.fetchImpl(url, init);
    });
    const err = await rejectionOf<McpError>(svc.searchJsonLogic(ctx, { var: 'content' }));
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.message).toBe(
      'Obsidian Local REST API forbids this request. Check the plugin permissions.',
    );
    // Every read it started had settled when it failed: none is dispatched afterwards.
    const reads = vault.requests.length;
    expect(reads).toBeLessThan(400);
    await new Promise((resolve) => setImmediate(resolve));
    expect(vault.requests).toHaveLength(reads);
  });

  it("rethrows the caller's cancellation mid-read rather than answering, and reads nothing after it", async () => {
    const controller = new AbortController();
    const vault = jsonLogicVault(
      Array.from({ length: 40 }, (_, i) => ({ path: `Work/n${i}.md`, content: 'x' })),
    );
    // Cancelled as the first body is requested.
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), (url, init) => {
      const res = vault.fetchImpl(url, init);
      if (vault.requests.length === 2) controller.abort();
      return res;
    });
    const err = await rejectionOf(
      svc.searchJsonLogic(createMockContext({ signal: controller.signal }), {
        in: ['x', { var: 'content' }],
      }),
    );
    expect(err).toBe(controller.signal.reason);
    expect(vault.requests).toHaveLength(2);
  });

  describe('one deadline for every request a search makes', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A vault whose body reads never answer until their signal aborts. */
    function stalledBodies(count: number) {
      const vault = jsonLogicVault(
        Array.from({ length: count }, (_, i) => ({ path: `Work/n${i}.md`, content: 'x' })),
      );
      const fetchImpl: ObsidianFetch = (url, init) => {
        if (new URL(url).pathname.startsWith('/vault/')) {
          vault.requests.push(`GET ${new URL(url).pathname}`);
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return vault.fetchImpl(url, init);
      };
      return {
        vault,
        svc: new ObsidianService(makeTestConfig({ readPaths: ['work'] }), fetchImpl),
      };
    }

    it('fails a search still reading bodies at 45 s with logic_too_costly, whatever the request count', async () => {
      vi.useFakeTimers();
      const { vault, svc } = stalledBodies(100);
      let settled = false;
      const run = svc.searchJsonLogic(ctx, { in: ['x', { var: 'content' }] }).finally(() => {
        settled = true;
      });
      run.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(settled).toBe(false);
      // At most 32 reads are in flight at once, and the deadline stops them all together.
      expect(vault.requests.filter((r) => r.startsWith('GET'))).toHaveLength(32);
      await vi.advanceTimersByTimeAsync(1);
      const err = await rejectionOf<McpError>(run);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'logic_too_costly' });
      expect(err.message).toBe(
        'The scoped JSONLogic search ran past 45 s reading and evaluating the readable notes.',
      );
      expect(vault.requests.filter((r) => r.startsWith('GET'))).toHaveLength(32);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the caller's cancellation a cancellation once the deadline is armed", async () => {
      vi.useFakeTimers();
      const { svc } = stalledBodies(3);
      const controller = new AbortController();
      const run = rejectionOf(
        svc.searchJsonLogic(createMockContext({ signal: controller.signal }), {
          in: ['x', { var: 'content' }],
        }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      expect(await run).toBe(controller.signal.reason);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  /** `count` readable notes, `Work/n000.md` on, tagged `x`, plus one out-of-scope note. */
  const workNotes = (count: number, fields: Record<string, unknown> = {}) => [
    ...Array.from({ length: count }, (_, i) => ({
      path: `Work/n${String(i).padStart(3, '0')}.md`,
      tags: ['x'],
      ...fields,
    })),
    { path: 'Private/p.md', tags: ['x'] },
  ];

  it('gives each first page its own walk, and reads a known walk without evaluating', async () => {
    const vault = jsonLogicVault(workNotes(51));
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    const logic = { var: 'tags' };
    const expected = workNotes(51)
      .slice(0, 51)
      .map((n) => ({ filename: n.path, result: ['x'] }));
    const one = await svc.pageJsonLogic(ctx, logic, undefined, 50);
    const two = await svc.pageJsonLogic(ctx, logic, undefined, 50);
    expect(one).toEqual({ hits: expected, walk: expect.any(String) });
    expect(two.walk).toEqual(expect.any(String));
    expect(two.walk).not.toBe(one.walk);
    expect(vault.bodies).toHaveLength(2);
    expect(await svc.pageJsonLogic(ctx, logic, one.walk, 50)).toEqual({
      hits: expected,
      walk: one.walk,
    });
    expect(vault.bodies).toHaveLength(2);
    // An id this service never issued evaluates fresh, under a new walk.
    const unknown = await svc.pageJsonLogic(ctx, logic, 'not-a-walk', 50);
    expect(unknown.hits).toEqual(expected);
    expect([one.walk, two.walk, 'not-a-walk']).not.toContain(unknown.walk);
    expect(vault.bodies).toHaveLength(3);
  });

  it('stores no walk for a search with no hits or a single page of them', async () => {
    const vault = jsonLogicVault(workNotes(51));
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    expect(await svc.pageJsonLogic(ctx, { var: 'absent' }, undefined, 50)).toEqual({ hits: [] });
    // Exactly one full page: nothing follows it.
    const onePage = await svc.pageJsonLogic(
      ctx,
      { '<': [{ substr: [{ var: 'path' }, 6, 3] }, '050'] },
      undefined,
      50,
    );
    expect(onePage.hits).toHaveLength(50);
    expect(onePage).not.toHaveProperty('walk');
    const twoPages = await svc.pageJsonLogic(ctx, { var: 'path' }, undefined, 50);
    expect(twoPages.hits).toHaveLength(51);
    expect(twoPages.walk).toEqual(expect.any(String));
  });

  it('keeps no walk whose hits outgrow the store, and stores none for an unscoped search', async () => {
    // 51 bodies of 700,000 characters: about 35.7 MB of hits, past the 32 MiB store.
    const vault = jsonLogicVault(workNotes(51, { content: 'a'.repeat(700_000) }));
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    const whole = await svc.pageJsonLogic(ctx, { var: 'content' }, undefined, 50);
    expect(whole.hits).toHaveLength(51);
    expect(whole).not.toHaveProperty('walk');
    const flags = await svc.pageJsonLogic(ctx, { in: ['a', { var: 'content' }] }, undefined, 50);
    expect(flags.walk).toEqual(expect.any(String));

    const unscoped = new ObsidianService(makeTestConfig({ writePaths: ['work'] }), vault.fetchImpl);
    const all = await unscoped.pageJsonLogic(ctx, { var: 'path' }, undefined, 50);
    expect(all.hits).toHaveLength(52);
    expect(all).not.toHaveProperty('walk');
  });

  it("counts a stored walk's tree toward the 32 MiB store, evicting the least recently read", async () => {
    const vault = jsonLogicVault(workNotes(51));
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    // Each tree carries a 17 MiB default it never returns: two of them pass the store.
    const tree = (fill: string) => ({ var: ['path', fill.repeat(17 * 1024 * 1024)] });
    const first = await svc.pageJsonLogic(ctx, tree('x'), undefined, 50);
    const second = await svc.pageJsonLogic(ctx, tree('y'), undefined, 50);
    expect(first.walk).toEqual(expect.any(String));
    expect(second.walk).toEqual(expect.any(String));
    expect(vault.bodies).toHaveLength(2);
    // The second walk stayed; storing it evicted the first, whose next page evaluates again.
    expect((await svc.pageJsonLogic(ctx, tree('y'), second.walk, 50)).walk).toBe(second.walk);
    expect(vault.bodies).toHaveLength(2);
    const again = await svc.pageJsonLogic(ctx, tree('x'), first.walk, 50);
    expect(again.hits).toHaveLength(51);
    expect(again.walk).not.toBe(first.walk);
    expect(vault.bodies).toHaveLength(3);
  });

  it('fails a tree past the depth bound with logic_too_costly before serializing it', async () => {
    // 100,000 levels: deep enough that serializing the tree overflows the stack under Bun.
    let deep: Record<string, unknown> = { var: 'path' };
    for (let level = 0; level < 50_000; level++) deep = { '!!': [deep] };
    const vault = jsonLogicVault(workNotes(1));
    const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
    const err = await rejectionOf<McpError>(svc.pageJsonLogic(ctx, deep, undefined, 50));
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'The JSONLogic tree nests deeper than 1,000 levels.',
      data: { reason: 'logic_too_costly' },
    });
    expect(vault.bodies).toEqual([]);
  });

  it('drops write-path notes under OBSIDIAN_READ_ONLY', async () => {
    const svc = guardIgnoringService({
      readPaths: ['work'],
      writePaths: ['drafts'],
      readOnly: true,
    });
    expect(await svc.searchJsonLogic(ctx, { var: 'path' })).toEqual([
      { filename: 'Work/a.md', result: 'Work/a.md' },
    ]);
  });

  it.each([
    ['{"var": "links"}', { var: 'links' }, 'links'],
    ['{"var": "backlinks.0"}', { var: 'backlinks.0' }, 'backlinks'],
    ['{"var": ["unresolvedLinks", []]}', { var: ['unresolvedLinks', []] }, 'unresolvedLinks'],
    [
      'a backlinks test nested in a content tree',
      { and: [{ in: ['x', { var: 'content' }] }, { in: ['Work/a.md', { var: 'backlinks' }] }] },
      'backlinks',
    ],
  ])(
    'rejects %s with link_fields_unavailable before any upstream request',
    async (_label, logic, field) => {
      const vault = jsonLogicVault([{ path: 'Work/a.md', content: 'x', links: ['Work/a.md'] }]);
      const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
      const err = await rejectionOf<McpError>(svc.pageJsonLogic(ctx, logic, undefined, 50));
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toEqual({ reason: 'link_fields_unavailable' });
      expect(err.message).toBe(
        `The JSONLogic tree reads \`${field}\`, which a search under OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS does not provide: \`links\`, \`backlinks\`, and \`unresolvedLinks\` follow Obsidian's link resolution across the whole vault.`,
      );
      expect(vault.requests).toEqual([]);
    },
  );

  /**
   * `missing` and `missing_some` read each key through `var`, so a fixed key
   * naming a link field would report it missing on every scoped note.
   */
  describe('missing and missing_some keys', () => {
    const VAULT: VaultNote[] = [
      { path: 'Work/a.md', frontmatter: { status: 'open' }, tags: ['x'], links: ['Work/b.md'] },
      { path: 'Work/b.md', unresolvedLinks: ['ghost'] },
      { path: 'Private/p.md', links: ['Work/a.md'] },
    ];

    it.each([
      ['{"missing": ["backlinks"]}', { missing: ['backlinks'] }, 'backlinks'],
      ['{"missing": [["path", "links.0"]]}', { missing: [['path', 'links.0']] }, 'links'],
      [
        '{"missing_some": [1, ["unresolvedLinks", "tags"]]}',
        { missing_some: [1, ['unresolvedLinks', 'tags']] },
        'unresolvedLinks',
      ],
      [
        'a missing test nested in if',
        { if: [{ missing: ['backlinks.0'] }, { var: 'path' }, false] },
        'backlinks',
      ],
    ])(
      'rejects %s from searchJsonLogic with link_fields_unavailable before any upstream request',
      async (_label, logic, field) => {
        const vault = jsonLogicVault(VAULT);
        const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
        const err = await rejectionOf<McpError>(svc.searchJsonLogic(ctx, logic));
        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toEqual({ reason: 'link_fields_unavailable' });
        expect(err.message).toMatch(new RegExp(`^The JSONLogic tree reads \`${field}\``));
        expect(vault.requests).toEqual([]);
      },
    );

    it('answers a computed key, which reads a link field as null', async () => {
      const vault = jsonLogicVault(VAULT);
      const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
      expect(await svc.searchJsonLogic(ctx, { missing: [{ cat: ['back', 'links'] }] })).toEqual([
        { filename: 'Work/a.md', result: ['backlinks'] },
        { filename: 'Work/b.md', result: ['backlinks'] },
      ]);
      expect(vault.requests).toEqual(['POST /search/']);
    });

    it('answers keys that name no link field over the readable notes', async () => {
      const vault = jsonLogicVault(VAULT);
      const svc = new ObsidianService(makeTestConfig({ readPaths: ['work'] }), vault.fetchImpl);
      expect(await svc.searchJsonLogic(ctx, { missing: ['frontmatter.status', 'tags.0'] })).toEqual(
        [{ filename: 'Work/b.md', result: ['frontmatter.status', 'tags.0'] }],
      );
      expect(
        await svc.searchJsonLogic(ctx, { missing_some: [2, ['path', 'frontmatter.status', 'x']] }),
      ).toEqual([{ filename: 'Work/b.md', result: ['frontmatter.status', 'x'] }]);
    });

    it('sends an unscoped tree to the plugin unchanged, link fields included', async () => {
      const vault = jsonLogicVault(VAULT);
      const svc = new ObsidianService(makeTestConfig({ writePaths: ['work'] }), vault.fetchImpl);
      const logic = { missing_some: [1, ['backlinks.0', 'unresolvedLinks.0']] };
      // Nothing links to Private/p.md, and only Work/b.md has an unresolved link.
      expect(await svc.searchJsonLogic(ctx, logic)).toEqual([
        { filename: 'Private/p.md', result: ['backlinks.0', 'unresolvedLinks.0'] },
      ]);
      expect(await svc.searchJsonLogic(ctx, { missing: ['backlinks.0'] })).toEqual([
        { filename: 'Private/p.md', result: ['backlinks.0'] },
      ]);
      expect(vault.bodies.map((b) => JSON.parse(b))).toEqual([logic, { missing: ['backlinks.0'] }]);
    });
  });
});

/**
 * `OBSIDIAN_DENY_PATHS=private,notes/private` with no allowlist: every gate
 * refuses a denied path before the upstream call, and every listing, tag
 * count, and JSONLogic result leaves denied notes out — the deny list routes
 * them through the same scoped paths OBSIDIAN_READ_PATHS does.
 */
describe('OBSIDIAN_DENY_PATHS — deny-only service gates', () => {
  const DENY = { denyPaths: ['private', 'notes/private'] };

  const expectWithheld = (err: McpError, path: string, op: 'read' | 'write') => {
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data).toMatchObject({
      reason: 'path_forbidden',
      subreason: 'denied_path',
      path,
      op,
    });
    expect(err.data).not.toHaveProperty('activeScope');
    expect(err.message).toContain('OBSIDIAN_DENY_PATHS');
  };

  it('refuses every read and write of a denied path before any upstream call', async () => {
    const svc = buildService(DENY);
    const path = 'Private/plan.md';
    const target: NoteTarget = { type: 'path', path };
    expectWithheld(await rejectionOf<McpError>(svc.getNoteContent(ctx, target)), path, 'read');
    expectWithheld(await rejectionOf<McpError>(svc.getNoteJson(ctx, target)), path, 'read');
    expectWithheld(await rejectionOf<McpError>(svc.tryGetSize(ctx, target)), path, 'read');
    expectWithheld(await rejectionOf<McpError>(svc.openInUi(ctx, path)), path, 'read');
    expectWithheld(await rejectionOf<McpError>(svc.writeNote(ctx, target, 'x')), path, 'write');
    expectWithheld(await rejectionOf<McpError>(svc.appendToNote(ctx, target, 'x')), path, 'write');
    expectWithheld(await rejectionOf<McpError>(svc.deleteNote(ctx, target)), path, 'write');
    // The spellings the plugin resolves to the same note are refused the same way.
    for (const spelling of ['notes//private/x.md', 'Notes\\Private\\x.md', 'NOTES/PRIVATE/x.md']) {
      expectWithheld(
        await rejectionOf<McpError>(svc.getNoteContent(ctx, { type: 'path', path: spelling })),
        spelling,
        'read',
      );
    }
    expect(upstreamHits).toBe(0);
  });

  it('reads and writes a path outside the deny list', async () => {
    const replies = new Map<string, () => MockResponse>([
      [
        '/vault/Notes/public.md',
        () => mockResponse('hello', { status: 200, headers: { 'content-type': 'text/markdown' } }),
      ],
      ['/vault/Privateer/x.md', () => mockResponse('', { status: 200 })],
    ]);
    const svc = buildService(DENY, replies);
    expect(await svc.getNoteContent(ctx, { type: 'path', path: 'Notes/public.md' })).toBe('hello');
    await svc.writeNote(ctx, { type: 'path', path: 'Privateer/x.md' }, 'x');
    expect(upstreamHits).toBe(2);
  });

  it('drops a denied folder from every listing level and refuses to list it', async () => {
    const listing = (files: string[]) => () =>
      mockResponse(JSON.stringify({ files }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const replies = new Map([
      ['/vault/', listing(['Private/', 'Notes/', 'todo.md', 'Privateer/'])],
      ['/vault/Notes/', listing(['Private/', 'Public/', 'n.md'])],
    ]);
    const svc = buildService(DENY, replies);
    expect(await svc.listFiles(ctx)).toEqual({ files: ['Notes/', 'todo.md', 'Privateer/'] });
    // A folder holding a denied descendant lists, without it.
    expect(await svc.listFiles(ctx, 'Notes')).toEqual({ files: ['Public/', 'n.md'] });
    expect(upstreamHits).toBe(2);
    for (const dir of ['Private', 'Notes/Private', 'notes//private', 'Notes/Private/Deeper']) {
      expectWithheld(await rejectionOf<McpError>(svc.listFiles(ctx, dir)), dir, 'read');
    }
    expect(upstreamHits).toBe(2);
  });

  it('counts tags over the readable notes only, from one JSONLogic search', async () => {
    const { svc, calls } = tagService({ denyPaths: ['private'] });
    expect(await svc.listTags(ctx)).toEqual([
      { name: 'work', count: 2 },
      { name: 'work/a', count: 2 },
      { name: 'work/b', count: 1 },
      { name: 'shared', count: 2 },
      { name: 'root-only', count: 1 },
      { name: 'draft', count: 1 },
      { name: 'draft/idea', count: 1 },
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /search/']);
    // No allowlist, so the guard passes every path upstream; the deny list is applied here.
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({
      if: [{ regexp: ['^', { var: 'path' }] }, { var: '' }, null],
    });
  });

  it('evaluates JSONLogic over the readable notes, and refuses the link fields without naming a deny prefix', async () => {
    const vault = jsonLogicVault([
      { path: 'Work/a.md', links: ['Private/p.md', 'Notes/Private/q.md', 'Work/b.md'] },
      { path: 'Work/b.md', links: ['Work/a.md'], unresolvedLinks: ['private/new', 'other'] },
      { path: 'Private/p.md', links: ['Work/a.md'], tags: ['x'] },
      { path: 'Notes/Private/q.md', links: ['Work/a.md'], tags: ['x'] },
    ]);
    const svc = new ObsidianService(makeTestConfig(DENY), vault.fetchImpl);
    expect(await svc.searchJsonLogic(ctx, { var: 'path' })).toEqual([
      { filename: 'Work/a.md', result: 'Work/a.md' },
      { filename: 'Work/b.md', result: 'Work/b.md' },
    ]);
    // A tree that matches only denied notes has no hits, rather than the plugin's.
    expect(await svc.searchJsonLogic(ctx, { in: ['x', { var: 'tags' }] })).toEqual([]);
    // Neither search sent the caller's tree upstream.
    expect(vault.bodies.every((b) => b.includes('"regexp"'))).toBe(true);
    const requests = vault.requests.length;
    const err = await rejectionOf<McpError>(
      svc.searchJsonLogic(ctx, { in: ['Work/a.md', { var: 'backlinks' }] }),
    );
    expect(err.data).toEqual({ reason: 'link_fields_unavailable' });
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(/private/i);
    expect(vault.requests).toHaveLength(requests);
  });

  it('reads a note under a withheld folder through the bodies it fetches for readable notes only', async () => {
    const vault = jsonLogicVault([
      { path: 'Work/a.md', content: 'alpha' },
      { path: 'Private/p.md', content: 'alpha secret' },
    ]);
    const svc = new ObsidianService(makeTestConfig(DENY), vault.fetchImpl);
    expect(await svc.searchJsonLogic(ctx, { in: ['alpha', { var: 'content' }] })).toEqual([
      { filename: 'Work/a.md', result: true },
    ]);
    expect(vault.requests).toEqual(['POST /search/', 'GET /vault/Work/a.md']);
  });
});

/**
 * Under a read scope `searchText` never calls `/search/simple/`, which builds
 * a context window for every match in the vault: one guarded `/search/` names
 * the readable notes whose path or body may hold every token, each of their
 * bodies is one `GET /vault/{path}`, and the server matches them the way the
 * plugin does. Issue #163.
 */
describe('searchText — under a read scope, matched in-server over the readable notes', () => {
  const json = (body: unknown) =>
    mockResponse(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  /** An unscoped service whose `/search/simple/` answers `hits`. */
  const unscopedOver = (hits: RawHit[]) =>
    new ObsidianService(makeTestConfig(), async (url) => {
      if (new URL(url).pathname === '/search/simple/') return json(hits);
      throw new Error(`unexpected ${url}`);
    });

  const scoped = (notes: VaultNote[], config: Partial<ServerConfig>) => {
    const vault = jsonLogicVault(notes);
    return { vault, svc: new ObsidianService(makeTestConfig(config), vault.fetchImpl) };
  };

  it('sends no /search/simple/ request: one guarded /search/, then one GET per readable candidate', async () => {
    const { vault, svc } = scoped(
      [
        { path: 'Work/a.md', content: 'alpha beta' },
        { path: 'Work/b.md', content: 'alpha only' },
        { path: 'Work/Beta.md', content: 'Alpha' },
        { path: 'Private/p.md', content: 'alpha beta secret' },
      ],
      { readPaths: ['work'] },
    );
    const hits = await svc.searchText(ctx, 'ALPHA beta', 5);
    expect(hits.map((h) => h.filename)).toEqual(['Work/a.md', 'Work/Beta.md']);
    expect(vault.requests).toEqual([
      'POST /search/',
      'GET /vault/Work/a.md',
      'GET /vault/Work/Beta.md',
    ]);
    const token = (pattern: string) => ({
      or: [{ regexp: [pattern, { var: 'path' }] }, { regexp: [pattern, { var: 'content' }] }],
    });
    const scope = new PathPolicy(makeTestConfig({ readPaths: ['work'] })).readScopePattern();
    expect(JSON.parse(vault.bodies[0] ?? 'null')).toEqual({
      if: [
        {
          and: [
            { regexp: [scope, { var: 'path' }] },
            token('[aA][lL][pP][hH][aA]'),
            token('[bB][eE][tT][aA]'),
          ],
        },
        { var: 'stat' },
        null,
      ],
    });
  });

  it('gives the same hits, or the same context_length_too_large, whatever out-of-scope notes contain', async () => {
    const needles = 'needle '.repeat(20_000);
    const outcome = async (notes: VaultNote[]) =>
      scoped(notes, { readPaths: ['work'] })
        .svc.searchText(ctx, 'needle', 2 ** 28)
        .then(
          (hits) => ({ hits }),
          (err: McpError) => ({ code: err.code, data: err.data, message: err.message }),
        );
    const small: VaultNote = { path: 'Work/a.md', content: 'one needle here' };
    const huge: VaultNote = { path: 'Work/huge.md', content: needles };
    const elsewhere: VaultNote[] = [
      { path: 'Private/p.md', content: needles },
      { path: 'Archive/needle.md', content: needles },
    ];
    // 20,000 windows each holding the whole note pass what one response can carry.
    const fits = await outcome([small]);
    expect(fits).toMatchObject({ hits: [{ filename: 'Work/a.md' }] });
    expect(await outcome([small, ...elsewhere])).toEqual(fits);
    const tooLarge = await outcome([small, huge]);
    expect(tooLarge).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'context_length_too_large', contextLength: 2 ** 28 },
    });
    expect(await outcome([...elsewhere, small, huge])).toEqual(tooLarge);
  });

  it.each(Object.keys(CAPTURE_QUERIES) as CaptureName[])(
    'answers as /search/simple/ does for the same readable note: %s',
    async (name) => {
      const query = CAPTURE_QUERIES[name];
      const { svc } = scoped(
        [
          { path: 'Private/copy.md', content: PROBE_BODY },
          { path: PROBE_PATH, content: PROBE_BODY },
        ],
        { readPaths: [PROBE_PATH.split('/')[0] ?? ''] },
      );
      const expected = await unscopedOver(loadCapture(name)).searchText(ctx, query, 100);
      expect(expected.length).toBeGreaterThan(0);
      expect(await svc.searchText(ctx, query, 100)).toEqual(expected);
    },
  );

  it.each(loadRuleCaptures().captures.map((c) => [JSON.stringify(c.query), c] as const))(
    'answers as /search/simple/ does under a deny list, in its order: %s',
    async (_label, { query, contextLength, response }) => {
      const rules = loadRuleCaptures();
      const notes: VaultNote[] = rules.vaultOrder.map((path) => ({
        path,
        content: rules.notes.find((n) => n.path === path)?.body ?? '',
      }));
      // Denied copies of every note, first and in the middle of the vault order.
      const denied = notes.map((n) => ({ ...n, path: `Private/${n.path}` }));
      const { svc } = scoped(
        [denied[0] as VaultNote, ...notes.slice(0, 3), ...denied.slice(1), ...notes.slice(3)],
        {
          denyPaths: ['private'],
        },
      );
      const expected = await unscopedOver(response).searchText(ctx, query, contextLength);
      expect(await svc.searchText(ctx, query, contextLength)).toEqual(expected);
    },
  );

  it('answers as /search/simple/ does for a common token at a small window, with escapes, emoji, and filename spans', async () => {
    const notes: VaultNote[] = [
      { path: 'Work/eve.md', content: 'e "q" e\\p e\tt e\u0001c e 😀 e\r\n'.repeat(300) },
      { path: 'Private/e.md', content: 'e '.repeat(500) },
      { path: 'Work/plain.md', content: 'the e of ee\n'.repeat(400) },
    ];
    const readable = notes
      .filter((n) => n.path.startsWith('Work/'))
      .map((n) => ({ path: n.path, body: n.content ?? '' }));
    for (const [query, contextLength] of [
      ['e', 1],
      ['e the', 0],
    ] as const) {
      const { hits } = simulateSimpleSearch(readable, query, contextLength);
      const expected = await unscopedOver(hits).searchText(ctx, query, contextLength);
      expect(expected.reduce((n, h) => n + h.matches.length, 0)).toBeGreaterThan(1_000);
      const { svc } = scoped(notes, { denyPaths: ['private'] });
      expect(await svc.searchText(ctx, query, contextLength)).toEqual(expected);
    }
  });

  /**
   * The plugin fails where its serialized response passes V8's longest
   * string, and every match carries about 150 characters there beside its
   * window. Nine notes of `e ` repeated 450,000 times, at contextLength 0, hold
   * 4,050,000 one-character windows, far under that string, and a response of
   * about 615 million characters, past it.
   */
  it('fails many small windows with context_length_too_large where their characters alone fit', async () => {
    const content = 'e '.repeat(450_000);
    const { svc } = scoped(
      [
        ...Array.from({ length: 9 }, (_, i) => ({ path: `Work/n${i}.md`, content })),
        { path: 'Private/p.md', content },
      ],
      { denyPaths: ['private'] },
    );
    expect(9 * 450_000).toBeLessThan(2 ** 29 - 24);
    const err = await rejectionOf<McpError>(svc.searchText(ctx, 'e', 0));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toEqual({ reason: 'context_length_too_large', contextLength: 0 });
  }, 60_000);

  it('sends no regexp for a token the case folding cannot express, and still finds the notes it matches', async () => {
    const { vault, svc } = scoped(
      [
        { path: 'Work/Café.md', content: 'MENU of the day' },
        { path: 'Work/other.md', content: 'menu without it' },
      ],
      { readPaths: ['work'] },
    );
    // 'café' is not ASCII and 'x\ny' could span the basename and the body: only 'menu' is sent.
    const hits = await svc.searchText(ctx, 'café menu', 100);
    expect(hits.map((h) => h.filename)).toEqual(['Work/Café.md']);
    await svc.searchText(ctx, 'menu x\ny', 100);
    for (const body of vault.bodies) {
      const clauses = (JSON.parse(body) as { if: [{ and: unknown[] }] }).if[0].and;
      expect(clauses).toHaveLength(2);
      expect(JSON.stringify(clauses[1])).toContain('[mM][eE][nN][uU]');
    }
  });

  it('reads no body for a query of spaces alone, and returns every readable note with no matches', async () => {
    const { vault, svc } = scoped(
      [
        { path: 'Work/a.md', content: 'alpha' },
        { path: 'Private/p.md', content: 'secret' },
        { path: 'Work/b.md', content: '' },
      ],
      { readPaths: ['work'] },
    );
    expect(await svc.searchText(ctx, '   ', 100)).toEqual([
      { filename: 'Work/a.md', matches: [] },
      { filename: 'Work/b.md', matches: [] },
    ]);
    expect(vault.requests).toEqual(['POST /search/']);
    expect(vault.bodies[0]).not.toContain('"content"');
  });

  describe('one deadline for every request a search makes', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A readable vault whose body reads never answer until their signal aborts. */
    function stalledBodies(count: number) {
      const vault = jsonLogicVault(
        Array.from({ length: count }, (_, i) => ({ path: `Work/n${i}.md`, content: 'x' })),
      );
      const fetchImpl: ObsidianFetch = (url, init) => {
        if (new URL(url).pathname.startsWith('/vault/')) {
          vault.requests.push(`GET ${new URL(url).pathname}`);
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return vault.fetchImpl(url, init);
      };
      return {
        vault,
        svc: new ObsidianService(makeTestConfig({ readPaths: ['work'] }), fetchImpl),
      };
    }

    it('fails a search still reading bodies at 45 s with text_search_too_costly', async () => {
      vi.useFakeTimers();
      const { vault, svc } = stalledBodies(100);
      let settled = false;
      const run = svc.searchText(ctx, 'x', 100).finally(() => {
        settled = true;
      });
      run.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(settled).toBe(false);
      expect(vault.requests.filter((r) => r.startsWith('GET'))).toHaveLength(32);
      await vi.advanceTimersByTimeAsync(1);
      const err = await rejectionOf<McpError>(run);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason: 'text_search_too_costly' });
      expect(err.message).toBe(
        'The scoped text search ran past 45 s reading and matching the readable notes.',
      );
      expect(vault.requests.filter((r) => r.startsWith('GET'))).toHaveLength(32);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the caller's cancellation a cancellation once the deadline is armed", async () => {
      vi.useFakeTimers();
      const { svc } = stalledBodies(3);
      const controller = new AbortController();
      const run = rejectionOf(
        svc.searchText(createMockContext({ signal: controller.signal }), 'x', 100),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      expect(await run).toBe(controller.signal.reason);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('write-implies-read for the same path', () => {
  it('getNoteContent passes when path is in writePaths only', async () => {
    const replies = new Map<string, () => MockResponse>([
      [
        '/vault/projects/foo.md',
        () => mockResponse('hello', { status: 200, headers: { 'content-type': 'text/markdown' } }),
      ],
    ]);
    const svc = buildService({ readPaths: ['public'], writePaths: ['projects'] }, replies);
    const out = await svc.getNoteContent(ctx, { type: 'path', path: 'projects/foo.md' });
    expect(out).toBe('hello');
  });
});

/**
 * `active` and `periodic` targets resolve upstream, so their scope is checked
 * on the note the plugin names. A denial names the target as the
 * `no_active_file` / `periodic_not_found` errors do, never the note.
 */
describe('non-path targets — gate after JSON resolution', () => {
  const RESOLVED = 'Private/secret.md';
  const TARGETS = NON_PATH_TARGETS;

  /**
   * Answers every note route with `notePath` (a document-map read gets an
   * empty 1.x map, the capability report a 4.x plugin) and records each
   * request as `METHOD /path`.
   */
  function resolvingService(config: Partial<ServerConfig>, notePath = RESOLVED) {
    const requests: string[] = [];
    const fetchImpl: ObsidianFetch = async (url, init) => {
      const path = decodeURIComponent(new URL(url).pathname);
      const method = (init.method ?? 'GET').toUpperCase();
      requests.push(`${method} ${path}`);
      const accept = new Headers(init.headers).get('accept') ?? '';
      const json = (body: unknown) =>
        mockResponse(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/') {
        return json({ status: 'OK', service: 'x', versions: { obsidian: '1', self: '4.1.0' } });
      }
      if (method !== 'GET') return mockResponse('', { status: 200 });
      if (accept.includes('document-map')) {
        return json({ headings: [], blocks: [], frontmatterFields: [] });
      }
      return json({
        path: notePath,
        content: 'hi',
        frontmatter: {},
        tags: [],
        stat: { ctime: 0, mtime: 0, size: 2 },
      });
    };
    return { svc: new ObsidianService(makeTestConfig(config), fetchImpl), requests };
  }

  /** Neither surface of the denial carries the resolved note. */
  const expectNoResolvedPath = (err: McpError) =>
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toMatch(/secret/i);

  it.each(TARGETS)(
    'read: %j names the target, not the note, and reads in scope unchanged',
    async (target, label) => {
      const inScope = resolvingService({ readPaths: ['work'] }, 'Work/a.md').svc;
      expect((await inScope.getNoteJson(ctx, target)).path).toBe('Work/a.md');

      const { svc } = resolvingService({ readPaths: ['work'] });
      const err = await rejectionOf<McpError>(svc.getNoteJson(ctx, target));
      expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
      expect(err.message).toBe(
        `Target '${label}' resolves to a note that is not readable: outside OBSIDIAN_READ_PATHS.`,
      );
      expect(err.data).toEqual({
        reason: 'path_forbidden',
        path: label,
        op: 'read',
        subreason: 'outside_read_paths',
        activeScope: ['work'],
        recovery: {
          hint: "Allowed prefixes: ['work']. Pass a path target within scope, or update OBSIDIAN_READ_PATHS to cover the note this target resolves to.",
        },
      });
      expectNoResolvedPath(err);
    },
  );

  it.each(TARGETS)('write: %j names the target and sends no write', async (target, label) => {
    const { svc, requests } = resolvingService({ readPaths: ['work'], writePaths: ['work'] });
    const err = await rejectionOf<McpError>(svc.writeNote(ctx, target, 'x'));
    expect(err.message).toBe(
      `Target '${label}' resolves to a note that is not writable: outside OBSIDIAN_WRITE_PATHS.`,
    );
    expect(err.data).toMatchObject({
      reason: 'path_forbidden',
      path: label,
      op: 'write',
      subreason: 'outside_write_paths',
      activeScope: ['work'],
    });
    expectNoResolvedPath(err);
    expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });

  it('read-only: a resolved write target is named by its label', async () => {
    const { svc } = resolvingService({ readOnly: true });
    const err = await rejectionOf<McpError>(svc.deleteNote(ctx, { type: 'active' }));
    expect(err.message).toBe(
      "Target '(active file)' resolves to a note that is not writable: server is in read-only mode (OBSIDIAN_READ_ONLY=true).",
    );
    expect(err.data).toMatchObject({ path: '(active file)', subreason: 'read_only_mode' });
    expectNoResolvedPath(err);
  });

  it.each(TARGETS)(
    'deny list: %j resolving to a withheld note names the target and sends no write',
    async (target, label) => {
      const { svc, requests } = resolvingService({ denyPaths: ['private'] });
      for (const [call, op] of [
        [svc.getNoteJson(ctx, target), 'read'],
        [svc.getNoteContent(ctx, target), 'read'],
        [svc.writeNote(ctx, target, 'x'), 'write'],
        [svc.deleteNote(ctx, target), 'write'],
      ] as const) {
        const err = await rejectionOf<McpError>(call);
        expect(err.message).toBe(
          `Target '${label}' resolves to a note that is not ${op === 'read' ? 'readable' : 'writable'}: withheld by OBSIDIAN_DENY_PATHS (subreason denied_path).`,
        );
        expect(err.data).toEqual({
          reason: 'path_forbidden',
          path: label,
          op,
          subreason: 'denied_path',
          recovery: {
            hint: 'The operator withholds the note this target resolves to. Pass a path target to a different note, or ask the operator to change OBSIDIAN_DENY_PATHS.',
          },
        });
        expectNoResolvedPath(err);
      }
      expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
    },
  );

  it('deny list: a target in scope is read through its resolution, not the raw markdown route', async () => {
    const { svc, requests } = resolvingService({ denyPaths: ['private'] }, 'Work/a.md');
    expect(await svc.getNoteContent(ctx, { type: 'active' })).toBe('hi');
    expect(requests).toEqual(['GET /active/']);
  });

  it('getDocumentMap and getNoteContent deny a resolved target by its label', async () => {
    const { svc } = resolvingService({ readPaths: ['work'] });
    const target: NoteTarget = { type: 'periodic', period: 'daily', date: '2026-10-01' };
    for (const call of [svc.getDocumentMap(ctx, target), svc.getNoteContent(ctx, target)]) {
      const err = await rejectionOf<McpError>(call);
      expect(err.data).toMatchObject({ path: 'daily note for 2026-10-01' });
      expectNoResolvedPath(err);
    }
  });

  it('a target pinned by resolveTarget keeps its label through the write gate', async () => {
    // Readable (no read scope) but outside the write scope.
    const { svc, requests } = resolvingService({ writePaths: ['work'] });
    const pinned = await svc.resolveTarget(ctx, { type: 'active' });
    expect(pinned).toEqual({ type: 'path', path: RESOLVED, resolvedFrom: '(active file)' });

    const err = await rejectionOf<McpError>(svc.writeNote(ctx, pinned, 'x'));
    expect(err.message).toBe(
      "Target '(active file)' resolves to a note that is not writable: outside OBSIDIAN_WRITE_PATHS.",
    );
    expect(err.data).toMatchObject({ path: '(active file)', subreason: 'outside_write_paths' });
    expectNoResolvedPath(err);
    expect(requests).toEqual(['GET /active/']);
  });
});

describe('unrestricted policy — no extra calls or behavior changes', () => {
  it('writeNote on any path passes through with one upstream call', async () => {
    const replies = new Map<string, () => MockResponse>([
      ['/vault/anywhere/foo.md', () => mockResponse('', { status: 200 })],
    ]);
    const svc = buildService({}, replies);
    await svc.writeNote(ctx, { type: 'path', path: 'anywhere/foo.md' }, 'x');
    expect(upstreamHits).toBe(1);
  });
});

describe('Windows-style paths integrate end-to-end', () => {
  /**
   * A user (or LLM) sending `Public\sub\note.md` should be treated identically
   * to `public/sub/note.md`: the policy matches against the configured prefix,
   * and the encoder produces a forward-slash URL.
   */
  it('Windows separators match forward-slash prefix and reach forward-slash URL', async () => {
    const replies = new Map<string, () => MockResponse>([
      [
        '/vault/Public/sub/note.md',
        () => mockResponse('hello', { status: 200, headers: { 'content-type': 'text/markdown' } }),
      ],
    ]);
    const svc = buildService({ readPaths: ['public'] }, replies);
    const out = await svc.getNoteContent(ctx, { type: 'path', path: 'Public\\sub\\note.md' });
    expect(out).toBe('hello');
    expect(upstreamHits).toBe(1);
  });

  it('blocks Windows-style traversal in restricted-read mode (policy catches it first)', async () => {
    const svc = buildService({ readPaths: ['public'] });
    await expect(
      svc.getNoteContent(ctx, { type: 'path', path: '..\\secret\\foo.md' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('blocks Windows-style traversal in unrestricted mode (encoder catches it)', async () => {
    const svc = buildService({});
    await expect(
      svc.getNoteContent(ctx, { type: 'path', path: '..\\..\\Windows\\System32\\config\\SAM' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('blocks Windows-style write traversal in unrestricted mode', async () => {
    const svc = buildService({});
    await expect(
      svc.writeNote(ctx, { type: 'path', path: '..\\..\\evil.md' }, 'pwned'),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('Windows-style write path matches write prefix and reaches upstream', async () => {
    const replies = new Map<string, () => MockResponse>([
      ['/vault/projects/note.md', () => mockResponse('', { status: 200 })],
    ]);
    const svc = buildService({ writePaths: ['projects'] }, replies);
    await svc.writeNote(ctx, { type: 'path', path: 'projects\\note.md' }, 'x');
    expect(upstreamHits).toBe(1);
  });
});

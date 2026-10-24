/**
 * @fileoverview Service-level path-policy integration tests. Constructs
 * `ObsidianService` with custom path config and verifies that gated methods
 * throw `path_forbidden` before hitting the upstream, while in-scope paths
 * pass through.
 * @module tests/services/obsidian-service-path-policy.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { Headers } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { obsidianGetNote } from '@/mcp-server/tools/definitions/obsidian-get-note.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import type { NoteTarget } from '@/services/obsidian/types.js';
import {
  deepNoteFetch,
  jsonLogicVault,
  type MockResponse,
  makeTestConfig,
  mockResponse,
  NON_PATH_TARGETS,
  rejectionOf,
} from '../helpers.js';

let ctx: Context;
let upstreamHits = 0;

beforeEach(() => {
  ctx = createMockContext();
  upstreamHits = 0;
});

afterEach(() => {
  setObsidianService(undefined);
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

  /** A note context with the given link fields, as the plugin's `{ var: '' }` returns it. */
  const context = (
    path: string,
    links: { links: string[]; backlinks: string[]; unresolvedLinks: string[] },
  ) => ({
    tags: [],
    frontmatter: {},
    stat: { ctime: 0, mtime: 0, size: 0 },
    path,
    content: '',
    ...links,
  });

  /**
   * An upstream that ignores whatever tree it is sent and returns every
   * note's context, plus a field naming an out-of-scope note: the read-scope
   * filter, not the guard, must keep out-of-scope notes and link entries out.
   */
  function guardIgnoringService(config: Partial<ServerConfig>) {
    const fetchImpl: ObsidianFetch = async () =>
      mockResponse(
        JSON.stringify(
          NOTES.map((n) => ({
            filename: n.path,
            result: {
              ...context(n.path, {
                links: n.links,
                backlinks: NOTES.filter((m) => m.links.includes(n.path)).map((m) => m.path),
                unresolvedLinks: n.unresolvedLinks ?? [],
              }),
              extra: ['Private/p.md'],
            },
          })),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    return new ObsidianService(makeTestConfig(config), fetchImpl);
  }

  it('gates the fetched contexts with the read scope, write paths included', async () => {
    const svc = guardIgnoringService({ readPaths: ['work'], writePaths: ['drafts'] });
    expect(await svc.searchJsonLogic(ctx, { var: '' })).toEqual([
      {
        filename: 'Work/a.md',
        result: context('Work/a.md', {
          links: ['Drafts/d.md'],
          backlinks: ['Drafts/d.md'],
          unresolvedLinks: ['drafts/new'],
        }),
      },
      {
        filename: 'Drafts/d.md',
        result: context('Drafts/d.md', {
          links: ['Work/a.md'],
          backlinks: ['Work/a.md'],
          unresolvedLinks: [],
        }),
      },
    ]);
  });

  it('fetches note bodies for readable notes only, in batches of at most 32 MiB', async () => {
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
    // Contexts without bodies, then one body fetch per batch, each naming only readable paths.
    expect(vault.bodies).toHaveLength(3);
    expect(vault.bodies[0]).not.toContain('"content"');
    const requested = vault.bodies
      .slice(1)
      .map((b) => (JSON.parse(b) as { if: [{ in: [unknown, string[]] }] }).if[0].in[1]);
    expect(requested).toEqual([['Work/one.md'], ['Work/two.md', 'Work/empty.md']]);
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

  it('drops write-path notes and links under OBSIDIAN_READ_ONLY', async () => {
    const svc = guardIgnoringService({
      readPaths: ['work'],
      writePaths: ['drafts'],
      readOnly: true,
    });
    expect(
      await svc.searchJsonLogic(ctx, { cat: [{ var: 'path' }, ' → ', { var: 'links' }] }),
    ).toEqual([{ filename: 'Work/a.md', result: 'Work/a.md → ' }]);
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

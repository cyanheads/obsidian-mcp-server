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
import { type MockResponse, makeTestConfig, mockResponse, rejectionOf } from '../helpers.js';

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
  it('blocks getNoteContent on a path outside readPaths', async () => {
    const svc = buildService({ readPaths: ['public'] });
    await expect(
      svc.getNoteContent(ctx, { type: 'path', path: 'secret/foo.md' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden', subreason: 'outside_read_paths' },
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
 * Per-note tag lists as the plugin's JsonLogic `{"var": "tags"}` returns them:
 * deduplicated within a note, no `#`, no parent expansion, untagged notes
 * absent. `Work/` is the read scope, `Drafts/` a write-only scope.
 */
const TAGGED_NOTES = [
  { filename: 'Work/a.md', result: ['work/a', 'work/b', 'shared'] },
  { filename: 'Work/b.md', result: ['shared', 'work/a'] },
  { filename: 'Private/a.md', result: ['secret', 'shared', 'secret/deep'] },
  { filename: 'todo.md', result: ['root-only'] },
  { filename: 'Drafts/d.md', result: ['draft/idea'] },
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
    if (path === '/search/') return json(TAGGED_NOTES);
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
  it('makes one JsonLogic POST /search/ for the tags var and no GET /tags/', async () => {
    const { svc, calls } = tagService({ readPaths: ['work'] });
    await svc.listTags(ctx);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/search/',
        contentType: 'application/vnd.olrapi.jsonlogic+json',
        body: JSON.stringify({ var: 'tags' }),
      },
    ]);
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

  it('expands every level of a deep hierarchical tag once per note', async () => {
    const fetchImpl: ObsidianFetch = async () =>
      mockResponse(
        JSON.stringify([
          { filename: 'Work/x.md', result: ['a/b/c/d', 'a/b/e'] },
          { filename: 'Work/y.md', result: ['a/b/c'] },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
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

describe('non-path targets — gate after JSON resolution', () => {
  it('getNoteJson on `active` throws path_forbidden when resolved path is out of scope', async () => {
    const replies = new Map<string, () => MockResponse>([
      [
        '/active/',
        () =>
          mockResponse(
            JSON.stringify({
              path: 'secret/foo.md',
              content: 'hi',
              frontmatter: {},
              tags: [],
              stat: { ctime: 0, mtime: 0, size: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ],
    ]);
    const svc = buildService({ readPaths: ['public'] }, replies);
    await expect(svc.getNoteJson(ctx, { type: 'active' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { subreason: 'outside_read_paths' },
    });
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

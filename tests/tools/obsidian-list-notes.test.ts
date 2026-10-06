/**
 * @fileoverview Handler tests for obsidian_list_notes — recursive walk,
 * filters across the tree, depth-limit truncation, entry-cap truncation, and
 * the read-scope filter on listings.
 * @module tests/tools/obsidian-list-notes.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { obsidianListNotes } from '@/mcp-server/tools/definitions/obsidian-list-notes.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { contractErrorOf, makeTestConfig, mockResponse, setupHarness } from '../helpers.js';

const harness = setupHarness();

/** The recovery sentence the tool's own contract advertises for `reason`. */
function declaredRecovery(reason: string): string {
  const entry = obsidianListNotes.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`obsidian_list_notes declares no '${reason}' contract entry`);
  return entry.recovery;
}

describe('obsidian_list_notes / non-recursive (depth: 1)', () => {
  it('lists vault root as a flat single-level tree', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(
        200,
        { files: ['Note.md', 'Sub/', 'Other.md', 'archive/'] },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ depth: 1 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.path).toBe('');
    expect(out.appliedFilters.depth).toBe(1);
    expect(out.entries.map((e) => e.path)).toEqual(['Note.md', 'Sub', 'Other.md', 'archive']);
    expect(out.entries.filter((e) => e.type === 'directory').every((e) => e.truncated)).toBe(true);
    expect(out.totals).toEqual({ entries: 4, files: 2, directories: 2 });
  });

  it('targets the requested subdirectory with a normalized URL', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Projects/', method: 'GET' })
      .reply(200, { files: ['Plan.md'] }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ path: '/Projects/', depth: 1 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.path).toBe('/Projects/');
    expect(out.entries).toEqual([{ path: 'Projects/Plan.md', type: 'file' }]);
  });
});

describe('obsidian_list_notes / recursive walk', () => {
  it('uses default depth 2 when `depth` is omitted (top-level + immediate children)', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/', method: 'GET' }).reply(200, { files: ['A.md', 'Projects/'] });
    pool
      .intercept({ path: '/vault/Projects/', method: 'GET' })
      .reply(200, { files: ['Plan.md', 'notes/'] });
    // Note: no intercept for /vault/Projects/notes/ — depth 2 must NOT walk it.

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({}),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.appliedFilters.depth).toBe(2);
    expect(out.entries.map((e) => e.path)).toEqual([
      'A.md',
      'Projects',
      'Projects/Plan.md',
      'Projects/notes',
    ]);
    expect(out.entries.find((e) => e.path === 'Projects/notes')?.truncated).toBe(true);
  });

  it('walks deeper when `depth: 3` is requested', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/', method: 'GET' }).reply(200, { files: ['A.md', 'Projects/'] });
    pool
      .intercept({ path: '/vault/Projects/', method: 'GET' })
      .reply(200, { files: ['Plan.md', 'notes/'] });
    pool
      .intercept({ path: '/vault/Projects/notes/', method: 'GET' })
      .reply(200, { files: ['deep.md'] });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ depth: 3 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.appliedFilters.depth).toBe(3);
    expect(out.entries.map((e) => e.path)).toEqual([
      'A.md',
      'Projects',
      'Projects/Plan.md',
      'Projects/notes',
      'Projects/notes/deep.md',
    ]);
    expect(out.entries.find((e) => e.path === 'Projects')?.truncated).toBeUndefined();
    expect(out.entries.find((e) => e.path === 'Projects/notes')?.truncated).toBeUndefined();
    expect(out.totals).toEqual({ entries: 5, files: 3, directories: 2 });
  });

  it('flags directories at the depth limit with `truncated: true`', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/', method: 'GET' }).reply(200, { files: ['Sub/'] });
    pool
      .intercept({ path: '/vault/Sub/', method: 'GET' })
      .reply(200, { files: ['Inner/', 'leaf.md'] });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ depth: 2 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    const inner = out.entries.find((e) => e.path === 'Sub/Inner');
    expect(inner).toEqual({ path: 'Sub/Inner', type: 'directory', truncated: true });
    expect(out.entries.find((e) => e.path === 'Sub')?.truncated).toBeUndefined();
  });

  it('swallows 404s on subdirectories during the walk', async () => {
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['Stable/', 'Vanishing/'] });
    pool.intercept({ path: '/vault/Stable/', method: 'GET' }).reply(200, { files: ['ok.md'] });
    pool
      .intercept({ path: '/vault/Vanishing/', method: 'GET' })
      .reply(404, { errorCode: 40400, message: 'Folder not found' });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ depth: 2 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.entries.map((e) => e.path)).toEqual(['Stable', 'Stable/ok.md', 'Vanishing']);
  });

  it('applies extension filter across the recursive walk', async () => {
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['note.md', 'image.png', 'Sub/'] });
    pool
      .intercept({ path: '/vault/Sub/', method: 'GET' })
      .reply(200, { files: ['deep.md', 'data.json'] });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ extension: 'md', depth: 2 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.appliedFilters.extension).toBe('.md');
    expect(out.entries.map((e) => e.path)).toEqual(['note.md', 'Sub', 'Sub/deep.md']);
  });

  it('applies nameRegex to skip walking into name-filtered-out directories', async () => {
    const pool = harness.current().pool;
    pool
      .intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['Projects/', 'archive/', 'Notes.md'] });
    // Regex matches `Projects` (parent), `Plan.md` (child), `Notes.md` (sibling) —
    // but NOT `archive`. We deliberately don't register an intercept for `archive/`;
    // an unintended walk into it would throw "No mock intercept" and fail the test.
    pool
      .intercept({ path: '/vault/Projects/', method: 'GET' })
      .reply(200, { files: ['Plan.md', 'other.md'] });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ nameRegex: '^(Projects|Plan|Notes)', depth: 2 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.appliedFilters.nameRegex).toBe('^(Projects|Plan|Notes)');
    expect(out.entries.map((e) => e.path)).toEqual(['Projects', 'Projects/Plan.md', 'Notes.md']);
  });
});

describe('obsidian_list_notes / caps and errors', () => {
  it('caps entries at the global limit and reports `excluded.reason: entry_cap`', async () => {
    const many = Array.from({ length: 1100 }, (_, i) => `n${i}.md`);
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: many });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ depth: 1 }),
      createMockContext({ errors: obsidianListNotes.errors }),
    );
    expect(out.entries).toHaveLength(1000);
    expect(out.totals.entries).toBe(1000);
    expect(out.excluded?.reason).toBe('entry_cap');
    expect(out.excluded?.cap).toBe(1000);
  });

  it('throws regex_invalid (ValidationError) when nameRegex is not valid', async () => {
    await expect(
      obsidianListNotes.handler(
        obsidianListNotes.input.parse({ nameRegex: '[' }),
        createMockContext({ errors: obsidianListNotes.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_invalid' },
    });
  });

  it('throws regex_unsafe (ValidationError) for a catastrophic-backtracking nameRegex before any vault access', async () => {
    // No pool intercept is registered: if the static guard didn't reject first,
    // the walk would issue a GET and throw "no mock intercept" instead.
    await expect(
      obsidianListNotes.handler(
        obsidianListNotes.input.parse({ nameRegex: '(a+)+$' }),
        createMockContext({ errors: obsidianListNotes.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_unsafe' },
    });
  });
});

/**
 * The two ways a `path` can be wrong for a listing. Both used to surface
 * untyped: a file path threw a raw JSON parse failure (or, for a vault `.json`
 * file, no failure at all), and a missing folder borrowed the note-read 404's
 * reason and its "locate the note" hint.
 */
describe('obsidian_list_notes / bad paths', () => {
  const fileHeaders = {
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': 'attachment; filename="Note.md"',
  };

  it('throws path_is_file with the contract recovery when `path` names a file', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md/', method: 'GET' })
      .reply(200, '# hello', { headers: fileHeaders });

    expect(await contractErrorOf(obsidianListNotes, { path: 'Note.md' })).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'path_is_file',
        path: 'Note.md',
        recovery: { hint: declaredRecovery('path_is_file') },
      },
    });
  });

  it('throws directory_missing with the contract recovery when the folder does not list', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Inbox/scratch-dir/', method: 'GET' })
      .reply(404, { message: 'Not Found', errorCode: 40400 });

    expect(
      await contractErrorOf(obsidianListNotes, { path: 'Inbox/scratch-dir', depth: 3 }),
    ).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'directory_missing',
        path: 'Inbox/scratch-dir',
        recovery: { hint: declaredRecovery('directory_missing') },
      },
    });
  });

  it('carries path_is_file to both wire surfaces', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md/', method: 'GET' })
      .reply(200, '# hello', { headers: fileHeaders });

    const res = await runToolContract(obsidianListNotes, { path: 'Note.md' });

    expect(res.isError).toBe(true);
    const error = (res.structuredContent as { error: { code: number; data: { reason: string } } })
      .error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('path_is_file');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('is a file, not a directory');
    expect(text).toContain(declaredRecovery('path_is_file'));
  });

  it('carries directory_missing to both wire surfaces', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Ghost/', method: 'GET' })
      .reply(404, { message: 'Not Found', errorCode: 40400 });

    const res = await runToolContract(obsidianListNotes, { path: 'Ghost' });

    expect(res.isError).toBe(true);
    const error = (res.structuredContent as { error: { code: number; data: { reason: string } } })
      .error;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('directory_missing');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Directory not found');
    expect(text).toContain(declaredRecovery('directory_missing'));
  });
});

describe('obsidian_list_notes / format()', () => {
  it('renders entries as a box-drawing tree with trailing slashes on directories', () => {
    // Projects is intermediate (not last) so its subtree uses pipe-carry indent;
    // README is last so we exercise both branch styles in one assertion set.
    const blocks = obsidianListNotes.format!({
      path: '',
      entries: [
        { path: 'Note.md', type: 'file' },
        { path: 'Projects', type: 'directory' },
        { path: 'Projects/Plan.md', type: 'file' },
        { path: 'Projects/notes', type: 'directory' },
        { path: 'Projects/notes/deep.md', type: 'file' },
        { path: 'README.md', type: 'file' },
      ],
      totals: { entries: 6, files: 4, directories: 2 },
      appliedFilters: { depth: 3 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('6 entries');
    expect(text).toContain('depth=3');
    expect(text).toContain('Entry `type`: a trailing `/` marks a `directory`');
    expect(text).toContain('├── Note.md');
    expect(text).toContain('├── Projects/');
    expect(text).toContain('│   ├── Plan.md');
    expect(text).toContain('│   └── notes/');
    expect(text).toContain('│       └── deep.md');
    expect(text).toContain('└── README.md');
  });

  it('annotates depth-limited directories with `[truncated — pass deeper depth …]`', () => {
    const blocks = obsidianListNotes.format!({
      path: '',
      entries: [{ path: 'Sub', type: 'directory', truncated: true }],
      totals: { entries: 1, files: 0, directories: 1 },
      appliedFilters: { depth: 1 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Sub/ [truncated');
  });

  it('shows the entry-cap message when results are capped', () => {
    const blocks = obsidianListNotes.format!({
      path: '',
      entries: [{ path: 'a.md', type: 'file' }],
      totals: { entries: 1, files: 1, directories: 0 },
      appliedFilters: { depth: 1 },
      excluded: { reason: 'entry_cap', cap: 1000, hint: 'Narrow filters or descend deeper.' },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('entry_cap');
    expect(text).toContain('cap=1000');
    expect(text).toContain('Narrow filters or descend deeper.');
  });
});

/**
 * Under OBSIDIAN_READ_PATHS a listing holds readable entries and the folders
 * on the way to the scope, nothing else. The stub vault answers every folder,
 * so a walk that ignored the scope would surface `Private/`, `todo.md`,
 * `Proj/`, and `Projects/Other/`.
 */
describe('obsidian_list_notes / OBSIDIAN_READ_PATHS scope', () => {
  const VAULT: Record<string, string[]> = {
    '': ['todo.md', 'Private/', 'Projects/', 'Proj/'],
    Private: ['a.md'],
    Projects: ['Work/', 'Other/', 'readme.md'],
    'Projects/Work': ['w.md', 'Deep/'],
    'Projects/Work/Deep': ['d.md'],
    'Projects/Other': ['o.md'],
    Proj: ['p.md'],
  };

  let listed: string[] = [];

  afterEach(() => {
    setObsidianService(undefined);
    listed = [];
  });

  function scope(config: Partial<ServerConfig>, vault: Record<string, string[]> = VAULT) {
    const fetchImpl: ObsidianFetch = async (url) => {
      const dir = decodeURIComponent(new URL(url).pathname)
        .replace(/^\/vault\/?/, '')
        .replace(/\/$/, '');
      listed.push(dir);
      const files = vault[dir];
      if (!files) {
        return mockResponse(JSON.stringify({ message: 'Not Found', errorCode: 40400 }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockResponse(JSON.stringify({ files }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    setObsidianService(new ObsidianService(makeTestConfig(config), fetchImpl));
  }

  const list = (input: Record<string, unknown>) =>
    obsidianListNotes.handler(
      obsidianListNotes.input.parse(input),
      createMockContext({ errors: obsidianListNotes.errors }),
    );

  const NESTED = { readPaths: ['projects/work'] };

  it('lists only the path to a nested scope from the root, at every depth', async () => {
    scope(NESTED);
    expect((await list({ depth: 1 })).entries).toEqual([
      { path: 'Projects', type: 'directory', truncated: true },
    ]);
    expect((await list({})).entries).toEqual([
      { path: 'Projects', type: 'directory' },
      { path: 'Projects/Work', type: 'directory', truncated: true },
    ]);
    expect((await list({ depth: 5 })).entries).toEqual([
      { path: 'Projects', type: 'directory' },
      { path: 'Projects/Work', type: 'directory' },
      { path: 'Projects/Work/w.md', type: 'file' },
      { path: 'Projects/Work/Deep', type: 'directory' },
      { path: 'Projects/Work/Deep/d.md', type: 'file' },
    ]);
    // No out-of-scope folder was ever listed upstream.
    expect(listed).not.toContain('Private');
    expect(listed).not.toContain('Projects/Other');
  });

  it('walks into the scope at depth 3, marking only the depth-stopped folder truncated', async () => {
    scope(NESTED);
    const out = await list({ depth: 3 });
    expect(out.entries).toEqual([
      { path: 'Projects', type: 'directory' },
      { path: 'Projects/Work', type: 'directory' },
      { path: 'Projects/Work/w.md', type: 'file' },
      { path: 'Projects/Work/Deep', type: 'directory', truncated: true },
    ]);
    expect(out.totals).toEqual({ entries: 4, files: 1, directories: 3 });
  });

  it('accepts an ancestor as `path` and returns only the scope beneath it', async () => {
    scope(NESTED);
    const out = await list({ path: 'Projects' });
    expect(out.entries).toEqual([
      { path: 'Projects/Work', type: 'directory' },
      { path: 'Projects/Work/w.md', type: 'file' },
      { path: 'Projects/Work/Deep', type: 'directory', truncated: true },
    ]);
  });

  it('renders the scoped root listing identically on both wire surfaces', async () => {
    scope(NESTED);
    const res = await runToolContract(obsidianListNotes, {});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      path: '',
      entries: [
        { path: 'Projects', type: 'directory' },
        { path: 'Projects/Work', type: 'directory', truncated: true },
      ],
      totals: { entries: 2, files: 0, directories: 2 },
    });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toBe(
      [
        '**(vault root)** — 2 entries · 0 files, 2 directories · depth=2',
        '',
        'Entry `type`: a trailing `/` marks a `directory`; every other line is a `file`.',
        '```',
        '└── Projects/',
        '    └── Work/ [truncated — pass deeper `depth` to expand]',
        '```',
      ].join('\n'),
    );
  });

  it('refuses a non-ancestor `path` with path_forbidden before any upstream call', async () => {
    scope(NESTED);
    for (const path of ['Private', 'Proj', 'Projects/Other']) {
      expect(await contractErrorOf(obsidianListNotes, { path })).toMatchObject({
        code: JsonRpcErrorCode.Forbidden,
        data: { reason: 'path_forbidden', subreason: 'outside_read_paths', path },
      });
    }
    expect(listed).toEqual([]);
  });

  it('lists only a scoped file under its folder', async () => {
    scope(
      { readPaths: ['work/plan.md'] },
      { '': ['Work/', 'todo.md'], Work: ['plan.md', 'salary.md', 'Sub/'], 'Work/Sub': ['x.md'] },
    );
    expect((await list({})).entries).toEqual([
      { path: 'Work', type: 'directory' },
      { path: 'Work/plan.md', type: 'file' },
    ]);
    expect((await list({ path: 'Work' })).entries).toEqual([
      { path: 'Work/plan.md', type: 'file' },
    ]);
  });

  it('reaches a write-path scope from the root, until OBSIDIAN_READ_ONLY hides it', async () => {
    const config = { readPaths: ['private'], writePaths: ['projects/work'] };
    scope(config);
    expect((await list({ depth: 1 })).entries.map((e) => e.path)).toEqual(['Private', 'Projects']);
    expect((await list({ path: 'Projects', depth: 1 })).entries.map((e) => e.path)).toEqual([
      'Projects/Work',
    ]);

    scope({ ...config, readOnly: true });
    expect((await list({ depth: 1 })).entries.map((e) => e.path)).toEqual(['Private']);
  });

  it('reports an empty scoped listing with the empty notice', async () => {
    scope({ readPaths: ['nowhere/deep'] });
    const ctx = createMockContext({ errors: obsidianListNotes.errors });
    const out = await obsidianListNotes.handler(obsidianListNotes.input.parse({}), ctx);
    expect(out.entries).toEqual([]);
    expect(out.totals).toEqual({ entries: 0, files: 0, directories: 0 });
    expect(getEnrichment(ctx).notice).toBe(
      'The directory is empty or no entries matched the active filters.',
    );
  });

  it('counts totals and the entry cap over returned entries only', async () => {
    const crowded = Array.from({ length: 1100 }, (_, i) => `n${i}.md`);
    scope(NESTED, {
      ...VAULT,
      '': [...crowded, 'Projects/'],
    });
    const out = await list({ depth: 3 });
    expect(out.excluded).toBeUndefined();
    expect(out.totals).toEqual({ entries: 4, files: 1, directories: 3 });
  });

  it('leaves listings unchanged when OBSIDIAN_READ_PATHS is unset', async () => {
    scope({ writePaths: ['projects/work'], readOnly: false });
    expect((await list({ depth: 1 })).entries.map((e) => e.path)).toEqual([
      'todo.md',
      'Private',
      'Projects',
      'Proj',
    ]);
  });
});

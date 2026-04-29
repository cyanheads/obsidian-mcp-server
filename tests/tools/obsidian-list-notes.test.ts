/**
 * @fileoverview Handler tests for obsidian_list_notes — recursive walk,
 * filters across the tree, depth-limit truncation, and entry-cap truncation.
 * @module tests/tools/obsidian-list-notes.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianListNotes } from '@/mcp-server/tools/definitions/obsidian-list-notes.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
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
      createMockContext(),
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
    expect(text).toContain('Sub/');
    expect(text).toContain('[truncated');
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

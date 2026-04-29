/**
 * @fileoverview Handler tests for obsidian_list_notes.
 * @module tests/tools/obsidian-list-notes.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianListNotes } from '@/mcp-server/tools/definitions/obsidian-list-notes.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const sampleFiles = ['Note.md', 'Sub/', 'Other.md', 'README.md', 'archive/'];

describe('obsidian_list_notes', () => {
  it('lists vault root and splits files vs. directories', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: sampleFiles }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({}),
      createMockContext(),
    );
    expect(out.path).toBe('');
    expect(out.directories).toEqual(['Sub', 'archive']);
    expect(out.files).toEqual(['Note.md', 'Other.md', 'README.md']);
  });

  it('filters by extension (case-insensitive, leading dot tolerated)', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: sampleFiles }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ extension: '.MD' }),
      createMockContext(),
    );
    expect(out.files).toEqual(['Note.md', 'Other.md', 'README.md']);
  });

  it('applies the nameRegex to both files and directories', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: sampleFiles }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ nameRegex: '^[Aa]' }),
      createMockContext(),
    );
    expect(out.files).toEqual([]);
    expect(out.directories).toEqual(['archive']);
  });

  it('throws regex_invalid (ValidationError) when nameRegex is not valid', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: [] }, { headers: { 'content-type': 'application/json' } });

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

  it('targets the requested subdirectory with a normalized URL', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Projects/', method: 'GET' })
      .reply(200, { files: ['Plan.md'] }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListNotes.handler(
      obsidianListNotes.input.parse({ path: '/Projects/' }),
      createMockContext(),
    );
    expect(out.files).toEqual(['Plan.md']);
    expect(out.path).toBe('/Projects/');
  });
});

describe('obsidian_list_notes / format()', () => {
  it('renders both files and directories', () => {
    const blocks = obsidianListNotes.format!({
      path: 'sub',
      files: ['a.md'],
      directories: ['nested'],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('sub');
    expect(text).toContain('a.md');
    expect(text).toContain('nested/');
  });
});

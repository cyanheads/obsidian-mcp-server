/**
 * @fileoverview Handler tests for obsidian_list_files.
 * @module tests/tools/obsidian-list-files.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianListFiles } from '@/mcp-server/tools/definitions/obsidian-list-files.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const sampleFiles = ['Note.md', 'Sub/', 'Other.md', 'README.md', 'archive/'];

describe('obsidian_list_files', () => {
  it('lists vault root and splits files vs. directories', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: sampleFiles }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListFiles.handler(
      obsidianListFiles.input.parse({}),
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

    const out = await obsidianListFiles.handler(
      obsidianListFiles.input.parse({ extension: '.MD' }),
      createMockContext(),
    );
    expect(out.files).toEqual(['Note.md', 'Other.md', 'README.md']);
  });

  it('applies the nameRegex to both files and directories', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: sampleFiles }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianListFiles.handler(
      obsidianListFiles.input.parse({ nameRegex: '^[Aa]' }),
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
      obsidianListFiles.handler(
        obsidianListFiles.input.parse({ nameRegex: '[' }),
        createMockContext({ errors: obsidianListFiles.errors }),
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

    const out = await obsidianListFiles.handler(
      obsidianListFiles.input.parse({ path: '/Projects/' }),
      createMockContext(),
    );
    expect(out.files).toEqual(['Plan.md']);
    expect(out.path).toBe('/Projects/');
  });
});

describe('obsidian_list_files / format()', () => {
  it('renders both files and directories', () => {
    const blocks = obsidianListFiles.format!({
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

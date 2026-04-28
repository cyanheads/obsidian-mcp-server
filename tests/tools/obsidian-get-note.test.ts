/**
 * @fileoverview Handler tests for obsidian_get_note across all four formats.
 * @module tests/tools/obsidian-get-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianGetNote } from '@/mcp-server/tools/definitions/obsidian-get-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian_get_note / format: content', () => {
  it('returns content via /vault/{path} with text/markdown accept', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, '# title\n\nbody');

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'path', path: 'Note.md' },
    });
    const out = await obsidianGetNote.handler(input, createMockContext());
    expect(out.result).toEqual({
      format: 'content',
      path: 'Note.md',
      content: '# title\n\nbody',
    });
  });

  it('falls back to NoteJson for active targets to resolve the path', async () => {
    harness
      .current()
      .pool.intercept({ path: '/active/', method: 'GET' })
      .reply(
        200,
        {
          path: 'today.md',
          content: 'daily body',
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'active' },
    });
    const out = await obsidianGetNote.handler(input, createMockContext());
    if (out.result.format !== 'content') throw new Error('expected content branch');
    expect(out.result.path).toBe('today.md');
    expect(out.result.content).toBe('daily body');
  });
});

describe('obsidian_get_note / format: full', () => {
  it('returns the parsed NoteJson', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: 'body',
          frontmatter: { title: 'T' },
          tags: ['t1'],
          stat: { ctime: 1, mtime: 2, size: 4 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
    });
    const out = await obsidianGetNote.handler(input, createMockContext());
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.frontmatter).toEqual({ title: 'T' });
    expect(out.result.tags).toEqual(['t1']);
    expect(out.result.stat).toEqual({ ctime: 1, mtime: 2, size: 4 });
  });
});

describe('obsidian_get_note / format: document-map', () => {
  it('returns headings, blocks, and frontmatter fields', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          headings: ['Top', 'Sub'],
          blocks: ['abc'],
          frontmatterFields: ['title'],
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'document-map',
      target: { type: 'path', path: 'Note.md' },
    });
    const out = await obsidianGetNote.handler(input, createMockContext());
    if (out.result.format !== 'document-map') throw new Error('expected document-map branch');
    expect(out.result.headings).toEqual(['Top', 'Sub']);
    expect(out.result.blocks).toEqual(['abc']);
    expect(out.result.frontmatterFields).toEqual(['title']);
  });
});

describe('obsidian_get_note / format: section', () => {
  it('extracts a heading section client-side from NoteJson', async () => {
    const md = ['# Top', 'top body', '', '## Sub', 'sub body', '', '# Other'].join('\n');
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: md,
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Top::Sub' },
    });
    const out = await obsidianGetNote.handler(input, createMockContext());
    if (out.result.format !== 'section') throw new Error('expected section branch');
    expect(out.result.valueText).toBe(['## Sub', 'sub body'].join('\n'));
    expect(out.result.valueJson).toBeUndefined();
  });

  it('returns frontmatter values via valueJson', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: 'body',
          frontmatter: { priority: 7 },
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'frontmatter', target: 'priority' },
    });
    const out = await obsidianGetNote.handler(input, createMockContext());
    if (out.result.format !== 'section') throw new Error('expected section branch');
    expect(out.result.valueJson).toBe(7);
    expect(out.result.valueText).toBeUndefined();
  });

  it('throws section_required (ValidationError) when section is omitted', async () => {
    // No upstream interception — handler should fail before any HTTP call.
    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
    });
    await expect(
      obsidianGetNote.handler(input, createMockContext({ errors: obsidianGetNote.errors })),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'section_required' },
    });
  });
});

describe('obsidian_get_note / case-insensitive fallback', () => {
  it('resolves a case-mismatch path and echoes the canonical name (content)', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/MyNote.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/', method: 'GET' })
      .reply(200, { files: ['mynote.md'] });
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/mynote.md', method: 'GET' })
      .reply(200, '# canonical body');

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'path', path: 'Notes/MyNote.md' },
    });
    const out = await obsidianGetNote.handler(input, createMockContext());
    if (out.result.format !== 'content') throw new Error('expected content branch');
    expect(out.result.path).toBe('Notes/mynote.md');
    expect(out.result.content).toBe('# canonical body');
  });
});

describe('obsidian_get_note / not-found suggestions', () => {
  it('enriches NotFound with `did you mean` candidates from the parent dir', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/Missing.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/', method: 'GET' })
      .reply(200, { files: ['Missing', 'other.md'] });

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'path', path: 'Notes/Missing.md' },
    });
    await expect(obsidianGetNote.handler(input, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Did you mean: "Notes/Missing"?'),
      data: { suggestions: ['Notes/Missing'] },
    });
  });
});

describe('obsidian_get_note / format()', () => {
  it('renders content', () => {
    const blocks = obsidianGetNote.format!({
      result: { format: 'content', path: 'A.md', content: 'body' },
    });
    expect((blocks[0] as { text: string }).text).toContain('A.md');
    expect((blocks[0] as { text: string }).text).toContain('body');
  });

  it('renders full with frontmatter, tags, stat, and content', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'full',
        path: 'A.md',
        content: 'body',
        frontmatter: { author: 'casey' },
        tags: ['t'],
        stat: { ctime: 1, mtime: 2, size: 3 },
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('author');
    expect(text).toContain('casey');
    expect(text).toContain('size=3');
    expect(text).toContain('body');
  });

  it('renders document-map listing', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'document-map',
        path: 'A.md',
        headings: ['H1'],
        blocks: ['b1'],
        frontmatterFields: ['f1'],
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('H1');
    expect(text).toContain('^b1');
    expect(text).toContain('f1');
  });
});

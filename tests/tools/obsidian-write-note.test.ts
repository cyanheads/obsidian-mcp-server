/**
 * @fileoverview Handler tests for obsidian_write_note (whole-file PUT and
 * section-targeted PATCH). Covers the response surface — `created` derived
 * from the pre-write HEAD, `previousSizeInBytes` and `currentSizeInBytes`
 * read from upstream HEADs around the write.
 * @module tests/tools/obsidian-write-note.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianWriteNote } from '@/mcp-server/tools/definitions/obsidian-write-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

describe('obsidian_write_note (whole file)', () => {
  it('PUTs the body with text/markdown when the note does not exist', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(404, '');

    let seenMethod = '';
    let seenBody = '';
    let seenContentType = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply((opts) => {
      seenMethod = opts.method as string;
      seenBody = String(opts.body ?? '');
      const headers = opts.headers as Record<string, string>;
      seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(10));

    const out = await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'fresh body',
      }),
      createMockContext(),
    );

    expect(seenMethod).toBe('PUT');
    expect(seenBody).toBe('fresh body');
    expect(seenContentType).toBe('text/markdown');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: false,
      created: true,
      previousSizeInBytes: 0,
      currentSizeInBytes: 10,
    });
  });

  it('refuses to clobber an existing note when overwrite is false', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(500));

    let putCalled = false;
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply(() => {
      putCalled = true;
      return { statusCode: 200, data: '' };
    });

    await expect(
      obsidianWriteNote.handler(
        obsidianWriteNote.input.parse({
          target: { type: 'path', path: 'Note.md' },
          content: 'replacement',
        }),
        createMockContext({ errors: obsidianWriteNote.errors }),
      ),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ reason: 'file_exists', path: 'Note.md' }),
    });

    expect(putCalled).toBe(false);
  });

  it('overwrites an existing note when overwrite is true and reports both sizes', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(5000));

    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply((opts) => {
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(11));

    const out = await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'replacement',
        overwrite: true,
      }),
      createMockContext(),
    );

    expect(seenBody).toBe('replacement');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: false,
      created: false,
      previousSizeInBytes: 5000,
      currentSizeInBytes: 11,
    });
  });
});

describe('obsidian_write_note (section)', () => {
  it('PATCHes with replace + heading delimiter + apply-if-content-preexists', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    let seenHeaders: Record<string, string> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(312));

    const out = await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Sub' },
        content: 'replacement',
      }),
      createMockContext(),
    );

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('replace');
    expect(seenHeaders['target-type'] ?? seenHeaders['Target-Type']).toBe('heading');
    expect(seenHeaders['target-delimiter'] ?? seenHeaders['Target-Delimiter']).toBe('::');
    expect(
      seenHeaders['apply-if-content-preexists'] ?? seenHeaders['Apply-If-Content-Preexists'],
    ).toBe('true');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: true,
      created: false,
      previousSizeInBytes: 300,
      currentSizeInBytes: 312,
    });
  });

  it('strips a leading duplicate heading line from content when targeting a heading', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Section A' },
        content: '## Section A\n\nbody line 1\nbody line 2',
      }),
      createMockContext(),
    );

    expect(seenBody).toBe('body line 1\nbody line 2');
  });

  it('preserves content unchanged when the leading heading does not match the target', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Section A' },
        content: '## Different Heading\n\nbody',
      }),
      createMockContext(),
    );

    expect(seenBody).toBe('## Different Heading\n\nbody');
  });

  it('uses application/json when contentType is "json"', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(404, '');

    let seenContentType = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply((opts) => {
      const headers = opts.headers as Record<string, string>;
      seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(7));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: '{"a":1}',
        contentType: 'json',
      }),
      createMockContext(),
    );
    expect(seenContentType).toBe('application/json');
  });
});

describe('obsidian_write_note / format()', () => {
  it('renders Created banner and size delta for new files', () => {
    const blocks = obsidianWriteNote.format!({
      path: 'New.md',
      sectionTargeted: false,
      created: true,
      previousSizeInBytes: 0,
      currentSizeInBytes: 12,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Created New.md**');
    expect(text).toMatch(/Size:\*?\s*0 → 12 bytes/);
    expect(text).toMatch(/Created:\*?\s*true/);
  });

  it('renders Wrote banner with the destructive blast radius on overwrite', () => {
    const blocks = obsidianWriteNote.format!({
      path: 'Existing.md',
      sectionTargeted: false,
      created: false,
      previousSizeInBytes: 5000,
      currentSizeInBytes: 11,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Wrote Existing.md**');
    expect(text).toMatch(/Size:\*?\s*5000 → 11 bytes/);
    expect(text).toMatch(/Created:\*?\s*false/);
  });
});

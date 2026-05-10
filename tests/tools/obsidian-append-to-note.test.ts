/**
 * @fileoverview Handler tests for obsidian_append_to_note. Covers the response
 * surface — `created` flagged when the whole-file POST silently upserted a new
 * file, and `previousSizeInBytes` / `currentSizeInBytes` read from upstream
 * HEADs around the write.
 * @module tests/tools/obsidian-append-to-note.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianAppendToNote } from '@/mcp-server/tools/definitions/obsidian-append-to-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

describe('obsidian_append_to_note (whole file)', () => {
  it('reports created:true with both sizes when the note did not exist', async () => {
    const pool = harness.current().pool;
    let seenMethod = '';
    let seenBody = '';

    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(404, '');
    pool.intercept({ path: '/vault/Note.md', method: 'POST' }).reply((opts) => {
      seenMethod = opts.method as string;
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(4));

    const out = await obsidianAppendToNote.handler(
      obsidianAppendToNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'tail',
      }),
      createMockContext(),
    );

    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('tail');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: false,
      created: true,
      previousSizeInBytes: 0,
      currentSizeInBytes: 4,
    });
  });

  it('reports created:false with byte deltas when the note already existed', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(100));
    pool.intercept({ path: '/vault/Note.md', method: 'POST' }).reply(200, '');
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(150));

    const out = await obsidianAppendToNote.handler(
      obsidianAppendToNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'B'.repeat(50),
      }),
      createMockContext(),
    );

    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: false,
      created: false,
      previousSizeInBytes: 100,
      currentSizeInBytes: 150,
    });
  });

  it('surfaces upstream auto-newline injection in currentSizeInBytes (4 + 4 → 9)', async () => {
    const pool = harness.current().pool;
    /** Mirrors verified plugin v3.6.1 behavior: appending 4 bytes to a 4-byte
     * file lacking a trailing newline yields 9 bytes (plugin injects \n).
     * The agent sees `currentSize - previousSize - bodyLen = 1` and can
     * decide whether the +1 is expected slack or warrants a reread. */
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(4));
    pool.intercept({ path: '/vault/Note.md', method: 'POST' }).reply(200, '');
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(9));

    const out = await obsidianAppendToNote.handler(
      obsidianAppendToNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'BBBB',
      }),
      createMockContext(),
    );

    expect(out.previousSizeInBytes).toBe(4);
    expect(out.currentSizeInBytes).toBe(9);
  });
});

describe('obsidian_append_to_note (section)', () => {
  it('PATCHes with operation=append and reports both sizes', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(200));

    let seenHeaders: Record<string, string> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(218));

    const out = await obsidianAppendToNote.handler(
      obsidianAppendToNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Daily' },
        content: '- new task',
        createTargetIfMissing: true,
      }),
      createMockContext(),
    );

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('append');
    expect(seenHeaders['create-target-if-missing'] ?? seenHeaders['Create-Target-If-Missing']).toBe(
      'true',
    );
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: true,
      created: false,
      previousSizeInBytes: 200,
      currentSizeInBytes: 218,
    });
  });

  it('throws note_missing when the pre-write HEAD shows the file does not exist', async () => {
    /** PATCH requires the file to exist — `getSize` enforces that up front
     * so we don't issue a doomed PATCH and surface a confusing upstream 404. */
    harness.current().pool.intercept({ path: '/vault/Gone.md', method: 'HEAD' }).reply(404, '');

    await expect(
      obsidianAppendToNote.handler(
        obsidianAppendToNote.input.parse({
          target: { type: 'path', path: 'Gone.md' },
          section: { type: 'heading', target: 'Daily' },
          content: 'x',
        }),
        createMockContext({ errors: obsidianAppendToNote.errors }),
      ),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ reason: 'note_missing' }),
    });
  });
});

describe('obsidian_append_to_note / format()', () => {
  it('renders Created banner, size delta, and divergence hint when created:true', () => {
    const blocks = obsidianAppendToNote.format!({
      path: 'New.md',
      sectionTargeted: false,
      created: true,
      previousSizeInBytes: 0,
      currentSizeInBytes: 12,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Created New.md**');
    expect(text).toContain('did not exist before');
    expect(text).toMatch(/Size:\*?\s*0 → 12 bytes/);
    expect(text).toMatch(/Created:\*?\s*true/);
    expect(text).toMatch(/Section targeted:\*?\s*false/);
  });

  it('renders Appended banner and size delta when created:false', () => {
    const blocks = obsidianAppendToNote.format!({
      path: 'Existing.md',
      sectionTargeted: false,
      created: false,
      previousSizeInBytes: 100,
      currentSizeInBytes: 151,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Appended to Existing.md**');
    expect(text).not.toContain('did not exist before');
    expect(text).toMatch(/Size:\*?\s*100 → 151 bytes/);
    expect(text).toMatch(/Created:\*?\s*false/);
  });

  it('renders the section branch with sectionTargeted:true and real sizes', () => {
    const blocks = obsidianAppendToNote.format!({
      path: 'Daily.md',
      sectionTargeted: true,
      created: false,
      previousSizeInBytes: 200,
      currentSizeInBytes: 218,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Appended to Daily.md**');
    expect(text).toMatch(/Size:\*?\s*200 → 218 bytes/);
    expect(text).toMatch(/Section targeted:\*?\s*true/);
  });
});

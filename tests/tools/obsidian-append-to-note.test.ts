/**
 * @fileoverview Handler tests for obsidian_append_to_note. Covers the response
 * surface — `created` flagged when the whole-file POST silently upserted a new
 * file, and `previousSizeInBytes` / `currentSizeInBytes` read from upstream
 * HEADs around the write.
 * @module tests/tools/obsidian-append-to-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianAppendToNote } from '@/mcp-server/tools/definitions/obsidian-append-to-note.tool.js';
import {
  documentMapV2,
  instructionOf,
  noteJson,
  repeatKey,
  servePluginVersion,
  setupHarness,
} from '../helpers.js';

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
      createMockContext({ errors: obsidianAppendToNote.errors }),
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
      createMockContext({ errors: obsidianAppendToNote.errors }),
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
      createMockContext({ errors: obsidianAppendToNote.errors }),
    );

    expect(out.previousSizeInBytes).toBe(4);
    expect(out.currentSizeInBytes).toBe(9);
  });
});

describe('obsidian_append_to_note (section)', () => {
  it('PATCHes a 2.0 append instruction on plugin v5.x and reports both sizes', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(200));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Daily: {} }));
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, noteJson('Note.md', '# Daily\nNotes for today.\n'));

    let instruction: Record<string, unknown> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      instruction = instructionOf(opts);
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
      createMockContext({ errors: obsidianAppendToNote.errors }),
    );

    expect(instruction).toEqual({
      targetType: 'heading',
      target: ['Daily'],
      operation: 'append',
      content: '- new task',
      createTargetIfMissing: true,
      rejectIfContentPreexists: true,
    });
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: true,
      sectionTarget: 'Daily',
      created: false,
      previousSizeInBytes: 200,
      currentSizeInBytes: 218,
    });
  });

  it('PATCHes with 1.x headers on plugin v4.x', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(200));
    servePluginVersion(pool, '4.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, { headings: ['Daily'], blocks: [], frontmatterFields: [] });
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, noteJson('Note.md', '# Daily\n- monday\n'));

    let seenHeaders: Record<string, string> = {};
    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
      seenBody = opts.body ?? '';
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
      createMockContext({ errors: obsidianAppendToNote.errors }),
    );

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('append');
    expect(seenHeaders['create-target-if-missing'] ?? seenHeaders['Create-Target-If-Missing']).toBe(
      'true',
    );
    expect(seenBody).toBe('- new task');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: true,
      sectionTarget: 'Daily',
      created: false,
      previousSizeInBytes: 200,
      currentSizeInBytes: 218,
    });
  });

  /**
   * Regression for the read/write locator asymmetry: a bare leaf that reads
   * fine through `format: "section"` must reach the same heading on a write,
   * and the response must say which locator the append actually landed on.
   */
  it('expands a bare heading leaf to its full path and reports the resolved target', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(200));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Sandbox: { 'Section A': {} } }));
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, noteJson('Note.md', '# Sandbox\n## Section A\n- old task\n'));

    let seenTarget: unknown;
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenTarget = instructionOf(opts).target;
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(212));

    const out = await obsidianAppendToNote.handler(
      obsidianAppendToNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Section A' },
        content: '- new task',
      }),
      createMockContext({ errors: obsidianAppendToNote.errors }),
    );

    expect(seenTarget).toEqual(['Sandbox', 'Section A']);
    expect(out.sectionTarget).toBe('Sandbox::Section A');
  });

  /**
   * Plugin v5.x separates a plain heading append from the section's content by
   * a blank line; a list item appended to a section ending in a list goes out
   * as a `within` splice on that list instead, so the list stays tight.
   */
  it('continues the list a section ends with, on both surfaces (plugin v5.x)', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(30));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Log: { Today: {} } }));
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, noteJson('Note.md', '# Log\n## Today\n- one\n- two\n'));
    let instruction: Record<string, unknown> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      instruction = instructionOf(opts);
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(38));

    const res = await runToolContract(obsidianAppendToNote, {
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Today' },
      content: '- three\n',
      createTargetIfMissing: true,
    });

    expect(instruction).toEqual({
      targetType: 'heading',
      target: ['Log', 'Today'],
      operation: 'append',
      scope: 'content',
      within: -1,
      content: '\n- three',
      rejectIfContentPreexists: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      path: 'Note.md',
      sectionTargeted: true,
      sectionTarget: 'Log::Today',
      created: false,
      previousSizeInBytes: 30,
      currentSizeInBytes: 38,
    });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Section targeted:* true → Log::Today');
    expect(text).toMatch(/Size:\*?\s*30 → 38 bytes/);
  });

  it('rejects a root-level heading that repeats in the note without appending', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(200));
    // # Daily / - monday / # Daily / - tuesday
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Daily: {}, [repeatKey('Daily', 1)]: {} }));
    // No PATCH intercept — a write here would surface "No mock intercept".

    await expect(
      obsidianAppendToNote.handler(
        obsidianAppendToNote.input.parse({
          target: { type: 'path', path: 'Note.md' },
          section: { type: 'heading', target: 'Daily' },
          content: '- new task',
        }),
        createMockContext({ errors: obsidianAppendToNote.errors }),
      ),
    ).rejects.toMatchObject({
      data: { reason: 'ambiguous_section', candidates: ['Daily', 'Daily'] },
    });
  });

  it('rejects a heading that would leave the section as heading_outside_section on both surfaces (plugin v5.x)', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(200));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Daily: { Tasks: {} } }));
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, noteJson('Note.md', '# Daily\n## Tasks\n- a\n'));
    // No PATCH intercept — a write here would surface "No mock intercept".

    const res = await runToolContract(obsidianAppendToNote, {
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Daily::Tasks' },
      content: '## Notes\ntext',
    });

    expect(res.isError).toBe(true);
    const { error } = res.structuredContent as {
      error: { code: number; data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('heading_outside_section');
    expect(error.data.recovery.hint).toContain("obsidian_append_to_note with `section: 'Daily'`");
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain("Heading '## Notes' in the content is level 2");
    expect(text).toContain('heading_outside_section');
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

  it('renders the resolved section target alongside sectionTargeted', () => {
    const blocks = obsidianAppendToNote.format!({
      path: 'Daily.md',
      sectionTargeted: true,
      sectionTarget: 'Sandbox::Section A',
      created: false,
      previousSizeInBytes: 200,
      currentSizeInBytes: 218,
    });
    expect((blocks[0] as { text: string }).text).toContain(
      'Section targeted:* true → Sandbox::Section A',
    );
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

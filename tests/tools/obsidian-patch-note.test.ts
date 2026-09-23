/**
 * @fileoverview Handler tests for obsidian_patch_note — surgical PATCH with
 * operation, section, and option flags.
 * @module tests/tools/obsidian-patch-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianPatchNote } from '@/mcp-server/tools/definitions/obsidian-patch-note.tool.js';
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

describe('obsidian_patch_note', () => {
  it('PATCHes with the requested operation and reports both sizes (plugin v4.x headers)', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(800));
    servePluginVersion(pool, '4.2.0');

    let seenHeaders: Record<string, string> = {};
    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(811));

    const out = await obsidianPatchNote.handler(
      obsidianPatchNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'block', target: 'abc123' },
        operation: 'prepend',
        content: 'note prefix',
        patchOptions: { applyIfContentPreexists: true, trimTargetWhitespace: true },
      }),
      createMockContext({ errors: obsidianPatchNote.errors }),
    );

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('prepend');
    expect(seenHeaders['target-type'] ?? seenHeaders['Target-Type']).toBe('block');
    // applyIfContentPreexists: true → omit the Reject header (force-apply path).
    expect(
      seenHeaders['reject-if-content-preexists'] ?? seenHeaders['Reject-If-Content-Preexists'],
    ).toBeUndefined();
    expect(seenHeaders['trim-target-whitespace'] ?? seenHeaders['Trim-Target-Whitespace']).toBe(
      'true',
    );
    expect(seenBody).toBe('note prefix');
    expect(out).toEqual({
      path: 'Note.md',
      section: { type: 'block', target: 'abc123' },
      operation: 'prepend',
      previousSizeInBytes: 800,
      currentSizeInBytes: 811,
    });
  });

  /**
   * Regression for the read/write locator asymmetry: the echoed `section` is
   * the locator the patch landed on, so an agent that passed a bare leaf can
   * see the full path it resolved to.
   */
  it('echoes the resolved heading path when a bare leaf was expanded', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Sandbox: { 'Section A': {} } }));

    let seenTarget: unknown;
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenTarget = instructionOf(opts).target;
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(305));

    const out = await obsidianPatchNote.handler(
      obsidianPatchNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Section A' },
        operation: 'replace',
        content: 'New.',
      }),
      createMockContext({ errors: obsidianPatchNote.errors }),
    );

    expect(seenTarget).toEqual(['Sandbox', 'Section A']);
    expect(out.section).toEqual({ type: 'heading', target: 'Sandbox::Section A' });
  });

  /**
   * Plugin v5.x separates a plain heading prepend from the section's content
   * by a blank line; a list item prepended to a section opening with a list
   * goes out as a `within` splice on that list, and an append beside a table
   * keeps the plain write.
   */
  it.each([
    [
      'prepends a list item flush against the list a section opens with',
      'prepend',
      '# Log\n## Today\n- one\n### Later\ntext\n',
      { scope: 'content', within: 0, content: '- zero\n' },
    ],
    [
      'appends a list item to a section ending in a table as the plain write',
      'append',
      '# Log\n## Today\n| a |\n| - |\n| 1 |\n',
      { content: '- zero' },
    ],
  ] as const)('%s, on both surfaces (plugin v5.x)', async (_l, operation, note, shape) => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(40));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Log: { Today: { Later: {} } } }));
    pool.intercept({ path: '/vault/Note.md', method: 'GET' }).reply(200, noteJson('Note.md', note));
    let instruction: Record<string, unknown> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      instruction = instructionOf(opts);
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(47));

    const res = await runToolContract(obsidianPatchNote, {
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Log::Today' },
      operation,
      content: '- zero',
    });

    expect(instruction).toEqual({
      targetType: 'heading',
      target: ['Log', 'Today'],
      operation,
      ...shape,
      rejectIfContentPreexists: true,
    });
    expect(res.structuredContent).toEqual({
      path: 'Note.md',
      section: { type: 'heading', target: 'Log::Today' },
      operation,
      previousSizeInBytes: 40,
      currentSizeInBytes: 47,
    });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('Log::Today');
    expect(text).toContain(operation);
  });

  it('surfaces an ambiguous bare leaf as a Conflict naming every candidate', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Top: { Child: {} }, Other: { Child: {} } }));
    // No PATCH intercept — a write here would surface "No mock intercept".

    await expect(
      obsidianPatchNote.handler(
        obsidianPatchNote.input.parse({
          target: { type: 'path', path: 'Note.md' },
          section: { type: 'heading', target: 'Child' },
          operation: 'append',
          content: 'x',
        }),
        createMockContext({ errors: obsidianPatchNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: {
        reason: 'ambiguous_section',
        candidates: ['Top::Child', 'Other::Child'],
      },
    });
  });

  it('carries a repeated heading path to both wire surfaces as ambiguous_section', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    // # Root / ## Dup / ## Dup
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Root: { Dup: {}, [repeatKey('Dup', 1)]: {} } }));
    // No PATCH intercept — a write here would surface "No mock intercept".

    const res = await runToolContract(obsidianPatchNote, {
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Root::Dup' },
      operation: 'append',
      content: 'x',
    });

    expect(res.isError).toBe(true);
    const error = (
      res.structuredContent as {
        error: { code: number; data: { candidates: string[]; path: string; reason: string } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.Conflict);
    expect(error.data).toMatchObject({
      reason: 'ambiguous_section',
      path: 'Note.md',
      candidates: ['Root::Dup', 'Root::Dup'],
    });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain("Heading 'Root::Dup' occurs 2 times in Note.md");
    expect(text).toContain('obsidian_replace_in_note');
    expect(text).toContain('reason ambiguous_section');
  });

  it('classifies a 404 as NotFound (pre-PATCH HEAD throws note_missing)', async () => {
    harness.current().pool.intercept({ path: '/vault/Missing.md', method: 'HEAD' }).reply(404, '');

    await expect(
      obsidianPatchNote.handler(
        obsidianPatchNote.input.parse({
          target: { type: 'path', path: 'Missing.md' },
          section: { type: 'heading', target: 'X' },
          operation: 'append',
          content: 'y',
        }),
        createMockContext({ errors: obsidianPatchNote.errors }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  /** Plugin v5.x speaks markdown-patch 2.0: a JSON instruction body with an array heading target. */
  describe('on plugin v5.x', () => {
    const textOf = (res: Awaited<ReturnType<typeof runToolContract>>) =>
      res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

    /** HEAD before the write, the version report, the 2.0 map, and the note for heading levels. */
    function serveReads(content: string) {
      const pool = harness.current().pool;
      pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
      servePluginVersion(pool, '5.2.0');
      pool
        .intercept({ path: '/vault/Note.md', method: 'GET' })
        .reply(200, documentMapV2({ Top: { Child: {} } }));
      pool
        .intercept({ path: '/vault/Note.md', method: 'GET' })
        .reply(200, noteJson('Note.md', content));
      return pool;
    }

    it('sends a JSON instruction and reports the write on both surfaces', async () => {
      const pool = serveReads('# Top\n## Child\nbody\n');
      let instruction: Record<string, unknown> = {};
      pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
        instruction = instructionOf(opts);
        return { statusCode: 200, data: '' };
      });
      pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(320));

      const res = await runToolContract(obsidianPatchNote, {
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Child' },
        operation: 'append',
        content: '### Sub\ntext',
      });

      expect(res.isError).toBeFalsy();
      // `### Sub` lands at level 3 in a level-2 section: one level down, as 2.0 counts it.
      expect(instruction).toEqual({
        targetType: 'heading',
        target: ['Top', 'Child'],
        operation: 'append',
        content: '# Sub\ntext',
        rejectIfContentPreexists: true,
      });
      expect(res.structuredContent).toEqual({
        path: 'Note.md',
        section: { type: 'heading', target: 'Top::Child' },
        operation: 'append',
        previousSizeInBytes: 300,
        currentSizeInBytes: 320,
      });
      const text = textOf(res);
      expect(text).toContain('heading → Top::Child');
      expect(text).toContain('300 → 320 bytes');
    });

    it('surfaces a heading the note lacks as section_target_missing with its recovery', async () => {
      const pool = harness.current().pool;
      pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
      servePluginVersion(pool, '5.2.0');
      pool
        .intercept({ path: '/vault/Note.md', method: 'GET' })
        .reply(200, documentMapV2({ Top: {} }));
      pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply(404, {
        message: 'Not Found\ncould not resolve heading target ["Top","Nope"]',
        errorCode: 40400,
      });

      const res = await runToolContract(obsidianPatchNote, {
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Nope' },
        operation: 'append',
        content: 'x',
      });

      expect(res.isError).toBe(true);
      const { error } = res.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('section_target_missing');
      expect(error.data.recovery.hint).toContain('document-map');
      expect(textOf(res)).toContain('Section target not found in Note.md');
      // The engine's own wording stays off the wire.
      expect(textOf(res)).not.toContain('could not resolve');
    });

    it('surfaces preexisting content as content_preexists', async () => {
      const pool = harness.current().pool;
      pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
      servePluginVersion(pool, '5.2.0');
      pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply(409, {
        message: 'Conflict\nthe target already contains the content to append',
        errorCode: 40900,
      });

      const res = await runToolContract(obsidianPatchNote, {
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'block', target: 'p1' },
        operation: 'append',
        content: ' more',
      });

      expect(res.isError).toBe(true);
      const { error } = res.structuredContent as { error: { data: { reason: string } } };
      expect(error.data.reason).toBe('content_preexists');
      expect(textOf(res)).toContain('applyIfContentPreexists');
    });

    it('rejects content whose heading would leave the section, on both surfaces, without writing', async () => {
      serveReads('# Top\n## Child\nbody\n');
      // No PATCH intercept: a write would surface "No mock intercept".

      const res = await runToolContract(obsidianPatchNote, {
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Child' },
        operation: 'append',
        content: '## Peer\ntext',
      });

      expect(res.isError).toBe(true);
      const { error } = res.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('heading_outside_section');
      expect(error.data.recovery.hint).toContain("obsidian_append_to_note with `section: 'Top'`");
      expect(error.data.recovery.hint).toContain('without `section`');
      expect(error.data.recovery.hint).toContain('level 3 or deeper');
      const text = textOf(res);
      expect(text).toContain("Heading '## Peer' in the content is level 2");
      expect(text).toContain('heading_outside_section');
    });

    it('names the note-level append for a top-level section, which has no parent', async () => {
      const pool = harness.current().pool;
      pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
      servePluginVersion(pool, '5.2.0');
      pool
        .intercept({ path: '/vault/Note.md', method: 'GET' })
        .reply(200, documentMapV2({ Top: {} }));
      pool
        .intercept({ path: '/vault/Note.md', method: 'GET' })
        .reply(200, noteJson('Note.md', '# Top\n'));

      const res = await runToolContract(obsidianPatchNote, {
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top' },
        operation: 'append',
        content: '# Another top\n',
      });

      const { error } = res.structuredContent as {
        error: { data: { reason: string; recovery: { hint: string } } };
      };
      expect(error.data.reason).toBe('heading_outside_section');
      expect(error.data.recovery.hint).not.toContain('parent');
      expect(error.data.recovery.hint).toContain('without `section`');
      expect(error.data.recovery.hint).toContain('level 2 or deeper');
    });

    it('surfaces a rejected table-row patch as patch_rejected with the declared recovery', async () => {
      const pool = harness.current().pool;
      pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
      servePluginVersion(pool, '5.2.0');
      pool
        .intercept({ path: '/vault/Note.md', method: 'GET' })
        .reply(200, noteJson('Note.md', 'para ^tbl\n'));
      pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply(400, {
        errorCode: 40080,
        message:
          'The patch you provided could not be applied to the target content.\nblock "tbl" is not a table; row writes require a table block',
      });

      const res = await runToolContract(obsidianPatchNote, {
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'block', target: 'tbl' },
        operation: 'append',
        content: '[["c","d"]]',
        contentType: 'json',
      });

      expect(res.isError).toBe(true);
      const { error } = res.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('patch_rejected');
      expect(error.data.recovery.hint).toBe(
        obsidianPatchNote.errors?.find((e) => e.reason === 'patch_rejected')?.recovery,
      );
      const text = textOf(res);
      expect(text).toContain('not a table');
      expect(text).not.toContain('row writes require');
    });
  });
});

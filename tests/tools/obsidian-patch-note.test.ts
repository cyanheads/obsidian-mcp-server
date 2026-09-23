/**
 * @fileoverview Handler tests for obsidian_patch_note — surgical PATCH with
 * operation, section, and option flags.
 * @module tests/tools/obsidian-patch-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianPatchNote } from '@/mcp-server/tools/definitions/obsidian-patch-note.tool.js';
import { documentMapV2, repeatKey, setupHarness } from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

describe('obsidian_patch_note', () => {
  it('PATCHes with the requested operation and reports both sizes', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(800));

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
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Sandbox: { 'Section A': {} } }));

    let seenTarget = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      const headers = (opts.headers as Record<string, string>) ?? {};
      seenTarget = decodeURIComponent(headers.target ?? headers.Target ?? '');
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

    expect(seenTarget).toBe('Sandbox::Section A');
    expect(out.section).toEqual({ type: 'heading', target: 'Sandbox::Section A' });
  });

  it('surfaces an ambiguous bare leaf as a Conflict naming every candidate', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
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
});

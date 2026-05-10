/**
 * @fileoverview Handler tests for obsidian_patch_note — surgical PATCH with
 * operation, section, and option flags.
 * @module tests/tools/obsidian-patch-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianPatchNote } from '@/mcp-server/tools/definitions/obsidian-patch-note.tool.js';
import { setupHarness } from '../helpers.js';

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
      createMockContext(),
    );

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('prepend');
    expect(seenHeaders['target-type'] ?? seenHeaders['Target-Type']).toBe('block');
    expect(
      seenHeaders['apply-if-content-preexists'] ?? seenHeaders['Apply-If-Content-Preexists'],
    ).toBe('true');
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
        createMockContext(),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });
});

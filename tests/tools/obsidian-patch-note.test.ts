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

describe('obsidian_patch_note', () => {
  it('PATCHes with the requested operation and propagates patchOptions flags', async () => {
    let seenHeaders: Record<string, string> = {};
    let seenBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'PATCH' })
      .reply((opts) => {
        seenHeaders = (opts.headers as Record<string, string>) ?? {};
        seenBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

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
    });
  });

  it('classifies a 404 as NotFound', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Missing.md', method: 'PATCH' })
      .reply(404, { message: 'no such file' });

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

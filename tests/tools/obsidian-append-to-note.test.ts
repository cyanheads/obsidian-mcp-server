/**
 * @fileoverview Handler tests for obsidian_append_to_note.
 * @module tests/tools/obsidian-append-to-note.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianAppendToNote } from '@/mcp-server/tools/definitions/obsidian-append-to-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian_append_to_note (whole file)', () => {
  it('POSTs the body when no section is given', async () => {
    let seenMethod = '';
    let seenBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'POST' })
      .reply((opts) => {
        seenMethod = opts.method as string;
        seenBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianAppendToNote.handler(
      obsidianAppendToNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'tail',
      }),
      createMockContext(),
    );

    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('tail');
    expect(out.sectionTargeted).toBe(false);
  });
});

describe('obsidian_append_to_note (section)', () => {
  it('PATCHes with operation=append and forwards createTargetIfMissing', async () => {
    let seenHeaders: Record<string, string> = {};
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'PATCH' })
      .reply((opts) => {
        seenHeaders = (opts.headers as Record<string, string>) ?? {};
        return { statusCode: 200, data: '' };
      });

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
    expect(out.sectionTargeted).toBe(true);
  });
});

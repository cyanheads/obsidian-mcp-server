/**
 * @fileoverview Handler tests for obsidian_write_note (whole-file PUT and
 * section-targeted PATCH).
 * @module tests/tools/obsidian-write-note.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianWriteNote } from '@/mcp-server/tools/definitions/obsidian-write-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian_write_note (whole file)', () => {
  it('PUTs the body with text/markdown when no section is given', async () => {
    let seenMethod = '';
    let seenBody = '';
    let seenContentType = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'PUT' })
      .reply((opts) => {
        seenMethod = opts.method as string;
        seenBody = String(opts.body ?? '');
        const headers = opts.headers as Record<string, string>;
        seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
        return { statusCode: 200, data: '' };
      });

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
    expect(out).toEqual({ path: 'Note.md', sectionTargeted: false });
  });
});

describe('obsidian_write_note (section)', () => {
  it('PATCHes with replace + heading delimiter + apply-if-content-preexists', async () => {
    let seenHeaders: Record<string, string> = {};
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'PATCH' })
      .reply((opts) => {
        seenHeaders = (opts.headers as Record<string, string>) ?? {};
        return { statusCode: 200, data: '' };
      });

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
    expect(out.sectionTargeted).toBe(true);
  });

  it('strips a leading duplicate heading line from content when targeting a heading', async () => {
    let seenBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'PATCH' })
      .reply((opts) => {
        seenBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

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
    let seenBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'PATCH' })
      .reply((opts) => {
        seenBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

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
    let seenContentType = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'PUT' })
      .reply((opts) => {
        const headers = opts.headers as Record<string, string>;
        seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
        return { statusCode: 200, data: '' };
      });

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
  it('renders the path and sectionTargeted', () => {
    const blocks = obsidianWriteNote.format!({
      path: 'A.md',
      sectionTargeted: true,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('A.md');
    expect(text).toMatch(/Section targeted:\*?\s*true/);
  });
});

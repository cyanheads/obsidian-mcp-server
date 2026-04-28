/**
 * @fileoverview Handler tests for obsidian_open_in_ui — the failIfMissing /
 * createdIfMissing matrix and newLeaf forwarding.
 * @module tests/tools/obsidian-open-in-ui.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianOpenInUi } from '@/mcp-server/tools/definitions/obsidian-open-in-ui.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const noteJson = (path: string) => ({
  path,
  content: 'body',
  frontmatter: {},
  tags: [],
  stat: { ctime: 0, mtime: 0, size: 0 },
});

describe('obsidian_open_in_ui', () => {
  it('opens an existing file when failIfMissing=true (default)', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('N.md'), { headers: { 'content-type': 'application/json' } });
    let opened = false;
    harness
      .current()
      .pool.intercept({ path: (p) => (p as string).startsWith('/open/N.md'), method: 'POST' })
      .reply(() => {
        opened = true;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'N.md' }),
      createMockContext(),
    );
    expect(opened).toBe(true);
    expect(out).toEqual({ path: 'N.md', opened: true, createdIfMissing: false });
  });

  it('throws NotFound when the file does not exist and failIfMissing is true', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(404, { message: 'gone' });
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['totally-different.md'] });

    await expect(
      obsidianOpenInUi.handler(obsidianOpenInUi.input.parse({ path: 'N.md' }), createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('appends `did you mean` to the NotFound message when a close match exists', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(404, { message: 'gone' });
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['n'] });

    await expect(
      obsidianOpenInUi.handler(obsidianOpenInUi.input.parse({ path: 'N.md' }), createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Did you mean: "n"?'),
      data: { path: 'N.md', suggestions: ['n'] },
    });
  });

  it('reports createdIfMissing=true when file was absent and failIfMissing=false', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness.current().pool.intercept({ path: '/vault/', method: 'GET' }).reply(200, { files: [] });
    harness
      .current()
      .pool.intercept({ path: (p) => (p as string).startsWith('/open/N.md'), method: 'POST' })
      .reply(200, '');

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'N.md', failIfMissing: false }),
      createMockContext(),
    );
    expect(out.createdIfMissing).toBe(true);
    expect(out.path).toBe('N.md');
  });

  it('resolves a case-mismatch path through the fallback and opens the canonical file', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/MyNote.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['mynote.md'] });
    harness
      .current()
      .pool.intercept({ path: '/vault/mynote.md', method: 'GET' })
      .reply(200, noteJson('mynote.md'), { headers: { 'content-type': 'application/json' } });
    let openedPath = '';
    harness
      .current()
      .pool.intercept({ path: (p) => (p as string).startsWith('/open/mynote.md'), method: 'POST' })
      .reply((opts) => {
        openedPath = opts.path;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'MyNote.md' }),
      createMockContext(),
    );
    expect(openedPath).toContain('/open/mynote.md');
    expect(out).toEqual({ path: 'mynote.md', opened: true, createdIfMissing: false });
  });

  it('forwards newLeaf=true as a query parameter', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('N.md'), { headers: { 'content-type': 'application/json' } });
    let seenPath = '';
    harness
      .current()
      .pool.intercept({
        path: (p) => {
          seenPath = p as string;
          return seenPath.startsWith('/open/');
        },
        method: 'POST',
      })
      .reply(200, '');

    await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'N.md', newLeaf: true }),
      createMockContext(),
    );
    expect(seenPath).toContain('newLeaf=true');
  });
});

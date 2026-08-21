/**
 * @fileoverview Handler tests for obsidian_open_in_ui — the failIfMissing /
 * createdIfMissing matrix, the path-policy gate on the create-capable branch,
 * and newLeaf forwarding.
 * @module tests/tools/obsidian-open-in-ui.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { obsidianOpenInUi } from '@/mcp-server/tools/definitions/obsidian-open-in-ui.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse, setupHarness } from '../helpers.js';

const harness = setupHarness();

const noteJson = (path: string) => ({
  path,
  content: 'body',
  frontmatter: {},
  tags: [],
  stat: { ctime: 0, mtime: 0, size: 0 },
});

/**
 * Install a service with a custom path policy over a fetch stub that records
 * every request it is asked to make. The recording is the point: proving the
 * tool refused a create means proving the `POST /open/…` that Obsidian would
 * have acted on was never issued, not merely that an error came back.
 */
function withPolicy(
  config: Partial<ServerConfig>,
  files: Record<string, unknown>,
): { requests: string[]; ctx: Parameters<typeof obsidianOpenInUi.handler>[1] } {
  const requests: string[] = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    const u = new URL(url);
    requests.push(`${(init.method ?? 'GET').toUpperCase()} ${u.pathname}`);
    if (u.pathname.startsWith('/open/')) return mockResponse('', { status: 200 });
    const body = files[u.pathname];
    if (body === undefined) {
      return mockResponse(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return mockResponse(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/vnd.olrapi.note+json',
        'content-disposition': 'attachment; filename="note.md"',
      },
    });
  };
  setObsidianService(new ObsidianService(makeTestConfig(config), fetchImpl));
  return { requests, ctx: createMockContext({ errors: obsidianOpenInUi.errors }) };
}

afterEach(() => {
  setObsidianService(undefined);
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
      createMockContext({ errors: obsidianOpenInUi.errors }),
    );
    expect(opened).toBe(true);
    expect(out).toEqual({ path: 'N.md', opened: true, createdIfMissing: false });
  });

  it('throws note_missing (NotFound) when the file does not exist and failIfMissing is true', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(404, { message: 'gone' });
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['totally-different.md'] });

    await expect(
      obsidianOpenInUi.handler(
        obsidianOpenInUi.input.parse({ path: 'N.md' }),
        createMockContext({ errors: obsidianOpenInUi.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'note_missing' },
    });
  });

  it('appends `did you mean` to the note_missing message when a close match exists', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(404, { message: 'gone' });
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['n'] });

    await expect(
      obsidianOpenInUi.handler(
        obsidianOpenInUi.input.parse({ path: 'N.md' }),
        createMockContext({ errors: obsidianOpenInUi.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        path: 'N.md',
        suggestions: ['n'],
        reason: 'note_missing',
        recovery: { hint: expect.stringContaining('Did you mean: "n"?') },
      },
    });
  });

  it('reports createdIfMissing=false for a file that already existed, with failIfMissing=false', async () => {
    let probed = false;
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(() => {
        probed = true;
        return {
          statusCode: 200,
          data: noteJson('N.md'),
          responseOptions: { headers: { 'content-type': 'application/vnd.olrapi.note+json' } },
        };
      });
    harness
      .current()
      .pool.intercept({ path: (p) => (p as string).startsWith('/open/N.md'), method: 'POST' })
      .reply(200, '');

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'N.md', failIfMissing: false }),
      createMockContext({ errors: obsidianOpenInUi.errors }),
    );
    expect(probed).toBe(true);
    expect(out).toEqual({ path: 'N.md', opened: true, createdIfMissing: false });
  });

  it('reports createdIfMissing=true only when the probe found nothing there', async () => {
    harness.current().pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(404, '');
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['unrelated.md'] });
    let opened = false;
    harness
      .current()
      .pool.intercept({ path: (p) => (p as string).startsWith('/open/N.md'), method: 'POST' })
      .reply(() => {
        opened = true;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'N.md', failIfMissing: false }),
      createMockContext({ errors: obsidianOpenInUi.errors }),
    );
    expect(opened).toBe(true);
    expect(out).toEqual({ path: 'N.md', opened: true, createdIfMissing: true });
  });

  it('resolves a case mismatch instead of creating a second file, with failIfMissing=false', async () => {
    harness.current().pool.intercept({ path: '/vault/MyNote.md', method: 'GET' }).reply(404, '');
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['mynote.md'] });
    harness
      .current()
      .pool.intercept({ path: '/vault/mynote.md', method: 'GET' })
      .reply(200, noteJson('mynote.md'), {
        headers: { 'content-type': 'application/vnd.olrapi.note+json' },
      });
    let openedPath = '';
    harness
      .current()
      .pool.intercept({ path: (p) => (p as string).startsWith('/open/'), method: 'POST' })
      .reply((opts) => {
        openedPath = opts.path;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'MyNote.md', failIfMissing: false }),
      createMockContext({ errors: obsidianOpenInUi.errors }),
    );
    expect(openedPath).toContain('/open/mynote.md');
    expect(out).toEqual({ path: 'mynote.md', opened: true, createdIfMissing: false });
  });

  /**
   * Two files whose names differ only in case leave the fallback with no single
   * canonical target. Before the probe ran on this branch, `failIfMissing:
   * false` skipped resolution entirely and handed the literal path to Obsidian,
   * which would have materialized a third file alongside the two that exist.
   * Now the ambiguity has to surface as `ambiguous_path` with no open issued.
   */
  it('refuses an ambiguous case match rather than creating a third file, with failIfMissing=false', async () => {
    harness.current().pool.intercept({ path: '/vault/mynote.md', method: 'GET' }).reply(404, '');
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: ['MyNote.md', 'MYNOTE.md'] });
    let opened = false;
    harness
      .current()
      .pool.intercept({ path: (p) => (p as string).startsWith('/open/'), method: 'POST' })
      .reply(() => {
        opened = true;
        return { statusCode: 200, data: '' };
      });

    await expect(
      obsidianOpenInUi.handler(
        obsidianOpenInUi.input.parse({ path: 'mynote.md', failIfMissing: false }),
        createMockContext({ errors: obsidianOpenInUi.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: {
        reason: 'ambiguous_path',
        matches: ['MyNote.md', 'MYNOTE.md'],
        recovery: { hint: expect.stringContaining('matches') },
      },
    });
    expect(opened).toBe(false);
  });

  it('rejects a path that names a folder', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Inbox', method: 'GET' })
      .reply(200, { files: ['a.md'] }, { headers: { 'content-type': 'application/json' } });

    await expect(
      obsidianOpenInUi.handler(
        obsidianOpenInUi.input.parse({ path: 'Inbox', failIfMissing: false }),
        createMockContext({ errors: obsidianOpenInUi.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_is_directory' },
    });
  });

  it('rejects a dot-segment path with path_traversal', async () => {
    await expect(
      obsidianOpenInUi.handler(
        obsidianOpenInUi.input.parse({ path: '../escape.md' }),
        createMockContext({ errors: obsidianOpenInUi.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal', recovery: { hint: expect.stringContaining('..') } },
    });
  });
});

describe('obsidian_open_in_ui — path policy on the create-capable branch', () => {
  it('read-only mode refuses to open a missing path and never issues the open request', async () => {
    const { requests, ctx } = withPolicy({ readOnly: true }, {});

    await expect(
      obsidianOpenInUi.handler(
        obsidianOpenInUi.input.parse({ path: 'Notes/ghost.md', failIfMissing: false }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden', subreason: 'read_only_mode', op: 'write' },
    });
    expect(requests.filter((r) => r.includes('/open/'))).toEqual([]);
  });

  it('read-only mode still opens a file that already exists', async () => {
    const { requests, ctx } = withPolicy(
      { readOnly: true },
      { '/vault/Notes/real.md': noteJson('Notes/real.md') },
    );

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'Notes/real.md', failIfMissing: false }),
      ctx,
    );
    expect(out).toEqual({ path: 'Notes/real.md', opened: true, createdIfMissing: false });
    expect(requests).toContain('POST /open/Notes/real.md');
  });

  it('refuses to open a missing path outside OBSIDIAN_WRITE_PATHS', async () => {
    const { requests, ctx } = withPolicy({ writePaths: ['inbox'] }, {});

    await expect(
      obsidianOpenInUi.handler(
        obsidianOpenInUi.input.parse({ path: 'Notes/ghost.md', failIfMissing: false }),
        ctx,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden', subreason: 'outside_write_paths', op: 'write' },
    });
    expect(requests.filter((r) => r.includes('/open/'))).toEqual([]);
  });

  it('creates inside OBSIDIAN_WRITE_PATHS', async () => {
    const { requests, ctx } = withPolicy({ writePaths: ['inbox'] }, {});

    const out = await obsidianOpenInUi.handler(
      obsidianOpenInUi.input.parse({ path: 'Inbox/new.md', failIfMissing: false }),
      ctx,
    );
    expect(out.createdIfMissing).toBe(true);
    expect(requests).toContain('POST /open/Inbox/new.md');
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
      createMockContext({ errors: obsidianOpenInUi.errors }),
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
      createMockContext({ errors: obsidianOpenInUi.errors }),
    );
    expect(seenPath).toContain('newLeaf=true');
  });
});

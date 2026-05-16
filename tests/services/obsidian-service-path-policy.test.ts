/**
 * @fileoverview Service-level path-policy integration tests. Constructs
 * `ObsidianService` with custom path config and verifies that gated methods
 * throw `path_forbidden` before hitting the upstream, while in-scope paths
 * pass through.
 * @module tests/services/obsidian-service-path-policy.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig } from '../helpers.js';

let ctx: Context;
let upstreamHits: number;

beforeEach(() => {
  ctx = createMockContext();
  upstreamHits = 0;
});

afterEach(() => {
  setObsidianService(undefined);
});

function buildService(
  config: Partial<ServerConfig>,
  scriptedReplies?: Map<string, () => Response>,
) {
  const fetchImpl: ObsidianFetch = async (url) => {
    upstreamHits++;
    const u = new URL(url);
    const reply = scriptedReplies?.get(u.pathname);
    if (reply) return reply();
    throw new Error(`No mock reply for ${u.pathname}`);
  };
  return new ObsidianService(makeTestConfig(config), fetchImpl);
}

describe('write tools — assertWritable before upstream', () => {
  it('blocks writeNote on a path outside writePaths without making an HTTP call', async () => {
    const svc = buildService({ writePaths: ['projects'] });
    await expect(
      svc.writeNote(ctx, { type: 'path', path: 'secret/foo.md' }, 'x'),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden', subreason: 'outside_write_paths' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('allows writeNote on a path inside writePaths', async () => {
    const replies = new Map<string, () => Response>([
      ['/vault/projects/foo.md', () => new Response('', { status: 200 })],
    ]);
    const svc = buildService({ writePaths: ['projects'] }, replies);
    await svc.writeNote(ctx, { type: 'path', path: 'projects/foo.md' }, 'x');
    expect(upstreamHits).toBe(1);
  });

  it('blocks deleteNote on a path outside writePaths', async () => {
    const svc = buildService({ writePaths: ['projects'] });
    await expect(
      svc.deleteNote(ctx, { type: 'path', path: 'secret/foo.md' }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Forbidden });
    expect(upstreamHits).toBe(0);
  });

  it('READ_ONLY=true short-circuits writeNote with read_only_mode subreason', async () => {
    const svc = buildService({ readOnly: true });
    let caughtSubreason: string | undefined;
    try {
      await svc.writeNote(ctx, { type: 'path', path: 'projects/foo.md' }, 'x');
    } catch (err) {
      caughtSubreason = (err as { data?: { subreason?: string } }).data?.subreason;
    }
    expect(caughtSubreason).toBe('read_only_mode');
    expect(upstreamHits).toBe(0);
  });
});

describe('read tools — assertReadable before upstream', () => {
  it('blocks getNoteContent on a path outside readPaths', async () => {
    const svc = buildService({ readPaths: ['public'] });
    await expect(
      svc.getNoteContent(ctx, { type: 'path', path: 'secret/foo.md' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden', subreason: 'outside_read_paths' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('blocks openInUi on a path outside readPaths', async () => {
    const svc = buildService({ readPaths: ['public'] });
    await expect(svc.openInUi(ctx, 'secret/foo.md')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
    expect(upstreamHits).toBe(0);
  });

  it('listFiles allows the vault root regardless of readPaths', async () => {
    const replies = new Map<string, () => Response>([
      [
        '/vault/',
        () =>
          new Response(JSON.stringify({ files: ['projects/', 'secret/', 'note.md'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ],
    ]);
    const svc = buildService({ readPaths: ['projects'] }, replies);
    const out = await svc.listFiles(ctx);
    expect(out.files).toContain('projects/');
    /** Children aren't filtered at the service level — caller-side reads are gated separately. */
    expect(out.files).toContain('secret/');
  });

  it('listFiles blocks a non-root dir outside readPaths', async () => {
    const svc = buildService({ readPaths: ['projects'] });
    await expect(svc.listFiles(ctx, 'secret')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
    });
    expect(upstreamHits).toBe(0);
  });
});

describe('write-implies-read for the same path', () => {
  it('getNoteContent passes when path is in writePaths only', async () => {
    const replies = new Map<string, () => Response>([
      [
        '/vault/projects/foo.md',
        () => new Response('hello', { status: 200, headers: { 'content-type': 'text/markdown' } }),
      ],
    ]);
    const svc = buildService({ readPaths: ['public'], writePaths: ['projects'] }, replies);
    const out = await svc.getNoteContent(ctx, { type: 'path', path: 'projects/foo.md' });
    expect(out).toBe('hello');
  });
});

describe('non-path targets — gate after JSON resolution', () => {
  it('getNoteJson on `active` throws path_forbidden when resolved path is out of scope', async () => {
    const replies = new Map<string, () => Response>([
      [
        '/active/',
        () =>
          new Response(
            JSON.stringify({
              path: 'secret/foo.md',
              content: 'hi',
              frontmatter: {},
              tags: [],
              stat: { ctime: 0, mtime: 0, size: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ],
    ]);
    const svc = buildService({ readPaths: ['public'] }, replies);
    await expect(svc.getNoteJson(ctx, { type: 'active' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { subreason: 'outside_read_paths' },
    });
  });
});

describe('unrestricted policy — no extra calls or behavior changes', () => {
  it('writeNote on any path passes through with one upstream call', async () => {
    const replies = new Map<string, () => Response>([
      ['/vault/anywhere/foo.md', () => new Response('', { status: 200 })],
    ]);
    const svc = buildService({}, replies);
    await svc.writeNote(ctx, { type: 'path', path: 'anywhere/foo.md' }, 'x');
    expect(upstreamHits).toBe(1);
  });
});

describe('Windows-style paths integrate end-to-end', () => {
  /**
   * A user (or LLM) sending `Public\sub\note.md` should be treated identically
   * to `public/sub/note.md`: the policy matches against the configured prefix,
   * and the encoder produces a forward-slash URL.
   */
  it('Windows separators match forward-slash prefix and reach forward-slash URL', async () => {
    const replies = new Map<string, () => Response>([
      [
        '/vault/Public/sub/note.md',
        () => new Response('hello', { status: 200, headers: { 'content-type': 'text/markdown' } }),
      ],
    ]);
    const svc = buildService({ readPaths: ['public'] }, replies);
    const out = await svc.getNoteContent(ctx, { type: 'path', path: 'Public\\sub\\note.md' });
    expect(out).toBe('hello');
    expect(upstreamHits).toBe(1);
  });

  it('blocks Windows-style traversal in restricted-read mode (policy catches it first)', async () => {
    const svc = buildService({ readPaths: ['public'] });
    await expect(
      svc.getNoteContent(ctx, { type: 'path', path: '..\\secret\\foo.md' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { reason: 'path_forbidden' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('blocks Windows-style traversal in unrestricted mode (encoder catches it)', async () => {
    const svc = buildService({});
    await expect(
      svc.getNoteContent(ctx, { type: 'path', path: '..\\..\\Windows\\System32\\config\\SAM' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('blocks Windows-style write traversal in unrestricted mode', async () => {
    const svc = buildService({});
    await expect(
      svc.writeNote(ctx, { type: 'path', path: '..\\..\\evil.md' }, 'pwned'),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
    expect(upstreamHits).toBe(0);
  });

  it('Windows-style write path matches write prefix and reaches upstream', async () => {
    const replies = new Map<string, () => Response>([
      ['/vault/projects/note.md', () => new Response('', { status: 200 })],
    ]);
    const svc = buildService({ writePaths: ['projects'] }, replies);
    await svc.writeNote(ctx, { type: 'path', path: 'projects\\note.md' }, 'x');
    expect(upstreamHits).toBe(1);
  });
});

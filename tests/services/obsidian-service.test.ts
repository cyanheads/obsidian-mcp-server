/**
 * @fileoverview Integration tests for ObsidianService against a mocked
 * `undici.fetch`. Asserts URL building, header behavior, error classification,
 * and retry.
 * @module tests/services/obsidian-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { encodeVaultPath, type ObsidianService } from '@/services/obsidian/obsidian-service.js';
import { setupHarness, type TestHarness } from '../helpers.js';

const harness = setupHarness();
let pool: TestHarness['pool'];
let service: ObsidianService;
let ctx: Context;

beforeEach(() => {
  pool = harness.current().pool;
  service = harness.current().service;
  ctx = createMockContext();
});

describe('ObsidianService.getStatus', () => {
  it('hits GET / without an Authorization header', async () => {
    pool
      .intercept({ path: '/', method: 'GET' })
      .reply(
        200,
        { status: 'OK', service: 'Obsidian Local REST API', authenticated: true },
        { headers: { 'content-type': 'application/json' } },
      );

    const status = await service.getStatus(ctx);
    expect(status.status).toBe('OK');
    expect(status.authenticated).toBe(true);
  });
});

describe('ObsidianService.getNoteContent', () => {
  it('GETs the encoded path with Accept: text/markdown', async () => {
    let seenAuth: string | undefined;
    let seenAccept: string | undefined;
    pool.intercept({ path: '/vault/Projects/My%20Note.md', method: 'GET' }).reply((opts) => {
      const headers = opts.headers as Record<string, string>;
      seenAuth = headers.authorization ?? headers.Authorization;
      seenAccept = headers.accept ?? headers.Accept;
      return { statusCode: 200, data: '# hello' };
    });

    const out = await service.getNoteContent(ctx, {
      type: 'path',
      path: 'Projects/My Note.md',
    });

    expect(out).toBe('# hello');
    expect(seenAuth).toBe('Bearer test-api-key');
    expect(seenAccept).toBe('text/markdown');
  });
});

describe('ObsidianService.getNoteJson', () => {
  it('uses the active-file path for target.type === "active"', async () => {
    pool.intercept({ path: '/active/', method: 'GET' }).reply(
      200,
      {
        path: 'today.md',
        content: 'body',
        frontmatter: {},
        tags: [],
        stat: { ctime: 0, mtime: 0, size: 4 },
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const note = await service.getNoteJson(ctx, { type: 'active' });
    expect(note.path).toBe('today.md');
  });

  it('builds a periodic-dated URL with zero-padded YYYY/MM/DD', async () => {
    pool.intercept({ path: '/periodic/daily/2026/04/01/', method: 'GET' }).reply(
      200,
      {
        path: 'Daily/2026-04-01.md',
        content: 'daily',
        frontmatter: {},
        tags: [],
        stat: { ctime: 0, mtime: 0, size: 5 },
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const note = await service.getNoteJson(ctx, {
      type: 'periodic',
      period: 'daily',
      date: '2026-04-01',
    });
    expect(note.path).toBe('Daily/2026-04-01.md');
  });

  it('rejects malformed dates with ValidationError', async () => {
    await expect(
      service.getNoteJson(ctx, {
        type: 'periodic',
        period: 'daily',
        date: 'not-a-date',
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('uses the current-period path when date is omitted', async () => {
    pool.intercept({ path: '/periodic/weekly/', method: 'GET' }).reply(
      200,
      {
        path: 'Weekly/Current.md',
        content: '',
        frontmatter: {},
        tags: [],
        stat: { ctime: 0, mtime: 0, size: 0 },
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const note = await service.getNoteJson(ctx, { type: 'periodic', period: 'weekly' });
    expect(note.path).toBe('Weekly/Current.md');
  });
});

describe('ObsidianService.patchNote header building', () => {
  it('emits Operation, Target-Type, URL-encoded Target, Target-Delimiter, and option flags', async () => {
    let seenHeaders: Record<string, string> = {};
    pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
      return { statusCode: 200, data: '' };
    });

    await service.patchNote(ctx, { type: 'path', path: 'N.md' }, 'inserted body', {
      operation: 'append',
      targetType: 'heading',
      target: 'Top::Sub Title',
      targetDelimiter: '::',
      createTargetIfMissing: true,
      applyIfContentPreexists: true,
      trimTargetWhitespace: true,
      contentType: 'markdown',
    });

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('append');
    expect(seenHeaders['target-type'] ?? seenHeaders['Target-Type']).toBe('heading');
    expect(seenHeaders.target ?? seenHeaders.Target).toBe(encodeURIComponent('Top::Sub Title'));
    expect(seenHeaders['target-delimiter'] ?? seenHeaders['Target-Delimiter']).toBe('::');
    expect(seenHeaders['create-target-if-missing'] ?? seenHeaders['Create-Target-If-Missing']).toBe(
      'true',
    );
    expect(
      seenHeaders['apply-if-content-preexists'] ?? seenHeaders['Apply-If-Content-Preexists'],
    ).toBe('true');
    expect(seenHeaders['trim-target-whitespace'] ?? seenHeaders['Trim-Target-Whitespace']).toBe(
      'true',
    );
    expect(seenHeaders['content-type'] ?? seenHeaders['Content-Type']).toBe('text/markdown');
  });

  it('omits unset option headers when the corresponding flag is undefined', async () => {
    let seenHeaders: Record<string, string> = {};
    pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
      return { statusCode: 200, data: '' };
    });

    await service.patchNote(ctx, { type: 'path', path: 'N.md' }, 'body', {
      operation: 'replace',
      targetType: 'frontmatter',
      target: 'priority',
      contentType: 'json',
    });

    expect(seenHeaders['create-target-if-missing']).toBeUndefined();
    expect(seenHeaders['apply-if-content-preexists']).toBeUndefined();
    expect(seenHeaders['trim-target-whitespace']).toBeUndefined();
    expect(seenHeaders['content-type'] ?? seenHeaders['Content-Type']).toBe('application/json');
  });
});

describe('ObsidianService error classification', () => {
  it('classifies 401 as Unauthorized with a remediation message', async () => {
    pool
      .intercept({ path: '/vault/x.md', method: 'GET' })
      .reply(401, { errorCode: 401, message: 'bad token' });

    await expect(service.getNoteContent(ctx, { type: 'path', path: 'x.md' })).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.Unauthorized,
        message: expect.stringContaining('OBSIDIAN_API_KEY'),
      },
    );
  });

  it('classifies 403 as Forbidden', async () => {
    pool.intercept({ path: '/vault/x.md', method: 'GET' }).reply(403, { message: 'nope' });

    await expect(service.getNoteContent(ctx, { type: 'path', path: 'x.md' })).rejects.toMatchObject(
      { code: JsonRpcErrorCode.Forbidden },
    );
  });

  it('classifies 404 on /active/ with no_active_file reason', async () => {
    pool.intercept({ path: '/active/', method: 'GET' }).reply(404, { message: 'no active' });

    await expect(service.getNoteJson(ctx, { type: 'active' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('No file is currently active'),
      data: { reason: 'no_active_file' },
    });
  });

  it('classifies 404 on /periodic/ with periodic_not_found reason', async () => {
    pool
      .intercept({ path: '/periodic/daily/2026/04/28/', method: 'GET' })
      .reply(404, { message: 'no daily' });

    await expect(
      service.getNoteJson(ctx, { type: 'periodic', period: 'daily', date: '2026-04-28' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'periodic_not_found' },
    });
  });

  it('classifies 404 on a vault path with note_missing reason', async () => {
    pool.intercept({ path: '/vault/x.md', method: 'GET' }).reply(404, { message: 'gone' });

    await expect(service.getNoteContent(ctx, { type: 'path', path: 'x.md' })).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'note_missing' },
      },
    );
  });

  it('classifies 404 on /commands/ with command_unknown reason', async () => {
    pool
      .intercept({ path: '/commands/unknown%3Acmd/', method: 'POST' })
      .reply(404, { message: 'no such command' });

    await expect(service.executeCommand(ctx, 'unknown:cmd')).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Unknown Obsidian command'),
      data: { reason: 'command_unknown' },
    });
  });

  it('classifies 405 as ValidationError with path_is_directory reason', async () => {
    pool.intercept({ path: '/vault/dir.md', method: 'GET' }).reply(405, { message: 'directory' });

    await expect(
      service.getNoteContent(ctx, { type: 'path', path: 'dir.md' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_is_directory' },
    });
  });

  it('classifies 400 as ValidationError and preserves the upstream message', async () => {
    pool.intercept({ path: '/vault/x.md', method: 'GET' }).reply(400, { message: 'malformed' });

    await expect(service.getNoteContent(ctx, { type: 'path', path: 'x.md' })).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('malformed'),
      },
    );
  });

  it('classifies 400 with "could not be applied" body as section_target_missing', async () => {
    pool
      .intercept({ path: '/vault/N.md', method: 'PATCH' })
      .reply(400, { message: 'patch could not be applied to the target' });

    await expect(
      service.patchNote(ctx, { type: 'path', path: 'N.md' }, 'body', {
        operation: 'append',
        targetType: 'heading',
        target: 'Missing',
        contentType: 'markdown',
      }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('Section target not found'),
      data: { reason: 'section_target_missing' },
    });
  });
});

describe('ObsidianService.probeAuthenticated', () => {
  it('returns false on a non-2xx response', async () => {
    pool.intercept({ path: '/vault/', method: 'GET' }).reply(401, {});
    expect(await service.probeAuthenticated(ctx)).toBe(false);
  });

  it('returns false on a network error', async () => {
    pool.intercept({ path: '/vault/', method: 'GET' }).reply(() => {
      throw new TypeError('network kaboom');
    });
    expect(await service.probeAuthenticated(ctx)).toBe(false);
  });

  it('re-throws when the request was aborted', async () => {
    const abortCtx = createMockContext();
    const controller = new AbortController();
    Object.defineProperty(abortCtx, 'signal', { value: controller.signal });
    controller.abort(new Error('cancelled'));

    pool.intercept({ path: '/vault/', method: 'GET' }).reply(() => {
      throw new Error('cancelled');
    });

    await expect(service.probeAuthenticated(abortCtx)).rejects.toThrow(/cancelled/);
  });
});

describe('ObsidianService search', () => {
  it('text search hits /search/simple/ with query + contextLength as query params', async () => {
    let seenPath = '';
    pool
      .intercept({
        path: (p) => {
          const s = p as string;
          if (s.startsWith('/search/simple/')) seenPath = s;
          return s.startsWith('/search/simple/');
        },
        method: 'POST',
      })
      .reply(200, [{ filename: 'x.md', matches: [] }], {
        headers: { 'content-type': 'application/json' },
      });

    await service.searchText(ctx, 'hello world', 50);
    expect(seenPath).toContain('query=hello+world');
    expect(seenPath).toContain('contextLength=50');
  });

  it('dataview search uses the DQL content type', async () => {
    let seenContentType = '';
    pool.intercept({ path: '/search/', method: 'POST' }).reply((opts) => {
      const headers = opts.headers as Record<string, string>;
      seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
      return { statusCode: 200, data: [{ filename: 'x.md', result: [] }] };
    });

    await service.searchDataview(ctx, 'TABLE file.mtime FROM ""');
    expect(seenContentType).toBe('application/vnd.olrapi.dataview.dql+txt');
  });

  it('jsonlogic search uses the JSONLogic content type and JSON-stringifies the body', async () => {
    let seenBody = '';
    let seenContentType = '';
    pool.intercept({ path: '/search/', method: 'POST' }).reply((opts) => {
      const headers = opts.headers as Record<string, string>;
      seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: [] };
    });

    await service.searchJsonLogic(ctx, { glob: ['*.md', { var: 'path' }] });
    expect(seenContentType).toBe('application/vnd.olrapi.jsonlogic+json');
    expect(seenBody).toContain('"glob"');
  });
});

describe('ObsidianService.openInUi', () => {
  it('sends newLeaf=true as a query param when requested', async () => {
    let seenPath = '';
    pool
      .intercept({
        path: (p) => {
          seenPath = p as string;
          return seenPath.startsWith('/open/');
        },
        method: 'POST',
      })
      .reply(200, '');

    await service.openInUi(ctx, 'Folder/Note.md', { newLeaf: true });
    expect(seenPath).toContain('newLeaf=true');
  });

  it('omits the query string when newLeaf is false/undefined', async () => {
    let seenPath = '';
    pool
      .intercept({
        path: (p) => {
          seenPath = p as string;
          return seenPath.startsWith('/open/');
        },
        method: 'POST',
      })
      .reply(200, '');

    await service.openInUi(ctx, 'Folder/Note.md');
    expect(seenPath.endsWith('Folder/Note.md')).toBe(true);
  });
});

describe('encodeVaultPath', () => {
  it('preserves slashes between segments and encodes per-segment', () => {
    expect(encodeVaultPath('Projects/My Note.md')).toBe('Projects/My%20Note.md');
  });

  it('strips empty leading/trailing slashes', () => {
    expect(encodeVaultPath('/foo/')).toBe('foo');
  });
});

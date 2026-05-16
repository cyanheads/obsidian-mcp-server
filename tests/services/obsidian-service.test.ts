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
import { type PathMatcher, type ReplyFn, setupHarness, type TestHarness } from '../helpers.js';

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

  it('routes 500 through the framework helper as InternalError (not retried)', async () => {
    pool.intercept({ path: '/vault/x.md', method: 'GET' }).reply(500, { message: 'kaboom' });

    await expect(service.getNoteContent(ctx, { type: 'path', path: 'x.md' })).rejects.toMatchObject(
      {
        code: JsonRpcErrorCode.InternalError,
        message: expect.stringContaining('Obsidian Local REST API'),
      },
    );
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

describe('ObsidianService.tryGetSize / getSize', () => {
  it('returns the Content-Length header value on a 200 HEAD', async () => {
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': '1024' } });

    const size = await service.tryGetSize(ctx, { type: 'path', path: 'N.md' });
    expect(size).toBe(1024);
  });

  it('returns null on a 404 HEAD (file does not exist)', async () => {
    pool.intercept({ path: '/vault/missing.md', method: 'HEAD' }).reply(404, '');

    expect(await service.tryGetSize(ctx, { type: 'path', path: 'missing.md' })).toBeNull();
  });

  it('routes non-2xx, non-404 statuses through the error classifier', async () => {
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(401, { message: 'bad token' });

    await expect(service.tryGetSize(ctx, { type: 'path', path: 'N.md' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
    });
  });

  it('throws when the upstream omits Content-Length on a successful HEAD', async () => {
    pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '');

    await expect(service.tryGetSize(ctx, { type: 'path', path: 'N.md' })).rejects.toThrow(
      /missing Content-Length/,
    );
  });

  it('rejects non-integer or negative Content-Length values', async () => {
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': 'not-a-number' } });

    await expect(service.tryGetSize(ctx, { type: 'path', path: 'N.md' })).rejects.toThrow(
      /invalid Content-Length/,
    );
  });

  it('getSize throws note_missing on 404', async () => {
    pool.intercept({ path: '/vault/missing.md', method: 'HEAD' }).reply(404, '');

    await expect(service.getSize(ctx, { type: 'path', path: 'missing.md' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'note_missing', path: 'missing.md' },
    });
  });

  it('getSize returns the size on a successful HEAD', async () => {
    pool
      .intercept({ path: '/vault/N.md', method: 'HEAD' })
      .reply(200, '', { headers: { 'content-length': '42' } });

    expect(await service.getSize(ctx, { type: 'path', path: 'N.md' })).toBe(42);
  });
});

describe('ObsidianService path-traversal enforcement', () => {
  /**
   * Default test config leaves `readPaths` / `writePaths` unset, so `PathPolicy`
   * short-circuits and `encodeVaultPath` is the only thing standing between a
   * caller-supplied path and the upstream URL. These tests assert traversal is
   * rejected before any HTTP request is issued — no `pool.intercept` calls are
   * set up, so an escaped fetch would surface "No mock intercept" (a generic
   * Error classified differently than `ValidationError`) and fail the
   * assertion below.
   *
   * Cross-platform: forward-slash (POSIX, HTTP-native) and backslash (Windows,
   * LLM-guess) traversal must both be blocked at every service entry point.
   */
  const FS_TRAVERSAL = '../etc/passwd';
  const WIN_TRAVERSAL = '..\\..\\Windows\\System32\\config\\SAM';

  describe.each([
    ['POSIX `../`', FS_TRAVERSAL, '../scratch'],
    ['Windows `..\\`', WIN_TRAVERSAL, '..\\scratch'],
    ['mixed separators', 'foo/..\\bar', 'foo\\../bar'],
  ])('via %s traversal', (_label, target, dir) => {
    it.each([
      ['getNoteContent', () => service.getNoteContent(ctx, { type: 'path', path: target })],
      ['getNoteJson', () => service.getNoteJson(ctx, { type: 'path', path: target })],
      ['getDocumentMap', () => service.getDocumentMap(ctx, { type: 'path', path: target })],
      ['writeNote', () => service.writeNote(ctx, { type: 'path', path: target }, 'body')],
      ['appendToNote', () => service.appendToNote(ctx, { type: 'path', path: target }, 'body')],
      ['deleteNote', () => service.deleteNote(ctx, { type: 'path', path: target })],
      ['tryGetSize', () => service.tryGetSize(ctx, { type: 'path', path: target })],
      ['getSize', () => service.getSize(ctx, { type: 'path', path: target })],
      ['listFiles', () => service.listFiles(ctx, dir)],
      ['openInUi', () => service.openInUi(ctx, target)],
    ])('rejects %s with ValidationError before fetching', async (_method, call) => {
      await expect(call()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'path_traversal' },
      });
    });
  });

  it('rejects patchNote (header-encoded target) traversal — POSIX', async () => {
    await expect(
      service.patchNote(ctx, { type: 'path', path: FS_TRAVERSAL }, 'body', {
        operation: 'append',
        targetType: 'heading',
        target: 'H',
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('rejects patchNote traversal — Windows', async () => {
    await expect(
      service.patchNote(ctx, { type: 'path', path: WIN_TRAVERSAL }, 'body', {
        operation: 'append',
        targetType: 'heading',
        target: 'H',
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  describe('legitimate cross-platform paths still flow through to fetch', () => {
    /**
     * Sanity check the inverse: encoder doesn't false-positive on legal paths.
     * These exercise the full pipeline end-to-end with an interceptor.
     */
    it('Unix-style dotfile path reaches upstream', async () => {
      pool.intercept({ path: '/vault/.obsidian/config.json', method: 'GET' }).reply(200, '# hi');
      await expect(
        service.getNoteContent(ctx, { type: 'path', path: '.obsidian/config.json' }),
      ).resolves.toBe('# hi');
    });

    it('Windows-style separator normalizes to forward-slash URL', async () => {
      pool.intercept({ path: '/vault/Projects/My%20Note.md', method: 'GET' }).reply(200, '# hi');
      await expect(
        service.getNoteContent(ctx, { type: 'path', path: 'Projects\\My Note.md' }),
      ).resolves.toBe('# hi');
    });

    it('unicode filename reaches upstream URL-encoded', async () => {
      pool
        .intercept({ path: '/vault/notes/%F0%9F%9A%80.md', method: 'GET' })
        .reply(200, '# rocket');
      await expect(
        service.getNoteContent(ctx, { type: 'path', path: 'notes/🚀.md' }),
      ).resolves.toBe('# rocket');
    });
  });
});

describe('encodeVaultPath', () => {
  describe('forward-slash paths (POSIX, HTTP-native)', () => {
    it('preserves slashes between segments and encodes per-segment', () => {
      expect(encodeVaultPath('Projects/My Note.md')).toBe('Projects/My%20Note.md');
    });

    it('strips empty leading/trailing slashes', () => {
      expect(encodeVaultPath('/foo/')).toBe('foo');
    });

    it('encodes unicode (Latin, Greek, CJK, emoji) per segment', () => {
      expect(encodeVaultPath('café/π.md')).toBe('caf%C3%A9/%CF%80.md');
      expect(encodeVaultPath('日本語/メモ.md')).toBe(
        '%E6%97%A5%E6%9C%AC%E8%AA%9E/%E3%83%A1%E3%83%A2.md',
      );
      expect(encodeVaultPath('notes/🚀.md')).toBe('notes/%F0%9F%9A%80.md');
    });

    it('encodes URL-reserved characters per segment', () => {
      expect(encodeVaultPath('a/b c/d&e.md')).toBe('a/b%20c/d%26e.md');
      expect(encodeVaultPath('q?/r#.md')).toBe('q%3F/r%23.md');
      expect(encodeVaultPath('a+b/c=d.md')).toBe('a%2Bb/c%3Dd.md');
    });

    it('does not decode pre-encoded segments (preserves caller intent)', () => {
      // Re-encoding `%` to `%25` is the safe behavior — never decode user
      // input mid-flight.
      expect(encodeVaultPath('Pre%20Encoded/note.md')).toBe('Pre%2520Encoded/note.md');
    });

    it('collapses consecutive slashes', () => {
      expect(encodeVaultPath('foo//bar///baz.md')).toBe('foo/bar/baz.md');
    });
  });

  describe('backslash paths (Windows, mixed)', () => {
    /**
     * Windows users (and LLMs guessing at filesystem conventions) may send
     * paths with `\` separators. The encoder normalizes to `/` so the
     * upstream URL is well-formed and traversal segments are detected
     * regardless of which separator the caller used.
     */
    it('splits on backslash and rejoins with forward slash', () => {
      expect(encodeVaultPath('Projects\\My Note.md')).toBe('Projects/My%20Note.md');
    });

    it('handles mixed separators', () => {
      expect(encodeVaultPath('a/b\\c/d\\e.md')).toBe('a/b/c/d/e.md');
    });

    it('strips empty leading/trailing backslashes', () => {
      expect(encodeVaultPath('\\foo\\')).toBe('foo');
      expect(encodeVaultPath('\\\\foo\\\\')).toBe('foo');
    });

    it('does not split on URL-encoded backslash (%5C is a literal byte)', () => {
      // %5C arrives as the 3-char string '%5C' (not a literal backslash),
      // so split sees it as part of the segment.
      expect(encodeVaultPath('foo%5Cbar.md')).toBe('foo%255Cbar.md');
    });
  });

  describe('path-traversal guard', () => {
    /**
     * `..` is unreserved per RFC 3986 so encodeURIComponent leaves it intact,
     * and PathPolicy short-circuits to allow when OBSIDIAN_READ_PATHS is
     * unset. Without this guard, traversal would reach the upstream URL.
     */
    it.each([
      ['leading ..', '../etc/passwd'],
      ['leading ./', './foo.md'],
      ['middle ..', 'foo/../bar.md'],
      ['middle .', 'foo/./bar.md'],
      ['trailing ..', 'foo/..'],
      ['trailing .', 'foo/.'],
      ['only ..', '..'],
      ['only .', '.'],
      ['only /../', '/../'],
      ['multiple ..', '../../etc/passwd'],
      ['leading ..\\ (Windows)', '..\\etc\\passwd'],
      ['leading .\\ (Windows)', '.\\foo.md'],
      ['middle ..\\ (Windows)', 'foo\\..\\bar.md'],
      ['middle .\\ (Windows)', 'foo\\.\\bar.md'],
      ['trailing \\..', 'foo\\..'],
      ['multiple ..\\ (Windows)', '..\\..\\Windows\\System32\\config\\SAM'],
      ['mixed separators with .. (forward-then-back)', 'foo/..\\bar'],
      ['mixed separators with .. (back-then-forward)', '..\\../etc'],
    ])('rejects %s', (_label, input) => {
      expect(() => encodeVaultPath(input)).toThrowError(
        expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }),
      );
    });

    it('attaches path + reason to error data', () => {
      try {
        encodeVaultPath('../etc/passwd');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          data: { path: '../etc/passwd', reason: 'path_traversal' },
        });
      }
    });

    it('preserves the original path string (with backslashes) in error data', () => {
      try {
        encodeVaultPath('..\\etc\\passwd');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({
          data: { path: '..\\etc\\passwd', reason: 'path_traversal' },
        });
      }
    });
  });

  describe('legitimate dotted filenames (allowed across platforms)', () => {
    /**
     * Filesystems on every platform reserve `.` and `..` as the only forbidden
     * filename strings. Anything else containing dots is a legal filename and
     * must pass through unchanged.
     */
    it.each([
      ['dotfile (Unix hidden)', '.gitignore', '.gitignore'],
      ['hidden folder + file', '.obsidian/config.json', '.obsidian/config.json'],
      ['double-dot prefix', '..hidden.md', '..hidden.md'],
      ['quadruple dot file', '....md', '....md'],
      ['embedded double-dot', 'foo..bar.md', 'foo..bar.md'],
      ['three-dot segment (not parent-of-parent)', 'a/...b/c.md', 'a/...b/c.md'],
      ['trailing dots in filename', 'note...md', 'note...md'],
      ['dot in folder name', 'v1.2/notes.md', 'v1.2/notes.md'],
      ['standard markdown', 'note.md', 'note.md'],
    ])('allows %s', (_label, input, expected) => {
      expect(encodeVaultPath(input)).toBe(expected);
    });
  });

  describe('encoded-traversal vectors (already safe — documented)', () => {
    it('does not decode percent-encoded `..` (re-encodes the %)', () => {
      // %2e%2e is percent-encoded '..' — split sees '%2e%2e' (not '..'),
      // so it's not flagged; encodeURIComponent re-encodes '%' to '%25',
      // producing '%252e%252e' which the upstream decodes once back to
      // '%2e%2e' (a literal filename, not parent-dir).
      expect(encodeVaultPath('%2e%2e/foo')).toBe('%252e%252e/foo');
    });

    it('does not decode mixed-case percent-encoded `..`', () => {
      expect(encodeVaultPath('%2E%2E/foo')).toBe('%252E%252E/foo');
    });

    it('does not decode percent-encoded path separator', () => {
      // %2f decoded would be '/'; we don't decode, so it stays as part of a
      // segment and gets re-encoded to %252f.
      expect(encodeVaultPath('foo%2f..%2fbar')).toBe('foo%252f..%252fbar');
    });
  });

  describe('platform-specific edge cases (pass-through, not our concern)', () => {
    it('does not block three-dot segment (modern Win + Node treat as literal)', () => {
      expect(encodeVaultPath('...')).toBe('...');
      expect(encodeVaultPath('foo/.../bar')).toBe('foo/.../bar');
    });

    it('does not block Windows reserved names (upstream concern, not traversal)', () => {
      expect(encodeVaultPath('CON.md')).toBe('CON.md');
      expect(encodeVaultPath('PRN/foo.md')).toBe('PRN/foo.md');
    });

    it('does not block trailing-dot/space filenames (Windows quirk)', () => {
      expect(encodeVaultPath('note. ')).toBe('note.%20');
    });

    it('encodes null byte and control chars safely', () => {
      expect(encodeVaultPath('foo\x00bar')).toBe('foo%00bar');
      expect(encodeVaultPath('foo\nbar')).toBe('foo%0Abar');
    });
  });
});

/**
 * Regression tests for the retry policy. POST/PATCH must bypass retry — the
 * default `withRetry` predicate treats raw network errors as transient and
 * would double-apply non-idempotent writes when the upstream succeeded but
 * the response was lost. GET/PUT/DELETE retry as normal.
 */
describe('ObsidianService retry policy', () => {
  /**
   * Queue `n` identical replies so the counter ticks once per actual fetch
   * attempt — a single intercept would let retries fall through to "no
   * intercept" without incrementing, hiding retry behavior.
   */
  function queueReplies(path: PathMatcher, method: string, n: number, reply: ReplyFn): void {
    for (let i = 0; i < n; i++) {
      pool.intercept({ path, method }).reply(reply);
    }
  }

  describe('POST/PATCH never retry on transient failures', () => {
    it('appendToNote (POST): does not retry on 503', async () => {
      let attempts = 0;
      queueReplies('/vault/N.md', 'POST', 4, () => {
        attempts++;
        return { statusCode: 503 };
      });

      await expect(
        service.appendToNote(ctx, { type: 'path', path: 'N.md' }, 'X'),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(attempts).toBe(1);
    });

    it('appendToNote (POST): does not retry on raw network errors', async () => {
      let attempts = 0;
      queueReplies('/vault/N.md', 'POST', 4, () => {
        attempts++;
        throw new TypeError('UND_ERR_SOCKET');
      });

      await expect(
        service.appendToNote(ctx, { type: 'path', path: 'N.md' }, 'X'),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
    });

    it('patchNote (PATCH) append: does not retry on 503', async () => {
      let attempts = 0;
      queueReplies('/vault/N.md', 'PATCH', 4, () => {
        attempts++;
        return { statusCode: 503 };
      });

      await expect(
        service.patchNote(ctx, { type: 'path', path: 'N.md' }, 'body', {
          operation: 'append',
          targetType: 'heading',
          target: 'X',
          contentType: 'markdown',
        }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
      expect(attempts).toBe(1);
    });

    it('patchNote (PATCH) prepend: does not retry on raw network errors', async () => {
      let attempts = 0;
      queueReplies('/vault/N.md', 'PATCH', 4, () => {
        attempts++;
        throw new TypeError('ECONNRESET');
      });

      await expect(
        service.patchNote(ctx, { type: 'path', path: 'N.md' }, 'body', {
          operation: 'prepend',
          targetType: 'heading',
          target: 'X',
          contentType: 'markdown',
        }),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
    });

    it('executeCommand (POST): does not retry on 503', async () => {
      let attempts = 0;
      queueReplies('/commands/editor%3Asave/', 'POST', 4, () => {
        attempts++;
        return { statusCode: 503 };
      });

      await expect(service.executeCommand(ctx, 'editor:save')).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
      });
      expect(attempts).toBe(1);
    });

    it('openInUi (POST): does not retry on 504', async () => {
      let attempts = 0;
      queueReplies(
        (p) => p.startsWith('/open/'),
        'POST',
        4,
        () => {
          attempts++;
          return { statusCode: 504 };
        },
      );

      await expect(service.openInUi(ctx, 'N.md')).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
      });
      expect(attempts).toBe(1);
    });
  });

  describe('GET/PUT/DELETE retry on transient failures', () => {
    it('getNoteContent (GET): retries on 503 then succeeds', async () => {
      let attempts = 0;
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(() => {
        attempts++;
        return { statusCode: 503 };
      });
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(() => {
        attempts++;
        return { statusCode: 200, data: '# hello' };
      });

      const out = await service.getNoteContent(ctx, { type: 'path', path: 'N.md' });
      expect(out).toBe('# hello');
      expect(attempts).toBe(2);
    });

    it('getNoteContent (GET): retries on raw network errors then succeeds', async () => {
      let attempts = 0;
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(() => {
        attempts++;
        throw new TypeError('ECONNRESET');
      });
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(() => {
        attempts++;
        return { statusCode: 200, data: '# hello' };
      });

      const out = await service.getNoteContent(ctx, { type: 'path', path: 'N.md' });
      expect(out).toBe('# hello');
      expect(attempts).toBe(2);
    });

    it('writeNote (PUT): retries on 503 then succeeds', async () => {
      let attempts = 0;
      pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
        attempts++;
        return { statusCode: 503 };
      });
      pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
        attempts++;
        return { statusCode: 200, data: '' };
      });

      await service.writeNote(ctx, { type: 'path', path: 'N.md' }, 'body');
      expect(attempts).toBe(2);
    });

    it('deleteNote (DELETE): retries on 503 then succeeds', async () => {
      let attempts = 0;
      pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
        attempts++;
        return { statusCode: 503 };
      });
      pool.intercept({ path: '/vault/N.md', method: 'DELETE' }).reply(() => {
        attempts++;
        return { statusCode: 200, data: '' };
      });

      await service.deleteNote(ctx, { type: 'path', path: 'N.md' });
      expect(attempts).toBe(2);
    });
  });

  describe('non-transient errors do not retry, regardless of method', () => {
    it('GET 404 (NotFound) is not retried', async () => {
      let attempts = 0;
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(() => {
        attempts++;
        return { statusCode: 404, data: { message: 'gone' } };
      });

      await expect(
        service.getNoteContent(ctx, { type: 'path', path: 'N.md' }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
      expect(attempts).toBe(1);
    });

    it('PUT 400 (ValidationError) is not retried', async () => {
      let attempts = 0;
      pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply(() => {
        attempts++;
        return { statusCode: 400, data: { message: 'bad' } };
      });

      await expect(
        service.writeNote(ctx, { type: 'path', path: 'N.md' }, 'body'),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      expect(attempts).toBe(1);
    });

    it('GET 500 (InternalError) is not retried', async () => {
      let attempts = 0;
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(() => {
        attempts++;
        return { statusCode: 500, data: { message: 'kaboom' } };
      });

      await expect(
        service.getNoteContent(ctx, { type: 'path', path: 'N.md' }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.InternalError });
      expect(attempts).toBe(1);
    });
  });
});

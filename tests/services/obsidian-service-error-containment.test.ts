/**
 * @fileoverview Wire-containment contract for `ObsidianService#throwForStatus`.
 *
 * Every branch of that function is driven with an upstream error body that
 * embeds three distinctive markers — a vault path, a note body, and an
 * absolute filesystem path. Each case asserts twice: the marker is absent from
 * the *whole* client-visible surface, and the server-authored diagnostic the
 * branch is supposed to keep is still present. The negative alone would pass
 * against an empty error, so neither assertion stands on its own.
 *
 * `clientSurface` mirrors exactly what the framework forwards — `code`,
 * `message`, `data` (see `buildToolErrorResult` for tools and the SDK's
 * JSON-RPC error object for resources). `cause` is deliberately excluded:
 * `ErrorOptions` makes it non-enumerable and neither surface reads it, which
 * is what lets the service keep the raw upstream text for its own
 * classification without publishing it.
 *
 * Several cases reach a branch over a route that would not produce that body
 * in production (a 400 "content-already-preexists-in-target" answered to a
 * POST, say). The branch, not the route, is what is under test — every case
 * uses a non-retry-safe method so `withRetry` never re-wraps the error and the
 * assertion sees the error the branch actually threw.
 *
 * @module tests/services/obsidian-service-error-containment.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse, setupHarness, type TestHarness } from '../helpers.js';

const harness = setupHarness();
let pool: TestHarness['pool'];
let service: ObsidianService;
let ctx: Context;

beforeEach(() => {
  pool = harness.current().pool;
  service = harness.current().service;
  ctx = createMockContext();
});

/**
 * Markers chosen so a match cannot be coincidental: each carries a random
 * token no server-authored string, path fixture, or framework message
 * contains.
 */
const LEAK = {
  /** A vault path outside any configured read scope. */
  notePath: 'Private/Ledger-zq7f31.md',
  /** Note body text — what the plugin echoes as the "pattern" on reversed operands. */
  noteBody: 'note-body-marker-zq7f31',
  /** Absolute on-disk location, as Node `fs` errors report it in a 500. */
  fsPath: '/Users/owner-marker-zq7f31/Vault Name/Private',
  /** Plugin-internal envelope field `safeUpstream` was written to drop. */
  errorCode: 40000,
} as const;

/**
 * The Local REST API's 400 text for a JSONLogic tree whose `regexp` operands
 * are reversed: the note body becomes the compiled pattern and the note being
 * evaluated is named in the trailing locator. Both markers, one string.
 */
const POISONED_400 = {
  errorCode: LEAK.errorCode,
  message:
    'The query you provided could not be processed.\n' +
    `Invalid regular expression: /${LEAK.noteBody}/: Unterminated group ` +
    `(while processing ${LEAK.notePath})`,
};

/** The Local REST API relays Node `fs` errors verbatim in its 500 bodies. */
const POISONED_500 = {
  errorCode: 50000,
  message: `Internal Server Error\nEISDIR: illegal operation on a directory, open '${LEAK.fsPath}'`,
};

/** Every marker that must never reach a client, in one list. */
const MARKERS = [LEAK.notePath, LEAK.noteBody, LEAK.fsPath, String(LEAK.errorCode)];

/**
 * Exactly the fields the framework forwards. Anything the service hangs off
 * the error elsewhere (notably `cause`) is invisible here, by design.
 */
function clientSurface(err: McpError): { code: number; message: string; data: unknown } {
  return { code: err.code, message: err.message, data: err.data };
}

async function throwsMcpError(fn: () => Promise<unknown>): Promise<McpError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(McpError);
    return e as McpError;
  }
  throw new Error('expected the call to reject');
}

/**
 * Assert containment over the serialized surface, then assert the branch still
 * says something of its own — a `.not.toContain` over a blank error is
 * vacuously true, so the positive half is what gives the negative meaning.
 */
function expectContained(err: McpError, keeps: RegExp): void {
  const serialized = JSON.stringify(clientSurface(err));
  for (const marker of MARKERS) {
    expect(serialized).not.toContain(marker);
  }
  expect(err.message).toMatch(keeps);
  expect(err.message.length).toBeGreaterThan(0);
  expect(err.data).toBeDefined();
}

/** POST — never retry-safe, so one upstream reply is one thrown error. */
function replyToAppend(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  pool.intercept({ path: '/vault/x.md', method: 'POST' }).reply(status, body, {
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
  return service.appendToNote(ctx, { type: 'path', path: 'x.md' }, 'content');
}

describe('#throwForStatus / upstream text never reaches the client', () => {
  /**
   * Characterization half of the matrix: the classification each status is
   * supposed to produce, pinned so the containment work cannot quietly change
   * which code or reason a caller switches on.
   */
  it.each([
    [401, JsonRpcErrorCode.Unauthorized, undefined, /OBSIDIAN_API_KEY/],
    [403, JsonRpcErrorCode.Forbidden, undefined, /plugin permissions/i],
    [404, JsonRpcErrorCode.NotFound, 'note_missing', /not found/i],
    [405, JsonRpcErrorCode.ValidationError, 'path_is_directory', /directory/i],
    [500, JsonRpcErrorCode.ServiceUnavailable, undefined, /HTTP 500/],
    [501, JsonRpcErrorCode.ServiceUnavailable, undefined, /HTTP 501/],
    [502, JsonRpcErrorCode.ServiceUnavailable, undefined, /HTTP 502/],
    [504, JsonRpcErrorCode.Timeout, undefined, /HTTP 504/],
    [429, JsonRpcErrorCode.RateLimited, undefined, /HTTP 429/],
    [409, JsonRpcErrorCode.Conflict, undefined, /HTTP 409/],
  ] as const)(
    'status %i classifies as %i and contains the upstream body',
    async (status, code, reason, keeps) => {
      const poisoned = status >= 500 ? POISONED_500 : POISONED_400;
      const err = await throwsMcpError(() => replyToAppend(status, poisoned));

      expect(err.code).toBe(code);
      expect((err.data as { reason?: string } | undefined)?.reason).toBe(reason);
      expect((err.data as { path?: string } | undefined)?.path).toBe('x.md');
      expectContained(err, keeps);
    },
  );

  it('contains the upstream body on the generic 400 fallback', async () => {
    const err = await throwsMcpError(() => replyToAppend(400, POISONED_400));

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expectContained(err, /x\.md/);
  });

  it('contains the upstream body on the content_preexists 400 branch', async () => {
    const err = await throwsMcpError(() =>
      replyToAppend(400, {
        errorCode: LEAK.errorCode,
        message: `content-already-preexists-in-target (while processing ${LEAK.notePath})`,
      }),
    );

    expect((err.data as { reason?: string }).reason).toBe('content_preexists');
    expectContained(err, /applyIfContentPreexists/);
  });

  it('contains the upstream body on the section_target_missing 400 branch', async () => {
    const err = await throwsMcpError(() =>
      replyToAppend(400, {
        errorCode: LEAK.errorCode,
        message: `could not be applied to the target content of ${LEAK.notePath}: ${LEAK.noteBody}`,
      }),
    );

    expect((err.data as { reason?: string }).reason).toBe('section_target_missing');
    expectContained(err, /document-map/);
  });

  it('contains the upstream body on the 404 command branch', async () => {
    pool
      .intercept({ path: '/commands/unknown-id/', method: 'POST' })
      .reply(404, POISONED_400, { headers: { 'content-type': 'application/json' } });

    const err = await throwsMcpError(() => service.executeCommand(ctx, 'unknown-id'));

    expect((err.data as { reason?: string }).reason).toBe('command_unknown');
    expectContained(err, /obsidian_list_commands/);
  });

  it('contains the upstream body on the 404 active-file branch', async () => {
    pool
      .intercept({ path: '/active/', method: 'POST' })
      .reply(404, POISONED_400, { headers: { 'content-type': 'application/json' } });

    const err = await throwsMcpError(() =>
      service.appendToNote(ctx, { type: 'active' }, 'content'),
    );

    expect((err.data as { reason?: string }).reason).toBe('no_active_file');
    expectContained(err, /open a file/i);
  });

  it('contains the upstream body on the periodic_disabled 400 branch', async () => {
    pool.intercept({ path: '/periodic/daily/', method: 'POST' }).reply(
      400,
      {
        errorCode: LEAK.errorCode,
        message: `Specified period is not enabled (while processing ${LEAK.notePath})`,
      },
      { headers: { 'content-type': 'application/json' } },
    );

    const err = await throwsMcpError(() =>
      service.appendToNote(ctx, { type: 'periodic', period: 'daily' }, 'content'),
    );

    expect((err.data as { reason?: string }).reason).toBe('periodic_disabled');
    expectContained(err, /Periodic Notes/i);
  });

  it('contains a non-JSON upstream body — the plain-text path through safeUpstream', async () => {
    pool
      .intercept({ path: '/vault/x.md', method: 'POST' })
      .reply(503, `upstream exploded reading ${LEAK.fsPath}`, {
        headers: { 'content-type': 'text/plain' },
      });

    const err = await throwsMcpError(() =>
      service.appendToNote(ctx, { type: 'path', path: 'x.md' }, 'content'),
    );

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expectContained(err, /HTTP 503/);
  });
});

describe('#throwForStatus / jsonlogic 400 (issue #116)', () => {
  const runLogic = () => {
    pool
      .intercept({ path: '/search/', method: 'POST' })
      .reply(400, POISONED_400, { headers: { 'content-type': 'application/json' } });
    return service.searchJsonLogic(ctx, { regexp: [{ var: 'content' }, '^x'] });
  };

  /**
   * The issue's own configuration: the caller is confined to `Inbox/`, and the
   * note the plugin was evaluating when the tree failed sits outside it. The
   * upstream is chosen by vault order, not read scope, so the success-path
   * filter never sees it.
   */
  const runLogicScoped = () => {
    const fetchImpl: ObsidianFetch = async () =>
      mockResponse(JSON.stringify(POISONED_400), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    const scoped = new ObsidianService(makeTestConfig({ readPaths: ['Inbox/'] }), fetchImpl);
    setObsidianService(scoped);
    return scoped.searchJsonLogic(ctx, { regexp: [{ var: 'content' }, '^x'] });
  };

  it('drops the vault locator and the echoed note body from a rejected tree', async () => {
    const err = await throwsMcpError(() => runLogic());

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err.data as { reason?: string }).reason).toBe('logic_invalid');
    expectContained(err, /JSONLogic/);
  });

  it('still names the regexp-compile failure so a bad pattern is diagnosable', async () => {
    const err = await throwsMcpError(() => runLogic());

    expect(err.message).toMatch(/regexp/i);
    expect(err.message).toMatch(/\[PATTERN, VALUE\]|pattern/i);
  });

  it('says only that the tree failed when the plugin reports something else', async () => {
    pool
      .intercept({ path: '/search/', method: 'POST' })
      .reply(
        400,
        { errorCode: 40000, message: 'Invalid JsonLogic query supplied.' },
        { headers: { 'content-type': 'application/json' } },
      );

    const err = await throwsMcpError(() => service.searchJsonLogic(ctx, { bogus: [1, 2] }));

    expect((err.data as { reason?: string }).reason).toBe('logic_invalid');
    expect(err.message).not.toMatch(/regexp/i);
    expect(err.message).toMatch(/JSONLogic/);
  });

  it('leaks nothing when the caller is confined by OBSIDIAN_READ_PATHS', async () => {
    const err = await throwsMcpError(() => runLogicScoped());

    expectContained(err, /JSONLogic/);
  });
});

describe('#throwForStatus / no upstream-authored keys survive on data', () => {
  it('carries neither data.body nor data.upstream on a 5xx', async () => {
    const err = await throwsMcpError(() => replyToAppend(500, POISONED_500));
    const data = err.data as Record<string, unknown>;

    expect(Object.hasOwn(data, 'body')).toBe(false);
    expect(Object.hasOwn(data, 'responseBody')).toBe(false);
    expect(Object.hasOwn(data, 'upstream')).toBe(false);
    // The classification a caller does switch on must survive the removal.
    expect(data.status).toBe(500);
    expect(data.path).toBe('x.md');
  });

  it('carries neither data.body nor data.upstream on a 4xx', async () => {
    const err = await throwsMcpError(() => replyToAppend(401, POISONED_400));
    const data = err.data as Record<string, unknown>;

    expect(Object.hasOwn(data, 'body')).toBe(false);
    expect(Object.hasOwn(data, 'upstream')).toBe(false);
    expect(data.path).toBe('x.md');
  });

  /**
   * `Retry-After` is the one response-derived field the default branch still
   * forwards. It is a duration, never vault data, and `withRetry` reads
   * `data.retryAfter` to pace its backoff — dropping it alongside the leaking
   * fields would change retry timing silently, so it is pinned here in both
   * directions.
   */
  it('forwards Retry-After on the default branch without the leaking fields', async () => {
    const err = await throwsMcpError(() =>
      replyToAppend(503, POISONED_500, { 'retry-after': '17' }),
    );
    const data = err.data as Record<string, unknown>;

    expect(data.retryAfter).toBe('17');
    expect(JSON.stringify(clientSurface(err))).not.toContain(LEAK.fsPath);
  });

  it('omits retryAfter when the upstream sends no Retry-After header', async () => {
    const err = await throwsMcpError(() => replyToAppend(503, POISONED_500));

    expect(Object.hasOwn(err.data as Record<string, unknown>, 'retryAfter')).toBe(false);
  });
});

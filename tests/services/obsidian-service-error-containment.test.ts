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
import {
  makeTestConfig,
  mockResponse,
  nodeFetchRejection,
  sequencedFetch,
  setupHarness,
  type TestHarness,
} from '../helpers.js';

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

describe('#throwForStatus / periodic capability probe (issue #103)', () => {
  /**
   * The probe reads a second upstream response to classify the first. Its
   * payload is plugin metadata rather than vault content, but it is still
   * upstream-authored text, so this fixture plants a marker in it and asserts
   * the new branch relays neither that nor the 404's own body.
   */
  const probeWithMarker = {
    status: 'OK',
    service: 'Obsidian Local REST API',
    authenticated: true,
    versions: { obsidian: '1.13.7', self: '5.0.3' },
    apiExtensions: [{ id: 'some-other-extension', name: LEAK.notePath, version: '1.0.0' }],
  };

  it('names the missing extension without relaying either upstream body', async () => {
    pool
      .intercept({ path: '/periodic/daily/', method: 'POST' })
      .reply(404, POISONED_400, { headers: { 'content-type': 'application/json' } });
    pool
      .intercept({ path: '/', method: 'GET' })
      .reply(200, probeWithMarker, { headers: { 'content-type': 'application/json' } });

    const err = await throwsMcpError(() =>
      service.appendToNote(ctx, { type: 'periodic', period: 'daily' }, 'content'),
    );

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect((err.data as { reason?: string }).reason).toBe('periodic_unsupported');
    expectContained(err, /local-rest-api-periodic-notes/);
  });
});

/**
 * The listing guards throw outside `#throwForStatus` — one on a `2xx` whose
 * body is the served file's own content. Same invariant, different entry
 * point: a server-authored message, `path`, `reason`, and the contract
 * recovery, and nothing the upstream wrote.
 */
describe('listing guards / upstream text never reaches the client (issue #105)', () => {
  it('contains the folder 404 body on the directory_missing branch', async () => {
    pool
      .intercept({ path: '/vault/Missing/', method: 'GET' })
      .reply(404, POISONED_400, { headers: { 'content-type': 'application/json' } });

    const err = await throwsMcpError(() => service.listFiles(ctx, 'Missing'));

    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect((err.data as { reason?: string }).reason).toBe('directory_missing');
    expectContained(err, /directory not found/i);
  });

  it('contains the served note body on the path_is_file branch', async () => {
    pool.intercept({ path: '/vault/Note.md/', method: 'GET' }).reply(200, LEAK.noteBody, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="Note.md"',
      },
    });

    const err = await throwsMcpError(() => service.listFiles(ctx, 'Note.md'));

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err.data as { reason?: string }).reason).toBe('path_is_file');
    expectContained(err, /file, not a directory/i);
  });
});

/**
 * Issue #122. The client-visible `path` is the vault-relative locator the
 * caller sent, and stays that way: `#throwForStatus` classifies on the route
 * prefix, `displayPath()` renders what the caller recognizes, and the base URL
 * is deployment detail no client has any business receiving. But when the base
 * URL itself is what broke the request — a trailing slash doubling every path —
 * the clean locator is the only thing anyone sees, and it reads like a genuine
 * 404. So the resolved URL rides the `cause`: the log record names it, and the
 * containment invariant above is untouched, since no client surface serializes
 * `cause`.
 */
describe('#throwForStatus / the requested URL rides the cause (issue #122)', () => {
  const causeOf = (err: McpError): string => {
    expect(err.cause).toBeInstanceOf(Error);
    return (err.cause as Error).message;
  };

  it('names the URL that was fetched, from the #request call site', async () => {
    const err = await throwsMcpError(() => replyToAppend(404, POISONED_400));

    expect(causeOf(err)).toContain('https://obsidian.test/vault/x.md');
    // The wire surface is exactly what it was: the vault-relative path alone.
    expect(err.message).toBe('Not found: x.md');
    expect((err.data as { path?: string }).path).toBe('x.md');
    expect(JSON.stringify(clientSurface(err))).not.toContain('obsidian.test');
  });

  it('names the URL that was fetched, from the tryGetSize call site', async () => {
    pool
      .intercept({ path: '/vault/x.md', method: 'HEAD' })
      .reply(403, POISONED_400, { headers: { 'content-type': 'application/json' } });

    const err = await throwsMcpError(() => service.tryGetSize(ctx, { type: 'path', path: 'x.md' }));

    expect(causeOf(err)).toContain('https://obsidian.test/vault/x.md');
    expect((err.data as { path?: string }).path).toBe('x.md');
    expect(JSON.stringify(clientSurface(err))).not.toContain('obsidian.test');
  });

  /**
   * The failure #122 was filed from: a trailing slash on the configured base
   * URL doubles the separator on every request, and the un-doubled path in the
   * message reads as a well-formed 404 against a healthy vault.
   */
  it('shows the doubled slash a malformed base URL produced', async () => {
    const fetchImpl: ObsidianFetch = async () =>
      mockResponse(JSON.stringify(POISONED_400), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    const misconfigured = new ObsidianService(
      makeTestConfig({ baseUrl: 'https://obsidian.test/' }),
      fetchImpl,
    );

    const err = await throwsMcpError(() => misconfigured.listTags(ctx));

    expect(causeOf(err)).toContain('https://obsidian.test//tags/');
    expect(err.message).toBe('Not found: /tags/');
  });
});

/**
 * Issue #130. The caller's identifier rides `data` under the name of the input
 * it echoes: `path` on the routes that address a note, `commandId` on a
 * command, and nothing at all on a route that carries no caller identifier —
 * where `path` used to hold the literal route string. The key follows the
 * route, never the status branch, so every branch is driven on every route.
 *
 * Each route is scripted with four identical replies: the GET routes are
 * retry-safe, and a 5xx there is transient, so the error that reaches the
 * assertion is the one `withRetry` surfaces after its last attempt.
 */
describe('#throwForStatus / the identifier key follows the route (issue #130)', () => {
  const STATUSES = [400, 401, 403, 404, 405, 500] as const;

  type Identifier = { path: string } | { commandId: string } | Record<string, never>;

  const ROUTES: ReadonlyArray<
    readonly [
      label: string,
      method: string,
      route: (p: string) => boolean,
      call: () => Promise<unknown>,
      identifier: Identifier,
    ]
  > = [
    [
      '/vault/<path>',
      'POST',
      (p) => p === '/vault/Folder/x.md',
      () => service.appendToNote(ctx, { type: 'path', path: 'Folder/x.md' }, 'c'),
      { path: 'Folder/x.md' },
    ],
    [
      '/open/<path>',
      'POST',
      (p) => p.startsWith('/open/'),
      () => service.openInUi(ctx, 'Folder/x.md'),
      { path: 'Folder/x.md' },
    ],
    [
      '/active/',
      'POST',
      (p) => p === '/active/',
      () => service.appendToNote(ctx, { type: 'active' }, 'c'),
      { path: '(active file)' },
    ],
    [
      '/periodic/<period>/<date>/',
      'POST',
      (p) => p === '/periodic/daily/2026/04/28/',
      () =>
        service.appendToNote(ctx, { type: 'periodic', period: 'daily', date: '2026-04-28' }, 'c'),
      { path: 'daily note for 2026-04-28' },
    ],
    [
      '/commands/<id>/',
      'POST',
      (p) => p === '/commands/app%3Azq7f31-cmd/',
      () => service.executeCommand(ctx, 'app:zq7f31-cmd'),
      { commandId: 'app:zq7f31-cmd' },
    ],
    ['/commands/', 'GET', (p) => p === '/commands/', () => service.listCommands(ctx), {}],
    ['/tags/', 'GET', (p) => p === '/tags/', () => service.listTags(ctx), {}],
    [
      '/search/',
      'POST',
      (p) => p === '/search/',
      () => service.searchJsonLogic(ctx, { '==': [1, 1] }),
      {},
    ],
    [
      '/search/simple/',
      'POST',
      (p) => p.startsWith('/search/simple/'),
      () => service.searchText(ctx, 'q'),
      {},
    ],
    ['/', 'GET', (p) => p === '/', () => service.getStatus(ctx), {}],
  ];

  const CASES = ROUTES.flatMap(([label, ...rest]) =>
    STATUSES.map((status) => [label, status, ...rest] as const),
  );

  it.each(CASES)(
    '%s on HTTP %i carries exactly its own identifier',
    async (_label, status, method, route, call, identifier) => {
      for (let i = 0; i < 4; i++) {
        pool
          .intercept({ path: route, method })
          .reply(status, status >= 500 ? POISONED_500 : POISONED_400, {
            headers: { 'content-type': 'application/json' },
          });
      }

      const err = await throwsMcpError(call);
      const data = err.data as Record<string, unknown>;

      expect(data.path).toBe('path' in identifier ? identifier.path : undefined);
      expect(data.commandId).toBe('commandId' in identifier ? identifier.commandId : undefined);
      if (!('path' in identifier)) expect(Object.hasOwn(data, 'path')).toBe(false);
      if (!('commandId' in identifier)) expect(Object.hasOwn(data, 'commandId')).toBe(false);
      for (const marker of MARKERS)
        expect(JSON.stringify(clientSurface(err))).not.toContain(marker);
    },
  );

  it('keeps reason, recovery, and the command message on the command_unknown 404', async () => {
    pool
      .intercept({ path: '/commands/app%3Azq7f31-cmd/', method: 'POST' })
      .reply(404, POISONED_400, { headers: { 'content-type': 'application/json' } });
    const contractCtx = createMockContext({
      errors: [
        {
          reason: 'command_unknown',
          code: JsonRpcErrorCode.NotFound,
          when: 'The command ID is not registered.',
          recovery: 'Call obsidian_list_commands to discover the registered command IDs.',
        },
      ],
    });

    const err = await throwsMcpError(() => service.executeCommand(contractCtx, 'app:zq7f31-cmd'));

    expect(err.message).toBe(
      'Unknown Obsidian command: app:zq7f31-cmd. Use `obsidian_list_commands` to discover valid command IDs.',
    );
    expect(err.data).toEqual({
      commandId: 'app:zq7f31-cmd',
      reason: 'command_unknown',
      recovery: { hint: 'Call obsidian_list_commands to discover the registered command IDs.' },
    });
  });

  it('keeps status, retryAfter, and retryable on the default branch of a route with no identifier', async () => {
    pool.intercept({ path: '/search/', method: 'POST' }).reply(501, POISONED_500, {
      headers: { 'content-type': 'application/json', 'retry-after': '3' },
    });

    const err = await throwsMcpError(() => service.searchJsonLogic(ctx, { '==': [1, 1] }));

    expect(err.data).toEqual({ status: 501, retryAfter: '3', retryable: false });
  });
});

/**
 * Issues #133 and #136. A `fetch` that rejects before any response never
 * reaches `#throwForStatus`, but the same invariant holds: the runtime's own
 * text — which names the host and port it tried, and on Node carries OpenSSL's
 * wording — rides as `cause`, and the client sees a server-authored message.
 * Retry-safe and single-attempt paths are both driven, since the retry
 * wrapper rebuilds the message and `data` on the way out.
 */
describe('fetch rejections / runtime text never reaches the client', () => {
  const runtimeText = `connect ECONNREFUSED ${LEAK.fsPath} (${LEAK.notePath})`;

  it.each([
    ['refused, single attempt', 'ECONNREFUSED', (s: ObsidianService) => s.searchText(ctx, 'q')],
    ['refused, retried', 'ECONNREFUSED', (s: ObsidianService) => s.listTags(ctx)],
    [
      'certificate, HEAD',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      (s: ObsidianService) => s.tryGetSize(ctx, { type: 'path', path: 'x.md' }),
    ],
  ] as const)('%s', async (_label, code, call) => {
    const rejection = nodeFetchRejection(code, runtimeText);
    const svc = new ObsidianService(makeTestConfig(), sequencedFetch(rejection).fetchImpl);

    const err = await throwsMcpError(() => call(svc));

    for (const marker of [...MARKERS, 'obsidian.test', 'fetch failed', 'ECONNREFUSED']) {
      expect(JSON.stringify(clientSurface(err))).not.toContain(marker);
    }
    expect(err.message).toMatch(/Obsidian Local REST API/);
    expect(err.data).toMatchObject({
      reason: expect.any(String),
      recovery: { hint: expect.any(String) },
    });
    expect(err.cause === rejection || (err.cause as Error).cause === rejection).toBe(true);
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

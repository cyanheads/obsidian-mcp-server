/**
 * @fileoverview Connection-failure classification for `ObsidianService`
 * (issue #136).
 *
 * When nothing answers at `OBSIDIAN_BASE_URL` — Obsidian closed, the Local
 * REST API plugin disabled, a wrong host or port — `fetch` rejects before any
 * response exists. That is transient, so the retry-safe methods keep their
 * budget, but whatever finally reaches the caller is a typed
 * `ServiceUnavailable` with `reason: 'obsidian_unreachable'` and a hint naming
 * what to check, identical on Bun and Node, with the base URL off the wire.
 *
 * Every rejection is shaped from one recorded on Bun 1.4.0 and Node 26.5.0:
 * a closed port, an unresolvable host, a socket reset on accept, and a socket
 * closed with no bytes. Calls are counted through the real `#request` and
 * `withRetry`, so an attempt count here is the attempt count on the wire.
 *
 * @module tests/services/obsidian-service-unreachable.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { obsidianStatus } from '@/mcp-server/resources/definitions/obsidian-status.resource.js';
import { obsidianListTags } from '@/mcp-server/tools/definitions/obsidian-list-tags.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import {
  bunFetchRejection,
  makeTestConfig,
  mockResponse,
  nodeFetchRejection,
  rejectionOf,
  sequencedFetch,
} from '../helpers.js';

/** Distinctive enough that a hit on the wire cannot be coincidental. */
const HOST = 'vault-host-zq7f31.test';
const BASE_URL = `http://${HOST}:27123`;

/** `withRetry` runs `maxRetries + 1` attempts; the service sets `maxRetries: 3`. */
const FULL_BUDGET = 4;

const REFUSED = {
  bun: () =>
    bunFetchRejection(
      'ConnectionRefused',
      'Unable to connect. Is the computer able to access the url?',
    ),
  node: () => nodeFetchRejection('ECONNREFUSED', `connect ECONNREFUSED ${HOST}:27123`),
};

/** Every connection failure recorded on either runtime, in its runtime's own shape. */
const CONNECTION_FAILURES = [
  ['Bun refused', REFUSED.bun],
  ['Node refused', REFUSED.node],
  [
    'Node refused on a dual-stack name',
    () => nodeFetchRejection('ECONNREFUSED', '', { aggregate: true }),
  ],
  ['Bun host not found', () => bunFetchRejection('ENOTFOUND', `getaddrinfo ENOTFOUND ${HOST}`)],
  ['Node host not found', () => nodeFetchRejection('ENOTFOUND', `getaddrinfo ENOTFOUND ${HOST}`)],
  [
    'Bun reset before a response',
    () =>
      bunFetchRejection(
        'ECONNRESET',
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      ),
  ],
  ['Node reset before a response', () => nodeFetchRejection('ECONNRESET', 'read ECONNRESET')],
  ['Node closed with no bytes', () => nodeFetchRejection('UND_ERR_SOCKET', 'other side closed')],
] as const;

type Call = (s: ObsidianService, c: Context) => Promise<unknown>;

const RETRY_SAFE: ReadonlyArray<readonly [string, Call]> = [
  ['GET', (s, c) => s.listTags(c)],
  ['PUT', (s, c) => s.writeNote(c, { type: 'path', path: 'N.md' }, 'x')],
  ['DELETE', (s, c) => s.deleteNote(c, { type: 'path', path: 'N.md' })],
];

const SINGLE_ATTEMPT: ReadonlyArray<readonly [string, Call]> = [
  ['POST', (s, c) => s.searchText(c, 'q')],
  ['HEAD (tryGetSize)', (s, c) => s.tryGetSize(c, { type: 'path', path: 'N.md' })],
];

const patchBlock: Call = (s, c) =>
  s.patchNote(c, { type: 'path', path: 'N.md' }, 'x', {
    operation: 'append',
    targetType: 'block',
    target: 'b1',
    contentType: 'markdown',
  });

/** The plugin's `GET /` report, which a PATCH reads once to pick its markdown-patch format. */
const pluginReport = () =>
  mockResponse(JSON.stringify({ status: 'OK', service: 's', versions: { self: '5.2.0' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function serviceOver(fetchImpl: ObsidianFetch): ObsidianService {
  return new ObsidianService(makeTestConfig({ baseUrl: BASE_URL }), fetchImpl);
}

function wireOf(err: McpError): string {
  return JSON.stringify({ code: err.code, message: err.message, data: err.data });
}

afterEach(() => setObsidianService(undefined));

/**
 * Characterization: a rejection that names no connection failure is not this
 * issue's to classify. It must keep reaching the caller untouched on a
 * single-attempt method, and keep its retries on a retry-safe one.
 */
describe('an unrecognized fetch rejection', () => {
  it('propagates as-is from a single-attempt method', async () => {
    const rejection = new TypeError('something the runtime never documented');
    const { calls, fetchImpl } = sequencedFetch(rejection);

    await expect(serviceOver(fetchImpl).searchText(createMockContext(), 'q')).rejects.toBe(
      rejection,
    );
    expect(calls).toHaveLength(1);
  });

  it('is retried on a retry-safe method and surfaces with the original as cause', async () => {
    const rejection = new TypeError('something the runtime never documented');
    const { calls, fetchImpl } = sequencedFetch(rejection);

    const err = await rejectionOf<Error>(serviceOver(fetchImpl).listTags(createMockContext()));

    expect(err).not.toBeInstanceOf(McpError);
    expect(err.message).toContain(`(failed after ${FULL_BUDGET} attempts)`);
    expect(err.cause).toBe(rejection);
    expect(calls).toHaveLength(FULL_BUDGET);
  });

  /**
   * A TLS handshake against a plain-HTTP port fails with a code that is
   * neither a connection failure nor a certificate verdict — on Bun it is
   * `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` even with verification relaxed —
   * so it stays unclassified rather than being given a wrong hint.
   */
  it.each([
    [
      'Bun',
      () =>
        bunFetchRejection(
          'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR',
          'unknown certificate verification error',
        ),
    ],
    ['Node', () => nodeFetchRejection('ERR_SSL_WRONG_VERSION_NUMBER', 'wrong version number')],
  ] as const)('leaves a %s scheme mismatch unclassified', async (_runtime, reject) => {
    const rejection = reject();
    const { fetchImpl } = sequencedFetch(rejection);

    await expect(serviceOver(fetchImpl).searchText(createMockContext(), 'q')).rejects.toBe(
      rejection,
    );
  });
});

describe('ObsidianService connection failure (issue #136)', () => {
  it.each(CONNECTION_FAILURES)('classifies a %s', async (_label, reject) => {
    const rejection = reject();
    const { fetchImpl } = sequencedFetch(rejection);

    const err = await rejectionOf(serviceOver(fetchImpl).searchText(createMockContext(), 'q'));

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'obsidian_unreachable',
      recovery: { hint: expect.stringContaining('OBSIDIAN_BASE_URL') },
    });
    expect(err.cause).toBe(rejection);
  });

  it.each(RETRY_SAFE)('%s spends the full retry budget, then throws typed', async (_m, call) => {
    const { calls, fetchImpl } = sequencedFetch(REFUSED.node());

    const err = await rejectionOf(call(serviceOver(fetchImpl), createMockContext()));

    expect(calls).toHaveLength(FULL_BUDGET);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    // The exhausted-retry wrapper keeps the attempt's data and adds its count.
    expect(err.data).toMatchObject({
      reason: 'obsidian_unreachable',
      recovery: { hint: expect.stringContaining('Local REST API') },
      retryAttempts: FULL_BUDGET,
    });
    expect(err.message).toContain(`(failed after ${FULL_BUDGET} attempts)`);
  });

  it.each(SINGLE_ATTEMPT)('%s throws typed on the first attempt', async (_m, call) => {
    const { calls, fetchImpl } = sequencedFetch(REFUSED.bun());

    await expect(call(serviceOver(fetchImpl), createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'obsidian_unreachable' },
    });
    expect(calls).toHaveLength(1);
  });

  it('PATCH throws typed on its first attempt', async () => {
    const { calls, fetchImpl } = sequencedFetch(pluginReport, REFUSED.bun());

    await expect(patchBlock(serviceOver(fetchImpl), createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'obsidian_unreachable' },
    });
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'PATCH']);
  });

  /**
   * The `GET /` a PATCH reads its markdown-patch format from is retry-safe, so
   * an unreachable plugin spends that read's budget and the PATCH is never
   * sent.
   */
  it('PATCH to an unreachable plugin fails on the format read, never reaching the PATCH', async () => {
    const { calls, fetchImpl } = sequencedFetch(REFUSED.bun());

    await expect(patchBlock(serviceOver(fetchImpl), createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'obsidian_unreachable' },
    });
    expect(calls).toHaveLength(FULL_BUDGET);
    expect(calls.every((c) => c.init.method === 'GET' && new URL(c.url).pathname === '/')).toBe(
      true,
    );
  });

  it('builds the same message and data from the Bun and the Node shape, retried or not', async () => {
    const outcome = (reject: () => Error, call: Call) =>
      rejectionOf(call(serviceOver(sequencedFetch(reject()).fetchImpl), createMockContext()));
    const post: Call = (s, c) => s.searchText(c, 'q');
    const get: Call = (s, c) => s.listTags(c);

    const [bunPost, nodePost, bunGet, nodeGet] = await Promise.all([
      outcome(REFUSED.bun, post),
      outcome(REFUSED.node, post),
      outcome(REFUSED.bun, get),
      outcome(REFUSED.node, get),
    ]);

    expect({ message: bunPost.message, data: bunPost.data }).toEqual({
      message: nodePost.message,
      data: nodePost.data,
    });
    expect({ message: bunGet.message, data: bunGet.data }).toEqual({
      message: nodeGet.message,
      data: nodeGet.data,
    });
  });

  it('keeps the base URL and the runtime text off the wire', async () => {
    for (const [, reject] of CONNECTION_FAILURES) {
      const err = await rejectionOf(
        serviceOver(sequencedFetch(reject()).fetchImpl).searchText(createMockContext(), 'q'),
      );
      const wire = wireOf(err);
      expect(wire).not.toContain(HOST);
      expect(wire).not.toContain('27123');
      expect(wire).not.toMatch(/fetch failed|ECONN|ENOTFOUND|UND_ERR|Unable to connect|socket/i);
    }
  });

  /** The retry loop past its first iteration, in both directions. */
  it('recovers when the plugin comes back mid-budget', async () => {
    const { calls, fetchImpl } = sequencedFetch(REFUSED.node(), REFUSED.bun(), () =>
      mockResponse('{"tags":[{"name":"a","count":1}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(serviceOver(fetchImpl).listTags(createMockContext())).resolves.toEqual([
      { name: 'a', count: 1 },
    ]);
    expect(calls).toHaveLength(3);
  });

  it('surfaces the classification of the last attempt when the failures vary', async () => {
    const { calls, fetchImpl } = sequencedFetch(
      nodeFetchRejection('ECONNRESET', 'read ECONNRESET'),
      new TypeError('something the runtime never documented'),
      REFUSED.node(),
    );

    await expect(serviceOver(fetchImpl).listTags(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'obsidian_unreachable', retryAttempts: FULL_BUDGET },
    });
    expect(calls).toHaveLength(FULL_BUDGET);
  });

  it('rethrows the original error when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = createMockContext({ signal: controller.signal });

    for (const call of [...RETRY_SAFE, ...SINGLE_ATTEMPT].map(([, c]) => c)) {
      const rejection = REFUSED.node();
      const { calls, fetchImpl } = sequencedFetch(rejection);
      await expect(call(serviceOver(fetchImpl), ctx)).rejects.toBe(rejection);
      expect(calls).toHaveLength(1);
    }
  });
});

describe('obsidian_unreachable on the client surfaces', () => {
  it('reaches both tool surfaces with the hint and the reason', async () => {
    setObsidianService(serviceOver(sequencedFetch(REFUSED.bun()).fetchImpl));

    const res = await runToolContract(obsidianListTags, {});

    expect(res.isError).toBe(true);
    const error = (
      res.structuredContent as {
        error: { code: number; message: string; data: { reason: string } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('obsidian_unreachable');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('OBSIDIAN_BASE_URL');
    expect(text).toContain('obsidian_unreachable');
    expect(text).not.toContain(HOST);
  });

  it('reaches a resource that declares no errors[] contract', async () => {
    setObsidianService(serviceOver(sequencedFetch(REFUSED.node()).fetchImpl));

    const err = await rejectionOf(
      (async () =>
        obsidianStatus.handler(
          obsidianStatus.params!.parse({}),
          createMockContext({ uri: new URL('obsidian://status') }),
        ))(),
    );

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({
      reason: 'obsidian_unreachable',
      recovery: { hint: expect.stringContaining('OBSIDIAN_BASE_URL') },
    });
  });
});

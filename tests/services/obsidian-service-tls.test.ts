/**
 * @fileoverview TLS-relaxation contract for `ObsidianService`.
 *
 * `OBSIDIAN_VERIFY_SSL=false` exists for one reason: the Local REST API's
 * always-on HTTPS port ships a self-signed certificate. The relaxation must
 * therefore reach that endpoint's own requests and nothing else — not the
 * process, and not a plain-HTTP request that has no certificate to check.
 *
 * Every request the service issues is driven here through the injected
 * `fetchImpl`, and each case asserts on the `init` the service handed it. The
 * option travels per request (`tls`) and on the dispatcher; Bun's fetch honors
 * the former and Node's undici the latter, so both are sent unconditionally and
 * only the per-request half is observable from a stub.
 *
 * The second half covers the opposite setting: with verification on, a
 * certificate the runtime refuses is classified once, on the first attempt.
 *
 * @module tests/services/obsidian-service-tls.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
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

type RecordedInit = Parameters<ObsidianFetch>[1];

interface Recorded {
  init: RecordedInit;
  url: string;
}

/**
 * A service whose every request is answered generically and recorded. The
 * replies are shaped just enough for each caller to finish: a JSON body for
 * the routes that parse one, and the HEAD headers `tryGetSize` reads.
 */
function recordingService(overrides: Partial<ServerConfig> = {}): {
  calls: Recorded[];
  service: ObsidianService;
} {
  const calls: Recorded[] = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    calls.push({ url, init });
    if ((init.method ?? 'GET').toUpperCase() === 'HEAD') {
      return mockResponse('', {
        status: 200,
        headers: {
          'content-length': '42',
          'content-disposition': 'attachment; filename="N.md"',
        },
      });
    }
    return mockResponse('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, service: new ObsidianService(makeTestConfig(overrides), fetchImpl) };
}

/** Drive every `#fetch` call site the service owns. */
async function exerciseEveryCallSite(service: ObsidianService, ctx: Context): Promise<void> {
  await service.listTags(ctx); // #request
  await service.tryGetSize(ctx, { type: 'path', path: 'N.md' }); // HEAD, bypasses #request
  await service.probeOmnisearch(); // startup probe
  await service.searchOmnisearch(ctx, 'q'); // Omnisearch query
}

const relaxed = { tls: { rejectUnauthorized: false } };

describe('ObsidianService TLS relaxation', () => {
  it('sends the per-request TLS option on every https request when verifySsl is false', async () => {
    const ctx = createMockContext();
    const { calls, service } = recordingService({
      baseUrl: 'https://obsidian.test',
      omnisearchUrl: 'https://omni.test',
      verifySsl: false,
    });

    await exerciseEveryCallSite(service, ctx);

    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect(call.url.startsWith('https:')).toBe(true);
      expect(call.init).toMatchObject(relaxed);
    }
  });

  it('reaches the capability probe, which also carries the option', async () => {
    const ctx = createMockContext();
    const calls: Recorded[] = [];
    const fetchImpl: ObsidianFetch = async (url, init) => {
      calls.push({ url, init });
      // A `/periodic/` 404 is the one path that consults the capability report.
      if (new URL(url).pathname.startsWith('/periodic/')) {
        return mockResponse(JSON.stringify({ message: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockResponse(
        JSON.stringify({ status: 'OK', service: 'Obsidian Local REST API', authenticated: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const service = new ObsidianService(
      makeTestConfig({ baseUrl: 'https://obsidian.test', verifySsl: false }),
      fetchImpl,
    );

    await expect(
      service.getNoteContent(ctx, { type: 'periodic', period: 'daily' }),
    ).rejects.toThrow();

    const probe = calls.find((call) => new URL(call.url).pathname === '/');
    expect(probe).toBeDefined();
    expect(probe?.init).toMatchObject(relaxed);
  });

  it('sends no TLS option to an http endpoint, even with verifySsl false', async () => {
    const ctx = createMockContext();
    // Omnisearch derives an `http:` URL from the base host, so both call sites
    // here are plain HTTP and neither has a certificate to relax.
    const { calls, service } = recordingService({
      baseUrl: 'http://127.0.0.1:27123',
      verifySsl: false,
    });

    await exerciseEveryCallSite(service, ctx);

    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect(call.url.startsWith('http:')).toBe(true);
      expect(call.init).not.toHaveProperty('tls');
    }
  });

  /**
   * A URL schema accepts `HTTPS://…` and hands back the spelling it was given,
   * so the config can carry an uppercase scheme all the way to the wire. Bun
   * reads only the per-request option, which makes withholding it here a failed
   * connection to the self-signed endpoint `verifySsl: false` exists for.
   */
  it('relaxes an https endpoint written with an uppercase scheme', async () => {
    const ctx = createMockContext();
    const { calls, service } = recordingService({
      baseUrl: 'HTTPS://obsidian.test',
      omnisearchUrl: 'HTTPS://omni.test',
      verifySsl: false,
    });

    await exerciseEveryCallSite(service, ctx);

    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect(call.init).toMatchObject(relaxed);
    }
  });

  it('sends no TLS option when verifySsl is true', async () => {
    const ctx = createMockContext();
    const { calls, service } = recordingService({
      baseUrl: 'https://obsidian.test',
      omnisearchUrl: 'https://omni.test',
      verifySsl: true,
    });

    await exerciseEveryCallSite(service, ctx);

    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect(call.init).not.toHaveProperty('tls');
    }
  });

  it('mixes the two within one service — https relaxed, the http Omnisearch leg not', async () => {
    const ctx = createMockContext();
    const { calls, service } = recordingService({
      baseUrl: 'https://obsidian.test',
      verifySsl: false,
    });

    await exerciseEveryCallSite(service, ctx);

    for (const call of calls) {
      if (call.url.startsWith('https:')) expect(call.init).toMatchObject(relaxed);
      else expect(call.init).not.toHaveProperty('tls');
    }
    expect(calls.some((call) => call.url.startsWith('http://'))).toBe(true);
  });

  /**
   * The relaxation used to be a process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0`
   * written by the constructor whenever the runtime reported itself as Bun —
   * which turned certificate validation off for every TLS connection the
   * process made, including ones that never touch Obsidian. The runtime probe
   * is faked here so the assertion holds on whichever runtime the suite is on.
   */
  it('never writes NODE_TLS_REJECT_UNAUTHORIZED, even on a runtime reporting itself as Bun', () => {
    const runtime = globalThis as { Bun?: unknown };
    const hadBun = 'Bun' in runtime;
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const noop: ObsidianFetch = async () => mockResponse('', { status: 200 });
    if (!hadBun) runtime.Bun = {};

    try {
      new ObsidianService(makeTestConfig({ verifySsl: false }), noop);
      new ObsidianService(
        makeTestConfig({ baseUrl: 'https://obsidian.test', verifySsl: false }),
        noop,
      );
      new ObsidianService(makeTestConfig({ verifySsl: true }), noop);

      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
    } finally {
      if (!hadBun) delete runtime.Bun;
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
    }
  });
});

/**
 * Issue #133. With `OBSIDIAN_VERIFY_SSL=true` against the plugin's self-signed
 * HTTPS port, `fetch` rejects before any response exists. The rejection is
 * permanent, so it is classified inside the attempt `withRetry` calls — a
 * non-transient code stops the loop there — and it names the setting that
 * fixes it, inline, because the status and tags resources have no `errors[]`
 * for `ctx.recoveryFor` to read.
 *
 * Every rejection below is shaped from a real one: the four codes were each
 * produced on Bun 1.4.0 and Node 26.5.0 against a local HTTPS server (a
 * self-signed leaf, an untrusted issuer, a SAN mismatch, an expired leaf).
 * Bun carries the code on the thrown error, Node one level down on `cause`.
 */
describe('ObsidianService certificate rejection (issue #133)', () => {
  /** Distinctive enough that a hit on the wire cannot be coincidental. */
  const HOST = 'vault-host-zq7f31.test';
  const BASE_URL = `https://${HOST}:27124`;

  const CERT_REJECTIONS = [
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'],
    [
      'ERR_TLS_CERT_ALTNAME_INVALID',
      `Hostname/IP does not match certificate's altnames: Host: ${HOST}. is not in the cert's altnames`,
    ],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
  ] as const;

  const SHAPES = [
    ['Bun', bunFetchRejection],
    ['Node', nodeFetchRejection],
  ] as const;

  /** One call site per path a request can take to the wire. */
  const CALL_SITES = [
    ['GET via #request (retry-safe)', (s: ObsidianService, c: Context) => s.listTags(c)],
    [
      'PUT via #request (retry-safe)',
      (s: ObsidianService, c: Context) => s.writeNote(c, { type: 'path', path: 'N.md' }, 'x'),
    ],
    [
      'DELETE via #request (retry-safe)',
      (s: ObsidianService, c: Context) => s.deleteNote(c, { type: 'path', path: 'N.md' }),
    ],
    ['POST via #request', (s: ObsidianService, c: Context) => s.searchText(c, 'q')],
    [
      'HEAD via tryGetSize',
      (s: ObsidianService, c: Context) => s.tryGetSize(c, { type: 'path', path: 'N.md' }),
    ],
  ] as const;

  function verifyingService(fetchImpl: ObsidianFetch): ObsidianService {
    return new ObsidianService(makeTestConfig({ baseUrl: BASE_URL, verifySsl: true }), fetchImpl);
  }

  afterEach(() => setObsidianService(undefined));

  describe.each(SHAPES)('%s-shaped rejection', (_runtime, reject) => {
    it.each(CALL_SITES)(
      '%s throws certificate_rejected on the first attempt',
      async (_site, call) => {
        const ctx = createMockContext();
        const rejection = reject('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate');
        const { calls, fetchImpl } = sequencedFetch(rejection);

        await expect(call(verifyingService(fetchImpl), ctx)).rejects.toMatchObject({
          code: JsonRpcErrorCode.ConfigurationError,
          data: {
            reason: 'certificate_rejected',
            recovery: { hint: expect.stringContaining('OBSIDIAN_VERIFY_SSL') },
          },
        });
        expect(calls).toHaveLength(1);
      },
    );

    it.each(CERT_REJECTIONS)('classifies %s', async (code, message) => {
      const { fetchImpl } = sequencedFetch(reject(code, message));

      await expect(
        verifyingService(fetchImpl).searchText(createMockContext(), 'q'),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining(code),
        data: { reason: 'certificate_rejected' },
      });
    });
  });

  it('builds the same message and data from the Bun and the Node shape', async () => {
    for (const [code, message] of CERT_REJECTIONS) {
      const [bun, node] = await Promise.all(
        [bunFetchRejection(code, message), nodeFetchRejection(code, message)].map((rejection) =>
          rejectionOf(
            verifyingService(sequencedFetch(rejection).fetchImpl).listTags(createMockContext()),
          ),
        ),
      );
      expect(bun).toBeInstanceOf(McpError);
      expect(node).toBeInstanceOf(McpError);
      expect({ message: bun?.message, data: bun?.data }).toEqual({
        message: node?.message,
        data: node?.data,
      });
    }
  });

  it('keeps the base URL and the runtime text off the wire, and the rejection on cause', async () => {
    const rejection = nodeFetchRejection(
      'ERR_TLS_CERT_ALTNAME_INVALID',
      `Hostname/IP does not match certificate's altnames: Host: ${HOST}. is not in the cert's altnames`,
    );
    const { fetchImpl } = sequencedFetch(rejection);

    const err = await rejectionOf(verifyingService(fetchImpl).listTags(createMockContext()));

    expect(err).toBeInstanceOf(McpError);
    const wire = JSON.stringify({ code: err.code, message: err.message, data: err.data });
    expect(wire).not.toContain(HOST);
    expect(wire).not.toContain('altnames');
    expect(wire).not.toContain('fetch failed');
    expect(err.cause).toBe(rejection);
  });

  /**
   * The retry loop past its first iteration: a transient failure is retried,
   * and the certificate rejection that follows still ends the loop on the
   * attempt it arrives on rather than riding out the remaining budget.
   */
  it('stops the retry loop on the attempt a certificate rejection arrives on', async () => {
    const { calls, fetchImpl } = sequencedFetch(
      nodeFetchRejection('ECONNRESET', 'read ECONNRESET'),
      nodeFetchRejection('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'),
      () => mockResponse('{"tags":[]}', { status: 200 }),
    );

    await expect(verifyingService(fetchImpl).listTags(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: { reason: 'certificate_rejected' },
    });
    expect(calls).toHaveLength(2);
  });

  it('leaves a refused connection unclassified as a certificate failure, and retried', async () => {
    const { calls, fetchImpl } = sequencedFetch(
      nodeFetchRejection('ECONNREFUSED', `connect ECONNREFUSED 127.0.0.1:27124`),
    );

    const err = await rejectionOf<{ data?: { reason?: string } }>(
      verifyingService(fetchImpl).listTags(createMockContext()),
    );

    expect(err.data?.reason).not.toBe('certificate_rejected');
    expect(calls).toHaveLength(4);
  });

  it('rethrows the original error when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = createMockContext({ signal: controller.signal });
    const rejection = bunFetchRejection('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate');

    for (const call of [
      (s: ObsidianService) => s.listTags(ctx),
      (s: ObsidianService) => s.searchText(ctx, 'q'),
      (s: ObsidianService) => s.tryGetSize(ctx, { type: 'path', path: 'N.md' }),
    ]) {
      const { calls, fetchImpl } = sequencedFetch(rejection);
      await expect(call(verifyingService(fetchImpl))).rejects.toBe(rejection);
      expect(calls).toHaveLength(1);
    }
  });

  it('reaches both tool surfaces with the hint and the reason', async () => {
    setObsidianService(
      verifyingService(
        sequencedFetch(bunFetchRejection('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'))
          .fetchImpl,
      ),
    );

    const res = await runToolContract(obsidianListTags, {});

    expect(res.isError).toBe(true);
    const error = (
      res.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.data.reason).toBe('certificate_rejected');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('OBSIDIAN_VERIFY_SSL');
    expect(text).toContain('certificate_rejected');
    expect(text).not.toContain(HOST);
  });
});

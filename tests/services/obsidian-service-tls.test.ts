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
 * @module tests/services/obsidian-service-tls.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { type ObsidianFetch, ObsidianService } from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse } from '../helpers.js';

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

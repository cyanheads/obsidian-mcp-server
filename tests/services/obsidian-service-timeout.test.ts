/**
 * @fileoverview Request timeout and call budget for `ObsidianService` (issue
 * #176).
 *
 * `OBSIDIAN_REQUEST_TIMEOUT_MS` bounds each attempt — the fetch and the body
 * read — through a timer joined to the request's signal, which both runtimes
 * honor before the headers and during the body. GET, PUT, and DELETE retry a
 * timed-out attempt; every request one call makes shares one budget, 45 s or
 * the timeout when that is longer, so a stalled or slow upstream settles
 * inside the 60 s an MCP client waits. Expiry is `Timeout` with
 * `reason: 'obsidian_timeout'`; a caller's cancellation and a scoped search's
 * deadline are told apart from the timer by identity and pass through.
 *
 * The stub fetches here behave as Bun 1.4.4 and Node 26.13.0 were measured to:
 * an abort rejects a pending fetch, or errors a pending body, with the
 * signal's own reason. Everything runs under fake timers, so every bound is
 * asserted on both sides of its instant.
 *
 * @module tests/services/obsidian-service-timeout.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { obsidianStatus } from '@/mcp-server/resources/definitions/obsidian-status.resource.js';
import { obsidianListTags } from '@/mcp-server/tools/definitions/obsidian-list-tags.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import {
  bunFetchRejection,
  jsonLogicVault,
  type MockResponse,
  makeTestConfig,
  mockResponse,
} from '../helpers.js';

/** Distinctive enough that a hit on the wire cannot be coincidental. */
const HOST = 'vault-host-t176q.test';
const BASE_URL = `http://${HOST}:27123`;

const HINT =
  'Obsidian may be busy or not responding. Retry a read as it is; a write may have applied before the timeout, so read the note before repeating one. If it keeps timing out, check that Obsidian responds, or raise OBSIDIAN_REQUEST_TIMEOUT_MS (a value above 45 s also extends the 45 s budget the requests of one call share).';

type Signal = AbortSignal | undefined;

/** Pending until `signal` aborts, then rejected with its reason. */
function untilAborted(signal: Signal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** `reply()` once `ms` have passed, unless `signal` aborts first. */
function answerAfter(ms: number, signal: Signal, reply: () => MockResponse): Promise<MockResponse> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => resolve(reply()), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** A 200 whose headers arrive and whose body sends a fragment, then stalls until `signal` aborts. */
function stalledBody(signal: Signal): MockResponse {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"tags":[{"name":"a'));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return mockResponse(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  mockResponse(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

const TAGS = () => json({ tags: [{ name: 'a', count: 1 }] });
const PLUGIN_REPORT = () => json({ status: 'OK', service: 's', versions: { self: '5.2.0' } });
const NOTE_HEAD = () =>
  mockResponse(null, {
    status: 200,
    headers: { 'content-length': '7', 'content-disposition': 'attachment; filename="N.md"' },
  });

/** How one upstream request is answered. */
type Reply = (signal: Signal) => Promise<MockResponse>;

const NEVER: Reply = (signal) => untilAborted(signal);
const BODY_STALL: Reply = async (signal) => stalledBody(signal);
const AFTER_20_S: Reply = (signal) => answerAfter(20_000, signal, TAGS);

interface Call {
  method: string;
  path: string;
}

/**
 * A stub fetch that routes each request to `route(method, path)`'s reply and
 * records it, so attempt counts are counted on the wire.
 */
function routedFetch(route: (method: string, path: string) => Reply): {
  calls: Call[];
  fetchImpl: ObsidianFetch;
} {
  const calls: Call[] = [];
  const fetchImpl: ObsidianFetch = (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    calls.push({ method, path });
    return route(method, path)(init.signal);
  };
  return { calls, fetchImpl };
}

function serviceOver(
  fetchImpl: ObsidianFetch,
  config: Partial<ServerConfig> = {},
): ObsidianService {
  return new ObsidianService(
    makeTestConfig({ baseUrl: BASE_URL, requestTimeoutMs: 3_000, ...config }),
    fetchImpl,
  );
}

/** `promise`, with a flag that flips once it settles. */
function tracked<T>(promise: Promise<T>): { done: Promise<T>; settled: () => boolean } {
  let settled = false;
  const done = promise.finally(() => {
    settled = true;
  });
  done.catch(() => undefined);
  return { done, settled: () => settled };
}

/** The rejection of a tracked call, once it has settled. */
async function failure(call: { done: Promise<unknown> }): Promise<McpError> {
  return await call.done.then(
    () => expect.unreachable('expected a rejection'),
    (e: unknown) => e as McpError,
  );
}

const wireOf = (err: McpError) =>
  JSON.stringify({ code: err.code, message: err.message, data: err.data });

type ServiceCall = (s: ObsidianService, c: Context) => Promise<unknown>;

const PATH_TARGET = { type: 'path', path: 'N.md' } as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setObsidianService(undefined);
});

describe('a retry-safe request under a stalled upstream', () => {
  it.each([
    ['never answers', NEVER],
    ['stalls its body after the headers', BODY_STALL],
    ['answers only after 20 s', AFTER_20_S],
  ] as const)('a GET that %s fails obsidian_timeout after four 3 s attempts', async (_s, reply) => {
    const { calls, fetchImpl } = routedFetch(() => reply);
    const call = tracked(serviceOver(fetchImpl).listTags(createMockContext()));

    // Four 3 s attempts plus three backoffs of 200, 400, and 800 ms, each ±25 %.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(call.settled()).toBe(true);

    const err = await failure(call);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message).toBe(
      'The Obsidian Local REST API did not respond within 3 s. (failed after 4 attempts)',
    );
    expect(err.data).toEqual({
      reason: 'obsidian_timeout',
      recovery: { hint: HINT },
      retryAttempts: 4,
      operation: 'obsidian.GET /tags/',
    });
    expect(calls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['PUT', (s, c) => s.writeNote(c, PATH_TARGET, 'x')],
    ['DELETE', (s, c) => s.deleteNote(c, PATH_TARGET)],
  ] satisfies ReadonlyArray<readonly [string, ServiceCall]>)(
    'a %s that never answers is retried the same way',
    async (method, run) => {
      const { calls, fetchImpl } = routedFetch(() => NEVER);
      const call = tracked(run(serviceOver(fetchImpl), createMockContext()));

      await vi.advanceTimersByTimeAsync(13_800);
      const err = await failure(call);
      expect(err.data).toMatchObject({ reason: 'obsidian_timeout', retryAttempts: 4 });
      expect(calls.map((c) => c.method)).toEqual([method, method, method, method]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('at the 30 s default, fails obsidian_timeout at the 45 s deadline, cutting the second attempt', async () => {
    const { calls, fetchImpl } = routedFetch(() => NEVER);
    const call = tracked(
      serviceOver(fetchImpl, { requestTimeoutMs: 30_000 }).listTags(createMockContext()),
    );

    await vi.advanceTimersByTimeAsync(44_999);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.settled()).toBe(true);

    const err = await failure(call);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message).toBe(
      "This call's requests to the Obsidian Local REST API did not finish within its 45 s budget.",
    );
    expect(err.data).toEqual({
      reason: 'obsidian_timeout',
      recovery: { hint: HINT },
      retryAttempts: 2,
    });
    expect(calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a timeout above 45 s the whole budget, in one attempt', async () => {
    const { calls, fetchImpl } = routedFetch(() => NEVER);
    const call = tracked(
      serviceOver(fetchImpl, { requestTimeoutMs: 120_000 }).listTags(createMockContext()),
    );

    await vi.advanceTimersByTimeAsync(119_999);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await failure(call);
    expect(err.data).toMatchObject({ reason: 'obsidian_timeout' });
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers when the upstream replies inside the timeout, leaving no timer behind', async () => {
    const { calls, fetchImpl } = routedFetch(() => (signal) => answerAfter(2_999, signal, TAGS));
    const call = tracked(serviceOver(fetchImpl).listTags(createMockContext()));

    await vi.advanceTimersByTimeAsync(2_999);
    await expect(call.done).resolves.toEqual([{ name: 'a', count: 1 }]);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers when a later attempt answers', async () => {
    let attempt = 0;
    const { calls, fetchImpl } = routedFetch(() => (signal) => {
      attempt++;
      return attempt < 3 ? BODY_STALL(signal) : Promise.resolve(TAGS());
    });
    const call = tracked(serviceOver(fetchImpl).listTags(createMockContext()));

    await vi.advanceTimersByTimeAsync(7_000);
    await expect(call.done).resolves.toEqual([{ name: 'a', count: 1 }]);
    expect(calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a single-attempt request under a stalled upstream', () => {
  const singleAttempt: ReadonlyArray<readonly [string, string, ServiceCall]> = [
    ['POST', '/search/simple/', (s, c) => s.searchText(c, 'q')],
    ['POST', '/commands/c/', (s, c) => s.executeCommand(c, 'c')],
    [
      'PATCH',
      '/vault/N.md',
      (s, c) =>
        s.patchNote(c, PATH_TARGET, 'x', {
          operation: 'append',
          targetType: 'block',
          target: 'b1',
          contentType: 'markdown',
        }),
    ],
    ['HEAD', '/vault/N.md', (s, c) => s.tryGetSize(c, PATH_TARGET)],
  ];

  it.each(singleAttempt)(
    'a %s to %s makes one attempt, cut off at the timeout',
    async (method, path, run) => {
      // The PATCH first reads the plugin's report for its markdown-patch format.
      const { calls, fetchImpl } = routedFetch((m, p) =>
        m === 'GET' && p === '/' ? async () => PLUGIN_REPORT() : NEVER,
      );
      const call = tracked(run(serviceOver(fetchImpl), createMockContext()));

      await vi.advanceTimersByTimeAsync(2_999);
      expect(call.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.settled()).toBe(true);

      const err = await failure(call);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toBe('The Obsidian Local REST API did not respond within 3 s.');
      expect(err.data).toEqual({ reason: 'obsidian_timeout', recovery: { hint: HINT } });
      expect(calls.filter((c) => c.method === method && c.path === path)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ['never answers', NEVER],
    ['stalls its body', BODY_STALL],
  ] as const)(
    'the Omnisearch query that %s is cut off at the timeout as omnisearch_unreachable',
    async (_s, reply) => {
      const { calls, fetchImpl } = routedFetch(() => reply);
      const call = tracked(serviceOver(fetchImpl).searchOmnisearch(createMockContext(), 'q'));

      await vi.advanceTimersByTimeAsync(2_999);
      expect(call.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const err = await failure(call);
      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.data).toMatchObject({ reason: 'omnisearch_unreachable' });
      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("the caller's cancellation, told apart from the timer by identity", () => {
  const reasons = [
    ['a plain abort', () => undefined],
    ['an abort whose reason is a TimeoutError', () => new DOMException('caller', 'TimeoutError')],
  ] as const;

  it.each(reasons)(
    '%s mid-attempt is rethrown untouched, with no further attempt',
    async (_l, reason) => {
      const controller = new AbortController();
      const { calls, fetchImpl } = routedFetch(() => NEVER);
      const call = tracked(
        serviceOver(fetchImpl).listTags(createMockContext({ signal: controller.signal })),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort(reason());
      await vi.advanceTimersByTimeAsync(20_000);

      expect(await failure(call)).toBe(controller.signal.reason);
      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(reasons)(
    '%s mid-backoff is rethrown untouched, with no further attempt',
    async (_l, reason) => {
      const controller = new AbortController();
      const { calls, fetchImpl } = routedFetch(() => NEVER);
      const call = tracked(
        serviceOver(fetchImpl).listTags(createMockContext({ signal: controller.signal })),
      );

      // The first attempt times out at 3 s; the backoff after it runs 150–250 ms.
      await vi.advanceTimersByTimeAsync(3_100);
      expect(calls).toHaveLength(1);
      controller.abort(reason());
      await vi.advanceTimersByTimeAsync(20_000);

      expect(await failure(call)).toBe(controller.signal.reason);
      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('rethrows a cancellation that lands on a single-attempt request untouched', async () => {
    const controller = new AbortController();
    const { fetchImpl } = routedFetch(() => NEVER);
    const call = tracked(
      serviceOver(fetchImpl).tryGetSize(
        createMockContext({ signal: controller.signal }),
        PATH_TARGET,
      ),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new DOMException('caller', 'TimeoutError'));
    await vi.advanceTimersByTimeAsync(0);

    expect(await failure(call)).toBe(controller.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['never answers', NEVER],
    ['stalls its body', BODY_STALL],
  ] as const)(
    'rethrows a cancellation that lands on an Omnisearch query that %s untouched',
    async (_s, reply) => {
      const controller = new AbortController();
      const { calls, fetchImpl } = routedFetch(() => reply);
      const call = tracked(
        serviceOver(fetchImpl).searchOmnisearch(
          createMockContext({ signal: controller.signal }),
          'q',
        ),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort(new DOMException('caller', 'TimeoutError'));
      await vi.advanceTimersByTimeAsync(0);

      expect(await failure(call)).toBe(controller.signal.reason);
      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('a scoped search under a stalled upstream', () => {
  const scoped = (
    route: (method: string, path: string) => Reply | undefined,
    timeoutMs: number,
  ) => {
    const vault = jsonLogicVault(
      Array.from({ length: 40 }, (_, i) => ({ path: `Work/n${i}.md`, content: 'x' })),
    );
    const calls: Call[] = [];
    const fetchImpl: ObsidianFetch = (url, init) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const path = new URL(url).pathname;
      calls.push({ method, path });
      const reply = route(method, path);
      return reply ? reply(init.signal) : vault.fetchImpl(url, init);
    };
    return {
      calls,
      svc: serviceOver(fetchImpl, { readPaths: ['work'], requestTimeoutMs: timeoutMs }),
    };
  };

  const textSearch: ServiceCall = (s, c) => s.searchText(c, 'x', 100);
  const logicSearch: ServiceCall = (s, c) =>
    s.searchJsonLogic(c, { in: ['x', { var: 'content' }] });

  it.each([
    ['text', textSearch],
    ['JSONLogic', logicSearch],
  ] as const)(
    'a %s search whose guarded /search/ stalls fails obsidian_timeout at the timeout, not at the search deadline',
    async (_mode, run) => {
      const { calls, svc } = scoped((m) => (m === 'POST' ? NEVER : undefined), 30_000);
      const call = tracked(run(svc, createMockContext()));

      await vi.advanceTimersByTimeAsync(29_999);
      expect(call.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const err = await failure(call);
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toBe('The Obsidian Local REST API did not respond within 30 s.');
      expect(err.data).toEqual({ reason: 'obsidian_timeout', recovery: { hint: HINT } });
      expect(calls).toEqual([{ method: 'POST', path: '/search/' }]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retries a body read that times out, and fails obsidian_timeout when every attempt does', async () => {
    const { calls, svc } = scoped((m) => (m === 'GET' ? NEVER : undefined), 5_000);
    const call = tracked(textSearch(svc, createMockContext()));

    // Four 5 s attempts plus their backoffs, well inside the 45 s search deadline.
    await vi.advanceTimersByTimeAsync(21_800);
    const err = await failure(call);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'obsidian_timeout', retryAttempts: 4 });
    // 32 reads in flight, each attempted four times; the other 8 never start.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(128);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['text', 'text_search_too_costly', textSearch],
    ['JSONLogic', 'logic_too_costly', logicSearch],
  ] as const)(
    'a %s search deadline landing in a body read backoff still fails %s, with no further attempt',
    async (_mode, reason, run) => {
      // Each read times out at 44.9 s and backs off 150–250 ms, across the 45 s deadline.
      const { calls, svc } = scoped((m) => (m === 'GET' ? NEVER : undefined), 44_900);
      const call = tracked(run(svc, createMockContext()));

      await vi.advanceTimersByTimeAsync(44_999);
      expect(call.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const err = await failure(call);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data).toMatchObject({ reason });
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(32);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls.filter((c) => c.method === 'GET')).toHaveLength(32);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('one budget for every request a call makes', () => {
  it('gives a request after a slow one only what is left of the 45 s', async () => {
    const { calls, fetchImpl } = routedFetch((method) =>
      method === 'GET' ? (signal) => answerAfter(29_000, signal, TAGS) : NEVER,
    );
    const svc = serviceOver(fetchImpl, { requestTimeoutMs: 30_000 });
    const ctx = createMockContext();
    const call = tracked(
      (async () => {
        await svc.listTags(ctx);
        await svc.writeNote(ctx, PATH_TARGET, 'x');
      })(),
    );

    await vi.advanceTimersByTimeAsync(44_999);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await failure(call);
    expect(err.message).toBe(
      "This call's requests to the Obsidian Local REST API did not finish within its 45 s budget.",
    );
    expect(err.data).toEqual({
      reason: 'obsidian_timeout',
      recovery: { hint: HINT },
      retryAttempts: 1,
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cuts a single-attempt request at what is left of the budget', async () => {
    const { fetchImpl } = routedFetch((method) =>
      method === 'GET' ? (signal) => answerAfter(40_000, signal, TAGS) : NEVER,
    );
    // A 44 s timeout keeps the budget at 45 s and lets the 40 s GET answer.
    const svc = serviceOver(fetchImpl, { requestTimeoutMs: 44_000 });
    const ctx = createMockContext();
    const call = tracked(
      (async () => {
        await svc.listTags(ctx);
        await svc.tryGetSize(ctx, PATH_TARGET);
      })(),
    );

    await vi.advanceTimersByTimeAsync(44_999);
    expect(call.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const err = await failure(call);
    expect(err.message).toBe(
      "This call's requests to the Obsidian Local REST API did not finish within its 45 s budget.",
    );
    expect(err.data).toEqual({ reason: 'obsidian_timeout', recovery: { hint: HINT } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never sends a request once the budget is spent', async () => {
    const { calls, fetchImpl } = routedFetch((method) =>
      method === 'GET' ? (signal) => answerAfter(49_999, signal, TAGS) : async () => NOTE_HEAD(),
    );
    const svc = serviceOver(fetchImpl, { requestTimeoutMs: 50_000 });
    const ctx = createMockContext();
    const first = tracked(svc.listTags(ctx));
    await vi.advanceTimersByTimeAsync(49_999);
    await first.done;
    await vi.advanceTimersByTimeAsync(1);

    const second = tracked(svc.tryGetSize(ctx, PATH_TARGET));
    await vi.advanceTimersByTimeAsync(0);
    const err = await failure(second);
    expect(err.message).toBe(
      "This call's requests to the Obsidian Local REST API did not finish within its 50 s budget.",
    );
    expect(err.data).toEqual({ reason: 'obsidian_timeout', recovery: { hint: HINT } });
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the typed failure of a request with no budget left to retry it', async () => {
    const refused = bunFetchRejection(
      'ConnectionRefused',
      'Unable to connect. Is the computer able to access the url?',
    );
    const { calls, fetchImpl } = routedFetch((method) =>
      method === 'GET'
        ? (signal) => answerAfter(44_900, signal, TAGS)
        : () => Promise.reject(refused),
    );
    const svc = serviceOver(fetchImpl, { requestTimeoutMs: 45_000 });
    const ctx = createMockContext();
    const call = tracked(
      (async () => {
        await svc.listTags(ctx);
        await svc.writeNote(ctx, PATH_TARGET, 'x');
      })(),
    );

    // The PUT is refused with 100 ms left, less than any backoff (150–250 ms).
    await vi.advanceTimersByTimeAsync(45_000);
    const err = await failure(call);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.message).toBe('Could not connect to the Obsidian Local REST API.');
    expect(err.data).toMatchObject({ reason: 'obsidian_unreachable' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives every call its own budget', async () => {
    const { fetchImpl } = routedFetch((method) =>
      method === 'GET' ? (signal) => answerAfter(40_000, signal, TAGS) : async () => NOTE_HEAD(),
    );
    const svc = serviceOver(fetchImpl, { requestTimeoutMs: 45_000 });
    await (async () => {
      const first = tracked(svc.listTags(createMockContext()));
      await vi.advanceTimersByTimeAsync(40_000);
      await first.done;
    })();

    const second = tracked(svc.listTags(createMockContext()));
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(second.done).resolves.toEqual([{ name: 'a', count: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('obsidian_timeout on the client surfaces', () => {
  it('keeps the base URL and the runtime text off the wire', async () => {
    const { fetchImpl } = routedFetch(() => BODY_STALL);
    const call = tracked(serviceOver(fetchImpl).listTags(createMockContext()));
    await vi.advanceTimersByTimeAsync(13_800);

    const wire = wireOf(await failure(call));
    expect(wire).not.toContain(HOST);
    expect(wire).not.toContain('27123');
    expect(wire).not.toMatch(
      /TimeoutError|AbortError|aborted|timer of|expired|terminated|fetch failed/i,
    );
  });

  it('reaches both tool surfaces with the hint and the reason', async () => {
    setObsidianService(serviceOver(routedFetch(() => NEVER).fetchImpl));

    const pending = runToolContract(obsidianListTags, {});
    await vi.advanceTimersByTimeAsync(13_800);
    const res = await pending;

    expect(res.isError).toBe(true);
    const error = (res.structuredContent as { error: { code: number; data: { reason: string } } })
      .error;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data.reason).toBe('obsidian_timeout');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('OBSIDIAN_REQUEST_TIMEOUT_MS');
    expect(text).toContain('obsidian_timeout');
    expect(text).not.toContain(HOST);
  });

  it('reaches a resource that declares no errors[] contract with the hint inline', async () => {
    setObsidianService(serviceOver(routedFetch(() => NEVER).fetchImpl));

    const call = tracked(
      (async () =>
        obsidianStatus.handler(
          obsidianStatus.params!.parse({}),
          createMockContext({ uri: new URL('obsidian://status') }),
        ))(),
    );
    await vi.advanceTimersByTimeAsync(13_800);

    const err = await failure(call);
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.data).toMatchObject({ reason: 'obsidian_timeout', recovery: { hint: HINT } });
  });
});

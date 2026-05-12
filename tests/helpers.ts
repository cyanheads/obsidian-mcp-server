/**
 * @fileoverview Shared test helpers — wires a real `ObsidianService` against
 * a stub fetch so handler tests exercise the full pipeline (URL builder,
 * headers, error classification) against scripted responses.
 *
 * The stub fetch is injected via the service constructor (`fetchImpl` arg);
 * we don't go through `vi.mock('undici', ...)` because Bun's runtime treats
 * `undici` as a builtin and silently ignores module-level mocks. The harness
 * exposes a `pool.intercept(matcher).reply(...)` API matching undici's
 * `MockPool` so existing tests stay shape-compatible.
 *
 * @module tests/helpers
 */

import { afterEach, beforeEach } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';

export const TEST_BASE_URL = 'https://obsidian.test';

export function makeTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiKey: 'test-api-key',
    baseUrl: TEST_BASE_URL,
    verifySsl: false,
    requestTimeoutMs: 5_000,
    enableCommands: false,
    enableOmnisearch: false,
    omnisearchBaseUrl: 'http://omnisearch.test',
    readPaths: undefined,
    writePaths: undefined,
    readOnly: false,
    ...overrides,
  };
}

type PathMatcher = string | ((path: string) => boolean);

interface InterceptMatcher {
  method?: string;
  path: PathMatcher;
}

interface DispatchOpts {
  body: string | undefined;
  headers: Record<string, string>;
  method: string;
  path: string;
}

interface DynamicReply {
  data?: unknown;
  responseOptions?: { headers?: Record<string, string> };
  statusCode: number;
}

type ReplyFn = (opts: DispatchOpts) => DynamicReply;

interface StaticReply {
  body: unknown;
  headers: Record<string, string> | undefined;
  status: number;
}

interface Intercept {
  consumed: boolean;
  matcher: InterceptMatcher;
  reply: ReplyFn | StaticReply;
}

class MockPool {
  readonly #intercepts: Intercept[] = [];

  intercept(matcher: InterceptMatcher): {
    reply: (
      statusOrFn: number | ReplyFn,
      body?: unknown,
      opts?: { headers?: Record<string, string> },
    ) => void;
  } {
    return {
      reply: (statusOrFn, body, opts) => {
        const reply: ReplyFn | StaticReply =
          typeof statusOrFn === 'function'
            ? statusOrFn
            : { status: statusOrFn, body, headers: opts?.headers };
        this.#intercepts.push({ matcher, reply, consumed: false });
      },
    };
  }

  consume(opts: DispatchOpts): Intercept | undefined {
    for (const ix of this.#intercepts) {
      if (ix.consumed) continue;
      if (ix.matcher.method && ix.matcher.method.toUpperCase() !== opts.method) continue;
      const ok =
        typeof ix.matcher.path === 'function'
          ? ix.matcher.path(opts.path)
          : ix.matcher.path === opts.path;
      if (!ok) continue;
      ix.consumed = true;
      return ix;
    }
    return;
  }
}

export interface TestHarness {
  pool: MockPool;
  service: ObsidianService;
}

export function setupHarness(): { current: () => TestHarness } {
  let harness: TestHarness;

  beforeEach(() => {
    const pool = new MockPool();
    const fetchImpl: ObsidianFetch = async (url, init) => {
      const u = new URL(url);
      const opts: DispatchOpts = {
        path: u.pathname + u.search,
        method: (init.method ?? 'GET').toUpperCase(),
        headers: normalizeHeaders(init.headers as HeadersInit | undefined),
        body: init.body == null ? undefined : String(init.body),
      };
      const ix = pool.consume(opts);
      if (!ix) {
        throw new Error(`No mock intercept for ${opts.method} ${opts.path}`);
      }
      return buildResponse(ix.reply, opts);
    };

    const service = new ObsidianService(makeTestConfig(), fetchImpl);
    setObsidianService(service);
    harness = { pool, service };
  });

  afterEach(() => {
    setObsidianService(undefined);
  });

  return { current: () => harness };
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(input)) return Object.fromEntries(input);
  return { ...input };
}

function buildResponse(reply: ReplyFn | StaticReply, opts: DispatchOpts): Response {
  let status: number;
  let body: unknown;
  let headers: Record<string, string> | undefined;

  if (typeof reply === 'function') {
    const r = reply(opts);
    status = r.statusCode;
    body = r.data;
    headers = r.responseOptions?.headers;
  } else {
    status = reply.status;
    body = reply.body;
    headers = reply.headers;
  }

  const isJsonLike = body !== null && typeof body === 'object';
  const text = body === undefined ? '' : isJsonLike ? JSON.stringify(body) : String(body);
  const finalHeaders = new Headers(headers ?? {});
  if (!finalHeaders.has('content-type') && isJsonLike) {
    finalHeaders.set('content-type', 'application/json');
  }
  return new Response(text, { status, headers: finalHeaders });
}

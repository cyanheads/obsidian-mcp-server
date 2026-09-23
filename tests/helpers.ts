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

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { Headers, type HeadersInit, Response } from 'undici';
import { afterEach, beforeEach, expect } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';

export const TEST_BASE_URL = 'https://obsidian.test';

/**
 * Build a stub upstream response. `ObsidianService` is typed against undici's
 * `fetch`, and undici's `Response` carries members (`textStream`) that the
 * ambient global `Response` — sourced from `undici-types` via `@types/node` —
 * does not, so a stub built with the global constructor does not satisfy
 * `ObsidianFetch`. Constructing through undici's own class is what makes a
 * hand-rolled fetch stub conform; every stub in the suite goes through here.
 */
export function mockResponse(...args: ConstructorParameters<typeof Response>): Response {
  return new Response(...args);
}

/** The response type a stub fetch must produce — annotate scripted-reply tables with this. */
export type MockResponse = ReturnType<typeof mockResponse>;

export function makeTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiKey: 'test-api-key',
    baseUrl: TEST_BASE_URL,
    verifySsl: false,
    requestTimeoutMs: 5_000,
    enableCommands: false,
    readPaths: undefined,
    writePaths: undefined,
    readOnly: false,
    ...overrides,
  };
}

/**
 * A `fetch` rejection as Bun raises it: one `TypeError` carrying the code
 * itself. Shapes recorded against Bun 1.4.0 — a self-signed certificate is
 * `code: 'DEPTH_ZERO_SELF_SIGNED_CERT'`, a refused connection the non-errno
 * `code: 'ConnectionRefused'`.
 */
export function bunFetchRejection(code: string, message: string): TypeError {
  return Object.assign(new TypeError(message), { code });
}

/**
 * A `fetch` rejection as Node's undici raises it: a bare `TypeError: fetch
 * failed` with the coded error one level down on `cause`. Recorded against
 * Node 26.5.0. `aggregate` reproduces a refused `localhost`, where both
 * address families fail and the cause is an `AggregateError` carrying the
 * shared code.
 */
export function nodeFetchRejection(
  code: string,
  message: string,
  opts: { aggregate?: boolean } = {},
): TypeError {
  const coded = opts.aggregate
    ? Object.assign(new AggregateError([new Error(message), new Error(message)], ''), { code })
    : Object.assign(new Error(message), { code });
  return new TypeError('fetch failed', { cause: coded });
}

/**
 * A stub fetch that plays `outcomes` in order — call `n` gets outcome `n`, and
 * the last one repeats — recording every call. An `Error` outcome rejects; a
 * response outcome resolves. Counting calls through the real `#request` /
 * `withRetry` path is what makes an attempt-count assertion mean anything.
 */
export function sequencedFetch(...outcomes: Array<Error | (() => MockResponse)>): {
  calls: Array<{ init: Parameters<ObsidianFetch>[1]; url: string }>;
  fetchImpl: ObsidianFetch;
} {
  const calls: Array<{ init: Parameters<ObsidianFetch>[1]; url: string }> = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    calls.push({ url, init });
    const outcome = outcomes[Math.min(calls.length, outcomes.length) - 1];
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error('sequencedFetch: no outcomes scripted');
    return outcome();
  };
  return { calls, fetchImpl };
}

/**
 * Assert that `p` rejects, then hand back what it rejected with so the caller
 * can make several assertions against one error.
 */
export async function rejectionOf<E = McpError>(p: Promise<unknown>): Promise<E> {
  await expect(p).rejects.toBeDefined();
  return p.then(
    () => expect.unreachable('expected a rejection'),
    (e: unknown) => e as E,
  );
}

/**
 * A `note+json` reply body carrying `content`. On plugin v4.x, whose document
 * map cannot count repeats, a heading-targeted write reads it to confirm the
 * resolved heading path names exactly one heading.
 */
export function noteJson(path: string, content: string) {
  return { path, content, frontmatter: {}, tags: [], stat: { ctime: 0, mtime: 0, size: 0 } };
}

/** A markdown-patch 2.0 heading tree: each key a heading, each value its child headings. */
export interface HeadingTree {
  [text: string]: HeadingTree;
}

/**
 * The key markdown-patch 2.0 gives the `n`th repeat (`n ≥ 1`) of a sibling
 * heading: the text, U+FC750, then `n − 1` in hex with each digit spelled as
 * one of U+F6440–U+F644F. Written out from markdown-patch 2.0.0's
 * `projection.js` rather than shared with the service.
 */
export function repeatKey(text: string, n: number): string {
  const digits = [...(n - 1).toString(16)].map((d) =>
    String.fromCodePoint(0xf6440 + Number.parseInt(d, 16)),
  );
  return `${text}${String.fromCodePoint(0xfc750)}${digits.join('')}`;
}

/**
 * A document-map reply in markdown-patch 2.0 format — the read a
 * heading-targeted write makes before its PATCH.
 */
export function documentMapV2(headings: HeadingTree) {
  return { version: 'abc123', frontmatterFields: [], headings, blocks: [] };
}

/**
 * Answer the plugin's `GET /` capability report with `self` as the installed
 * Local REST API version. A section write or document-map read reads it once
 * per service to pick the markdown-patch format: 5.x and later speak 2.0, 4.x
 * the 1.x header protocol. `self: undefined` omits `versions` entirely.
 */
export function servePluginVersion(pool: TestHarness['pool'], self: string | undefined): void {
  pool.intercept({ path: '/', method: 'GET' }).reply(200, {
    status: 'OK',
    service: 'Obsidian Local REST API',
    authenticated: true,
    ...(self === undefined ? {} : { versions: { obsidian: '1.13.7', self } }),
  });
}

/** A PATCH request's markdown-patch 2.0 instruction body, parsed. */
export function instructionOf(opts: DispatchOpts): Record<string, unknown> {
  return JSON.parse(opts.body ?? 'null') as Record<string, unknown>;
}

export type PathMatcher = string | ((path: string) => boolean);

interface InterceptMatcher {
  method?: string;
  path: PathMatcher;
}

export interface DispatchOpts {
  body: string | undefined;
  headers: Record<string, string>;
  method: string;
  path: string;
}

export interface DynamicReply {
  data?: unknown;
  responseOptions?: { headers?: Record<string, string> };
  statusCode: number;
}

export type ReplyFn = (opts: DispatchOpts) => DynamicReply;

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
        headers: normalizeHeaders(init.headers),
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
  /** A record entry set to `undefined` means "no such header" — drop it rather than record it. */
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
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
  if (!finalHeaders.has('content-disposition') && servesAFile(opts, body)) {
    finalHeaders.set('content-disposition', `attachment; filename="${fileNameOf(opts.path)}"`);
  }
  return mockResponse(text, { status, headers: finalHeaders });
}

/**
 * Reproduce the one upstream header contract the service reads rather than
 * just forwards. Local REST API serves a file from `/vault/<path>` with
 * `Content-Disposition: attachment; filename="…"` and a folder from the same
 * route with a bare `application/json` listing, which is how
 * `ObsidianService` tells a note read from a directory read. Fixtures that
 * mean "this path is a folder" reply with a `files` array and get no
 * disposition, matching the upstream; every other `/vault/` reply is a file.
 * An explicit `content-disposition` in the fixture always wins.
 */
function servesAFile(opts: DispatchOpts, body: unknown): boolean {
  if (!opts.path.startsWith('/vault/')) return false;
  if (opts.path.endsWith('/')) return false;
  return !(body !== null && typeof body === 'object' && 'files' in body);
}

/** Left percent-encoded — `Headers` rejects values outside Latin-1, and the service only reads the header's presence. */
function fileNameOf(path: string): string {
  return path.split('?')[0]?.slice('/vault/'.length) ?? path;
}

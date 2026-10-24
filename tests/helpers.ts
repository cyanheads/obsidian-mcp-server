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

import type { AnyToolDefinition, z } from '@cyanheads/mcp-ts-core';
import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import globToRegExp from 'glob-to-regexp';
import jsonLogic from 'json-logic-js';
import { Headers, type HeadersInit, Response } from 'undici';
import { afterEach, beforeEach, expect } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import type { NoteTarget } from '@/services/obsidian/types.js';

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
    deleteElicitation: false,
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

/** The error half of a tool's `structuredContent`, as `runToolContract` builds it. */
export interface ContractError {
  code: number;
  data: Record<string, unknown>;
  message: string;
}

/**
 * Run `definition` through `runToolContract` — the production error pipeline,
 * which fills a declared reason's contract `recovery` as `data.recovery.hint` —
 * and hand back the envelope's error. Fails the test if the call succeeds.
 */
export async function contractErrorOf<T extends AnyToolDefinition>(
  definition: T,
  input: z.input<T['input']>,
): Promise<ContractError> {
  const res = await runToolContract(definition, input);
  expect(res.isError).toBe(true);
  return (res.structuredContent as { error: ContractError }).error;
}

/**
 * Assert that `scan` costs time linear in the length of its input. `build`
 * makes an input of each size, doubling from 5,000 to 320,000 characters (a
 * 64× span); each size is scanned three times and its best thread CPU time
 * must stay under a 1 s budget before the next size is tried, and the cost at
 * 320k must stay under 256× that at 5k — ~64× for a linear scan, ~4,096× for a
 * quadratic one. Thread CPU time rather than wall-clock time, so a worker
 * descheduled under a parallel run cannot fail the budget.
 */
export async function expectLinearCpu(
  build: (size: number) => string,
  scan: (input: string) => unknown,
): Promise<void> {
  const costs: string[] = [];
  let first = 0;
  let last = 0;
  for (let size = 5_000; size <= 320_000; size *= 2) {
    const input = build(size);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = process.threadCpuUsage();
      await scan(input);
      const used = process.threadCpuUsage(start);
      best = Math.min(best, (used.user + used.system) / 1000);
    }
    costs.push(`${size}: ${best.toFixed(2)}ms`);
    expect(best, costs.join(', ')).toBeLessThan(1_000);
    if (size === 5_000) first = best;
    last = best;
  }
  expect(last / first, costs.join(', ')).toBeLessThan(256);
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

const PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;

/** Every `active` / `periodic` target form, each with the label a path-policy denial names it by. */
export const NON_PATH_TARGETS: ReadonlyArray<readonly [NoteTarget, string]> = [
  [{ type: 'active' }, '(active file)'],
  ...PERIODS.flatMap((period) => [
    [{ type: 'periodic', period }, `${period} note for the current period`] as const,
    [{ type: 'periodic', period, date: '2026-10-01' }, `${period} note for 2026-10-01`] as const,
  ]),
];

/** The two notes {@link installMovingTargetVault} holds, and their opening content. */
export const MOVING_TARGET_NOTES = {
  first: 'Work/a.md',
  second: 'Private/b.md',
  body: (path: string) => `---\nstatus: draft\n---\nbody of ${path}\n`,
} as const;

/**
 * A two-note vault whose `active` and `periodic` routes move after their first
 * read: the first request to `/active/` or `/periodic/…` resolves to
 * `Work/a.md`, every later one to `Private/b.md`. Both routes and `/vault/`
 * paths serve `note+json` built from the current content — or, under the
 * document-map `Accept`, a 1.x map whose headings are the note's `#` lines —
 * HEAD answers each note's size, PUT replaces a note's content, `GET /`
 * reports plugin v4.2.0, and every request is recorded as `METHOD /path`.
 * Installs a fresh service with `config` and returns it.
 */
export function installMovingTargetVault(config: Partial<ServerConfig> = {}): {
  notes: Record<string, string>;
  requests: string[];
  service: ObsidianService;
} {
  const { first, second, body } = MOVING_TARGET_NOTES;
  const notes: Record<string, string> = { [first]: body(first), [second]: body(second) };
  const requests: string[] = [];
  let moved = false;

  const fetchImpl: ObsidianFetch = async (url, init) => {
    const route = decodeURIComponent(new URL(url).pathname);
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push(`${method} ${route}`);
    if (route === '/') {
      return mockResponse(
        JSON.stringify({
          status: 'OK',
          service: 'Obsidian Local REST API',
          authenticated: true,
          versions: { obsidian: '1.13.7', self: '4.2.0' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    let path: string | undefined;
    if (route === '/active/' || route.startsWith('/periodic/')) {
      path = moved ? second : first;
      moved = true;
    } else if (route.startsWith('/vault/')) {
      path = route.slice('/vault/'.length);
    }
    const content = path === undefined ? undefined : notes[path];
    if (path === undefined || content === undefined) {
      return mockResponse(JSON.stringify({ message: 'Not Found', errorCode: 40400 }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'PUT') {
      notes[path] = String(init.body);
      return mockResponse('', { status: 200 });
    }
    if (method === 'HEAD') {
      return mockResponse('', {
        status: 200,
        headers: {
          'content-type': 'text/markdown',
          'content-disposition': 'attachment',
          'content-length': String(Buffer.byteLength(content)),
        },
      });
    }
    if (
      new Headers(normalizeHeaders(init.headers)).get('accept') ===
      'application/vnd.olrapi.document-map+json'
    ) {
      const headings = content.split('\n').flatMap((line) => /^#+ (.+)$/.exec(line)?.[1] ?? []);
      return mockResponse(JSON.stringify({ headings, blocks: [], frontmatterFields: ['status'] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-disposition': 'attachment' },
      });
    }
    return mockResponse(
      JSON.stringify({
        path,
        content,
        frontmatter: { status: 'draft' },
        tags: [],
        stat: { ctime: 0, mtime: 0, size: Buffer.byteLength(content) },
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-disposition': 'attachment' },
      },
    );
  };
  const service = new ObsidianService(makeTestConfig(config), fetchImpl);
  setObsidianService(service);
  return { notes, requests, service };
}

/**
 * A note in a {@link jsonLogicVault}. `links` are resolved targets — each must
 * name another note in the vault — and `unresolvedLinks` link text with no
 * note behind it; `backlinks` are derived from every note's `links`.
 */
export interface VaultNote {
  content?: string;
  frontmatter?: Record<string, unknown>;
  links?: string[];
  path: string;
  tags?: string[];
  unresolvedLinks?: string[];
}

/**
 * The plugin's own operator set, registered on this thread's json-logic-js as
 * Local REST API 5.x registers it in `VaultOperations`: pattern first, and
 * `false` for a non-string operand rather than a throw.
 */
jsonLogic.add_operation('glob', (pattern, field) =>
  typeof field === 'string' && typeof pattern === 'string'
    ? globToRegExp(pattern).test(field)
    : false,
);
jsonLogic.add_operation('regexp', (pattern, field) =>
  typeof field === 'string' && typeof pattern === 'string'
    ? new RegExp(pattern).test(field)
    : false,
);

/** The plugin's hit test: `null`/`undefined`, `[]`, and `{}` drop a note. */
function pluginTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * A stub fetch serving JSONLogic `POST /search/` the way Local REST API 5.x
 * does (`searchJsonLogic`, plugin 5.2.0–5.5.2): the received tree is evaluated
 * against every note's context in vault order, out-of-scope notes included,
 * with `content` read only when the tree's JSON contains `"content"`, and a
 * throw on any note fails the whole search with a 400 naming that note. Every
 * request body is recorded in `bodies`; any other route throws.
 */
export function jsonLogicVault(notes: readonly VaultNote[]): {
  bodies: string[];
  fetchImpl: ObsidianFetch;
} {
  const backlinks = new Map<string, string[]>();
  for (const note of notes) {
    for (const target of note.links ?? []) {
      backlinks.set(target, [...(backlinks.get(target) ?? []), note.path]);
    }
  }
  const bodies: string[] = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path !== '/search/' || (init.method ?? 'GET').toUpperCase() !== 'POST') {
      throw new Error(`jsonLogicVault serves only POST /search/, got ${init.method} ${path}`);
    }
    const body = String(init.body);
    bodies.push(body);
    const tree: unknown = JSON.parse(body);
    const includeContent = body.includes('"content"');
    const results: Array<{ filename: string; result: unknown }> = [];
    for (const note of notes) {
      const context = {
        tags: note.tags ?? [],
        frontmatter: note.frontmatter ?? {},
        stat: { ctime: 1, mtime: 2, size: (note.content ?? '').length },
        path: note.path,
        content: includeContent ? (note.content ?? '') : '',
        links: note.links ?? [],
        backlinks: backlinks.get(note.path) ?? [],
        unresolvedLinks: note.unresolvedLinks ?? [],
      };
      let result: unknown;
      try {
        result = jsonLogic.apply(tree, context);
      } catch (e) {
        return mockResponse(
          JSON.stringify({
            errorCode: 40070,
            message: `${(e as Error).message} (while processing ${note.path})`,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (pluginTruthy(result)) results.push({ filename: note.path, result });
    }
    return mockResponse(JSON.stringify(results), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { bodies, fetchImpl };
}

/**
 * A stub fetch whose every JSONLogic search returns one note, `path`, tagged
 * `deep`, whose frontmatter nests `levels` objects deep. The response is
 * written as text, so no serializer in the stub recurses over it; the
 * service's `JSON.parse` does not recurse either.
 */
export function deepNoteFetch(path: string, levels: number): ObsidianFetch {
  const frontmatter = `${'{"a":'.repeat(levels)}"leaf"${'}'.repeat(levels)}`;
  const context = `{"tags":["deep"],"frontmatter":${frontmatter},"stat":{"ctime":1,"mtime":2,"size":0},"path":${JSON.stringify(path)},"content":""}`;
  const body = `[{"filename":${JSON.stringify(path)},"result":${context}}]`;
  return async () =>
    mockResponse(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

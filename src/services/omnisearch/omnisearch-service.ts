/**
 * @fileoverview Omnisearch HTTP API client. Wraps the Obsidian Omnisearch
 * plugin's local HTTP server (`/search?q=…`) and classifies upstream errors
 * for the framework. Plugin docs: https://github.com/scambier/obsidian-omnisearch
 * @module services/omnisearch/omnisearch-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { Agent, type Dispatcher, type RequestInit, fetch as undiciFetch } from 'undici';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

/**
 * Test seam mirroring `ObsidianFetch` in obsidian-service.ts — Bun treats
 * `undici` as a builtin so module-level `vi.mock('undici')` is a no-op; tests
 * inject a stub through the constructor instead.
 */
export type OmnisearchFetch = (
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher; signal?: AbortSignal },
) => Promise<UndiciResponse>;

export interface OmnisearchMatch {
  match: string;
  offset: number;
}

export interface OmnisearchHit {
  basename: string;
  excerpt?: string;
  foundWords: string[];
  matches: OmnisearchMatch[];
  path: string;
  score: number;
  vault: string;
}

export class OmnisearchService {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #dispatcher: Dispatcher;
  readonly #fetch: OmnisearchFetch;

  constructor(config: ServerConfig, fetchImpl?: OmnisearchFetch) {
    this.#baseUrl = config.omnisearchBaseUrl.replace(/\/+$/, '');
    this.#timeoutMs = config.requestTimeoutMs;
    this.#dispatcher = new Agent({
      headersTimeout: this.#timeoutMs,
      bodyTimeout: this.#timeoutMs,
    });
    this.#fetch = fetchImpl ?? (undiciFetch as OmnisearchFetch);
  }

  /** Configured plugin base URL — surfaced to error messages so operators can verify connectivity. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  async search(ctx: Context, query: string): Promise<OmnisearchHit[]> {
    const path = `/search?q=${encodeURIComponent(query)}`;
    const url = `${this.#baseUrl}${path}`;
    try {
      const res = await withRetry(
        async () => {
          const r = await this.#fetch(url, {
            method: 'GET',
            dispatcher: this.#dispatcher,
            signal: ctx.signal,
          });
          if (!r.ok) {
            await this.#throwForStatus(r, path, ctx);
          }
          return r;
        },
        {
          operation: `omnisearch.GET ${path}`,
          context: {
            requestId: ctx.requestId,
            timestamp: ctx.timestamp,
            ...(ctx.tenantId !== undefined ? { tenantId: ctx.tenantId } : {}),
            ...(ctx.traceId !== undefined ? { traceId: ctx.traceId } : {}),
            ...(ctx.spanId !== undefined ? { spanId: ctx.spanId } : {}),
          },
          baseDelayMs: 200,
          maxRetries: 3,
          signal: ctx.signal,
        },
      );
      const body = (await res.json()) as OmnisearchHit[];
      return Array.isArray(body) ? body : [];
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      // Caller cancelled? Bubble. Otherwise re-throw connection / DNS / abort
      // failures as the contract's `omnisearch_unreachable` reason so the
      // recovery hint lands on the wire (httpErrorFromResponse already does
      // this for HTTP-level errors via #throwForStatus).
      if (err && typeof err === 'object' && 'data' in err) throw err;
      const msg =
        err instanceof Error
          ? `Omnisearch unreachable at ${url}: ${err.message}`
          : `Omnisearch unreachable at ${url}.`;
      throw serviceUnavailable(msg, {
        url,
        reason: 'omnisearch_unreachable',
        ...ctx.recoveryFor('omnisearch_unreachable'),
      });
    }
  }

  async #throwForStatus(res: UndiciResponse, path: string, ctx: Context): Promise<never> {
    const text = await this.#readBodySafe(res);
    const truncated = text ? (text.length > 500 ? `${text.slice(0, 500)}…` : text) : undefined;
    throw await httpErrorFromResponse(res, {
      service: 'Obsidian Omnisearch',
      captureBody: false,
      data: {
        url: `${this.#baseUrl}${path}`,
        reason: 'omnisearch_unreachable',
        ...ctx.recoveryFor('omnisearch_unreachable'),
        ...(truncated !== undefined ? { body: truncated } : {}),
      },
    });
  }

  async #readBodySafe(res: UndiciResponse): Promise<string> {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }
}

let _service: OmnisearchService | undefined;

export function initOmnisearchService(
  config: ServerConfig = getServerConfig(),
  fetchImpl?: OmnisearchFetch,
): void {
  _service = new OmnisearchService(config, fetchImpl);
}

/** Test-only: directly install an instance (e.g., one backed by a stub fetch). */
export function setOmnisearchService(service: OmnisearchService | undefined): void {
  _service = service;
}

export function getOmnisearchService(): OmnisearchService {
  if (!_service) {
    throw new Error(
      'OmnisearchService not initialized — set OBSIDIAN_OMNISEARCH_ENABLE=true and call initOmnisearchService() in setup().',
    );
  }
  return _service;
}

/**
 * @fileoverview Issue #121, end to end: a trailing slash on
 * `OBSIDIAN_BASE_URL` must not reach the wire. The config schema is what
 * normalizes it, so these cases drive the real `getServerConfig()` rather than
 * the hand-built test config, and assert on the URL the service actually
 * fetched — the layer the operator's 404s came from.
 *
 * @module tests/services/obsidian-service-base-url.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';
import { type ObsidianFetch, ObsidianService } from '@/services/obsidian/obsidian-service.js';
import { mockResponse } from '../helpers.js';

const ENV_KEYS = ['OBSIDIAN_API_KEY', 'OBSIDIAN_BASE_URL', 'OBSIDIAN_OMNISEARCH_URL'] as const;

beforeEach(() => {
  resetServerConfig();
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfig();
});

/** A service built from the real env-parsed config, recording every URL it fetches. */
function serviceFromEnv(baseUrl: string): { service: ObsidianService; urls: string[] } {
  vi.stubEnv('OBSIDIAN_API_KEY', 'k');
  vi.stubEnv('OBSIDIAN_BASE_URL', baseUrl);
  const urls: string[] = [];
  const fetchImpl: ObsidianFetch = async (url) => {
    urls.push(url);
    return mockResponse(JSON.stringify({ tags: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { service: new ObsidianService(getServerConfig(), fetchImpl), urls };
}

describe('a slash-terminated OBSIDIAN_BASE_URL reaches the wire un-doubled', () => {
  it('requests /tags/ rather than //tags/', async () => {
    const { service, urls } = serviceFromEnv('https://obsidian.test/');

    await service.listTags(createMockContext());

    expect(urls).toEqual(['https://obsidian.test/tags/']);
    expect(new URL(urls[0] ?? '').pathname).toBe('/tags/');
  });

  it('requests a vault path un-doubled', async () => {
    const { service, urls } = serviceFromEnv('https://obsidian.test///');

    await service.listFiles(createMockContext());

    expect(urls).toEqual(['https://obsidian.test/vault/']);
  });

  it('keeps a path prefix intact while dropping its trailing slash', async () => {
    const { service, urls } = serviceFromEnv('https://gateway.test/obsidian/');

    await service.listTags(createMockContext());

    expect(urls).toEqual(['https://gateway.test/obsidian/tags/']);
  });

  it('derives the Omnisearch URL from the normalized host', async () => {
    const { service } = serviceFromEnv('https://obsidian.test/');

    expect(service.omnisearchUrl).toBe('http://obsidian.test:51361');
  });
});

/**
 * @fileoverview Handler tests for the obsidian://status resource.
 * @module tests/resources/obsidian-status.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianStatus } from '@/mcp-server/resources/definitions/obsidian-status.resource.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian://status', () => {
  it('merges anonymous status with an authenticated probe to /vault/', async () => {
    harness
      .current()
      .pool.intercept({ path: '/', method: 'GET' })
      .reply(
        200,
        {
          status: 'OK',
          service: 'Obsidian Local REST API',
          authenticated: false,
          versions: { obsidian: '1.5.0', self: '3.0.0' },
          manifest: { id: 'obsidian-local-rest-api', name: 'Local REST API', version: '3.0.0' },
        },
        { headers: { 'content-type': 'application/json' } },
      );
    harness
      .current()
      .pool.intercept({ path: '/vault/', method: 'GET' })
      .reply(200, { files: [] }, { headers: { 'content-type': 'application/json' } });

    const out = await obsidianStatus.handler(
      obsidianStatus.params!.parse({}),
      createMockContext({ uri: new URL('obsidian://status') }),
    );
    expect(out.status).toBe('OK');
    expect(out.authenticated).toBe(true);
    expect(out.versions?.self).toBe('3.0.0');
  });

  it('reports authenticated=false when the auth probe fails', async () => {
    harness
      .current()
      .pool.intercept({ path: '/', method: 'GET' })
      .reply(
        200,
        {
          status: 'OK',
          service: 'Obsidian Local REST API',
          authenticated: false,
        },
        { headers: { 'content-type': 'application/json' } },
      );
    harness.current().pool.intercept({ path: '/vault/', method: 'GET' }).reply(401, {});

    const out = await obsidianStatus.handler(
      obsidianStatus.params!.parse({}),
      createMockContext({ uri: new URL('obsidian://status') }),
    );
    expect(out.authenticated).toBe(false);
  });
});

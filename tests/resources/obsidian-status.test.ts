/**
 * @fileoverview Handler tests for the obsidian://status resource.
 * @module tests/resources/obsidian-status.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianStatus } from '@/mcp-server/resources/definitions/obsidian-status.resource.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const read = () =>
  obsidianStatus.handler(
    obsidianStatus.params!.parse({}),
    createMockContext({ uri: new URL('obsidian://status') }),
  );

describe('obsidian://status', () => {
  it('reports reachability, versions, and the registered extensions', async () => {
    harness
      .current()
      .pool.intercept({ path: '/', method: 'GET' })
      .reply(
        200,
        {
          status: 'OK',
          service: 'Obsidian Local REST API',
          authenticated: true,
          versions: { obsidian: '1.13.7', self: '5.0.3' },
          manifest: { id: 'obsidian-local-rest-api', name: 'Local REST API', version: '5.0.3' },
          apiExtensions: [
            {
              id: 'local-rest-api-periodic-notes',
              name: 'Periodic Notes',
              version: '1.0.2',
              routes: ['/periodic/:period/*'],
            },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await read();
    expect(out.status).toBe('OK');
    expect(out.authenticated).toBe(true);
    expect(out.versions?.self).toBe('5.0.3');
    expect(out.apiExtensions).toEqual([
      { id: 'local-rest-api-periodic-notes', name: 'Periodic Notes', version: '1.0.2' },
    ]);
    expect(out).toEqual(expect.schemaMatching(obsidianStatus.output!));
  });

  /**
   * The reason the probe is a single authenticated `GET /`: the route answers
   * `200` for an unaccepted key and says so in the body, so the resource still
   * reports reachability instead of failing.
   */
  it('reports authenticated=false without throwing when the key is not accepted', async () => {
    harness
      .current()
      .pool.intercept({ path: '/', method: 'GET' })
      .reply(
        200,
        {
          status: 'OK',
          service: 'Obsidian Local REST API',
          authenticated: false,
          versions: { obsidian: '1.13.7', self: '5.0.3' },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await read();
    expect(out.authenticated).toBe(false);
    expect(out.status).toBe('OK');
    expect(out.apiExtensions).toBeUndefined();
  });

  it('reports an empty apiExtensions array as "none registered"', async () => {
    harness
      .current()
      .pool.intercept({ path: '/', method: 'GET' })
      .reply(
        200,
        {
          status: 'OK',
          service: 'Obsidian Local REST API',
          authenticated: true,
          versions: { obsidian: '1.13.7', self: '5.0.3' },
          apiExtensions: [],
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await read();
    expect(out.apiExtensions).toEqual([]);
  });
});

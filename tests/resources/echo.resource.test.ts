/**
 * @fileoverview Tests for the echo resource.
 * @module tests/resources/echo.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { echoResource } from '@/mcp-server/resources/definitions/echo.resource.js';

describe('echoResource', () => {
  it('echoes the message from params', async () => {
    const ctx = createMockContext();
    const params = echoResource.params.parse({ message: 'hello world' });
    const result = await echoResource.handler(params, ctx);
    expect(result).toEqual({ message: 'hello world' });
  });

  it('lists available resources', () => {
    const listing = echoResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'echo://hello',
      name: 'Echo Hello',
    });
  });
});

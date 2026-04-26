/**
 * @fileoverview Tests for the echo tool.
 * @module tests/tools/echo.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { echoTool } from '@/mcp-server/tools/definitions/echo.tool.js';

describe('echoTool', () => {
  it('echoes the message back', async () => {
    const ctx = createMockContext();
    const input = echoTool.input.parse({ message: 'hello world' });
    const result = await echoTool.handler(input, ctx);
    expect(result).toEqual({ message: 'hello world' });
  });

  it('formats output as text content', () => {
    const blocks = echoTool.format!({ message: 'hello world' });
    expect(blocks).toEqual([{ type: 'text', text: 'hello world' }]);
  });
});

/**
 * @fileoverview Handler tests for the obsidian://vault/{+path} resource.
 * @module tests/resources/obsidian-vault-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianVaultNote } from '@/mcp-server/resources/definitions/obsidian-vault-note.resource.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

describe('obsidian://vault/{+path}', () => {
  it('returns the parsed NoteJson for the requested path', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Projects/A.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Projects/A.md',
          content: 'body',
          frontmatter: { title: 'A' },
          tags: ['t'],
          stat: { ctime: 1, mtime: 2, size: 4 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianVaultNote.handler(
      obsidianVaultNote.params!.parse({ path: 'Projects/A.md' }),
      createMockContext({ uri: new URL('obsidian://vault/Projects/A.md') }),
    );
    expect(out.path).toBe('Projects/A.md');
    expect(out.frontmatter).toEqual({ title: 'A' });
    expect(out.tags).toEqual(['t']);
  });

  it('surfaces 404 as NotFound', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Missing.md', method: 'GET' })
      .reply(404, { message: 'gone' });

    await expect(
      obsidianVaultNote.handler(
        obsidianVaultNote.params!.parse({ path: 'Missing.md' }),
        createMockContext({ uri: new URL('obsidian://vault/Missing.md') }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });
});

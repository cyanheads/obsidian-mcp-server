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
      createMockContext({
        errors: obsidianVaultNote.errors,
        uri: new URL('obsidian://vault/Projects/A.md'),
      }),
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
        createMockContext({
          errors: obsidianVaultNote.errors,
          uri: new URL('obsidian://vault/Missing.md'),
        }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  /**
   * The template captures `{+path}` from the percent-encoded URI, so the
   * handler receives `Test%20Note.md` for a note named `Test Note.md`. Each
   * row pins the captured value to the upstream request path it must produce —
   * a double-encoded request (`%2520`) means the capture was not decoded.
   */
  it.each([
    ['a space', 'Folder/Test%20Note.md', '/vault/Folder/Test%20Note.md', 'Folder/Test Note.md'],
    ['non-ASCII', 'Folder/Caf%C3%A9.md', '/vault/Folder/Caf%C3%A9.md', 'Folder/Café.md'],
    [
      'an encoded %',
      'Folder/50%25%20plan.md',
      '/vault/Folder/50%25%20plan.md',
      'Folder/50% plan.md',
    ],
    ['a bare %', 'Folder/50%%20plan.md', '/vault/Folder/50%25%20plan.md', 'Folder/50% plan.md'],
    ['a stray % escape', 'Folder/100%zz.md', '/vault/Folder/100%25zz.md', 'Folder/100%zz.md'],
    ['a nested folder', 'A%20B/C%20D/E.md', '/vault/A%20B/C%20D/E.md', 'A B/C D/E.md'],
  ])('decodes a captured path containing %s', async (_label, captured, requestPath, notePath) => {
    harness
      .current()
      .pool.intercept({ path: requestPath, method: 'GET' })
      .reply(
        200,
        {
          path: notePath,
          content: 'body',
          frontmatter: {},
          tags: [],
          stat: { ctime: 1, mtime: 2, size: 4 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const out = await obsidianVaultNote.handler(
      obsidianVaultNote.params!.parse({ path: captured }),
      createMockContext({
        errors: obsidianVaultNote.errors,
        uri: new URL(`obsidian://vault/${captured}`),
      }),
    );
    expect(out.path).toBe(notePath);
  });

  it('rejects a traversal segment that only appears once decoded', async () => {
    await expect(
      obsidianVaultNote.handler(
        obsidianVaultNote.params!.parse({ path: 'Notes/%2E%2E/Secret.md' }),
        createMockContext({
          errors: obsidianVaultNote.errors,
          uri: new URL('obsidian://vault/Notes/Secret.md'),
        }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
  });

  it('rejects a path that names a folder instead of failing schema validation', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Inbox', method: 'GET' })
      .reply(
        200,
        { files: ['a.md', 'nested/'] },
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      );

    await expect(
      obsidianVaultNote.handler(
        obsidianVaultNote.params!.parse({ path: 'Inbox' }),
        createMockContext({
          uri: new URL('obsidian://vault/Inbox'),
          errors: obsidianVaultNote.errors,
        }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'path_is_directory',
        recovery: { hint: expect.stringContaining('obsidian_list_notes') },
      },
    });
  });
});

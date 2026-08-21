/**
 * @fileoverview Contract conformance for the two path error reasons every
 * path-accepting tool declares. Each cell drives the real handler against a
 * folder-shaped upstream (or a dot-segment path) and asserts the thrown error
 * carries the reason *and* the recovery hint that tool's own `errors[]`
 * advertises — a declared reason nothing can throw, or a hint that has drifted
 * from the contract, fails here rather than shipping as a dead entry.
 * @module tests/tools/path-error-contracts.test
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { obsidianAppendToNote } from '@/mcp-server/tools/definitions/obsidian-append-to-note.tool.js';
import { obsidianDeleteNote } from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import { obsidianGetNote } from '@/mcp-server/tools/definitions/obsidian-get-note.tool.js';
import { obsidianManageFrontmatter } from '@/mcp-server/tools/definitions/obsidian-manage-frontmatter.tool.js';
import { obsidianManageTags } from '@/mcp-server/tools/definitions/obsidian-manage-tags.tool.js';
import { obsidianOpenInUi } from '@/mcp-server/tools/definitions/obsidian-open-in-ui.tool.js';
import { obsidianPatchNote } from '@/mcp-server/tools/definitions/obsidian-patch-note.tool.js';
import { obsidianReplaceInNote } from '@/mcp-server/tools/definitions/obsidian-replace-in-note.tool.js';
import { obsidianWriteNote } from '@/mcp-server/tools/definitions/obsidian-write-note.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse } from '../helpers.js';

/** A folder path and a dot-segment path, substituted into each tool's own input shape. */
const FOLDER = 'Inbox';
const TRAVERSAL = '../outside.md';

/**
 * Reply the way Local REST API answers a note-read URL that names a folder:
 * `200`, a bare `application/json` listing, no `Content-Disposition` — on GET
 * and on the HEAD behind the size probes. Every request is recorded so the
 * traversal cases can assert nothing reached the upstream at all.
 */
function installFolderUpstream(): string[] {
  const requests: string[] = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    const u = new URL(url);
    requests.push(`${(init.method ?? 'GET').toUpperCase()} ${u.pathname}`);
    const body = JSON.stringify({ files: ['a.md', 'b.md', 'nested/'] });
    return mockResponse(init.method === 'HEAD' ? '' : body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      },
    });
  };
  setObsidianService(new ObsidianService(makeTestConfig(), fetchImpl));
  return requests;
}

interface Cell {
  /** Minimal valid input addressing `path` — the shortest route to the path guard. */
  input: (path: string) => Record<string, unknown>;
  /** Type-erased — the matrix spans nine unrelated input/output shapes. */
  tool: AnyToolDefinition;
}

const byPath = (path: string) => ({ target: { type: 'path', path } });

const MATRIX: Cell[] = [
  { tool: obsidianGetNote, input: (p) => ({ format: 'content', ...byPath(p) }) },
  { tool: obsidianWriteNote, input: (p) => ({ ...byPath(p), content: 'x', overwrite: true }) },
  { tool: obsidianAppendToNote, input: (p) => ({ ...byPath(p), content: 'x' }) },
  {
    tool: obsidianPatchNote,
    input: (p) => ({
      ...byPath(p),
      section: { type: 'heading', target: 'Intro' },
      operation: 'append',
      content: 'x',
    }),
  },
  {
    tool: obsidianReplaceInNote,
    input: (p) => ({ ...byPath(p), replacements: [{ search: 'a', replace: 'b' }] }),
  },
  {
    tool: obsidianManageFrontmatter,
    input: (p) => ({ ...byPath(p), operation: 'get', key: 'status' }),
  },
  { tool: obsidianManageTags, input: (p) => ({ ...byPath(p), operation: 'list' }) },
  { tool: obsidianDeleteNote, input: (p) => byPath(p) },
  { tool: obsidianOpenInUi, input: (p) => ({ path: p }) },
];

/** The recovery sentence this tool's contract advertises for `reason`. */
function declaredRecovery(tool: AnyToolDefinition, reason: string): string {
  const entry = tool.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`${tool.name} declares no '${reason}' contract entry`);
  return entry.recovery;
}

afterEach(() => {
  setObsidianService(undefined);
});

describe('path_is_directory reaches every tool that declares it', () => {
  it.each(MATRIX.map((c) => [c.tool.name, c] as const))('%s', async (_name, cell) => {
    installFolderUpstream();

    await expect(
      cell.tool.handler(
        cell.tool.input.parse(cell.input(FOLDER)),
        createMockContext({ errors: cell.tool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'path_is_directory',
        path: FOLDER,
        recovery: { hint: declaredRecovery(cell.tool, 'path_is_directory') },
      },
    });
  });
});

describe('path_traversal reaches every tool that declares it', () => {
  it.each(MATRIX.map((c) => [c.tool.name, c] as const))('%s', async (_name, cell) => {
    const requests = installFolderUpstream();

    await expect(
      cell.tool.handler(
        cell.tool.input.parse(cell.input(TRAVERSAL)),
        createMockContext({ errors: cell.tool.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'path_traversal',
        recovery: { hint: declaredRecovery(cell.tool, 'path_traversal') },
      },
    });
    expect(requests).toEqual([]);
  });
});

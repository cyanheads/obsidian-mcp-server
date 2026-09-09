/**
 * @fileoverview Contract conformance for `periodic_unsupported` across every
 * tool that accepts a `periodic` target. Local REST API v5.0.2 removed the
 * built-in `/periodic/` routes, so on a current plugin without the companion
 * extension the route-miss 404 is indistinguishable from "no note for that
 * period" — each cell drives the real handler against that upstream and
 * asserts the thrown error carries the reason *and* the recovery hint the
 * tool's own `errors[]` advertises.
 * @module tests/tools/periodic-error-contracts.test
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { obsidianAppendToNote } from '@/mcp-server/tools/definitions/obsidian-append-to-note.tool.js';
import { obsidianDeleteNote } from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import { obsidianGetNote } from '@/mcp-server/tools/definitions/obsidian-get-note.tool.js';
import { obsidianManageFrontmatter } from '@/mcp-server/tools/definitions/obsidian-manage-frontmatter.tool.js';
import { obsidianManageTags } from '@/mcp-server/tools/definitions/obsidian-manage-tags.tool.js';
import { obsidianPatchNote } from '@/mcp-server/tools/definitions/obsidian-patch-note.tool.js';
import { obsidianReplaceInNote } from '@/mcp-server/tools/definitions/obsidian-replace-in-note.tool.js';
import { obsidianWriteNote } from '@/mcp-server/tools/definitions/obsidian-write-note.tool.js';
import {
  type ObsidianFetch,
  ObsidianService,
  setObsidianService,
} from '@/services/obsidian/obsidian-service.js';
import { makeTestConfig, mockResponse } from '../helpers.js';

const PERIODIC_EXTENSION_ID = 'local-rest-api-periodic-notes';

/**
 * A plugin build past the route removal. `extension` decides which of the two
 * 404 readings is correct: registered means the routes are served and the note
 * genuinely is not there; absent means the route never existed.
 */
function installUpstream(opts: { extension: boolean }): void {
  const fetchImpl: ObsidianFetch = async (url) => {
    if (new URL(url).pathname === '/') {
      return mockResponse(
        JSON.stringify({
          status: 'OK',
          service: 'Obsidian Local REST API',
          authenticated: true,
          versions: { obsidian: '1.13.7', self: '5.0.3' },
          apiExtensions: opts.extension ? [{ id: PERIODIC_EXTENSION_ID }] : [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return mockResponse(JSON.stringify({ message: 'Not Found', errorCode: 40400 }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  setObsidianService(new ObsidianService(makeTestConfig(), fetchImpl));
}

const daily = { target: { type: 'periodic', period: 'daily' } } as const;

interface Cell {
  /** Minimal valid input carrying a periodic target — the shortest route upstream. */
  input: Record<string, unknown>;
  /** Type-erased — the matrix spans eight unrelated input/output shapes. */
  tool: AnyToolDefinition;
}

const MATRIX: Cell[] = [
  { tool: obsidianGetNote, input: { format: 'content', ...daily } },
  { tool: obsidianWriteNote, input: { ...daily, content: 'x', overwrite: true } },
  { tool: obsidianAppendToNote, input: { ...daily, content: 'x' } },
  {
    tool: obsidianPatchNote,
    input: {
      ...daily,
      section: { type: 'heading', target: 'Intro' },
      operation: 'append',
      content: 'x',
    },
  },
  {
    tool: obsidianReplaceInNote,
    input: { ...daily, replacements: [{ search: 'a', replace: 'b' }] },
  },
  { tool: obsidianManageFrontmatter, input: { ...daily, operation: 'get', key: 'status' } },
  { tool: obsidianManageTags, input: { ...daily, operation: 'list' } },
  { tool: obsidianDeleteNote, input: daily },
];

/** The recovery sentence this tool's contract advertises for `reason`. */
function declaredRecovery(tool: AnyToolDefinition, reason: string): string {
  const entry = tool.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`${tool.name} declares no '${reason}' contract entry`);
  return entry.recovery;
}

const run = (cell: Cell) =>
  cell.tool.handler(
    cell.tool.input.parse(cell.input),
    createMockContext({ errors: cell.tool.errors }),
  );

afterEach(() => {
  setObsidianService(undefined);
});

describe('periodic_unsupported reaches every tool that declares it', () => {
  it.each(MATRIX.map((c) => [c.tool.name, c] as const))('%s', async (_name, cell) => {
    installUpstream({ extension: false });

    await expect(run(cell)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'periodic_unsupported',
        recovery: { hint: declaredRecovery(cell.tool, 'periodic_unsupported') },
      },
    });
  });
});

describe('periodic_not_found survives on an install that serves the routes', () => {
  it.each(MATRIX.map((c) => [c.tool.name, c] as const))('%s', async (_name, cell) => {
    installUpstream({ extension: true });

    await expect(run(cell)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'periodic_not_found',
        recovery: { hint: declaredRecovery(cell.tool, 'periodic_not_found') },
      },
    });
  });
});

describe('periodic_unsupported on the wire', () => {
  it('carries the reason and the extension URL to both surfaces', async () => {
    installUpstream({ extension: false });

    const res = await runToolContract(obsidianGetNote, { format: 'content', ...daily });

    expect(res.isError).toBe(true);
    const error = (res.structuredContent as { error: { code: number; data: { reason: string } } })
      .error;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('periodic_unsupported');

    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('/periodic/ routes');
    expect(text).toContain(
      'https://github.com/coddingtonbear/obsidian-local-rest-api-periodic-notes',
    );
  });

  /**
   * The three periodic reasons have to be readable as mutually exclusive from
   * the contract alone — an agent picks its next move from `when`/`recovery`,
   * not from the service source.
   */
  it.each(MATRIX.map((c) => [c.tool.name, c.tool] as const))(
    '%s distinguishes all three periodic reasons',
    (_name, tool) => {
      const unsupported = tool.errors?.find((e) => e.reason === 'periodic_unsupported');
      const notFound = tool.errors?.find((e) => e.reason === 'periodic_not_found');
      const disabled = tool.errors?.find((e) => e.reason === 'periodic_disabled');

      expect(unsupported?.when).toMatch(/v5\.0\.2/);
      expect(unsupported?.recovery).toContain(
        'https://github.com/coddingtonbear/obsidian-local-rest-api-periodic-notes',
      );
      expect(notFound?.when).toMatch(/no note exists/i);
      expect(disabled?.when).toMatch(/not enabled/i);
      expect(new Set([unsupported?.when, notFound?.when, disabled?.when]).size).toBe(3);
    },
  );
});

/**
 * @fileoverview Contract conformance for the path error reasons every
 * path-accepting tool declares. Each cell drives the real handler through
 * `runToolContract` against a folder-shaped upstream (or a dot-segment path)
 * and asserts the error envelope carries the reason *and* the recovery hint
 * that tool's own `errors[]` advertises — a declared reason nothing can throw, or a hint that has drifted
 * from the contract, fails here rather than shipping as a dead entry. The
 * `path_forbidden` cells check what a denial on an `active` or `periodic`
 * target names on both surfaces, and that a `denied_path` denial names no
 * deny prefix.
 * @module tests/tools/path-error-contracts.test
 */

import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { obsidianVaultNote } from '@/mcp-server/resources/definitions/obsidian-vault-note.resource.js';
import { obsidianAppendToNote } from '@/mcp-server/tools/definitions/obsidian-append-to-note.tool.js';
import { obsidianDeleteNote } from '@/mcp-server/tools/definitions/obsidian-delete-note.tool.js';
import { obsidianGetNote } from '@/mcp-server/tools/definitions/obsidian-get-note.tool.js';
import { obsidianListNotes } from '@/mcp-server/tools/definitions/obsidian-list-notes.tool.js';
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
import { contractErrorOf, makeTestConfig, mockResponse } from '../helpers.js';

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

    expect(await contractErrorOf(cell.tool, cell.input(FOLDER))).toMatchObject({
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

    expect(await contractErrorOf(cell.tool, cell.input(TRAVERSAL))).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'path_traversal',
        recovery: { hint: declaredRecovery(cell.tool, 'path_traversal') },
      },
    });
    expect(requests).toEqual([]);
  });
});

/** The note every `active` / `periodic` target resolves to in the cells below. */
const NOTE_BODY = '---\nstatus: draft\n---\nbody\n';

/**
 * Answer every route as a vault whose active and periodic notes are
 * `notePath`: `note+json` reads return it, HEADs size it, the capability
 * report names a 5.x plugin, and writes succeed. Each request is recorded as
 * `METHOD /path`.
 */
function installTargetUpstream(config: Partial<ServerConfig>, notePath: string): string[] {
  const requests: string[] = [];
  const fetchImpl: ObsidianFetch = async (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname);
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push(`${method} ${path}`);
    const json = (body: unknown) =>
      mockResponse(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/') {
      return json({ status: 'OK', service: 'x', versions: { obsidian: '1', self: '5.0.3' } });
    }
    if (method === 'HEAD') {
      return mockResponse('', {
        status: 200,
        headers: {
          'content-type': 'text/markdown',
          'content-disposition': 'attachment',
          'content-length': String(NOTE_BODY.length),
        },
      });
    }
    if (method !== 'GET') return mockResponse('', { status: 200 });
    return json({
      path: notePath,
      content: NOTE_BODY,
      frontmatter: { status: 'draft' },
      tags: [],
      stat: { ctime: 0, mtime: 0, size: NOTE_BODY.length },
    });
  };
  setObsidianService(new ObsidianService(makeTestConfig(config), fetchImpl));
  return requests;
}

/** A tool code path that takes a target: its name, the tool, and its input minus `target`. */
type TargetCell = [name: string, tool: AnyToolDefinition, input: Record<string, unknown>];

/** One input per write-tool code path, each one that changes the target note. */
const WRITE_CELLS: TargetCell[] = [
  ['write_note', obsidianWriteNote, { content: 'x', overwrite: true }],
  ['append_to_note', obsidianAppendToNote, { content: 'x' }],
  [
    'patch_note',
    obsidianPatchNote,
    { section: { type: 'heading', target: 'Intro' }, operation: 'append', content: 'x' },
  ],
  [
    'replace_in_note',
    obsidianReplaceInNote,
    { replacements: [{ search: 'body', replace: 'text' }] },
  ],
  [
    'manage_frontmatter set',
    obsidianManageFrontmatter,
    { operation: 'set', key: 'status', value: 'done' },
  ],
  ['manage_frontmatter delete', obsidianManageFrontmatter, { operation: 'delete', key: 'status' }],
  ['manage_tags add', obsidianManageTags, { operation: 'add', tags: ['new'] }],
  ['delete_note', obsidianDeleteNote, {}],
];

/** One input per tool code path that takes a target. */
const READ_CELLS: TargetCell[] = [
  ['get_note content', obsidianGetNote, { format: 'content' }],
  ['get_note full', obsidianGetNote, { format: 'full' }],
  ['get_note document-map', obsidianGetNote, { format: 'document-map' }],
  [
    'get_note section',
    obsidianGetNote,
    { format: 'section', section: { type: 'heading', target: 'Intro' } },
  ],
  ...WRITE_CELLS,
  ['manage_frontmatter get', obsidianManageFrontmatter, { operation: 'get', key: 'k' }],
  ['manage_tags list', obsidianManageTags, { operation: 'list' }],
];

/** Each resolving target, undated and dated, with the label its denial carries. */
const TARGETS: Array<[target: Record<string, unknown>, label: string]> = [
  [{ type: 'active' }, '(active file)'],
  [{ type: 'periodic', period: 'daily' }, 'daily note for the current period'],
  [{ type: 'periodic', period: 'weekly', date: '2026-10-01' }, 'weekly note for 2026-10-01'],
];

/** Every cell on every target, as `[name, tool, input, label]` rows. */
function onEveryTarget(
  cells: TargetCell[],
): Array<[string, AnyToolDefinition, Record<string, unknown>, string]> {
  return TARGETS.flatMap(([target, label]) =>
    cells.map(
      ([name, tool, input]): [string, AnyToolDefinition, Record<string, unknown>, string] => [
        `${name} on ${label}`,
        tool,
        { ...input, target },
        label,
      ],
    ),
  );
}

/** The denial's error and its `content[]` text, from one `runToolContract` call. */
async function denialOf(tool: AnyToolDefinition, input: Record<string, unknown>) {
  const res = await runToolContract(tool, input);
  expect(res.isError).toBe(true);
  const { error } = res.structuredContent as {
    error: { code: number; data: Record<string, unknown>; message: string };
  };
  const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
  return { error, text };
}

/**
 * A denial names the target's label, never the path it resolved to, on both
 * surfaces, and nothing but `methods` reached the upstream.
 */
async function expectTargetDenial(
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  expected: {
    data: Record<string, unknown>;
    hidden: string;
    message: string;
    methods: string[];
    requests: string[];
  },
): Promise<void> {
  const { error, text } = await denialOf(tool, input);
  expect(error).toMatchObject({
    code: JsonRpcErrorCode.Forbidden,
    message: expected.message,
    data: { reason: 'path_forbidden', activeScope: ['work'], ...expected.data },
  });
  expect(text).toContain(expected.message);
  expect(JSON.stringify(error)).not.toContain(expected.hidden);
  expect(text).not.toContain(expected.hidden);
  expect(expected.requests.filter((r) => !expected.methods.includes(r.split(' ')[0]!))).toEqual([]);
}

describe('path_forbidden on a target outside OBSIDIAN_READ_PATHS names the target', () => {
  it.each(onEveryTarget(READ_CELLS))('%s', async (_name, tool, input, label) => {
    const requests = installTargetUpstream({ readPaths: ['work'] }, 'Private/secret.md');
    await expectTargetDenial(tool, input, {
      message: `Target '${label}' resolves to a note that is not readable: outside OBSIDIAN_READ_PATHS.`,
      data: { path: label, op: 'read', subreason: 'outside_read_paths' },
      hidden: 'secret',
      methods: ['GET'],
      requests,
    });
  });
});

describe('path_forbidden on a readable target outside OBSIDIAN_WRITE_PATHS names the target', () => {
  it.each(onEveryTarget(WRITE_CELLS))('%s', async (_name, tool, input, label) => {
    const requests = installTargetUpstream({ writePaths: ['work'] }, 'Notes/a.md');
    await expectTargetDenial(tool, input, {
      message: `Target '${label}' resolves to a note that is not writable: outside OBSIDIAN_WRITE_PATHS.`,
      data: { path: label, op: 'write', subreason: 'outside_write_paths' },
      hidden: 'Notes/a.md',
      methods: ['GET', 'HEAD'],
      requests,
    });
  });
});

/**
 * `OBSIDIAN_DENY_PATHS=private,journal`: a denial names the variable and the
 * subreason on both surfaces, carries no scope, and names neither deny prefix
 * — the strings below are the prefixes as the parser stores them.
 */
const DENY_PATHS = ['private', 'journal'];

function expectWithheldEnvelope(
  error: { data: Record<string, unknown>; message: string },
  text: string,
) {
  expect(error.data).toMatchObject({ reason: 'path_forbidden', subreason: 'denied_path' });
  expect(error.data).not.toHaveProperty('activeScope');
  expect(error.message).toMatch(/: withheld by OBSIDIAN_DENY_PATHS \(subreason denied_path\)\.$/);
  expect(text).toContain(error.message);
  expect(text).toContain('denied_path');
  for (const prefix of DENY_PATHS) {
    expect(JSON.stringify(error)).not.toContain(prefix);
    expect(text).not.toContain(prefix);
  }
}

describe('every path_forbidden contract names the deny list among its causes', () => {
  it.each([
    ...MATRIX.map((c) => [c.tool.name, c.tool.errors] as const),
    [obsidianListNotes.name, obsidianListNotes.errors] as const,
    ['obsidian://vault/{+path}', obsidianVaultNote.errors] as const,
  ])('%s', (_name, errors) => {
    const entry = errors?.find((e) => e.reason === 'path_forbidden');
    expect(entry?.when).toContain('inside OBSIDIAN_DENY_PATHS');
  });
});

describe('path_forbidden with denied_path reaches every path-taking tool', () => {
  it.each(MATRIX.map((c) => [c.tool.name, c] as const))('%s', async (_name, cell) => {
    const requests: string[] = [];
    const fetchImpl: ObsidianFetch = async (url, init) => {
      requests.push(`${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`);
      return mockResponse('', { status: 200 });
    };
    setObsidianService(new ObsidianService(makeTestConfig({ denyPaths: DENY_PATHS }), fetchImpl));
    const { error, text } = await denialOf(cell.tool, cell.input('Private/Plan.md'));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { path: 'Private/Plan.md' },
    });
    expectWithheldEnvelope(error, text);
    expect(requests).toEqual([]);
  });
});

describe('path_forbidden on a target resolving into OBSIDIAN_DENY_PATHS names the target', () => {
  it.each(onEveryTarget(READ_CELLS))('%s', async (_name, tool, input, label) => {
    const requests = installTargetUpstream({ denyPaths: DENY_PATHS }, 'Private/secret.md');
    const { error, text } = await denialOf(tool, input);
    expect(error).toMatchObject({ code: JsonRpcErrorCode.Forbidden, data: { path: label } });
    const withheld = (op: string) =>
      `Target '${label}' resolves to a note that is not ${op}: withheld by OBSIDIAN_DENY_PATHS (subreason denied_path).`;
    expect([withheld('readable'), withheld('writable')]).toContain(error.message);
    expectWithheldEnvelope(error, text);
    for (const hidden of ['secret', 'Private']) {
      expect(JSON.stringify(error)).not.toContain(hidden);
      expect(text).not.toContain(hidden);
    }
    expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);
  });
});

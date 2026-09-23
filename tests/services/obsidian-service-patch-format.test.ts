/**
 * @fileoverview Markdown-patch format negotiation in ObsidianService. The
 * plugin's `GET /` version picks the wire format once per service: Local REST
 * API 5.x and later get markdown-patch 2.0 (a JSON instruction body, array
 * heading targets, the nested document map), 4.x keeps the 1.x header
 * protocol. Fixtures are the shapes plugin 5.2.0 and markdown-patch 2.0.0
 * send, recorded live.
 * @module tests/services/obsidian-service-patch-format.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ObsidianService } from '@/services/obsidian/obsidian-service.js';
import type { PatchInstruction } from '@/services/obsidian/types.js';
import {
  type DispatchOpts,
  documentMapV2,
  instructionOf,
  makeTestConfig,
  mockResponse,
  noteJson,
  rejectionOf,
  repeatKey,
  sequencedFetch,
  servePluginVersion,
  setupHarness,
  type TestHarness,
} from '../helpers.js';

const harness = setupHarness();
let pool: TestHarness['pool'];
let service: ObsidianService;
let ctx: Context;

beforeEach(() => {
  pool = harness.current().pool;
  service = harness.current().service;
  ctx = createMockContext();
});

const NOTE = { type: 'path', path: 'N.md' } as const;
const INSTRUCTION_CT = 'application/vnd.olrapi.patch-instruction+json';
const MAP_ACCEPT = 'application/vnd.olrapi.document-map+json';

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** Record every PATCH to `N.md` and answer 200. */
function capturePatches(): DispatchOpts[] {
  const seen: DispatchOpts[] = [];
  const reply = (opts: DispatchOpts) => {
    seen.push(opts);
    return { statusCode: 200, data: '' };
  };
  for (let i = 0; i < 4; i++) pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply(reply);
  return seen;
}

/** Answer the 2.0 document-map read a heading write makes, asserting its format pin. */
function serveMapV2(headings: Parameters<typeof documentMapV2>[0]): void {
  pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply((opts) => {
    const h = lower(opts.headers);
    expect(h.accept).toBe(MAP_ACCEPT);
    expect(h['markdown-patch-version']).toBe('2');
    return { statusCode: 200, data: documentMapV2(headings) };
  });
}

/** Answer a note read (the note+json the service fetches for heading levels). */
function serveNote(content: string): void {
  pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply((opts) => {
    expect(lower(opts.headers).accept).toBe('application/vnd.olrapi.note+json');
    return { statusCode: 200, data: noteJson('N.md', content) };
  });
}

const heading = (target: string, extra: Partial<PatchInstruction> = {}): PatchInstruction => ({
  operation: 'append',
  targetType: 'heading',
  target,
  contentType: 'markdown',
  ...extra,
});

describe('markdown-patch 2.0 on Local REST API 5.x', () => {
  it('sends a heading write as a JSON instruction with an array target', async () => {
    servePluginVersion(pool, '5.2.0');
    serveMapV2({ Top: { Child: {} } });
    const patches = capturePatches();

    await expect(service.patchNote(ctx, NOTE, 'Hello', heading('Top::Child'))).resolves.toBe(
      'Top::Child',
    );

    expect(patches).toHaveLength(1);
    const [patch] = patches;
    const h = lower(patch?.headers ?? {});
    expect(h['content-type']).toBe(INSTRUCTION_CT);
    expect(h['markdown-patch-version']).toBe('2');
    for (const legacy of ['operation', 'target-type', 'target', 'target-delimiter']) {
      expect(h[legacy]).toBeUndefined();
    }
    expect(instructionOf(patch as DispatchOpts)).toEqual({
      targetType: 'heading',
      target: ['Top', 'Child'],
      operation: 'append',
      content: 'Hello',
      rejectIfContentPreexists: true,
    });
  });

  it('expands a bare leaf, then targets the resolved path as an array', async () => {
    servePluginVersion(pool, '5.2.0');
    serveMapV2({ Top: { Child: {} }, '': { Untitled: {} } });
    const patches = capturePatches();

    await expect(service.patchNote(ctx, NOTE, 'x', heading('Untitled'))).resolves.toBe(
      '::Untitled',
    );
    expect(instructionOf(patches[0] as DispatchOpts).target).toEqual(['', 'Untitled']);
  });

  it('carries the option flags a 2.0 instruction has, and drops Trim-Target-Whitespace', async () => {
    servePluginVersion(pool, '5.2.0');
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, 'pre ', {
      operation: 'prepend',
      targetType: 'block',
      target: 'abc123',
      contentType: 'markdown',
      createTargetIfMissing: true,
      applyIfContentPreexists: true,
      trimTargetWhitespace: true,
    });

    expect(instructionOf(patches[0] as DispatchOpts)).toEqual({
      targetType: 'block',
      target: 'abc123',
      operation: 'prepend',
      content: 'pre ',
      createTargetIfMissing: true,
    });
  });

  it.each([
    ['a JSON string', 'json', '"Bye"', 'Bye'],
    ['a JSON list', 'json', '["a","b"]', ['a', 'b']],
    ['a JSON object', 'json', '{"x":1,"y":[true,null]}', { x: 1, y: [true, null] }],
    ['markdown text', 'markdown', 'plain', 'plain'],
  ] as const)(
    'sends a frontmatter write of %s as the structured `value`',
    async (_l, contentType, content, value) => {
      servePluginVersion(pool, '5.2.0');
      const patches = capturePatches();

      await service.patchNote(ctx, NOTE, content, {
        operation: 'replace',
        targetType: 'frontmatter',
        target: 'title',
        contentType,
        createTargetIfMissing: true,
      });

      expect(instructionOf(patches[0] as DispatchOpts)).toEqual({
        targetType: 'frontmatter',
        target: 'title',
        operation: 'replace',
        value,
        createTargetIfMissing: true,
        rejectIfContentPreexists: true,
      });
    },
  );

  it.each([
    ['one row', '["c","d"]', [['c', 'd']]],
    [
      'several rows',
      '[["c","d"],["e","f"]]',
      [
        ['c', 'd'],
        ['e', 'f'],
      ],
    ],
  ])('sends table rows (%s) as a 2-D `value`', async (_l, content, value) => {
    servePluginVersion(pool, '5.2.0');
    serveNote('| a | b |\n| - | - |\n| c | d | ^tbl\n');
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, content, {
      operation: 'append',
      targetType: 'block',
      target: 'tbl',
      contentType: 'json',
    });

    expect(instructionOf(patches[0] as DispatchOpts).value).toEqual(value);
  });

  it('rejects `json` content that does not parse, before any PATCH', async () => {
    servePluginVersion(pool, '5.2.0');

    const err = await rejectionOf(
      service.patchNote(ctx, NOTE, 'draft', {
        operation: 'replace',
        targetType: 'frontmatter',
        target: 'status',
        contentType: 'json',
      }),
    );
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.message).toContain('not valid JSON');
  });

  /**
   * markdown-patch 2.0 reads `#` levels in heading content as relative to the
   * section they land in; 1.x writes them as given. The service rewrites them
   * so the note gets the levels the caller wrote.
   */
  describe('heading levels inside heading content', () => {
    it('rewrites absolute levels to the section-relative ones 2.0 reads', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: { Child: {} } });
      serveNote('# Top\nintro\n\n## Child\n- a\n');
      const patches = capturePatches();

      await service.patchNote(
        ctx,
        NOTE,
        '### Sub\ntext\n\n#### Deeper ##\n',
        heading('Top::Child'),
      );

      expect(instructionOf(patches[0] as DispatchOpts).content).toBe(
        '# Sub\ntext\n\n## Deeper ##\n',
      );
    });

    it('reads the section level from the note, not from the path depth', async () => {
      // # A / ### C — `A::C` is one level down the path but level 3 in the note.
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ A: { C: {} } });
      serveNote('---\ntitle: x\n---\n# A\n### C\nbody\n');
      const patches = capturePatches();

      await service.patchNote(ctx, NOTE, '#### D\nx\n', heading('A::C'));

      expect(instructionOf(patches[0] as DispatchOpts).content).toBe('# D\nx\n');
    });

    it('bases a created section on its deepest existing ancestor plus the missing levels', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: {} });
      serveNote('# Top\nbody\n');
      const patches = capturePatches();

      await service.patchNote(
        ctx,
        NOTE,
        '#### Deeper\nx\n',
        heading('Top::New::Newer', { createTargetIfMissing: true }),
      );

      // `# Top` is level 1, so `New` is created at 2 and `Newer` at 3.
      expect(instructionOf(patches[0] as DispatchOpts).content).toBe('# Deeper\nx\n');
    });

    it('bases a created top-level section on level 1', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: {} });
      serveNote('# Top\nbody\n');
      const patches = capturePatches();

      await service.patchNote(
        ctx,
        NOTE,
        '## Sub\nx\n',
        heading('Fresh', { createTargetIfMissing: true }),
      );

      expect(instructionOf(patches[0] as DispatchOpts).content).toBe('# Sub\nx\n');
    });

    it('rejects content carrying a heading at or above the section level, before any PATCH', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: { Child: {} } });
      serveNote('# Top\n## Child\nbody\n');
      // No PATCH intercept: a write would surface "No mock intercept".

      const err = await rejectionOf(
        service.patchNote(ctx, NOTE, 'text\n\n## Peer\nmore\n', heading('Top::Child')),
      );
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.message).toContain("'## Peer'");
      expect(err.message).toContain('Top::Child');
      expect(err.data).toMatchObject({
        path: 'N.md',
        recovery: { hint: expect.stringContaining('Top') },
      });
    });

    it('leaves a section the write would not create to the plugin, which reports it missing', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: { Child: {} } });
      serveNote('# Top\n## Child\nbody\n');
      let sent = '';
      pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply((opts) => {
        sent = String(instructionOf(opts).content);
        return {
          statusCode: 404,
          data: { message: 'could not resolve heading target ["Top","Nope"]', errorCode: 40400 },
        };
      });

      await expect(
        service.patchNote(ctx, NOTE, '## Peer\nmore\n', heading('Top::Nope')),
      ).rejects.toMatchObject({ data: { reason: 'section_target_missing' } });
      expect(sent).toBe('## Peer\nmore\n');
    });

    it.each([
      ['plain text', 'just text\n'],
      ['a `#` line inside a fence', '```\n## not a heading\n```\n'],
      ['a setext heading, which 2.0 does not re-level', 'Sub\n---\ntext\n'],
      ['a hashtag', '#tag and more\n'],
    ])('sends %s as written, without reading the note', async (_l, content) => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: { Child: {} } });
      // No note read intercepted: one would surface "No mock intercept".
      const patches = capturePatches();

      await service.patchNote(ctx, NOTE, content, heading('Top::Child'));

      expect(instructionOf(patches[0] as DispatchOpts).content).toBe(content);
    });

    it('leaves block content alone — 2.0 splices it literally', async () => {
      servePluginVersion(pool, '5.2.0');
      const patches = capturePatches();

      await service.patchNote(ctx, NOTE, '\n## Heading\n', {
        operation: 'append',
        targetType: 'block',
        target: 'p1',
        contentType: 'markdown',
      });

      expect(instructionOf(patches[0] as DispatchOpts).content).toBe('\n## Heading\n');
    });
  });

  describe('the #137 repeat check reads the same 2.0 map', () => {
    it('rejects a repeated path without sending a PATCH', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Root: { Dup: {}, [repeatKey('Dup', 1)]: {} } });

      await expect(service.patchNote(ctx, NOTE, 'x', heading('Root::Dup'))).rejects.toMatchObject({
        code: JsonRpcErrorCode.Conflict,
        data: { reason: 'ambiguous_section', candidates: ['Root::Dup', 'Root::Dup'] },
      });
    });
  });

  describe('2.0 failure responses', () => {
    it('classifies a 404 naming an unresolved target as section_target_missing', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: {} });
      pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply(404, {
        message: 'Not Found\ncould not resolve heading target ["Top","Nope"]',
        errorCode: 40400,
      });

      await expect(service.patchNote(ctx, NOTE, 'x', heading('Top::Nope'))).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('Section target not found in N.md'),
        data: { reason: 'section_target_missing' },
      });
    });

    it('keeps a bare 404 on the PATCH as note_missing', async () => {
      servePluginVersion(pool, '5.2.0');
      pool
        .intercept({ path: '/vault/N.md', method: 'PATCH' })
        .reply(404, { message: 'Not Found', errorCode: 40400 });

      await expect(
        service.patchNote(ctx, NOTE, 'x', {
          operation: 'append',
          targetType: 'block',
          target: 'p1',
          contentType: 'markdown',
        }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'note_missing' },
      });
    });

    it('classifies the 409 for preexisting content as content_preexists', async () => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ Top: {} });
      serveNote('# Top\nSee - a.\n');
      pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply(409, {
        message: 'Conflict\nthe target already contains the content to append',
        errorCode: 40900,
      });

      await expect(service.patchNote(ctx, NOTE, '- a', heading('Top'))).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('already appears at the target'),
        data: { reason: 'content_preexists' },
      });
    });
  });

  describe('document map', () => {
    it('reads the 2.0 map and flattens it to the `::`-joined list the 1.x map carried', async () => {
      servePluginVersion(pool, '5.2.0');
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply((opts) => {
        const h = lower(opts.headers);
        expect(h.accept).toBe(MAP_ACCEPT);
        expect(h['markdown-patch-version']).toBe('2');
        return {
          statusCode: 200,
          data: {
            version: '9eb810',
            frontmatterFields: ['title', 'tags'],
            headings: {
              Top: { Child: { Deep: {} }, Sibling: {}, [repeatKey('Child', 1)]: {} },
              '': { Untitled: {} },
              Other: {},
            },
            blocks: ['blk1', 'blk2', repeatKey('blk1', 1)],
          },
        };
      });

      await expect(service.getDocumentMap(ctx, NOTE)).resolves.toEqual({
        headings: ['Top', 'Top::Child', 'Top::Child::Deep', 'Top::Sibling', '::Untitled', 'Other'],
        blocks: ['blk1', 'blk2'],
        frontmatterFields: ['title', 'tags'],
      });
    });

    it('orders integer-like block ids and fields first, as the 1.x map did, and headings as the note', async () => {
      servePluginVersion(pool, '5.2.0');
      pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(200, {
        version: 'aaaaaa',
        frontmatterFields: ['title', '2024'],
        headings: { Intro: {}, '2024': {} },
        blocks: ['abc', '123456'],
      });
      serveNote('# Intro\n# 2024\n');

      await expect(service.getDocumentMap(ctx, NOTE)).resolves.toEqual({
        headings: ['Intro', '2024'],
        blocks: ['123456', 'abc'],
        frontmatterFields: ['2024', 'title'],
      });
    });

    it('returns empty lists for a note with no headings, blocks, or frontmatter', async () => {
      servePluginVersion(pool, '5.2.0');
      pool
        .intercept({ path: '/vault/N.md', method: 'GET' })
        .reply(200, { version: 'e3b0c4', frontmatterFields: [], headings: {}, blocks: [] });

      await expect(service.getDocumentMap(ctx, NOTE)).resolves.toEqual({
        headings: [],
        blocks: [],
        frontmatterFields: [],
      });
    });
  });

  it('sends no request carrying Markdown-Patch-Version: 1', async () => {
    const seen: DispatchOpts[] = [];
    servePluginVersion(pool, '5.2.0');
    const map = (opts: DispatchOpts) => {
      seen.push(opts);
      return { statusCode: 200, data: documentMapV2({ Top: { Child: {} } }) };
    };
    // In request order: the write's map read, its note read, then the document-map read.
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(map);
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply((opts) => {
      seen.push(opts);
      return { statusCode: 200, data: noteJson('N.md', '# Top\n## Child\n') };
    });
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(map);
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, '### Sub\n', heading('Top::Child'));
    await service.getDocumentMap(ctx, NOTE);
    seen.push(...patches);

    // The map read for the write, the note read for its heading levels, the PATCH, the map read.
    expect(seen).toHaveLength(4);
    for (const req of seen) expect(lower(req.headers)['markdown-patch-version']).not.toBe('1');
  });
});

/**
 * markdown-patch 2.0 addresses an isolated block id (`^id` alone on its line,
 * after a blank line) as that marker paragraph, not the table above it, so a
 * table-row write through one fails upstream with "block is not a table".
 * Plugin 5.x still accepts the 1.x format, which resolves it to the table.
 */
describe('table rows through an isolated block id on plugin v5.x', () => {
  const rows = {
    operation: 'append',
    targetType: 'block',
    target: 'tbl',
    contentType: 'json',
  } as const;
  const TABLE = '| h1 | h2 |\n| --- | --- |\n| a | b |\n';

  it.each([
    ['after a blank line', `x\n\n${TABLE}\n^tbl\n\nafter\n`],
    ['after a blank line, CRLF', `x\r\n\r\n${TABLE.replace(/\n/g, '\r\n')}\r\n^tbl\r\n`],
    ['with whitespace around it, below frontmatter', `---\na: 1\n---\n${TABLE}\n  ^tbl  \n`],
  ])('sends the 1.x headers for an id %s', async (_l, content) => {
    servePluginVersion(pool, '5.2.0');
    serveNote(content);
    const patches = capturePatches();

    await expect(service.patchNote(ctx, NOTE, '[["c","d"]]', rows)).resolves.toBe('tbl');

    const h = lower(patches[0]?.headers ?? {});
    expect(h['markdown-patch-version']).toBe('1');
    expect(h.operation).toBe('append');
    expect(h['target-type']).toBe('block');
    expect(h.target).toBe('tbl');
    expect(h['content-type']).toBe('application/json');
    expect(patches[0]?.body).toBe('[["c","d"]]');
  });

  it.each([
    ['an inline id on a table row', `${TABLE.trimEnd()} ^tbl\n`],
    ['an id line directly under the table, which the table absorbs', `${TABLE}^tbl\n`],
    ['an isolated id inside a fence only', `\`\`\`\n\n^tbl\n\`\`\`\n${TABLE.trimEnd()} ^tbl\n`],
    ['an id the note does not have', `${TABLE}\n^other\n`],
  ])('sends 2.0 for %s', async (_l, content) => {
    servePluginVersion(pool, '5.2.0');
    serveNote(content);
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, '[["c","d"]]', rows);

    expect(lower(patches[0]?.headers ?? {})['markdown-patch-version']).toBe('2');
    expect(instructionOf(patches[0] as DispatchOpts).value).toEqual([['c', 'd']]);
  });

  it('sends 2.0, without reading the note, for markdown written to an isolated id', async () => {
    servePluginVersion(pool, '5.2.0');
    // No note read intercepted: one would surface "No mock intercept".
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, ' more', { ...rows, contentType: 'markdown' });

    expect(lower(patches[0]?.headers ?? {})['markdown-patch-version']).toBe('2');
  });
});

/**
 * markdown-patch 2.0 takes table rows only through a block target — a heading
 * write carries its payload in `content`, never `value` — while the 1.x engine
 * appends rows to the table that ends the section. Plugin 5.x still accepts
 * 1.x, so a JSON write to a heading goes out in it.
 */
describe('table rows under a heading on plugin v5.x', () => {
  it('sends the 1.x headers, resolved against the 1.x map', async () => {
    servePluginVersion(pool, '5.2.0');
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply((opts) => {
      expect(lower(opts.headers)['markdown-patch-version']).toBe('1');
      return {
        statusCode: 200,
        data: { headings: ['T', 'T::A'], blocks: [], frontmatterFields: [] },
      };
    });
    serveNote('# T\n## A\n| a | b |\n| - | - |\n| 1 | 2 |\n');
    const patches = capturePatches();

    await expect(
      service.patchNote(ctx, NOTE, '[["3","4"]]', heading('A', { contentType: 'json' })),
    ).resolves.toBe('T::A');

    const h = lower(patches[0]?.headers ?? {});
    expect(h['markdown-patch-version']).toBe('1');
    expect(h['target-type']).toBe('heading');
    expect(decodeURIComponent(h.target ?? '')).toBe('T::A');
    expect(h['content-type']).toBe('application/json');
    expect(patches[0]?.body).toBe('[["3","4"]]');
  });
});

/**
 * Plugin 5.x separates inserted content from its neighbours with a blank line,
 * wherever it lands; an append at the end of a note goes out as the same plain
 * content-scope instruction as any other.
 */
it('sends an end-of-note heading append as a plain 2.0 content append', async () => {
  servePluginVersion(pool, '5.2.0');
  serveMapV2({ Top: {}, Other: {} });
  serveNote('# Top\n- a\n# Other\nLast words.');
  const patches = capturePatches();

  await service.patchNote(ctx, NOTE, '- c', heading('Other'));

  expect(instructionOf(patches[0] as DispatchOpts)).toEqual({
    targetType: 'heading',
    target: ['Other'],
    operation: 'append',
    content: '- c',
    rejectIfContentPreexists: true,
  });
});

/**
 * markdown-patch 2.0 puts a blank line between a plain heading append (or
 * prepend) and the section's own content, which turns a tight list loose when
 * the content is one more item. A list item written next to the list a
 * section ends (prepend: opens) with goes out as a `within` splice on that
 * list instead: `content` scope, spliced literally, so the service supplies
 * the line break. Issue #145.
 */
describe('a list item written beside the list its section ends or opens with, on plugin v5.x', () => {
  const LIST = '# T\n## A\n- one\n- two\n';
  const plain = (operation: 'append' | 'prepend', content: string) => ({
    targetType: 'heading',
    target: ['T', 'A'],
    operation,
    content,
    rejectIfContentPreexists: true,
  });
  const within = (operation: 'append' | 'prepend', content: string) => ({
    targetType: 'heading',
    target: ['T', 'A'],
    operation,
    scope: 'content',
    within: operation === 'append' ? -1 : 0,
    content,
    rejectIfContentPreexists: true,
  });

  async function send(
    note: string,
    content: string,
    extra: Partial<PatchInstruction> = {},
  ): Promise<Record<string, unknown>> {
    servePluginVersion(pool, '5.2.0');
    serveMapV2({ T: { A: {}, B: {} } });
    serveNote(note);
    const patches = capturePatches();
    await expect(service.patchNote(ctx, NOTE, content, heading('T::A', extra))).resolves.toBe(
      'T::A',
    );
    expect(patches).toHaveLength(1);
    return instructionOf(patches[0] as DispatchOpts);
  }

  it('appends as a `within: -1` splice that opens with its own line break', async () => {
    await expect(send(LIST, '- three')).resolves.toEqual(within('append', '\n- three'));
  });

  it('prepends as a `within: 0` splice that closes with its own line break', async () => {
    await expect(send(LIST, '- zero', { operation: 'prepend' })).resolves.toEqual(
      within('prepend', '- zero\n'),
    );
  });

  it.each([
    ['a trailing line break', '- three\n', '\n- three'],
    ['blank lines around it', '\n\n- three\n\n', '\n- three'],
    ['trailing spaces', '- three  \n', '\n- three'],
    ['CRLF line endings', '- three\r\n- four\r\n', '\n- three\n- four'],
    ['a task item', '- [ ] three', '\n- [ ] three'],
    ['an ordered item', '1. three', '\n1. three'],
    ['a star bullet', '* three', '\n* three'],
    ['an indented item', '  - three', '\n  - three'],
    [
      'a list item followed by more blocks',
      '- three\n\nA paragraph.\n',
      '\n- three\n\nA paragraph.',
    ],
  ])('reduces content with %s as 2.0 reduces a plain write', async (_l, content, spliced) => {
    await expect(send(LIST, content)).resolves.toEqual(within('append', spliced));
  });

  it.each([
    ['a nested list', '# T\n## A\n- one\n  - nested\n'],
    [
      'a list after a blank line, above a blank line and the next heading',
      '# T\n## A\n\n- one\n- two\n\n## B\ntext\n',
    ],
    ['a list below frontmatter', '---\ntags: [x]\n---\n# T\n## A\n- one\n'],
    ['a loose list', '# T\n## A\n- one\n\n- two\n'],
    ['a CRLF list', '# T\r\n## A\r\n- one\r\n- two\r\n'],
    ['an ordered list', '# T\n## A\n1. one\n2. two\n'],
    ['a list after a paragraph', '# T\n## A\nIntro.\n\n- one\n'],
  ])('appends beside %s', async (_l, note) => {
    await expect(send(note, '- three')).resolves.toEqual(within('append', '\n- three'));
  });

  it('prepends beside the list a section opens with, above its sub-headings', async () => {
    await expect(
      send('# T\n## A\n- one\n### Sub\ntext\n', '- zero', { operation: 'prepend' }),
    ).resolves.toEqual(within('prepend', '- zero\n'));
  });

  it('drops `createTargetIfMissing`, which 2.0 refuses beside `within`, for a section the note has', async () => {
    await expect(send(LIST, '- three', { createTargetIfMissing: true })).resolves.toEqual(
      within('append', '\n- three'),
    );
  });

  it('carries no `rejectIfContentPreexists` when duplicates are allowed', async () => {
    const { rejectIfContentPreexists: _, ...allowed } = within('append', '\n- three');
    await expect(send(LIST, '- three', { applyIfContentPreexists: true })).resolves.toEqual(
      allowed,
    );
  });

  it.each([
    ['a paragraph', '# T\n## A\n- one\n\nClosing words.\n'],
    ['a table', '# T\n## A\n| a |\n| - |\n| 1 |\n'],
    ['a fenced code block', '# T\n## A\n```\n- one\n```\n'],
    ['an indented code block', '# T\n## A\n- one\n\nText.\n\n    code\n'],
    ['a blockquote holding a list', '# T\n## A\n> - one\n'],
    ['a list and its isolated block id', '# T\n## A\n- one\n\n^list\n'],
    ['a list, then sub-headings the append lands below', '# T\n## A\n- one\n### Sub\n- two\n'],
    ['no content at all', '# T\n## A\n## B\n'],
  ])('appends a list item to a section ending in %s as the plain write', async (_l, note) => {
    await expect(send(note, '- three')).resolves.toEqual(plain('append', '- three'));
  });

  it.each([
    ['a paragraph', '# T\n## A\nIntro.\n\n- one\n'],
    ['a sub-heading', '# T\n## A\n### Sub\n- one\n'],
    ['no content at all', '# T\n## A\n'],
  ])('prepends a list item to a section opening with %s as the plain write', async (_l, note) => {
    await expect(send(note, '- zero', { operation: 'prepend' })).resolves.toEqual(
      plain('prepend', '- zero'),
    );
  });

  /**
   * A prepend's last block is the one that meets the section's list. Spliced
   * flush, a paragraph there takes in an ordered list that does not start at
   * 1, and an HTML block takes in whatever follows it up to a blank line.
   */
  it.each([
    ['a paragraph', '# T\n## A\n3. three\n4. four\n', '- zero\n\nA paragraph.'],
    ['an HTML block', LIST, '- zero\n\n<div>x</div>'],
  ])('prepends a list item followed by %s as the plain write', async (_l, note, content) => {
    await expect(send(note, content, { operation: 'prepend' })).resolves.toEqual(
      plain('prepend', content),
    );
  });

  it.each([
    ['a paragraph', 'three'],
    ['a paragraph, then a list item', 'Three:\n- three'],
    ['a thematic break', '---'],
    ['a fenced list', '```\n- three\n```'],
  ])(
    'appends content opening with %s as the plain write, without reading the note',
    async (_l, content) => {
      servePluginVersion(pool, '5.2.0');
      serveMapV2({ T: { A: {} } });
      // No note read intercepted: one would surface "No mock intercept".
      const patches = capturePatches();

      await service.patchNote(ctx, NOTE, content, heading('T::A'));

      expect(instructionOf(patches[0] as DispatchOpts)).toEqual(plain('append', content));
    },
  );

  it('appends a list item carrying a heading as the plain write, heading levels rewritten', async () => {
    await expect(send(LIST, '- three\n\n### Sub\n')).resolves.toEqual(
      plain('append', '- three\n\n# Sub\n'),
    );
  });

  it('replaces the section body with the plain write', async () => {
    servePluginVersion(pool, '5.2.0');
    serveMapV2({ T: { A: {} } });
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, '- new', heading('T::A', { operation: 'replace' }));

    expect(instructionOf(patches[0] as DispatchOpts)).toEqual(
      plain('replace' as 'append', '- new'),
    );
  });

  it('keeps the plain write when the section already holds the content, so 2.0 still refuses the duplicate', async () => {
    await expect(send('# T\n## A\nSee - three.\n\n- one\n', '- three')).resolves.toEqual(
      plain('append', '- three'),
    );
  });

  it('keeps the plain write for a section the note does not have, so it can still be created', async () => {
    await expect(
      send('# T\n## B\n- one\n', '- three', { createTargetIfMissing: true }),
    ).resolves.toEqual({ ...plain('append', '- three'), createTargetIfMissing: true });
  });

  it('classifies a `within` index the note no longer has as section_target_missing', async () => {
    servePluginVersion(pool, '5.2.0');
    serveMapV2({ T: { A: {} } });
    serveNote(LIST);
    pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply(404, {
      message: 'Not Found\n`within` index -1 is out of range: ["T","A"] has 0 top-level blocks',
      errorCode: 40400,
    });

    await expect(service.patchNote(ctx, NOTE, '- three', heading('T::A'))).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'section_target_missing' },
    });
  });

  it('sends the 1.x headers and the content as written on plugin v4.x', async () => {
    servePluginVersion(pool, '4.2.0');
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, { headings: ['T', 'T::A'], blocks: [], frontmatterFields: [] });
    serveNote(LIST);
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, '- three', heading('T::A'));

    const h = lower(patches[0]?.headers ?? {});
    expect(h['markdown-patch-version']).toBe('1');
    expect(h.operation).toBe('append');
    expect(decodeURIComponent(h.target ?? '')).toBe('T::A');
    expect(patches[0]?.body).toBe('- three');
  });
});

/**
 * JavaScript orders integer-like object keys first, so the plugin's 2.0 heading
 * tree — and the keys of 4.x's flat map — list a `## 2025` above a `## 2024`
 * the wrong way round. Heading paths follow the note instead.
 */
describe('heading order with integer-like names', () => {
  const JOURNAL = '# Journal\n## 2025\n### Notes\nb\n## 2024\n### Notes\na\n# 2023 recap\n';

  it('lists 2.0 map headings in note order', async () => {
    servePluginVersion(pool, '5.2.0');
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(200, {
      version: 'v',
      frontmatterFields: [],
      headings: { Journal: { '2025': { Notes: {} }, '2024': { Notes: {} } }, '2023 recap': {} },
      blocks: [],
    });
    serveNote(JOURNAL);

    await expect(service.getDocumentMap(ctx, NOTE)).resolves.toMatchObject({
      headings: [
        'Journal',
        'Journal::2025',
        'Journal::2025::Notes',
        'Journal::2024',
        'Journal::2024::Notes',
        '2023 recap',
      ],
    });
  });

  it('lists top-level integer headings from the 1.x map in note order', async () => {
    servePluginVersion(pool, '4.2.0');
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(200, {
      headings: ['2024', '2025', 'Intro', '2025::Notes', '2024::Notes'],
      blocks: [],
      frontmatterFields: [],
    });
    serveNote('# Intro\n# 2025\n## Notes\n# 2024\n## Notes\n');

    await expect(service.getDocumentMap(ctx, NOTE)).resolves.toMatchObject({
      headings: ['Intro', '2025', '2025::Notes', '2024', '2024::Notes'],
    });
  });

  it('reads no note when no heading name is integer-like', async () => {
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, documentMapV2({ B: {}, A: {} }));
    // No note read intercepted: one would surface "No mock intercept".

    await expect(service.getDocumentMap(ctx, NOTE)).resolves.toMatchObject({
      headings: ['B', 'A'],
    });
  });

  it.each([
    [
      'plugin v5.x',
      '5.2.0',
      () => serveMapV2({ Journal: { '2025': { Notes: {} }, '2024': { Notes: {} } } }),
    ],
    [
      'plugin v4.x',
      '4.2.0',
      () =>
        pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(200, {
          headings: [
            'Journal',
            'Journal::2025',
            'Journal::2025::Notes',
            'Journal::2024',
            'Journal::2024::Notes',
          ],
          blocks: [],
          frontmatterFields: [],
        }),
    ],
  ])('names ambiguous-leaf candidates in note order on %s', async (_l, version, serveMap) => {
    servePluginVersion(pool, version);
    serveMap();
    serveNote('# Journal\n## 2025\n### Notes\n## 2024\n### Notes\n');

    const err = await rejectionOf(service.patchNote(ctx, NOTE, 'x', heading('Notes')));
    expect(err.data).toMatchObject({
      reason: 'ambiguous_section',
      candidates: ['Journal::2025::Notes', 'Journal::2024::Notes'],
      recovery: { hint: expect.stringContaining('"Journal::2025::Notes"') },
    });
  });

  it('names top-level integer candidates in note order on plugin v4.x', async () => {
    servePluginVersion(pool, '4.2.0');
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply(200, {
      headings: ['2024', '2025', '2025::Notes', '2024::Notes'],
      blocks: [],
      frontmatterFields: [],
    });
    serveNote('# 2025\n## Notes\n# 2024\n## Notes\n');

    const err = await rejectionOf(service.patchNote(ctx, NOTE, 'x', heading('Notes')));
    expect(err.data).toMatchObject({ candidates: ['2025::Notes', '2024::Notes'] });
  });
});

/**
 * PATCH rejections other than a missing target, in the shapes plugin 5.2.0
 * returns them: the 1.x engine's `PatchFailed` reason tokens and the 2.0
 * engine's `PatchFailed` / `InvalidPatchInstruction` bodies.
 */
describe('PATCH rejection classification', () => {
  const block = {
    operation: 'append',
    targetType: 'block',
    target: 'tbl',
    contentType: 'json',
  } as const;

  const rejectWith = async (version: string, status: number, body: unknown) => {
    servePluginVersion(pool, version);
    if (version.startsWith('5')) serveNote('text\n\n| a | b |\n| - | - |\n| c | d | ^tbl\n');
    pool.intercept({ path: '/vault/N.md', method: 'PATCH' }).reply(status, body);
    return rejectionOf(service.patchNote(ctx, NOTE, '[["x","y"]]', block));
  };

  const failed = (detail: string) => ({
    errorCode: 40080,
    message: `The patch you provided could not be applied to the target content.\n${detail}`,
  });

  it.each([
    ['1.x content-not-mergeable', '4.2.0', failed('content-not-mergeable'), 'cannot be merged'],
    [
      '1.x content-type-invalid-for-target',
      '4.2.0',
      failed('content-type-invalid-for-target'),
      // The 1.x table writer reports a wrong cell count under this token too (seen live).
      "not a table, or a row's cell count does not match",
    ],
    [
      '1.x table-content-incorrect-column-count',
      '4.2.0',
      failed('table-content-incorrect-column-count'),
      'column count',
    ],
    [
      '1.x content-type-invalid',
      '4.2.0',
      failed('content-type-invalid'),
      'shape this target takes',
    ],
    [
      '2.0 not-a-table',
      '5.2.0',
      failed('block "tbl" is not a table; row writes require a table block'),
      'not a table',
    ],
    [
      '2.0 column count',
      '5.2.0',
      failed('row ["x"] has 1 cell(s); table "tbl" has 2 column(s)'),
      'column count',
    ],
    [
      '2.0 merge failure',
      '5.2.0',
      failed('frontmatter key "k" cannot be merged with the given value'),
      'cannot be merged',
    ],
    [
      '2.0 malformed instruction',
      '5.2.0',
      {
        errorCode: 40081,
        message:
          'The patch instruction you provided was malformed or outside the supported algebra.\nvalue: Expected array',
      },
      'shape this target takes',
    ],
    ['an unrecognized PatchFailed', '5.2.0', failed('secret-note-body-zq81'), 'could not apply'],
  ])('classifies %s as patch_rejected, in its own words', async (_l, version, body, phrase) => {
    const err = await rejectWith(version, 400, body);

    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data).toMatchObject({ reason: 'patch_rejected', path: 'N.md' });
    expect(err.message).toContain('N.md');
    expect(err.message).toContain(phrase);
    // Containment: none of the upstream body reaches the wire.
    const wire = JSON.stringify({ message: err.message, data: err.data });
    expect(wire).not.toContain(body.message.split('\n')[1]);
    expect(wire).not.toContain('could not be applied to the target content');
  });

  it('keeps a genuine 1.x missing target as section_target_missing', async () => {
    const err = await rejectWith('4.2.0', 400, failed('invalid-target'));
    expect(err.data).toMatchObject({ reason: 'section_target_missing' });
  });
});

describe('markdown-patch 1.x on Local REST API 4.x', () => {
  it('keeps the header protocol and never sends a 2.0 body or target', async () => {
    servePluginVersion(pool, '4.2.0');
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply((opts) => {
      expect(lower(opts.headers)['markdown-patch-version']).toBe('1');
      return {
        statusCode: 200,
        data: { headings: ['Top', 'Top::Child'], blocks: [], frontmatterFields: [] },
      };
    });
    serveNote('# Top\n## Child\n');
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, '### Sub\n', heading('Child'));

    const h = lower(patches[0]?.headers ?? {});
    expect(h['markdown-patch-version']).toBe('1');
    expect(h.operation).toBe('append');
    expect(h['target-type']).toBe('heading');
    expect(decodeURIComponent(h.target ?? '')).toBe('Top::Child');
    expect(h['target-delimiter']).toBe('::');
    expect(h['content-type']).toBe('text/markdown');
    expect(patches[0]?.body).toBe('### Sub\n');
  });

  it('reads the flat 1.x document map', async () => {
    servePluginVersion(pool, '4.2.0');
    pool.intercept({ path: '/vault/N.md', method: 'GET' }).reply((opts) => {
      expect(lower(opts.headers)['markdown-patch-version']).toBe('1');
      return {
        statusCode: 200,
        data: { headings: ['Top'], blocks: ['b'], frontmatterFields: ['f'] },
      };
    });

    await expect(service.getDocumentMap(ctx, NOTE)).resolves.toEqual({
      headings: ['Top'],
      blocks: ['b'],
      frontmatterFields: ['f'],
    });
  });
});

describe('format negotiation', () => {
  it.each([
    ['a pre-release tag', '5.3.0-beta.1', '2'],
    ['a future major', '6.0.0', '2'],
    ['an unparseable version', 'dev-build', '2'],
    ['no `versions` at all', undefined, '2'],
    ['a 4.x release', '4.0.0', '1'],
  ])('reads %s as markdown-patch %s', async (_l, self, expected) => {
    servePluginVersion(pool, self);
    const patches = capturePatches();

    await service.patchNote(ctx, NOTE, 'x', {
      operation: 'append',
      targetType: 'block',
      target: 'p1',
      contentType: 'markdown',
    });

    expect(lower(patches[0]?.headers ?? {})['markdown-patch-version']).toBe(expected);
  });

  it('reads the version once per service', async () => {
    servePluginVersion(pool, '5.2.0');
    const patches = capturePatches();
    const block = {
      operation: 'append',
      targetType: 'block',
      target: 'p1',
      contentType: 'markdown',
    } as const;

    await service.patchNote(ctx, NOTE, 'a', block);
    await service.patchNote(ctx, NOTE, 'b', block);

    // A second GET / would find no intercept and fail the call.
    expect(patches).toHaveLength(2);
  });

  it('surfaces a failing GET / as its classified error and sends no PATCH', async () => {
    const { calls, fetchImpl } = sequencedFetch(() =>
      mockResponse(JSON.stringify({ message: 'boom' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);

    const err = await rejectionOf(
      svc.patchNote(ctx, NOTE, 'x', {
        operation: 'append',
        targetType: 'block',
        target: 'p1',
        contentType: 'markdown',
      }),
    );

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(calls.every((c) => new URL(c.url).pathname === '/')).toBe(true);
    expect(calls.some((c) => c.init.method === 'PATCH')).toBe(false);
  });

  it('surfaces a failing GET / on a document-map read without reading the map', async () => {
    const { calls, fetchImpl } = sequencedFetch(() => mockResponse('', { status: 500 }));
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);

    await expect(svc.getDocumentMap(ctx, NOTE)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(calls.every((c) => new URL(c.url).pathname === '/')).toBe(true);
  });

  it('tries again after a failed read instead of caching the failure', async () => {
    const { fetchImpl } = sequencedFetch(
      () => mockResponse('', { status: 500 }),
      () => mockResponse('', { status: 500 }),
      () => mockResponse('', { status: 500 }),
      () => mockResponse('', { status: 500 }),
      () =>
        mockResponse(JSON.stringify({ status: 'OK', service: 's', versions: { self: '5.2.0' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      () => mockResponse('', { status: 200 }),
    );
    const svc = new ObsidianService(makeTestConfig(), fetchImpl);
    const block = {
      operation: 'append',
      targetType: 'block',
      target: 'p1',
      contentType: 'markdown',
    } as const;

    await expect(svc.patchNote(ctx, NOTE, 'x', block)).rejects.toBeDefined();
    await expect(svc.patchNote(ctx, NOTE, 'x', block)).resolves.toBe('p1');
  });

  it('shares the report with the /periodic/ diagnostic instead of reading it again', async () => {
    pool.intercept({ path: '/', method: 'GET' }).reply(200, {
      status: 'OK',
      service: 'Obsidian Local REST API',
      authenticated: true,
      versions: { obsidian: '1.13.7', self: '5.2.0' },
      apiExtensions: [],
    });
    capturePatches();
    pool
      .intercept({ path: '/periodic/daily/', method: 'GET' })
      .reply(404, { message: 'Not Found' });

    await service.patchNote(ctx, NOTE, 'x', {
      operation: 'append',
      targetType: 'block',
      target: 'p1',
      contentType: 'markdown',
    });
    // A second GET / would find no intercept; the diagnostic reads the cached report.
    await expect(
      service.getNoteJson(ctx, { type: 'periodic', period: 'daily' }),
    ).rejects.toMatchObject({
      data: { reason: 'periodic_unsupported' },
    });
  });
});

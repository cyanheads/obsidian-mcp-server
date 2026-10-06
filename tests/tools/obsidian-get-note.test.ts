/**
 * @fileoverview Handler tests for obsidian_get_note across all four formats.
 * @module tests/tools/obsidian-get-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianGetNote } from '@/mcp-server/tools/definitions/obsidian-get-note.tool.js';
import {
  contractErrorOf,
  noteJson,
  repeatKey,
  servePluginVersion,
  setupHarness,
} from '../helpers.js';

const harness = setupHarness();

describe('obsidian_get_note / format: content', () => {
  it('returns content via /vault/{path} with text/markdown accept', async () => {
    let accept: string | undefined;
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply((opts) => {
        accept = opts.headers.Accept ?? opts.headers.accept;
        return { statusCode: 200, data: '# title\n\nbody' };
      });

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'path', path: 'Note.md' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    expect(accept).toBe('text/markdown');
    expect(out.result).toEqual({
      format: 'content',
      path: 'Note.md',
      content: '# title\n\nbody',
    });
  });

  it('falls back to NoteJson for active targets to resolve the path', async () => {
    harness
      .current()
      .pool.intercept({ path: '/active/', method: 'GET' })
      .reply(
        200,
        {
          path: 'today.md',
          content: 'daily body',
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'active' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    expect(out.result).toEqual({ format: 'content', path: 'today.md', content: 'daily body' });
  });
});

describe('obsidian_get_note / path names a folder', () => {
  /**
   * The Local REST API answers a note-read URL that names a folder with `200`
   * and a JSON listing, whatever the `Accept` — so every projection reads the
   * same reply here, and none of them may hand it back as note data.
   */
  const listing = { files: ['a.md', 'b.md', 'nested/'] };
  const asFolder = { headers: { 'content-type': 'application/json; charset=utf-8' } };

  const inputs = [
    ['content', { format: 'content', target: { type: 'path', path: 'Inbox' } }],
    ['full', { format: 'full', target: { type: 'path', path: 'Inbox' } }],
    ['document-map', { format: 'document-map', target: { type: 'path', path: 'Inbox' } }],
    [
      'section',
      {
        format: 'section',
        target: { type: 'path', path: 'Inbox' },
        section: { type: 'heading', target: 'Intro' },
      },
    ],
  ] as const;

  it.each(inputs)('format %s rejects with path_is_directory', async (label, args) => {
    const { pool } = harness.current();
    // The document map reads the plugin's version first, to pick its markdown-patch format.
    if (label === 'document-map') servePluginVersion(pool, '5.2.0');
    pool.intercept({ path: '/vault/Inbox', method: 'GET' }).reply(200, listing, asFolder);

    expect(await contractErrorOf(obsidianGetNote, args)).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'path_is_directory',
        path: 'Inbox',
        recovery: { hint: expect.stringContaining('obsidian_list_notes') },
      },
    });
  });

  it('rejects a dot-segment path with path_traversal', async () => {
    await expect(
      obsidianGetNote.handler(
        obsidianGetNote.input.parse({
          format: 'content',
          target: { type: 'path', path: 'Projects/../../etc/passwd' },
        }),
        createMockContext({ errors: obsidianGetNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'path_traversal' },
    });
  });
});

describe('obsidian_get_note / format: full', () => {
  it('returns the parsed NoteJson', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: 'body',
          frontmatter: { title: 'T' },
          tags: ['t1'],
          stat: { ctime: 1, mtime: 2, size: 4 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    expect(out.result).toEqual({
      format: 'full',
      path: 'Note.md',
      content: 'body',
      frontmatter: { title: 'T' },
      tags: ['t1'],
      stat: { ctime: 1, mtime: 2, size: 4 },
    });
  });
});

describe('obsidian_get_note / format: document-map', () => {
  /**
   * Both maps plugin 5.2.0 served for one note, recorded live: the flat 1.x
   * map (`Markdown-Patch-Version: 1`) and the 2.0 tree. The note carries a
   * repeated heading, a repeated block id, setext headings, an untitled
   * heading, and an integer-like frontmatter key and block id. Its
   * `## 2024` under `# Top` is left out here and pinned on its own below.
   */
  const RECORDED_V1_MAP = {
    headings: [
      'Top',
      'Top::Child',
      'Top::Child::Deep',
      'Setext Parent',
      'Setext Parent::Setext Child',
      '::Under untitled',
      'Other',
    ],
    blocks: ['123456', 'intro1', 'li1'],
    frontmatterFields: ['2024', 'title', 'tags'],
  };
  const RECORDED_V2_MAP = {
    version: 'db5b8f',
    frontmatterFields: ['title', '2024', 'tags'],
    headings: {
      Top: { Child: { Deep: {} }, [repeatKey('Child', 1)]: {} },
      'Setext Parent': { 'Setext Child': {} },
      '': { 'Under untitled': {} },
      Other: {},
    },
    blocks: ['intro1', 'li1', '123456', repeatKey('intro1', 1)],
  };

  /** The map read, then — when `note` is given — the note read that orders its headings. */
  const mapResult = async (version: string, reply: unknown, note?: string) => {
    const { pool } = harness.current();
    servePluginVersion(pool, version);
    pool.intercept({ path: '/vault/Note.md', method: 'GET' }).reply(200, reply);
    if (note !== undefined) {
      pool.intercept({ path: '/vault/Note.md', method: 'GET' }).reply(200, {
        path: 'Note.md',
        content: note,
        frontmatter: {},
        tags: [],
        stat: { ctime: 0, mtime: 0, size: 0 },
      });
    }
    return await runToolContract(obsidianGetNote, {
      format: 'document-map',
      target: { type: 'path', path: 'Note.md' },
    });
  };
  const textOf = (res: Awaited<ReturnType<typeof runToolContract>>) =>
    res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

  const EXPECTED = { result: { format: 'document-map', path: 'Note.md', ...RECORDED_V1_MAP } };

  it.each([
    ['plugin v4.x, from the flat 1.x map', '4.2.0', RECORDED_V1_MAP],
    ['plugin v5.x, from the 2.0 tree', '5.2.0', RECORDED_V2_MAP],
  ])('returns one map for the note on %s', async (_label, version, reply) => {
    const res = await mapResult(version, reply);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(EXPECTED);
    const text = textOf(res);
    expect(text).toContain('**Headings (7)**');
    expect(text).toContain('- Setext Parent::Setext Child');
    expect(text).toContain('- ::Under untitled');
    expect(text).toContain('**Blocks (3)**');
    expect(text).toContain('- ^123456');
    expect(text).toContain('**Frontmatter fields (3)**');
  });

  /**
   * The recorded note's `## 2024` under `# Top`. The 2.0 tree is a JSON object,
   * so it reaches the client ahead of `## Child`, its sibling above it in the
   * note; the listing follows the note, as the 1.x map does.
   */
  it('lists an integer-named heading in note order on plugin v5.x', async () => {
    const note = [
      '---',
      'title: Map fixture',
      '2024: numeric key',
      'tags:',
      '  - a',
      '---',
      '# Top',
      'intro ^intro1',
      '',
      '## Child',
      '- a ^li1',
      '- b',
      '',
      '### Deep',
      'deep text',
      '',
      '## Child',
      'second child',
      '',
      '## 2024',
      'numbered',
      '',
      '# Other',
      'dup id ^intro1',
      '',
    ].join('\n');
    const res = await mapResult(
      '5.2.0',
      {
        ...RECORDED_V2_MAP,
        headings: {
          Top: { '2024': {}, Child: { Deep: {} }, [repeatKey('Child', 1)]: {} },
          Other: {},
        },
      },
      note,
    );

    expect((res.structuredContent as typeof EXPECTED).result.headings).toEqual([
      'Top',
      'Top::Child',
      'Top::Child::Deep',
      'Top::2024',
      'Other',
    ]);
    expect(textOf(res)).toContain('- Top::Child::Deep\n- Top::2024\n- Other');
  });

  it('returns empty lists on plugin v5.x for a note with no headings, blocks, or frontmatter', async () => {
    const res = await mapResult('5.2.0', {
      version: 'e3b0c4',
      frontmatterFields: [],
      headings: {},
      blocks: [],
    });

    expect(res.structuredContent).toEqual({
      result: {
        format: 'document-map',
        path: 'Note.md',
        headings: [],
        blocks: [],
        frontmatterFields: [],
      },
    });
    const text = textOf(res);
    expect(text).toContain('**Headings (0)**');
    expect(text).toContain('**Frontmatter fields (0)**');
  });
});

describe('obsidian_get_note / format: section', () => {
  it('extracts a heading section client-side from NoteJson', async () => {
    const md = ['# Top', 'top body', '', '## Sub', 'sub body', '', '# Other'].join('\n');
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: md,
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Top::Sub' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'section') throw new Error('expected section branch');
    expect(out.result.valueText).toBe(['## Sub', 'sub body'].join('\n'));
    expect(out.result.valueJson).toBeUndefined();
  });

  it('returns frontmatter values via valueJson', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: 'body',
          frontmatter: { priority: 7 },
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'frontmatter', target: 'priority' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'section') throw new Error('expected section branch');
    expect(out.result.valueJson).toBe(7);
    expect(out.result.valueText).toBeUndefined();
  });

  it('reaches a heading above the second fence when the opening fence has trailing whitespace', async () => {
    const md = '--- \n# Real Heading\n\nBody text.\n---\n';
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: md,
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Real Heading' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'section') throw new Error('expected section branch');
    expect(out.result.valueText).toBe('# Real Heading\n\nBody text.\n---');
  });

  it('skips an empty properties block when extracting a heading', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: '---\n---\n# Heading\nbody ^blk',
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Heading' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'section') throw new Error('expected section branch');
    expect(out.result.valueText).toBe('# Heading\nbody ^blk');
  });

  it('throws section_required (ValidationError) when section is omitted', async () => {
    // No upstream interception — handler should fail before any HTTP call.
    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
    });
    await expect(
      obsidianGetNote.handler(input, createMockContext({ errors: obsidianGetNote.errors })),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'section_required' },
    });
  });

  it('carries section_missing to both wire surfaces when the heading is absent', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content: '# Present\nbody',
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );

    const res = await runToolContract(obsidianGetNote, {
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Absent' },
    });

    expect(res.isError).toBe(true);
    const error = (
      res.structuredContent as {
        error: { code: number; data: { reason: string; path: string; section: unknown } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data).toMatchObject({
      reason: 'section_missing',
      path: 'Note.md',
      section: { type: 'heading', target: 'Absent' },
    });
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain("Heading 'Absent' not found");
    expect(text).toContain('format "document-map"');
    expect(text).toContain('reason section_missing');
  });
});

describe('obsidian_get_note / section heading resolution', () => {
  const AMBIGUOUS = [
    '# Overview',
    '## Alpha',
    '### Shared',
    '',
    'Nested under Alpha.',
    '',
    '## Beta',
    '### Shared',
    '',
    'Nested under Beta.',
  ].join('\n');

  function mockNote(content: string): void {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content,
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );
  }

  async function readSection(
    target: string,
    ctx = createMockContext({ errors: obsidianGetNote.errors }),
  ) {
    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target },
    });
    const out = await obsidianGetNote.handler(input, ctx);
    if (out.result.format !== 'section') throw new Error('expected section branch');
    return out.result;
  }

  it('reports the resolved full path for a single bare-leaf match', async () => {
    mockNote(['# Root', 'root body', '## Nested', 'nested body'].join('\n'));
    const result = await readSection('Nested');
    expect(result.sectionTarget).toBe('Root::Nested');
    expect(result.candidates).toBeUndefined();
  });

  it('reports every colliding path and a notice on an ambiguous leaf', async () => {
    mockNote(AMBIGUOUS);
    const ctx = createMockContext({ errors: obsidianGetNote.errors });
    const result = await readSection('Shared', ctx);
    expect(result.valueText).toBe('### Shared\n\nNested under Alpha.');
    expect(result.sectionTarget).toBe('Overview::Alpha::Shared');
    expect(result.candidates).toEqual(['Overview::Alpha::Shared', 'Overview::Beta::Shared']);
    expect(getEnrichment(ctx).notice).toContain('Overview::Alpha::Shared');
    expect(getEnrichment(ctx).notice).toContain('2 headings');
  });

  it('echoes a fully-qualified target without candidates', async () => {
    mockNote(['# Root', '## Child', 'body'].join('\n'));
    const result = await readSection('Root::Child');
    expect(result.sectionTarget).toBe('Root::Child');
    expect(result.candidates).toBeUndefined();
  });

  it('leaves a "::"-qualified target unflagged when its parent name repeats elsewhere', async () => {
    mockNote(['# A', '## B', 'b body', '# A', '## C', 'c body'].join('\n'));
    const result = await readSection('A::B');
    expect(result.valueText).toBe(['## B', 'b body'].join('\n'));
    expect(result.sectionTarget).toBe('A::B');
    expect(result.candidates).toBeUndefined();
  });

  it('repeats identical strings in candidates for same-level duplicates', async () => {
    mockNote(['# Dup', 'first body', '# Dup', 'second body'].join('\n'));
    const result = await readSection('Dup');
    expect(result.valueText).toBe(['# Dup', 'first body'].join('\n'));
    expect(result.sectionTarget).toBe('Dup');
    expect(result.candidates).toEqual(['Dup', 'Dup']);
  });

  it('reads a document-map locator under an untitled heading back as that locator', async () => {
    mockNote('##\n\n### Request body\n\nbody text\n\n### Returns\n\nreturns text\n');
    const result = await readSection('::Request body');
    expect(result.valueText).toBe('### Request body\n\nbody text');
    expect(result.sectionTarget).toBe('::Request body');
    expect(result.candidates).toBeUndefined();
  });

  it('discloses a full path that repeats and says writes reject it', async () => {
    mockNote(['# Root', '## Dup', 'first', '## Dup', 'second'].join('\n'));
    const ctx = createMockContext({ errors: obsidianGetNote.errors });
    const result = await readSection('Root::Dup', ctx);
    expect(result.valueText).toBe('## Dup\nfirst');
    expect(result.sectionTarget).toBe('Root::Dup');
    expect(result.candidates).toEqual(['Root::Dup', 'Root::Dup']);
    expect(getEnrichment(ctx).notice).toBe(
      'Heading `Root::Dup` is ambiguous — 2 headings share that name; read `Root::Dup`. See `candidates` for the rest. Every one has the same full path, so the write tools reject it with `ambiguous_section`.',
    );
  });

  it('carries a repeated full path to structuredContent and content[]', async () => {
    mockNote(['# Root', '## Dup', 'first', '## Dup', 'second'].join('\n'));
    const res = await runToolContract(obsidianGetNote, {
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Root::Dup' },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      notice?: string;
      result: { candidates?: string[]; sectionTarget?: string; valueText?: string };
    };
    expect(structured.result).toMatchObject({
      sectionTarget: 'Root::Dup',
      candidates: ['Root::Dup', 'Root::Dup'],
      valueText: '## Dup\nfirst',
    });
    expect(structured.notice).toContain('ambiguous_section');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Candidates:* Root::Dup, Root::Dup');
    expect(text).toContain('## Dup\nfirst');
  });

  /**
   * The second `## Dup` sits in the HTML block the `<br>` line opens, so the
   * plugin's document map — and every write — sees one `Root::Dup` section
   * running to `not a heading`. The read addresses that same span.
   */
  it('reads the span a write edits past a heading line inside an HTML block', async () => {
    mockNote('# Root\n## Dup\nfirst\n\n<br>\n## Dup\nnot a heading\n');
    const res = await runToolContract(obsidianGetNote, {
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Root::Dup' },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      notice?: string;
      result: Record<string, unknown>;
    };
    expect(structured.result).toEqual({
      format: 'section',
      path: 'Note.md',
      section: { type: 'heading', target: 'Root::Dup' },
      sectionTarget: 'Root::Dup',
      valueText: '## Dup\nfirst\n\n<br>\n## Dup\nnot a heading',
    });
    expect(structured.notice).toBeUndefined();
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('## Dup\nfirst\n\n<br>\n## Dup\nnot a heading');
    expect(text).toContain('*Resolved:* Root::Dup');
    expect(text).not.toContain('*Candidates:*');
    expect(text).not.toContain('ambiguous');
  });

  it('reads a setext heading section byte for byte', async () => {
    mockNote('# Root\nDup\n---\nbody');
    const result = await readSection('Root::Dup');
    expect(result.valueText).toBe('Dup\n---\nbody');
    expect(result.sectionTarget).toBe('Root::Dup');
    expect(result.candidates).toBeUndefined();
  });

  it('fails with section_missing on both surfaces for a heading line inside a list item', async () => {
    mockNote('# Root\n- item\n  ## Nested\nmore');
    const res = await runToolContract(obsidianGetNote, {
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Root::Nested' },
    });

    expect(res.isError).toBe(true);
    const { error } = res.structuredContent as {
      error: { code: number; data: { reason: string } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('section_missing');
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain("Heading 'Root::Nested' not found");
    expect(text).toContain('reason section_missing');
  });

  it('resolves the path below a frontmatter block', async () => {
    mockNote(['---', 'title: Foo', '---', '', '# Root', '## Nested', 'nested body'].join('\n'));
    const result = await readSection('Nested');
    expect(result.valueText).toBe(['## Nested', 'nested body'].join('\n'));
    expect(result.sectionTarget).toBe('Root::Nested');
  });

  it('trims trailing whitespace from heading text in the resolved path', async () => {
    mockNote(['# Root  ', '## Child  ', 'body'].join('\n'));
    const result = await readSection('Child');
    expect(result.sectionTarget).toBe('Root::Child');
  });

  it('omits both fields for a frontmatter section', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Other.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Other.md',
          content: 'body',
          frontmatter: { priority: 7 },
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );
    const input = obsidianGetNote.input.parse({
      format: 'section',
      target: { type: 'path', path: 'Other.md' },
      section: { type: 'frontmatter', target: 'priority' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'section') throw new Error('expected section branch');
    expect(out.result.sectionTarget).toBeUndefined();
    expect(out.result.candidates).toBeUndefined();
  });

  it('validates the new fields through the tool contract and renders them in content[]', async () => {
    mockNote(AMBIGUOUS);
    const res = await runToolContract(obsidianGetNote, {
      format: 'section',
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Shared' },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      notice?: string;
      result: { candidates?: string[]; sectionTarget?: string };
    };
    expect(structured.result.sectionTarget).toBe('Overview::Alpha::Shared');
    expect(structured.result.candidates).toEqual([
      'Overview::Alpha::Shared',
      'Overview::Beta::Shared',
    ]);
    expect(structured.notice).toContain('Overview::Alpha::Shared');

    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('*Resolved:* Overview::Alpha::Shared');
    expect(text).toContain('*Candidates:* Overview::Alpha::Shared, Overview::Beta::Shared');
  });
});

describe('obsidian_get_note / case-insensitive fallback', () => {
  it('resolves a case-mismatch path and echoes the canonical name (content)', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/MyNote.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/', method: 'GET' })
      .reply(200, { files: ['mynote.md'] });
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/mynote.md', method: 'GET' })
      .reply(200, '# canonical body');

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'path', path: 'Notes/MyNote.md' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'content') throw new Error('expected content branch');
    expect(out.result.path).toBe('Notes/mynote.md');
    expect(out.result.content).toBe('# canonical body');
  });

  const REQUESTED = 'Notes/MyNote.md';
  const CANONICAL = 'Notes/mynote.md';
  const CASE_NOTICE =
    '`Notes/MyNote.md` has no exact match; read `Notes/mynote.md`, the one file in that folder whose name matches it ignoring case. Write and delete tools match paths exactly — pass them `Notes/mynote.md`.';
  const DUP_NOTE = ['# Root', '## Dup', 'first', '## Dup', 'second'].join('\n');
  const DUP_NOTICE =
    'Heading `Root::Dup` is ambiguous — 2 headings share that name; read `Root::Dup`. See `candidates` for the rest. Every one has the same full path, so the write tools reject it with `ambiguous_section`.';
  const asJson = { headers: { 'content-type': 'application/json' } };

  /** The requested path 404s and its folder holds exactly one case-insensitive match. */
  function serveCaseMatch(canonicalReply: () => void): void {
    const { pool } = harness.current();
    pool
      .intercept({ path: `/vault/${REQUESTED}`, method: 'GET' })
      .reply(404, { message: 'absent' });
    pool.intercept({ path: '/vault/Notes/', method: 'GET' }).reply(200, { files: ['mynote.md'] });
    canonicalReply();
  }

  function serveCanonicalNote(content: string): () => void {
    return () =>
      harness
        .current()
        .pool.intercept({ path: `/vault/${CANONICAL}`, method: 'GET' })
        .reply(200, noteJson(CANONICAL, content), asJson);
  }

  function textOf(res: { content: unknown[] }): string {
    return res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
  }

  it.each([
    [
      'content',
      {},
      () =>
        harness
          .current()
          .pool.intercept({ path: `/vault/${CANONICAL}`, method: 'GET' })
          .reply(200, 'body'),
    ],
    ['full', {}, serveCanonicalNote('body')],
    [
      'document-map',
      {},
      () => {
        servePluginVersion(harness.current().pool, '4.2.0');
        harness
          .current()
          .pool.intercept({ path: `/vault/${CANONICAL}`, method: 'GET' })
          .reply(200, { headings: ['Top'], blocks: [], frontmatterFields: [] }, asJson);
      },
    ],
    [
      'section',
      { section: { type: 'heading', target: 'Root' } },
      serveCanonicalNote('# Root\nbody'),
    ],
  ] as const)(
    'discloses the substitution on both surfaces (format %s)',
    async (format, extra, reply) => {
      serveCaseMatch(reply);
      const res = await runToolContract(obsidianGetNote, {
        format,
        target: { type: 'path', path: REQUESTED },
        ...extra,
      });

      expect(res.isError).toBeFalsy();
      const structured = res.structuredContent as {
        notice?: string;
        requestedPath?: string;
        result: { path: string };
      };
      expect(structured.result.path).toBe(CANONICAL);
      expect(structured.requestedPath).toBe(REQUESTED);
      expect(structured.notice).toBe(CASE_NOTICE);
      expect((res.content.at(-1) as { text: string }).text).toBe(
        `\n\n**requestedPath:** ${REQUESTED}\n> ${CASE_NOTICE}`,
      );
    },
  );

  it('keeps both messages when a substituted section read also matches an ambiguous heading', async () => {
    serveCaseMatch(serveCanonicalNote(DUP_NOTE));
    const res = await runToolContract(obsidianGetNote, {
      format: 'section',
      target: { type: 'path', path: REQUESTED },
      section: { type: 'heading', target: 'Root::Dup' },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      notice?: string;
      requestedPath?: string;
      result: { path: string; candidates?: string[] };
    };
    expect(structured.result).toMatchObject({
      path: CANONICAL,
      candidates: ['Root::Dup', 'Root::Dup'],
    });
    expect(structured.requestedPath).toBe(REQUESTED);
    expect(structured.notice).toBe(`${CASE_NOTICE} ${DUP_NOTICE}`);
    expect((res.content.at(-1) as { text: string }).text).toBe(
      `\n\n**requestedPath:** ${REQUESTED}\n> ${CASE_NOTICE} ${DUP_NOTICE}`,
    );
  });

  it('carries no requestedPath or case notice on an exact-path hit', async () => {
    harness
      .current()
      .pool.intercept({ path: `/vault/${CANONICAL}`, method: 'GET' })
      .reply(200, noteJson(CANONICAL, 'body'), asJson);
    const res = await runToolContract(obsidianGetNote, {
      format: 'full',
      target: { type: 'path', path: CANONICAL },
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).not.toHaveProperty('requestedPath');
    expect(res.structuredContent).not.toHaveProperty('notice');
    expect(textOf(res)).not.toContain('requestedPath');
  });

  it('keeps the heading notice alone on an exact-path ambiguous section read', async () => {
    harness
      .current()
      .pool.intercept({ path: `/vault/${CANONICAL}`, method: 'GET' })
      .reply(200, noteJson(CANONICAL, DUP_NOTE), asJson);
    const res = await runToolContract(obsidianGetNote, {
      format: 'section',
      target: { type: 'path', path: CANONICAL },
      section: { type: 'heading', target: 'Root::Dup' },
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).not.toHaveProperty('requestedPath');
    expect((res.structuredContent as { notice?: string }).notice).toBe(DUP_NOTICE);
  });

  it.each([
    ['an ambiguous_path conflict', ['mynote.md', 'MYNOTE.md'], 'ambiguous_path'],
    ['a "did you mean" miss', ['MyNote'], 'note_missing'],
  ])('carries no requestedPath on %s', async (_label, files, reason) => {
    const { pool } = harness.current();
    pool
      .intercept({ path: `/vault/${REQUESTED}`, method: 'GET' })
      .reply(404, { message: 'absent' });
    pool.intercept({ path: '/vault/Notes/', method: 'GET' }).reply(200, { files });
    const res = await runToolContract(obsidianGetNote, {
      format: 'full',
      target: { type: 'path', path: REQUESTED },
    });

    expect(res.isError).toBe(true);
    expect(
      (res.structuredContent as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe(reason);
    expect(res.structuredContent).not.toHaveProperty('requestedPath');
    expect(textOf(res)).not.toContain('requestedPath');
  });
});

describe('obsidian_get_note / not-found suggestions', () => {
  it('enriches NotFound with `did you mean` candidates from the parent dir', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/Missing.md', method: 'GET' })
      .reply(404, { message: 'absent' });
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/', method: 'GET' })
      .reply(200, { files: ['Missing', 'other.md'] });

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'path', path: 'Notes/Missing.md' },
    });
    await expect(
      obsidianGetNote.handler(input, createMockContext({ errors: obsidianGetNote.errors })),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: expect.stringContaining('Did you mean: "Notes/Missing"?'),
      data: { suggestions: ['Notes/Missing'] },
    });
  });
});

describe('obsidian_get_note / includeLinks', () => {
  function mockFullNote(content: string): void {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(
        200,
        {
          path: 'Note.md',
          content,
          frontmatter: {},
          tags: [],
          stat: { ctime: 0, mtime: 0, size: 0 },
        },
        { headers: { 'content-type': 'application/json' } },
      );
  }

  it('defaults includeLinks to false — outgoingLinks absent', async () => {
    mockFullNote('See [[Other]] and [link](other.md).');
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toBeUndefined();
  });

  it('captures wikilinks with aliases, sections, and embeds; excludes self-section and empty', async () => {
    mockFullNote(
      [
        '[[Project Plan]]',
        '[[Meeting Notes|the meeting]]',
        '![[diagram.png]]',
        '[[Project Plan#Goals]]',
        '[[Project Plan#Goals|alias]]',
        '[[#self-section-only]]',
        '[[]]',
      ].join('\n'),
    );
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([
      { target: 'Project Plan', type: 'wikilink' },
      { target: 'Meeting Notes', type: 'wikilink' },
      { target: 'diagram.png', type: 'wikilink' },
      { target: 'Project Plan', type: 'wikilink' },
      { target: 'Project Plan', type: 'wikilink' },
    ]);
  });

  /**
   * Targets Obsidian 1.14.4's metadata cache derives for each form (read back
   * through the Local REST API's `links` / `unresolvedLinks`): `\|` is the alias
   * separator in a table cell and in prose alike, while `\#` is no escape and
   * `\\|` keeps one backslash.
   */
  const ESCAPED_PIPE_FORMS = [
    ['[[Alpha\\|x]]', 'Alpha'],
    ['![[Beta\\|x]]', 'Beta'],
    ['[[Dir/Gamma\\|x]]', 'Dir/Gamma'],
    ['[[Delta#H\\|x]]', 'Delta'],
    ['[[Epsilon\\#H]]', 'Epsilon\\'],
    ['[[Zeta\\\\|x]]', 'Zeta\\'],
  ] as const;

  it.each([
    ['a table', ['| Link |', '| --- |', ...ESCAPED_PIPE_FORMS.map(([link]) => `| ${link} |`)]],
    ['prose', ESCAPED_PIPE_FORMS.map(([link]) => `- ${link}`)],
  ])(
    'derives the target Obsidian derives for escaped-pipe and backslash forms in %s',
    async (_where, lines) => {
      mockFullNote(lines.join('\n'));
      const input = obsidianGetNote.input.parse({
        format: 'full',
        target: { type: 'path', path: 'Note.md' },
        includeLinks: true,
      });
      const out = await obsidianGetNote.handler(
        input,
        createMockContext({ errors: obsidianGetNote.errors }),
      );
      if (out.result.format !== 'full') throw new Error('expected full branch');
      expect(out.result.outgoingLinks).toEqual(
        ESCAPED_PIPE_FORMS.map(([, target]) => ({ target, type: 'wikilink' })),
      );
    },
  );

  it('carries escaped-pipe targets to structuredContent and the content[] link list', async () => {
    mockFullNote(ESCAPED_PIPE_FORMS.map(([link]) => `| ${link} |`).join('\n'));
    const res = await runToolContract(obsidianGetNote, {
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      result: { outgoingLinks?: Array<{ target: string; type: string }> };
    };
    expect(structured.result.outgoingLinks?.map((l) => l.target)).toEqual(
      ESCAPED_PIPE_FORMS.map(([, target]) => target),
    );
    const text = res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain(
      [
        '**Outgoing links (6)**',
        ...ESCAPED_PIPE_FORMS.map(([, target]) => `- [wikilink] ${target}`),
        '',
        '**Content**',
      ].join('\n'),
    );
  });

  /**
   * Targets Obsidian 1.14.4's metadata cache derives for links carrying single
   * `[` or `]` (read back through the Local REST API's `unresolvedLinks`). A
   * link runs from `[[` to the first `]]` on the same line; single brackets
   * belong to it, but a second `[[` starts it over, and a link broken across
   * lines is not indexed.
   */
  const BRACKET_FORMS = [
    ['[[Ghost Q|a [b]]]', ['Ghost Q']],
    ['[[Ghost R|see [1]]]', ['Ghost R']],
    ['[[Ghost S#Sec [x]|A]]', ['Ghost S']],
    ['[[Ghost T#Sec [x]]]', ['Ghost T']],
    ['[[Ghost U|a [b]]', ['Ghost U']],
    ['[[Ghost V|a ]b]]', ['Ghost V']],
    ['[[Ghost W\\|a [b]]]', ['Ghost W']],
    ['![[Ghost X|a [b]]]', ['Ghost X']],
    ['| [[Ghost Y\\|a [b]]] |', ['Ghost Y']],
    ['[[Ghost AA|x [[Ghost AB]] y]]', ['Ghost AB']],
    ['[[Ghost [AC]]]', ['Ghost [AC']],
    ['[[Ghost AD]x]]', ['Ghost AD]x']],
    ['[[Ghost AE#S]x|A]]', ['Ghost AE']],
    ['[[Ghost AF#S[x|A]]', ['Ghost AF']],
    ['[[Ghost AG|a]b]]', ['Ghost AG']],
    ['[[Ghost AH|[1]]] and [[Ghost AI|[2]]]', ['Ghost AH', 'Ghost AI']],
    ['[[[Ghost BA]]', ['[Ghost BA']],
    ['[[Ghost BB|x]]]', ['Ghost BB']],
    ['[[Ghost BC\n|x]]', []],
    ['[[[[Ghost BD]]', ['[Ghost BD']],
    ['[[ [[Ghost BE]]', ['Ghost BE']],
    ['[[Ghost BF[|a]]', ['Ghost BF[']],
  ] as const;

  it('derives the target Obsidian derives for links containing single brackets', async () => {
    mockFullNote(BRACKET_FORMS.map(([line]) => `- ${line}`).join('\n'));
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual(
      BRACKET_FORMS.flatMap(([, targets]) =>
        targets.map((target) => ({ target, type: 'wikilink' })),
      ),
    );
  });

  /**
   * Each shape repeats an opener that never closes, the worst case for a
   * backtracking scan. Best-of-3 thread CPU time per size; a linear scan grows
   * ~16x from 5k to 80k characters, a quadratic one ~256x.
   */
  it.each([
    ['[['],
    ['[[a'],
    ['[[a|'],
    ['[[a\\'],
    ['[[a|[b]'],
    ['[[a]'],
    ['[[[a'],
    ['['],
    ['[a]('],
    ['[a](<'],
    ['[a](b "'],
    ['[a]((a'],
  ])('scans %j repeated to 80k characters in linear time', async (shape) => {
    async function cpuMs(size: number): Promise<number> {
      const content = shape.repeat(Math.ceil(size / shape.length)).slice(0, size);
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        mockFullNote(content);
        const input = obsidianGetNote.input.parse({
          format: 'full',
          target: { type: 'path', path: 'Note.md' },
          includeLinks: true,
        });
        const ctx = createMockContext({ errors: obsidianGetNote.errors });
        const start = process.threadCpuUsage();
        await obsidianGetNote.handler(input, ctx);
        const used = process.threadCpuUsage(start);
        best = Math.min(best, (used.user + used.system) / 1000);
      }
      return best;
    }

    const small = await cpuMs(5_000);
    const large = await cpuMs(80_000);
    expect(large / small).toBeLessThan(64);
  });

  it('captures internal markdown links and filters external URIs', async () => {
    mockFullNote(
      [
        '[plain](Notes/plain.md)',
        '[relative](../shared.md)',
        '![image](assets/x.png)',
        '[ext](https://anthropic.com)',
        '[mailto](mailto:x@y.com)',
        '![ext-img](https://e.com/i.png)',
      ].join('\n'),
    );
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([
      { target: 'Notes/plain.md', type: 'markdown' },
      { target: '../shared.md', type: 'markdown' },
      { target: 'assets/x.png', type: 'markdown' },
    ]);
  });

  it('keeps balanced parentheses and square brackets inside a bare markdown URL', async () => {
    mockFullNote(['[paren](Notes/Note(1).md)', '[bracket](Notes/Note[1].md)'].join('\n'));
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([
      { target: 'Notes/Note(1).md', type: 'markdown' },
      { target: 'Notes/Note[1].md', type: 'markdown' },
    ]);
  });

  /**
   * Only wikilink targets drop their `#heading`; a markdown link reports its
   * URL as written, fragment included, and the `target` description says so.
   */
  it('reports a markdown link URL as written, `#fragment` included', async () => {
    mockFullNote(['[[Wiki#H]]', '[md](Notes/Md.md#H)'].join('\n'));
    const res = await runToolContract(obsidianGetNote, {
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });

    expect(
      (res.structuredContent as { result: { outgoingLinks?: unknown } }).result.outgoingLinks,
    ).toEqual([
      { target: 'Wiki', type: 'wikilink' },
      { target: 'Notes/Md.md#H', type: 'markdown' },
    ]);
    const full = obsidianGetNote.output.shape.result.options[1];
    expect(full.shape.format.value).toBe('full');
    const description = full.shape.outgoingLinks.unwrap().element.shape.target.description ?? '';
    expect(description).toMatch(/markdown link/i);
    expect(description).toMatch(/as written/);
  });

  it('captures bracketed markdown URLs containing spaces (regression: angle-bracket form)', async () => {
    mockFullNote(
      [
        '[doc](<Notes/with spaces.md>)',
        '[short](<short.md>)',
        '[trim](<  Notes/x.md  >)',
        '[empty](<>)',
      ].join('\n'),
    );
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([
      { target: 'Notes/with spaces.md', type: 'markdown' },
      { target: 'short.md', type: 'markdown' },
      { target: 'Notes/x.md', type: 'markdown' },
    ]);
  });

  it('returns an empty array when the body has no links', async () => {
    mockFullNote('Just prose, no links.\n\nAnother paragraph.');
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([]);
  });

  it('is silently ignored for format: "content"', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, '[[Other]]');

    const input = obsidianGetNote.input.parse({
      format: 'content',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    expect(out.result).toEqual({
      format: 'content',
      path: 'Note.md',
      content: '[[Other]]',
    });
  });

  it('ignores wikilinks and markdown links inside fenced code blocks', async () => {
    mockFullNote(
      [
        '[[Real-Wiki]]',
        '[Real-Md](real.md)',
        '',
        '```markdown',
        '[[Fake-Wiki]]',
        '[Fake-Md](fake.md)',
        '```',
        '',
        '[[After-Wiki]]',
      ].join('\n'),
    );
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([
      { target: 'Real-Wiki', type: 'wikilink' },
      { target: 'After-Wiki', type: 'wikilink' },
      { target: 'real.md', type: 'markdown' },
    ]);
  });

  it('ignores links inside tilde-fenced code blocks too', async () => {
    mockFullNote(
      ['[[Real]]', '', '~~~markdown', '[[Fake]]', '~~~', '', '[[Also-Real]]'].join('\n'),
    );
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([
      { target: 'Real', type: 'wikilink' },
      { target: 'Also-Real', type: 'wikilink' },
    ]);
  });

  it('ignores wikilinks and markdown links inside inline code spans', async () => {
    mockFullNote(
      [
        'Real link: [[Real]] and [Md](real.md).',
        'Syntax: `[[fake-wiki]]` and `[label](fake.md)`.',
      ].join('\n'),
    );
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([
      { target: 'Real', type: 'wikilink' },
      { target: 'real.md', type: 'markdown' },
    ]);
  });

  it('treats an unclosed fence as extending to EOF', async () => {
    mockFullNote(
      ['[[Real]]', '', '```markdown', '[[Fake-Inside-Unclosed]]', 'Still in fence.'].join('\n'),
    );
    const input = obsidianGetNote.input.parse({
      format: 'full',
      target: { type: 'path', path: 'Note.md' },
      includeLinks: true,
    });
    const out = await obsidianGetNote.handler(
      input,
      createMockContext({ errors: obsidianGetNote.errors }),
    );
    if (out.result.format !== 'full') throw new Error('expected full branch');
    expect(out.result.outgoingLinks).toEqual([{ target: 'Real', type: 'wikilink' }]);
  });
});

describe('obsidian_get_note / format()', () => {
  it('renders content', () => {
    const blocks = obsidianGetNote.format!({
      result: { format: 'content', path: 'A.md', content: 'body' },
    });
    expect((blocks[0] as { text: string }).text).toBe('**A.md** (format: content)\n\nbody');
  });

  it('renders full with frontmatter, tags, stat, and content', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'full',
        path: 'A.md',
        content: 'body',
        frontmatter: { author: 'casey' },
        tags: ['t'],
        stat: { ctime: 1, mtime: 2, size: 3 },
      },
    });
    expect((blocks[0] as { text: string }).text).toBe(
      [
        '**A.md** (format: full)',
        '*Tags:* t',
        '*Stat:* ctime=1 mtime=2 size=3',
        '',
        '**Frontmatter**',
        '- `author`: casey',
        '',
        '**Content**',
        'body',
      ].join('\n'),
    );
  });

  it('renders an outgoing-links section when outgoingLinks is populated', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'full',
        path: 'A.md',
        content: 'body',
        frontmatter: {},
        tags: [],
        stat: { ctime: 0, mtime: 0, size: 0 },
        outgoingLinks: [
          { target: 'Other', type: 'wikilink' },
          { target: 'Notes/with spaces.md', type: 'markdown' },
        ],
      },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Outgoing links (2)');
    expect(text).toContain('[wikilink] Other');
    expect(text).toContain('[markdown] Notes/with spaces.md');
  });

  it('omits the outgoing-links section when outgoingLinks is empty or absent', () => {
    const baseResult = {
      format: 'full' as const,
      path: 'A.md',
      content: 'body',
      frontmatter: {},
      tags: [],
      stat: { ctime: 0, mtime: 0, size: 0 },
    };
    const empty = obsidianGetNote.format!({ result: { ...baseResult, outgoingLinks: [] } });
    const absent = obsidianGetNote.format!({ result: baseResult });
    expect((empty[0] as { text: string }).text).not.toContain('Outgoing links');
    expect((absent[0] as { text: string }).text).not.toContain('Outgoing links');
  });

  it('renders a section without resolution metadata unchanged', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'section',
        path: 'A.md',
        section: { type: 'block', target: 'abc' },
        valueText: 'a claim ^abc',
      },
    });
    expect((blocks[0] as { text: string }).text).toBe(
      [
        '**A.md** (format: section)',
        '*Section:* block → abc',
        '',
        '**Value:**',
        'a claim ^abc',
      ].join('\n'),
    );
  });

  /**
   * Asserted as the whole rendered block rather than by substring: the
   * resolved locator is also one of the candidates, so a `toContain` on it
   * passes whether or not the `*Resolved:*` line is rendered at all.
   */
  it('renders the resolved locator and every colliding path for a section', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'section',
        path: 'A.md',
        section: { type: 'heading', target: 'Shared' },
        sectionTarget: 'Overview::Alpha::Shared',
        candidates: ['Overview::Alpha::Shared', 'Overview::Beta::Shared'],
        valueText: '### Shared',
      },
    });
    expect((blocks[0] as { text: string }).text).toBe(
      [
        '**A.md** (format: section)',
        '*Section:* heading → Shared',
        '*Resolved:* Overview::Alpha::Shared',
        '*Candidates:* Overview::Alpha::Shared, Overview::Beta::Shared',
        '',
        '**Value:**',
        '### Shared',
      ].join('\n'),
    );
  });

  /** A heading section carries the resolved locator even with nothing to disambiguate. */
  it('renders the resolved locator for a heading section with no collision', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'section',
        path: 'A.md',
        section: { type: 'heading', target: 'Nested' },
        sectionTarget: 'Root::Nested',
        valueText: '## Nested',
      },
    });
    expect((blocks[0] as { text: string }).text).toBe(
      [
        '**A.md** (format: section)',
        '*Section:* heading → Nested',
        '*Resolved:* Root::Nested',
        '',
        '**Value:**',
        '## Nested',
      ].join('\n'),
    );
  });

  it('renders document-map listing', () => {
    const blocks = obsidianGetNote.format!({
      result: {
        format: 'document-map',
        path: 'A.md',
        headings: ['H1'],
        blocks: ['b1'],
        frontmatterFields: ['f1'],
      },
    });
    expect((blocks[0] as { text: string }).text).toBe(
      [
        '**A.md** (format: document-map)',
        '',
        '**Headings (1)**',
        '- H1',
        '',
        '**Blocks (1)**',
        '- ^b1',
        '',
        '**Frontmatter fields (1)**',
        '- f1',
      ].join('\n'),
    );
  });
});

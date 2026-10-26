/**
 * @fileoverview Handler tests for obsidian_write_note (whole-file PUT and
 * section-targeted PATCH). Covers the response surface — `created` derived
 * from the pre-write HEAD, `previousSizeInBytes` and `currentSizeInBytes`
 * read from upstream HEADs around the write.
 * @module tests/tools/obsidian-write-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianWriteNote } from '@/mcp-server/tools/definitions/obsidian-write-note.tool.js';
import {
  type DispatchOpts,
  type DynamicReply,
  documentMapV2,
  type HeadingTree,
  instructionOf,
  markdownText,
  noteJson,
  repeatKey,
  servePluginVersion,
  setupHarness,
} from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

/**
 * Recorded request headers keep the casing the service sent, so lower-case
 * every key before reading one — an absent-header assertion against a single
 * spelling would pass whatever casing the header actually went out in.
 */
const lowerKeys = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

/** `tree` as ATX heading lines, one level per nesting depth, repeat suffixes dropped. */
function noteFor(tree: HeadingTree, depth = 1): string {
  return Object.entries(tree)
    .map(([key, children]) => {
      const text = key.replace(/\u{FC750}[\u{F6440}-\u{F644F}]+$/u, '');
      return `${'#'.repeat(depth)} ${text}\nbody\n${noteFor(children, depth + 1)}`;
    })
    .join('');
}

/** `tree` as the flat 1.x map's `::`-joined paths, repeats listed once. */
function flatPaths(tree: HeadingTree, parent?: string): string[] {
  const paths = Object.entries(tree).flatMap(([key, children]) => {
    const text = key.replace(/\u{FC750}[\u{F6440}-\u{F644F}]+$/u, '');
    const path = parent === undefined ? text : `${parent}::${text}`;
    return [path, ...flatPaths(children, path)];
  });
  return [...new Set(paths)];
}

/**
 * Answer the reads a heading-targeted write makes on plugin v4.x before its
 * 1.x PATCH: the version report, the flat map, and the note it counts repeats in.
 */
function serveMap(headings: HeadingTree): void {
  const pool = harness.current().pool;
  servePluginVersion(pool, '4.2.0');
  pool
    .intercept({ path: '/vault/Note.md', method: 'GET' })
    .reply(200, { headings: flatPaths(headings), blocks: [], frontmatterFields: [] });
  pool
    .intercept({ path: '/vault/Note.md', method: 'GET' })
    .reply(200, noteJson('Note.md', noteFor(headings)));
}

describe('obsidian_write_note (whole file)', () => {
  it('PUTs the body with text/markdown when the note does not exist', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(404, '');

    let seenMethod = '';
    let seenBody = '';
    let seenContentType = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply((opts) => {
      seenMethod = opts.method as string;
      seenBody = String(opts.body ?? '');
      seenContentType = lowerKeys(opts.headers)['content-type'] ?? '';
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(10));

    const out = await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'fresh body',
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );

    expect(seenMethod).toBe('PUT');
    expect(seenBody).toBe('fresh body');
    expect(seenContentType).toBe('text/markdown');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: false,
      created: true,
      previousSizeInBytes: 0,
      currentSizeInBytes: 10,
    });
  });

  it('refuses to clobber an existing note when overwrite is false', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(500));
    pool.intercept({ path: '/vault/', method: 'GET' }).reply(200, { files: ['Note.md'] });

    let putCalled = false;
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply(() => {
      putCalled = true;
      return { statusCode: 200, data: '' };
    });

    await expect(
      obsidianWriteNote.handler(
        obsidianWriteNote.input.parse({
          target: { type: 'path', path: 'Note.md' },
          content: 'replacement',
        }),
        createMockContext({ errors: obsidianWriteNote.errors }),
      ),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ reason: 'file_exists', path: 'Note.md' }),
    });

    expect(putCalled).toBe(false);
  });

  it('overwrites an existing note when overwrite is true and reports both sizes', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(5000));

    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply((opts) => {
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(11));

    const out = await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'replacement',
        overwrite: true,
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );

    expect(seenBody).toBe('replacement');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: false,
      created: false,
      previousSizeInBytes: 5000,
      currentSizeInBytes: 11,
    });
  });

  /** The case-variant listing runs only on a refused write; a catch-all records anything else. */
  it.each([
    ['a write to a new path', 404, false],
    ['an exact-case overwrite', 200, true],
  ])('sends HEAD, PUT, HEAD and nothing else for %s', async (_label, headStatus, overwrite) => {
    const pool = harness.current().pool;
    const seen: string[] = [];
    const record = (opts: DispatchOpts, statusCode: number): DynamicReply => {
      seen.push(`${opts.method} ${opts.path}`);
      return { statusCode, data: '', responseOptions: { headers: { 'content-length': '4' } } };
    };
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply((o) => record(o, headStatus));
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply((o) => record(o, 200));
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply((o) => record(o, 200));
    pool.intercept({ path: () => true }).reply((o) => record(o, 500));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: 'body',
        overwrite,
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );

    expect(seen).toEqual(['HEAD /vault/Note.md', 'PUT /vault/Note.md', 'HEAD /vault/Note.md']);
  });
});

/**
 * `Notes/case.md` exists; the caller writes `Notes/Case.md`. On a
 * case-insensitive filesystem the HEAD answers 200 for the folded spelling and
 * Obsidian's `Vault.create` refuses the PUT with HTTP 500 "File already
 * exists." (Local REST API 5.2.0). The real name comes from the parent listing.
 */
describe('obsidian_write_note (case variant on a case-insensitive filesystem)', () => {
  const textOf = (res: Awaited<ReturnType<typeof runToolContract>>) =>
    res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
  const errorOf = (res: Awaited<ReturnType<typeof runToolContract>>) =>
    (res.structuredContent as { error: { code: number; data: Record<string, unknown> } }).error;
  const contractRecovery = obsidianWriteNote.errors?.find(
    (e) => e.reason === 'case_variant_exists',
  )?.recovery;
  const input = (overwrite: boolean) => ({
    target: { type: 'path' as const, path: 'Notes/Case.md' },
    content: 'x',
    overwrite,
  });

  /** HEAD 200, then the refused PUT queued four deep; returns the PUT count. */
  function serveRefusedPut(): () => number {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Notes/Case.md', method: 'HEAD' }).reply(200, '', cl(7));
    let puts = 0;
    for (let i = 0; i < 4; i++) {
      pool.intercept({ path: '/vault/Notes/Case.md', method: 'PUT' }).reply(() => {
        puts++;
        return {
          statusCode: 500,
          data: { message: 'Internal Server Error\nFile already exists.', errorCode: 50000 },
        };
      });
    }
    return () => puts;
  }

  /** The parent folder's listing: its files, or a 404 for a listing that fails. */
  function serveListing(files: string[] | 'fails'): void {
    const listing = harness.current().pool.intercept({ path: '/vault/Notes/', method: 'GET' });
    if (files === 'fails') listing.reply(404, {});
    else listing.reply(200, { files });
  }

  it.each([
    ['overwrite: true, after one refused PUT', true, 1],
    ['overwrite: false, before any PUT', false, 0],
  ])('names the existing note on both surfaces (%s)', async (_label, overwrite, putCount) => {
    const puts = serveRefusedPut();
    serveListing(['Other.md', 'case.md']);

    const res = await runToolContract(obsidianWriteNote, input(overwrite));

    expect(res.isError).toBe(true);
    expect(puts()).toBe(putCount);
    const error = errorOf(res);
    expect(error.code).toBe(JsonRpcErrorCode.Conflict);
    expect(error.data).toMatchObject({
      reason: 'case_variant_exists',
      path: 'Notes/Case.md',
      existingPath: 'Notes/case.md',
      recovery: { hint: contractRecovery },
    });
    const text = markdownText(textOf(res));
    expect(text).toContain("Note 'Notes/case.md' already exists");
    expect(text).toContain(contractRecovery);
    expect(text).not.toContain('Internal Server Error');
  });

  it.each([
    ['the exact name is listed', ['Case.md', 'case-notes.md']],
    ['nothing in the folder matches', ['Other.md']],
  ])('keeps file_exists when overwrite is false and %s', async (_label, files) => {
    const puts = serveRefusedPut();
    serveListing(files);

    const res = await runToolContract(obsidianWriteNote, input(false));

    expect(res.isError).toBe(true);
    expect(puts()).toBe(0);
    const { data } = errorOf(res);
    expect(data).toMatchObject({ reason: 'file_exists', path: 'Notes/Case.md' });
    expect(Object.hasOwn(data, 'existingPath')).toBe(false);
  });

  it.each([
    ['no listed file matches ignoring case', ['Other.md']],
    ['more than one listed file matches ignoring case', ['case.md', 'CASE.md']],
    ['the folder listing itself fails', 'fails'],
  ] as Array<[string, string[] | 'fails']>)('omits existingPath when %s', async (_label, files) => {
    const puts = serveRefusedPut();
    serveListing(files);

    const res = await runToolContract(obsidianWriteNote, input(true));

    expect(puts()).toBe(1);
    const { data } = errorOf(res);
    expect(data).toMatchObject({ reason: 'case_variant_exists', path: 'Notes/Case.md' });
    expect(Object.hasOwn(data, 'existingPath')).toBe(false);
    expect(textOf(res)).toContain('Notes/Case.md');
  });

  it.each([
    ['overwrite: true, after the refused PUT', true],
    ['overwrite: false, after the HEAD', false],
  ])('propagates a cancellation during the folder listing (%s)', async (_label, overwrite) => {
    serveRefusedPut();
    const controller = new AbortController();
    const cancelled = Object.assign(new Error('aborted'), { name: 'AbortError' });
    harness
      .current()
      .pool.intercept({ path: '/vault/Notes/', method: 'GET' })
      .reply(() => {
        controller.abort();
        throw cancelled;
      });

    const call = obsidianWriteNote.handler(
      obsidianWriteNote.input.parse(input(overwrite)),
      createMockContext({ signal: controller.signal, errors: obsidianWriteNote.errors }),
    );

    await expect(call).rejects.toBe(cancelled);
  });
});

describe('obsidian_write_note (section)', () => {
  it('PATCHes with replace + heading delimiter (force-apply: no Reject header)', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    serveMap({ Top: { Sub: {} } });

    let seenHeaders: Record<string, string> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = lowerKeys(opts.headers);
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(312));

    const out = await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Sub' },
        content: 'replacement',
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );

    expect(seenHeaders.operation).toBe('replace');
    expect(seenHeaders['target-type']).toBe('heading');
    expect(seenHeaders['target-delimiter']).toBe('::');
    // write-note's section replace hardcodes applyIfContentPreexists: true → no Reject header.
    // (Replace is exempt at the plugin layer anyway; this just keeps intent explicit.)
    expect(seenHeaders).not.toHaveProperty('reject-if-content-preexists');
    expect(out).toEqual({
      path: 'Note.md',
      sectionTargeted: true,
      sectionTarget: 'Top::Sub',
      created: false,
      previousSizeInBytes: 300,
      currentSizeInBytes: 312,
    });
  });

  it('strips a leading duplicate heading line from content when targeting a heading', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    serveMap({ Top: { 'Section A': {} } });

    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Section A' },
        content: '## Section A\n\nbody line 1\nbody line 2',
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );

    expect(seenBody).toBe('body line 1\nbody line 2\n');
  });

  it('preserves content unchanged when the leading heading does not match the target', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    serveMap({ Top: { 'Section A': {} } });

    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Section A' },
        content: '## Different Heading\n\nbody',
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );

    expect(seenBody).toBe('## Different Heading\n\nbody\n');
  });

  /**
   * Captures the PATCH body of a heading-section write of `content` to `target`
   * on plugin v4.x, whose markdown-patch 1.x engine splices content in as
   * given — the service closes it with a line break so it keeps off the next
   * heading.
   */
  async function writtenBody(
    target: string,
    headings: HeadingTree,
    content: string,
  ): Promise<string> {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    serveMap(headings);
    let seenBody = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenBody = String(opts.body ?? '');
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target },
        content,
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );
    return seenBody;
  }

  it('strips a CRLF leading heading line and the blank line after it', async () => {
    const body = await writtenBody(
      'Top::Section A',
      { Top: { 'Section A': {} } },
      '## Section A\r\n\r\nbody',
    );
    expect(body).toBe('body\n');
  });

  it('strips a leading heading written with a closing sequence', async () => {
    const body = await writtenBody('T::Closed', { T: { Closed: {} } }, '## Closed ##\n\nnew body');
    expect(body).toBe('new body\n');
  });

  it.each([
    ['indented', '   ## Section A\n\nbody', 'body\n'],
    ['carrying trailing spaces', '## Section A   \n\nbody', 'body\n'],
    ['with no body after it', '## Section A', ''],
    ['followed by two blank lines, only one of which goes', '## Section A\n\n\nbody', '\nbody\n'],
  ])('strips a leading heading line %s', async (_label, content, expected) => {
    const body = await writtenBody('Top::Section A', { Top: { 'Section A': {} } }, content);
    expect(body).toBe(expected);
  });

  it.each([
    ['below frontmatter', '---\na: 1\n---\n## Section A\nbody'],
    ['on the second line', 'intro\n## Section A\nbody'],
    ['inside a fence', '```\n## Section A\n```\nbody'],
  ])('leaves a heading line that names the target %s', async (_label, content) => {
    const body = await writtenBody('Top::Section A', { Top: { 'Section A': {} } }, content);
    expect(body).toBe(`${content}\n`);
  });

  it('strips a leading setext heading that names the target', async () => {
    const body = await writtenBody(
      'Top::Section A',
      { Top: { 'Section A': {} } },
      'Section A\n---\n\nbody',
    );
    expect(body).toBe('body\n');
  });

  it('keeps a four-space-indented `#` line, which is code rather than a heading', async () => {
    const content = '    ## Section A\nbody';
    const body = await writtenBody('Top::Section A', { Top: { 'Section A': {} } }, content);
    expect(body).toBe(`${content}\n`);
  });

  it('rejects a heading path that repeats in the note without writing', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    // # Root / ## Dup / ## Dup
    serveMap({ Root: { Dup: {}, [repeatKey('Dup', 1)]: {} } });
    // No PATCH intercept — a write here would surface "No mock intercept".

    await expect(
      obsidianWriteNote.handler(
        obsidianWriteNote.input.parse({
          target: { type: 'path', path: 'Note.md' },
          section: { type: 'heading', target: 'Root::Dup' },
          content: 'x',
        }),
        createMockContext({ errors: obsidianWriteNote.errors }),
      ),
    ).rejects.toMatchObject({
      data: { reason: 'ambiguous_section', candidates: ['Root::Dup', 'Root::Dup'] },
    });
  });

  it('uses application/json when contentType is "json"', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(404, '');

    let seenContentType = '';
    pool.intercept({ path: '/vault/Note.md', method: 'PUT' }).reply((opts) => {
      seenContentType = lowerKeys(opts.headers)['content-type'] ?? '';
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(7));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        content: '{"a":1}',
        contentType: 'json',
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );
    expect(seenContentType).toBe('application/json');
  });
});

/** Plugin v5.x speaks markdown-patch 2.0: a JSON instruction body with an array heading target. */
describe('obsidian_write_note (section, plugin v5.x)', () => {
  const textOf = (res: Awaited<ReturnType<typeof runToolContract>>) =>
    res.content.map((b) => (b as { text?: string }).text ?? '').join('\n');

  /**
   * HEAD before the write, the version report, the 2.0 map, and — for content
   * carrying a heading — the note the section's level is read from.
   */
  function serveReads(note?: string) {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    servePluginVersion(pool, '5.2.0');
    pool
      .intercept({ path: '/vault/Note.md', method: 'GET' })
      .reply(200, documentMapV2({ Top: { 'Section A': {} } }));
    if (note !== undefined) {
      pool
        .intercept({ path: '/vault/Note.md', method: 'GET' })
        .reply(200, noteJson('Note.md', note));
    }
    return pool;
  }

  function capture(pool: ReturnType<typeof serveReads>): () => Record<string, unknown> {
    let instruction: Record<string, unknown> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      instruction = instructionOf(opts);
      return { statusCode: 200, data: '' };
    });
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(290));
    return () => instruction;
  }

  it('replaces the section body through a 2.0 instruction and reports it on both surfaces', async () => {
    const sent = capture(serveReads());

    const res = await runToolContract(obsidianWriteNote, {
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Section A' },
      content: '## Section A\n\nbody line 1\nbody line 2',
    });

    expect(res.isError).toBeFalsy();
    expect(sent()).toEqual({
      targetType: 'heading',
      target: ['Top', 'Section A'],
      operation: 'replace',
      content: 'body line 1\nbody line 2',
    });
    expect(res.structuredContent).toEqual({
      path: 'Note.md',
      sectionTargeted: true,
      sectionTarget: 'Top::Section A',
      created: false,
      previousSizeInBytes: 300,
      currentSizeInBytes: 290,
    });
    expect(textOf(res)).toBe(
      [
        '**Wrote Note.md**',
        '*Size:* 300 → 290 bytes',
        '*Section targeted:* true → Top::Section A',
        '*Created:* false',
      ].join('\n'),
    );
  });

  it('keeps a subsection at the level the caller wrote', async () => {
    const sent = capture(serveReads('# Top\n## Section A\nold\n'));

    await obsidianWriteNote.handler(
      obsidianWriteNote.input.parse({
        target: { type: 'path', path: 'Note.md' },
        section: { type: 'heading', target: 'Top::Section A' },
        content: '## Section A\n\nintro\n\n### Detail\nx',
      }),
      createMockContext({ errors: obsidianWriteNote.errors }),
    );

    // `### Detail` is one level under the level-2 section, which is how 2.0 counts it.
    expect(sent().content).toBe('intro\n\n# Detail\nx');
  });

  it('rejects a body whose heading would close the section, without writing', async () => {
    serveReads('# Top\n## Section A\nold\n');
    // No PATCH intercept — a write here would surface "No mock intercept".

    const res = await runToolContract(obsidianWriteNote, {
      target: { type: 'path', path: 'Note.md' },
      section: { type: 'heading', target: 'Top::Section A' },
      content: '## Different Heading\n\nbody',
    });

    expect(res.isError).toBe(true);
    const { error } = res.structuredContent as {
      error: { data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.data.reason).toBe('heading_outside_section');
    expect(error.data.recovery.hint).toContain("obsidian_append_to_note with `section: 'Top'`");
    const text = textOf(res);
    expect(text).toContain("Heading '## Different Heading' in the content is level 2");
    expect(text).toContain('heading_outside_section');
  });
});

describe('obsidian_write_note / format()', () => {
  it('renders Created banner and size delta for new files', () => {
    const blocks = obsidianWriteNote.format!({
      path: 'New.md',
      sectionTargeted: false,
      created: true,
      previousSizeInBytes: 0,
      currentSizeInBytes: 12,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Created New.md**');
    expect(text).toMatch(/Size:\*?\s*0 → 12 bytes/);
    expect(text).toMatch(/Created:\*?\s*true/);
  });

  it('renders Wrote banner with the destructive blast radius on overwrite', () => {
    const blocks = obsidianWriteNote.format!({
      path: 'Existing.md',
      sectionTargeted: false,
      created: false,
      previousSizeInBytes: 5000,
      currentSizeInBytes: 11,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Wrote Existing.md**');
    expect(text).toMatch(/Size:\*?\s*5000 → 11 bytes/);
    expect(text).toMatch(/Created:\*?\s*false/);
  });
});

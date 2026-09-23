/**
 * @fileoverview Handler tests for obsidian_write_note (whole-file PUT and
 * section-targeted PATCH). Covers the response surface — `created` derived
 * from the pre-write HEAD, `previousSizeInBytes` and `currentSizeInBytes`
 * read from upstream HEADs around the write.
 * @module tests/tools/obsidian-write-note.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianWriteNote } from '@/mcp-server/tools/definitions/obsidian-write-note.tool.js';
import {
  documentMapV2,
  type HeadingTree,
  instructionOf,
  noteJson,
  repeatKey,
  servePluginVersion,
  setupHarness,
} from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

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
      const headers = opts.headers as Record<string, string>;
      seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
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
});

describe('obsidian_write_note (section)', () => {
  it('PATCHes with replace + heading delimiter (force-apply: no Reject header)', async () => {
    const pool = harness.current().pool;
    pool.intercept({ path: '/vault/Note.md', method: 'HEAD' }).reply(200, '', cl(300));
    serveMap({ Top: { Sub: {} } });

    let seenHeaders: Record<string, string> = {};
    pool.intercept({ path: '/vault/Note.md', method: 'PATCH' }).reply((opts) => {
      seenHeaders = (opts.headers as Record<string, string>) ?? {};
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

    expect(seenHeaders.operation ?? seenHeaders.Operation).toBe('replace');
    expect(seenHeaders['target-type'] ?? seenHeaders['Target-Type']).toBe('heading');
    expect(seenHeaders['target-delimiter'] ?? seenHeaders['Target-Delimiter']).toBe('::');
    // write-note's section replace hardcodes applyIfContentPreexists: true → no Reject header.
    // (Replace is exempt at the plugin layer anyway; this just keeps intent explicit.)
    expect(
      seenHeaders['reject-if-content-preexists'] ?? seenHeaders['Reject-If-Content-Preexists'],
    ).toBeUndefined();
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

    expect(seenBody).toBe('body line 1\nbody line 2');
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

    expect(seenBody).toBe('## Different Heading\n\nbody');
  });

  /** Captures the PATCH body of a heading-section write of `content` to `target`. */
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
    expect(body).toBe('body');
  });

  it('strips a leading heading written with a closing sequence', async () => {
    const body = await writtenBody('T::Closed', { T: { Closed: {} } }, '## Closed ##\n\nnew body');
    expect(body).toBe('new body');
  });

  it.each([
    ['indented', '   ## Section A\n\nbody', 'body'],
    ['carrying trailing spaces', '## Section A   \n\nbody', 'body'],
    ['with no body after it', '## Section A', ''],
    ['followed by two blank lines, only one of which goes', '## Section A\n\n\nbody', '\nbody'],
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
    expect(body).toBe(content);
  });

  it('strips a leading setext heading that names the target', async () => {
    const body = await writtenBody(
      'Top::Section A',
      { Top: { 'Section A': {} } },
      'Section A\n---\n\nbody',
    );
    expect(body).toBe('body');
  });

  it('keeps a four-space-indented `#` line, which is code rather than a heading', async () => {
    const content = '    ## Section A\nbody';
    const body = await writtenBody('Top::Section A', { Top: { 'Section A': {} } }, content);
    expect(body).toBe(content);
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
      const headers = opts.headers as Record<string, string>;
      seenContentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
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
    expect(textOf(res)).toContain('Top::Section A');
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

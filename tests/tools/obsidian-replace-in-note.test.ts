/**
 * @fileoverview Handler tests for obsidian_replace_in_note (read → mutate → write).
 * @module tests/tools/obsidian-replace-in-note.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { obsidianReplaceInNote } from '@/mcp-server/tools/definitions/obsidian-replace-in-note.tool.js';
import { setupHarness } from '../helpers.js';

const harness = setupHarness();

const cl = (n: number) => ({ headers: { 'content-length': String(n) } });

const noteJson = (content: string) => ({
  path: 'N.md',
  content,
  frontmatter: {},
  tags: [],
  stat: { ctime: 0, mtime: 0, size: content.length },
});

/** Stubs the GET → PUT → HEAD round-trip for a successful replace. */
function stubReplaceFlow(beforeContent: string, afterSize: number) {
  const pool = harness.current().pool;
  let putBody = '';
  pool
    .intercept({ path: '/vault/N.md', method: 'GET' })
    .reply(200, noteJson(beforeContent), { headers: { 'content-type': 'application/json' } });
  pool.intercept({ path: '/vault/N.md', method: 'PUT' }).reply((opts) => {
    putBody = String(opts.body ?? '');
    return { statusCode: 200, data: '' };
  });
  pool.intercept({ path: '/vault/N.md', method: 'HEAD' }).reply(200, '', cl(afterSize));
  return () => putBody;
}

describe('obsidian_replace_in_note', () => {
  it('applies replacements sequentially and writes the result back', async () => {
    const before = 'Hello world. Hello there.';
    const after = 'Hi earth. Hi there.';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [
          { search: 'Hello', replace: 'Hi' },
          { search: 'Hi world', replace: 'Hi earth' },
        ],
      }),
      createMockContext(),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(3);
    expect(out.perReplacement).toEqual([
      { search: 'Hello', count: 2 },
      { search: 'Hi world', count: 1 },
    ]);
    expect(out.previousSizeInBytes).toBe(Buffer.byteLength(before, 'utf8'));
    expect(out.currentSizeInBytes).toBe(Buffer.byteLength(after, 'utf8'));
  });

  it('skips the write when no replacement matched and currentSize equals previousSize', async () => {
    let putCalls = 0;
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('untouched'), { headers: { 'content-type': 'application/json' } });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply(() => {
        putCalls++;
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'absent', replace: 'present' }],
      }),
      createMockContext(),
    );

    expect(out.totalReplacements).toBe(0);
    expect(putCalls).toBe(0);
    expect(out.previousSizeInBytes).toBe(out.currentSizeInBytes);
  });

  it('honors useRegex and caseSensitive flags', async () => {
    const before = 'Foo foo FOO';
    const after = 'bar bar bar';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'foo', replace: 'bar', useRegex: true, caseSensitive: false }],
      }),
      createMockContext(),
    );

    expect(out.totalReplacements).toBe(3);
    expect(getBody()).toBe(after);
  });

  it('honors $1/$2 capture-group references in regex replacements', async () => {
    const before = 'The quick brown fox.';
    const after = 'The brown quick fox.';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: '(quick) (brown)', replace: '$2 $1', useRegex: true }],
      }),
      createMockContext(),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(1);
  });

  it('honors wholeWord in literal mode (avoids substring matches)', async () => {
    const before = 'cat scatter category cat.';
    const after = 'dog scatter category dog.';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'cat', replace: 'dog', wholeWord: true }],
      }),
      createMockContext(),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(2);
  });

  it('honors wholeWord in regex mode (wraps the pattern in \\b…\\b)', async () => {
    const before = 'foo foobar foo';
    const after = 'X foobar X';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'fo+', replace: 'X', useRegex: true, wholeWord: true }],
      }),
      createMockContext(),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(2);
  });

  it('honors flexibleWhitespace in literal mode (collapses runs of whitespace)', async () => {
    const before = 'the  quick\tbrown\nfox  jumps';
    const after = 'the  slow red\nfox  jumps';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'quick brown', replace: 'slow red', flexibleWhitespace: true }],
      }),
      createMockContext(),
    );

    expect(getBody()).toBe(after);
    expect(out.totalReplacements).toBe(1);
  });

  it('keeps `$1` literal in literal mode with wholeWord (no capture-group expansion)', async () => {
    const before = 'cat sat';
    const after = 'dog$1 sat';
    const getBody = stubReplaceFlow(before, Buffer.byteLength(after, 'utf8'));

    await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'cat', replace: 'dog$1', wholeWord: true }],
      }),
      createMockContext(),
    );

    expect(getBody()).toBe(after);
  });

  it('throws regex_invalid (ValidationError) on a malformed regex', async () => {
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('body'), { headers: { 'content-type': 'application/json' } });

    await expect(
      obsidianReplaceInNote.handler(
        obsidianReplaceInNote.input.parse({
          target: { type: 'path', path: 'N.md' },
          replacements: [{ search: '(', replace: 'x', useRegex: true }],
        }),
        createMockContext({ errors: obsidianReplaceInNote.errors }),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'regex_invalid' },
    });
  });
});

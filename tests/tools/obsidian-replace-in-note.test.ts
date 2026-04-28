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

const noteJson = (content: string) => ({
  path: 'N.md',
  content,
  frontmatter: {},
  tags: [],
  stat: { ctime: 0, mtime: 0, size: content.length },
});

describe('obsidian_replace_in_note', () => {
  it('applies replacements sequentially and writes the result back', async () => {
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('Hello world. Hello there.'), {
        headers: { 'content-type': 'application/json' },
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

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

    expect(putBody).toBe('Hi earth. Hi there.');
    expect(out.totalReplacements).toBe(3);
    expect(out.perReplacement).toEqual([
      { search: 'Hello', count: 2 },
      { search: 'Hi world', count: 1 },
    ]);
  });

  it('skips the write when no replacement matched', async () => {
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
  });

  it('honors useRegex and caseSensitive flags', async () => {
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('Foo foo FOO'), { headers: { 'content-type': 'application/json' } });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'foo', replace: 'bar', useRegex: true, caseSensitive: false }],
      }),
      createMockContext(),
    );

    expect(out.totalReplacements).toBe(3);
    expect(putBody).toBe('bar bar bar');
  });

  it('honors $1/$2 capture-group references in regex replacements', async () => {
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('The quick brown fox.'), {
        headers: { 'content-type': 'application/json' },
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: '(quick) (brown)', replace: '$2 $1', useRegex: true }],
      }),
      createMockContext(),
    );

    expect(putBody).toBe('The brown quick fox.');
    expect(out.totalReplacements).toBe(1);
  });

  it('honors wholeWord in literal mode (avoids substring matches)', async () => {
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('cat scatter category cat.'), {
        headers: { 'content-type': 'application/json' },
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'cat', replace: 'dog', wholeWord: true }],
      }),
      createMockContext(),
    );

    expect(putBody).toBe('dog scatter category dog.');
    expect(out.totalReplacements).toBe(2);
  });

  it('honors wholeWord in regex mode (wraps the pattern in \\b…\\b)', async () => {
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('foo foobar foo'), {
        headers: { 'content-type': 'application/json' },
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'fo+', replace: 'X', useRegex: true, wholeWord: true }],
      }),
      createMockContext(),
    );

    expect(putBody).toBe('X foobar X');
    expect(out.totalReplacements).toBe(2);
  });

  it('honors flexibleWhitespace in literal mode (collapses runs of whitespace)', async () => {
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('the  quick\tbrown\nfox  jumps'), {
        headers: { 'content-type': 'application/json' },
      });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

    const out = await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'quick brown', replace: 'slow red', flexibleWhitespace: true }],
      }),
      createMockContext(),
    );

    expect(putBody).toBe('the  slow red\nfox  jumps');
    expect(out.totalReplacements).toBe(1);
  });

  it('keeps `$1` literal in literal mode with wholeWord (no capture-group expansion)', async () => {
    let putBody = '';
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'GET' })
      .reply(200, noteJson('cat sat'), { headers: { 'content-type': 'application/json' } });
    harness
      .current()
      .pool.intercept({ path: '/vault/N.md', method: 'PUT' })
      .reply((opts) => {
        putBody = String(opts.body ?? '');
        return { statusCode: 200, data: '' };
      });

    await obsidianReplaceInNote.handler(
      obsidianReplaceInNote.input.parse({
        target: { type: 'path', path: 'N.md' },
        replacements: [{ search: 'cat', replace: 'dog$1', wholeWord: true }],
      }),
      createMockContext(),
    );

    expect(putBody).toBe('dog$1 sat');
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

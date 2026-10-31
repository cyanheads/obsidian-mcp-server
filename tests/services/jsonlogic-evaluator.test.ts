/**
 * @fileoverview Tests for the server-side JSONLogic evaluator that scoped
 * searches run: plugin-identical results, the hardened operator set, and the
 * bounds — tree depth, the per-note and per-search work budgets, deadline —
 * plus cancellation. Each case runs the real worker thread.
 * @module tests/services/jsonlogic-evaluator.test
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoLinkFields,
  assertTreeDepth,
  createJsonLogicEvaluation,
  MAX_TREE_DEPTH,
  readsContent,
} from '@/services/obsidian/jsonlogic-evaluator.js';
import type { NoteContext } from '@/services/obsidian/jsonlogic-worker.js';
import { rejectionOf } from '../helpers.js';

/** A one-batch evaluation, its worker closed once it answers. */
async function evaluateJsonLogic(
  logic: unknown,
  notes: NoteContext[],
  opts?: Parameters<typeof createJsonLogicEvaluation>[1],
) {
  const evaluation = createJsonLogicEvaluation(logic, opts);
  try {
    return await evaluation.evaluate(notes);
  } finally {
    await evaluation.close();
  }
}

/** Spy on every JSONLogic worker: the instances handed a batch, and those terminated. */
function spyOnWorkers() {
  const post = vi.spyOn(Worker.prototype, 'postMessage');
  const terminate = vi.spyOn(Worker.prototype, 'terminate');
  return {
    batches: () =>
      post.mock.calls.map(([request]) =>
        (request as { notes: NoteContext[] }).notes.map((n) => n.path),
      ),
    instances: () => new Set(post.mock.contexts),
    terminated: () => new Set(terminate.mock.contexts),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const note = (path: string, fields: Record<string, unknown> = {}) => ({
  tags: [],
  frontmatter: {},
  stat: { ctime: 1, mtime: 2, size: 3 },
  path,
  content: '',
  links: [],
  backlinks: [],
  unresolvedLinks: [],
  ...fields,
});

/** Exactly `depth` (even, ≥ 2) levels of nested objects and arrays, innermost a `var`. */
function nested(depth: number): unknown {
  let tree: unknown = { var: ['path'] };
  for (let level = 4; level <= depth; level += 2) tree = { '!!': [tree] };
  return tree;
}

async function tooCostly(p: Promise<unknown>): Promise<McpError> {
  const err = await rejectionOf<McpError>(p);
  expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
  expect(err.data).toEqual({ reason: 'logic_too_costly' });
  return err;
}

describe('evaluateJsonLogic — plugin parity', () => {
  it('keeps a hit only for a truthy result and shapes results by a JSON round trip', async () => {
    const notes = [note('a.md', { tags: ['x'] }), note('b.md')];
    expect(await evaluateJsonLogic({ var: 'tags' }, notes)).toEqual([
      { filename: 'a.md', result: ['x'] },
    ]);
    // Infinity is truthy, and serializes as null on the plugin's wire.
    expect(await evaluateJsonLogic({ '/': [1, 0] }, notes)).toEqual([
      { filename: 'a.md', result: null },
      { filename: 'b.md', result: null },
    ]);
  });

  it('takes glob and regexp operands pattern first, and false for a non-string operand', async () => {
    const notes = [note('Work/a.md'), note('Other/b.md')];
    expect(await evaluateJsonLogic({ glob: ['Work/*', { var: 'path' }] }, notes)).toEqual([
      { filename: 'Work/a.md', result: true },
    ]);
    expect(await evaluateJsonLogic({ regexp: ['^Other/', { var: 'path' }] }, notes)).toEqual([
      { filename: 'Other/b.md', result: true },
    ]);
    expect(await evaluateJsonLogic({ regexp: ['.', { var: 'stat' }] }, notes)).toEqual([]);
  });

  it('fails the whole search with logic_invalid when the tree throws on any note', async () => {
    const regexp = await rejectionOf<McpError>(
      evaluateJsonLogic({ regexp: ['(', { var: 'path' }] }, [note('a.md')]),
    );
    expect(regexp.data).toEqual({ reason: 'logic_invalid' });
    expect(regexp.message).toMatch(/`regexp`.*\[PATTERN, VALUE\]/);

    const unknown = await rejectionOf<McpError>(evaluateJsonLogic({ nope: [1] }, [note('a.md')]));
    expect(unknown.data).toEqual({ reason: 'logic_invalid' });
    expect(unknown.message).toBe('The JSONLogic tree could not be evaluated.');
  });

  it('reads own properties only through var', async () => {
    const notes = [note('a.md')];
    expect(await evaluateJsonLogic({ var: 'path.length' }, notes)).toEqual([
      { filename: 'a.md', result: 4 },
    ]);
    for (const key of ['path.constructor', '__proto__', 'tags.map', 'stat.toString']) {
      expect(await evaluateJsonLogic({ var: key }, notes), key).toEqual([]);
    }
    expect(await evaluateJsonLogic({ missing: ['constructor', 'path'] }, notes)).toEqual([
      { filename: 'a.md', result: ['constructor'] },
    ]);
  });

  it('answers an empty note set without evaluating', async () => {
    const workers = spyOnWorkers();
    expect(await evaluateJsonLogic({ nope: [1] }, [])).toEqual([]);
    expect(workers.instances().size).toBe(0);
  });

  it('reads note bodies on the plugin rule: the string "content" anywhere in the tree', () => {
    expect(readsContent({ in: ['x', { var: 'content' }] })).toBe(true);
    expect(readsContent({ '==': ['content', 'y'] })).toBe(true);
    expect(readsContent({ var: '' })).toBe(false);
    expect(readsContent({ var: 'contents' })).toBe(false);
  });
});

describe('createJsonLogicEvaluation — one worker per search', () => {
  it('evaluates every batch on one worker, terminated only once the evaluation closes', async () => {
    const workers = spyOnWorkers();
    const evaluation = createJsonLogicEvaluation({ var: 'path' });
    for (const batch of [['a.md'], ['b.md', 'c.md'], ['d.md']]) {
      expect(await evaluation.evaluate(batch.map((path) => note(path)))).toEqual(
        batch.map((path) => ({ filename: path, result: path })),
      );
    }
    expect(workers.batches()).toEqual([['a.md'], ['b.md', 'c.md'], ['d.md']]);
    expect(workers.instances().size).toBe(1);
    expect(workers.terminated().size).toBe(0);
    await evaluation.close();
    await evaluation.close();
    expect(workers.terminated()).toEqual(workers.instances());
  });

  it.each([
    ['fails on a note', { regexp: ['(', { var: 'path' }] }, 'logic_invalid'],
    [
      'passes a work budget',
      { map: [Array.from({ length: 1_000 }, (_, i) => i), ['y'.repeat(100_000)]] },
      'logic_too_costly',
    ],
  ])('terminates its worker when a batch %s', async (_label, logic, reason) => {
    const workers = spyOnWorkers();
    const evaluation = createJsonLogicEvaluation(logic);
    const err = await rejectionOf<McpError>(evaluation.evaluate([note('a.md')]));
    expect(err.data).toEqual({ reason });
    expect(workers.instances().size).toBe(1);
    expect(workers.terminated()).toEqual(workers.instances());
  });

  it('starts no worker for a search whose batches are all empty, and closes cleanly', async () => {
    const workers = spyOnWorkers();
    const evaluation = createJsonLogicEvaluation({ var: 'path' });
    expect(await evaluation.evaluate([])).toEqual([]);
    await evaluation.close();
    expect(workers.instances().size).toBe(0);
    expect(workers.terminated().size).toBe(0);
  });
});

/**
 * Under a read scope the note contexts carry no link fields, so a tree naming
 * one by a `var`, `missing`, or `missing_some` key the note is read through
 * fails at once, before any request, rather than evaluating to `null` on
 * every note.
 */
describe('assertNoLinkFields', () => {
  it.each([
    ['a bare field', { var: 'links' }, 'links'],
    ['a path into a field', { var: 'backlinks.0' }, 'backlinks'],
    ['the array form with a default', { var: ['unresolvedLinks', []] }, 'unresolvedLinks'],
    ['the array form without one', { var: ['links'] }, 'links'],
    ['a key built from a literal array', { var: [['backlinks']] }, 'backlinks'],
    ['a field read for its length', { var: 'links.length' }, 'links'],
    ['a membership test', { in: ['Work/x', { var: 'unresolvedLinks' }] }, 'unresolvedLinks'],
    [
      'a test nested in boolean logic',
      { and: [{ '==': [{ var: 'path' }, 'a.md'] }, { or: [false, { var: 'backlinks' }] }] },
      'backlinks',
    ],
    ['the array a map walks', { map: [{ var: 'links' }, { var: '' }] }, 'links'],
    [
      "a reduce's initial value",
      { reduce: [{ var: 'tags' }, { var: 'current' }, { var: 'links' }] },
      'links',
    ],
    ['a var computing another var key', { var: [{ var: 'backlinks.0' }] }, 'backlinks'],
    ['an element of an array literal', [1, { var: 'links' }], 'links'],
  ])('rejects %s', (_label, logic, field) => {
    let thrown: unknown;
    try {
      assertNoLinkFields(logic);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'link_fields_unavailable' },
    });
    expect((thrown as Error).message).toMatch(new RegExp(`^The JSONLogic tree reads \`${field}\``));
  });

  it.each([
    ['a field whose name starts like one', { var: 'linksTo' }],
    ['a frontmatter key named like one', { var: 'frontmatter.links' }],
    ['a computed key', { var: { cat: ['back', 'links'] } }],
    ['a computed key with a default', { var: [{ cat: ['un', 'resolvedLinks'] }, []] }],
    ['the elements a map walks', { map: [{ var: 'frontmatter.items' }, { var: 'links' }] }],
    ['the elements a filter tests', { filter: [{ var: 'tags' }, { var: 'backlinks' }] }],
    ['the elements some tests', { some: [{ var: 'tags' }, { var: 'links.0' }] }],
    ["a reduce's step", { reduce: [{ var: 'tags' }, { var: 'links' }, 0] }],
    ['the field name as a string', { '==': [{ var: 'path' }, 'links'] }],
    ['an object literal no operator reads', { a: { var: 'links' }, b: 1 }],
    ['the whole note', { var: '' }],
  ])('accepts %s', (_label, logic) => {
    expect(() => assertNoLinkFields(logic)).not.toThrow();
  });

  /**
   * `missing` reads each key through `var`. json-logic-js takes its keys from
   * a first argument that is an array, and otherwise from every argument;
   * `missing_some` hands its second operand to `missing` as those arguments.
   */
  it.each([
    ['missing keys spread as arguments', { missing: ['links', 'backlinks'] }, 'links'],
    ['missing keys in one array argument', { missing: [['path', 'backlinks']] }, 'backlinks'],
    ['missing with a lone key', { missing: 'unresolvedLinks' }, 'unresolvedLinks'],
    ['a dotted missing key', { missing: ['path', 'backlinks.0'] }, 'backlinks'],
    ['a dotted key in one array argument', { missing: [['links.0']] }, 'links'],
    ['a missing key written as a literal array', { missing: ['path', ['backlinks']] }, 'backlinks'],
    [
      'a fixed missing key beside a computed one',
      { missing: [[{ var: 'frontmatter.key' }, 'unresolvedLinks']] },
      'unresolvedLinks',
    ],
    [
      'a fixed first missing key before a computed one',
      { missing: ['backlinks', { var: 'frontmatter.key' }] },
      'backlinks',
    ],
    ['missing_some keys', { missing_some: [1, ['path', 'links']] }, 'links'],
    ['a dotted missing_some key', { missing_some: [2, ['tags', 'backlinks.0']] }, 'backlinks'],
    [
      'missing_some keys in one array argument',
      { missing_some: [1, [['unresolvedLinks', 'path']]] },
      'unresolvedLinks',
    ],
    ['missing_some with a lone key', { missing_some: [1, 'backlinks'] }, 'backlinks'],
    [
      'missing_some with a computed count',
      { missing_some: [{ var: 'frontmatter.n' }, ['links']] },
      'links',
    ],
    ['a missing test in if', { if: [{ missing: ['links'] }, 'none', 'some'] }, 'links'],
    [
      'a missing_some test nested in and/or',
      {
        and: [
          { '==': [{ var: 'path' }, 'a.md'] },
          { or: [false, { missing_some: [1, ['backlinks.0']] }] },
        ],
      },
      'backlinks',
    ],
    [
      'the array some walks, built by missing',
      { some: [{ missing: ['backlinks'] }, { '==': [{ var: '' }, 'backlinks'] }] },
      'backlinks',
    ],
    [
      'the array a map walks, built by missing_some',
      { map: [{ missing_some: [1, ['links', 'tags']] }, { var: '' }] },
      'links',
    ],
  ])('rejects %s', (_label, logic, field) => {
    expect(() => assertNoLinkFields(logic)).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'link_fields_unavailable' },
        message: expect.stringMatching(new RegExp(`^The JSONLogic tree reads \`${field}\``)),
      }),
    );
  });

  it.each([
    ['missing keys none of which is a link field', { missing: ['frontmatter.links', 'linksTo'] }],
    ['missing_some keys none of which is a link field', { missing_some: [1, ['path', 'tags.0']] }],
    ['a computed missing key', { missing: ['path', { cat: ['back', 'links'] }] }],
    ['a computed key in one array argument', { missing: [[{ cat: ['lin', 'ks'] }]] }],
    ['a computed missing key list', { missing: { merge: [['backlinks']] } }],
    [
      'a key list whose form a computed first argument decides',
      { missing: [{ var: 'frontmatter.keys' }, 'backlinks'] },
    ],
    ['a computed missing_some key list', { missing_some: [1, { var: 'frontmatter.keys' }] }],
    ['a key after a first array argument, which missing ignores', { missing: [['path'], 'links'] }],
    ['missing on the elements some tests', { some: [{ var: 'tags' }, { missing: ['links'] }] }],
    [
      'missing_some on the elements a filter tests',
      { filter: [{ var: 'frontmatter.items' }, { missing_some: [1, ['backlinks', 'x']] }] },
    ],
    ['missing on the elements all tests', { all: [{ var: 'tags' }, { missing: [['backlinks']] }] }],
    ['missing on the elements a map walks', { map: [{ var: 'tags' }, { missing: 'links.0' }] }],
  ])('accepts %s', (_label, logic) => {
    expect(() => assertNoLinkFields(logic)).not.toThrow();
  });

  it(`finds a link field at the bottom of a ${MAX_TREE_DEPTH}-level tree, and walks a wide one`, () => {
    let deep: unknown = { var: ['backlinks'] };
    for (let level = 4; level <= MAX_TREE_DEPTH; level += 2) deep = { '!!': [deep] };
    expect(() => assertTreeDepth(deep)).not.toThrow();
    expect(() => assertNoLinkFields(deep)).toThrow(
      expect.objectContaining({ data: { reason: 'link_fields_unavailable' } }),
    );
    const wide = {
      or: [...Array.from({ length: 100_000 }, () => ({ var: 'path' })), { var: 'links' }],
    };
    expect(() => assertNoLinkFields(wide)).toThrow(
      expect.objectContaining({ data: { reason: 'link_fields_unavailable' } }),
    );
  });
});

/**
 * Under stdio the process's stdout is the JSON-RPC stream. A child process
 * runs the evaluator so its stdout can be read whole.
 */
describe('evaluateJsonLogic — the log operator', () => {
  it('returns its argument and writes nothing to stdout', () => {
    const evaluator = pathToFileURL(
      fileURLToPath(new URL('../../src/services/obsidian/jsonlogic-evaluator.ts', import.meta.url)),
    ).href;
    // A promise chain rather than top-level await: Node evaluates `-e` as CommonJS,
    // and `--input-type` would be inherited by the evaluator's worker.
    const code = `import(${JSON.stringify(evaluator)})
  .then(async ({ createJsonLogicEvaluation }) => {
    const evaluation = createJsonLogicEvaluation({ log: { var: 'path' } });
    const hits = await evaluation.evaluate([{ path: 'log-marker.md' }]);
    await evaluation.close();
    return hits;
  })
  .then((hits) => process.stderr.write(JSON.stringify(hits)));`;
    const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 30_000 });
    expect(child.stderr).toBe('[{"filename":"log-marker.md","result":"log-marker.md"}]');
    expect(child.stdout).toBe('');
  });
});

describe('evaluateJsonLogic — bounds', () => {
  it(`rejects a tree nested deeper than ${MAX_TREE_DEPTH} levels, and accepts one at the limit`, () => {
    expect(() => assertTreeDepth(nested(MAX_TREE_DEPTH))).not.toThrow();
    expect(() => assertTreeDepth(nested(MAX_TREE_DEPTH + 2))).toThrow(
      expect.objectContaining({ data: { reason: 'logic_too_costly' } }),
    );
    // A wide tree is not a deep one.
    expect(() =>
      assertTreeDepth({ and: Array.from({ length: 10_000 }, () => true) }),
    ).not.toThrow();
  });

  it('answers a 1,000-level tree, as the plugin does, and still rejects one past every stack', async () => {
    expect(await evaluateJsonLogic(nested(1_000), [note('a.md')])).toEqual([
      { filename: 'a.md', result: true },
    ]);
    // A unary chain spends the most stack per level, in the worker hand-off and in evaluation.
    let unary: unknown = { var: 'path' };
    for (let level = 2; level <= 1_000; level++) unary = { '!!': unary };
    expect(() => assertTreeDepth(unary)).not.toThrow();
    expect(await evaluateJsonLogic(unary, [note('a.md')])).toEqual([
      { filename: 'a.md', result: true },
    ]);
    // Neither the plugin nor the worker evaluates 20,000 levels; that fails as a bound, before any recursion.
    expect(() => assertTreeDepth(nested(20_000))).toThrow(
      expect.objectContaining({
        message: 'The JSONLogic tree nests deeper than 1,000 levels.',
        data: { reason: 'logic_too_costly' },
      }),
    );
  });

  const hundred = Array.from({ length: 100 }, (_, i) => i);

  it.each([
    [
      'nested map fan-out',
      { map: [hundred, { map: [hundred, { map: [hundred, { map: [hundred, 1] }] }] }] },
    ],
    [
      'an array doubled by reduce',
      {
        reduce: [
          hundred,
          { merge: [{ var: 'accumulator' }, { var: 'accumulator' }] },
          [{ var: 'content' }],
        ],
      },
    ],
    [
      'a string doubled by reduce',
      { reduce: [hundred, { cat: [{ var: 'accumulator' }, { var: 'accumulator' }] }, 'x'] },
    ],
    [
      'an array literal repeating a large field',
      Array.from({ length: 50 }, () => ({ var: 'content' })),
    ],
    [
      'a nested array literal repeating a large field',
      [[Array.from({ length: 50 }, () => ({ var: 'content' }))]],
    ],
    [
      'a constant multiplied by map',
      {
        '==': [{ map: [Array.from({ length: 1_000 }, (_, i) => i), ['y'.repeat(100_000)]] }, 'x'],
      },
    ],
  ])('stops %s at the work budget', async (_label, logic) => {
    const notes = [note('a.md', { content: 'y'.repeat(500_000) })];
    const started = process.threadCpuUsage();
    const err = await tooCostly(evaluateJsonLogic(logic, notes));
    expect(err.message).toMatch(/work budget of 10,000,000 units/);
    expect(err.message).toMatch(/^Evaluating the JSONLogic tree on one readable note built more/);
    // The budget stopped it, not the deadline, and the main thread did no work.
    const used = process.threadCpuUsage(started);
    expect((used.user + used.system) / 1000).toBeLessThan(2_000);
  });

  it('answers a path list of 1,000 over 11,000 notes: testing membership builds nothing', async () => {
    const pathOf = (i: number) => `Projects/Area ${i % 40}/Meeting notes ${i}.md`;
    const notes = Array.from({ length: 11_000 }, (_, i) => note(pathOf(i)));
    const wanted = Array.from({ length: 1_000 }, (_, i) => pathOf(i * 11));
    // About 11,000,000 evaluation steps, none of which builds anything.
    const hits = await evaluateJsonLogic({ in: [{ var: 'path' }, wanted] }, notes);
    expect(hits).toHaveLength(1_000);
    expect(hits[999]).toEqual({ filename: pathOf(10_989), result: true });
  });

  it('answers link, tag, and content predicates however many steps they take', async () => {
    const notes = Array.from({ length: 1_000 }, (_, i) =>
      note(`Area ${i % 40}/Note ${i}.md`, {
        tags: ['project', `area/${i % 40}`],
        links: [
          ...Array.from({ length: 60 }, (_, j) => `Area ${j % 40}/Link ${i}-${j}.md`),
          ...(i % 100 === 0 ? ['Hub.md'] : []),
        ],
        content: i % 7 === 0 ? `see [[Target ${i}]]` : 'nothing here',
      }),
    );
    // Sixty links per note, each tested against 200 names: about 12,000,000 evaluation steps.
    const names = [...Array.from({ length: 199 }, (_, k) => `Never ${k}.md`), 'Hub.md'];
    const hubHits = await evaluateJsonLogic(
      { some: [{ var: 'links' }, { in: [{ var: '' }, names] }] },
      notes,
    );
    expect(hubHits).toHaveLength(10);
    expect(hubHits[1]).toEqual({ filename: 'Area 20/Note 100.md', result: true });

    const areaTags = await evaluateJsonLogic(
      { filter: [{ var: 'tags' }, { in: ['area/', { var: '' }] }] },
      notes,
    );
    expect(areaTags).toHaveLength(1_000);
    expect(areaTags[41]).toEqual({ filename: 'Area 1/Note 41.md', result: ['area/1'] });

    const targets = await evaluateJsonLogic(
      { regexp: ['\\[\\[Target \\d+\\]\\]', { var: 'content' }] },
      notes,
    );
    expect(targets).toHaveLength(143);
    expect(targets[1]).toEqual({ filename: 'Area 7/Note 7.md', result: true });
  });

  it.each([
    ['a large literal default', { var: ['absent', 'x'.repeat(50_000)] }],
    ['a constant repeated by map', { map: [hundred, 'x'.repeat(10_000)] }],
  ])('charges each kept result holding %s, at the work budget', async (_label, logic) => {
    const notes = Array.from({ length: 400 }, (_, i) => note(`n${i}.md`));
    const err = await tooCostly(evaluateJsonLogic(logic, notes));
    expect(err.message).toMatch(/work budget of 10,000,000 units/);
    expect(err.message).toMatch(/^The JSONLogic tree's results over the readable notes held more/);
  });

  it('keeps results of up to 1,024 serialized characters free, and charges a larger one past its note', async () => {
    const notes = Array.from({ length: 12_000 }, (_, i) => note(`n${i}.md`));
    // 12,000 kept constants of 1,002 serialized characters hold 12,024,000, past the search's budget.
    const free = await evaluateJsonLogic({ var: ['absent', 'x'.repeat(1_000)] }, notes);
    expect(free).toHaveLength(12_000);
    expect(free[11_999]).toEqual({ filename: 'n11999.md', result: 'x'.repeat(1_000) });
    // At 1,025 characters each pays what it holds beyond its own note's JSON: about 890 units, 10,680,000 in all.
    const err = await tooCostly(evaluateJsonLogic({ var: ['absent', 'x'.repeat(1_023)] }, notes));
    expect(err.message).toMatch(/^The JSONLogic tree's results over the readable notes held more/);
  });

  it.each([
    ['a long number', 1.2345678901234567e300],
    ['an empty object', {}],
  ])(
    'charges %s its string conversion, so cat cannot join it past the budget',
    async (_label, element) => {
      // Doubled twenty times: 1,048,576 elements, each 15–23 characters once converted.
      const twenty = Array.from({ length: 20 }, (_, i) => i);
      const doubled = {
        reduce: [twenty, { merge: [{ var: 'accumulator' }, { var: 'accumulator' }] }, [element]],
      };
      const err = await tooCostly(
        evaluateJsonLogic({ '!!': [{ cat: [doubled] }] }, [note('a.md')]),
      );
      expect(err.message).toMatch(/^Evaluating the JSONLogic tree on one readable note built more/);
    },
  );

  it('keeps a result drawn from its own note free, however large', async () => {
    const bodies = Array.from({ length: 200 }, (_, i) =>
      note(`b${i}.md`, { content: 'z'.repeat(100_000) }),
    );
    const hits = await evaluateJsonLogic({ var: 'content' }, bodies);
    expect(hits).toHaveLength(200);
    expect(hits[199]).toEqual({ filename: 'b199.md', result: 'z'.repeat(100_000) });
  });

  it('spends one work budget on kept results across batches', async () => {
    const notes = [note('a.md')];
    // Each batch keeps a 6,000,000-unit result built from the tree: one fits the budget, two do not.
    const logic = { map: [[1, 2, 3, 4, 5, 6], 'x'.repeat(1_000_000)] };
    const kept = Array.from({ length: 6 }, () => 'x'.repeat(1_000_000));
    expect(await evaluateJsonLogic(logic, notes)).toEqual([{ filename: 'a.md', result: kept }]);
    const evaluation = createJsonLogicEvaluation(logic);
    expect(await evaluation.evaluate(notes)).toEqual([{ filename: 'a.md', result: kept }]);
    const err = await tooCostly(evaluation.evaluate(notes));
    expect(err.message).toBe(
      "The JSONLogic tree's results over the readable notes held more than the search's work budget of 10,000,000 units: each result over 1,024 characters pays for what it holds beyond its own note's size.",
    );
  });

  it('gives each note its own allowance for what it builds, across notes and batches', async () => {
    // Each note builds a copy of its 500,000-character body: 15,000,000 units over 30 notes.
    const notes = Array.from({ length: 30 }, (_, i) =>
      note(`n${i}.md`, { content: `${'y'.repeat(500_000)}${i === 17 ? 'zzqxv' : ''}` }),
    );
    const logic = { in: ['zzqxv', { cat: [{ var: 'path' }, { var: 'content' }] }] };
    const hit = [{ filename: 'n17.md', result: true }];
    expect(await evaluateJsonLogic(logic, notes)).toEqual(hit);
    const evaluation = createJsonLogicEvaluation(logic);
    expect(await evaluation.evaluate(notes.slice(0, 15))).toEqual([]);
    expect(await evaluation.evaluate(notes.slice(15))).toEqual(hit);
  });

  it('answers a tree that builds from every note of a broad scope', async () => {
    // Sixty links per note, each mapped to a new string: about 15,000,000 units over 4,000 notes.
    const notes = Array.from({ length: 4_000 }, (_, i) =>
      note(`Area ${i % 40}/Note ${i}.md`, {
        links: [
          ...Array.from({ length: 59 }, (_, j) => `Area ${j % 40}/Linked note ${i}-${j}.md`),
          i % 1_000 === 0 ? 'Hub.md' : `Area 0/Linked note ${i}-59.md`,
        ],
      }),
    );
    const hits = await evaluateJsonLogic(
      { in: ['Hub.md/', { map: [{ var: 'links' }, { cat: [{ var: '' }, '/'] }] }] },
      notes,
    );
    expect(hits).toEqual(
      [0, 1_000, 2_000, 3_000].map((i) => ({ filename: `Area 0/Note ${i}.md`, result: true })),
    );
  });

  it('answers a copy of a note at the 32 MiB content batch cap', async () => {
    const cap = note('cap.md', { content: `${'y'.repeat(32 * 1024 * 1024 - 5)}zzqxv` });
    expect(
      await evaluateJsonLogic({ in: ['zzqxv', { cat: [{ var: 'path' }, { var: 'content' }] }] }, [
        cap,
      ]),
    ).toEqual([{ filename: 'cap.md', result: true }]);
  });

  it("bounds a note's builds at its own size plus 10,000,000 units", async () => {
    const tripled = {
      '!!': [{ cat: [{ var: 'content' }, { var: 'content' }, { var: 'content' }] }],
    };
    // Three copies of a 4,000,000-character body fit 4,000,000 + 10,000,000 units.
    expect(
      await evaluateJsonLogic(tripled, [note('a.md', { content: 'y'.repeat(4_000_000) })]),
    ).toEqual([{ filename: 'a.md', result: true }]);
    // Three copies of a 6,000,000-character body pass 6,000,000 + 10,000,000.
    const err = await tooCostly(
      evaluateJsonLogic(tripled, [note('a.md', { content: 'y'.repeat(6_000_000) })]),
    );
    expect(err.message).toBe(
      "Evaluating the JSONLogic tree on one readable note built more than the per-note work budget of 10,000,000 units beyond that note's own size.",
    );
  });
});

/**
 * A note's data reaches the worker through structured clone, which recurses
 * and overflows the stack on data nested deep enough — about 3,500 levels
 * under Node, tens of thousands under Bun. 100,000 levels is past both.
 */
describe('evaluateJsonLogic — a note too deep to hand to the worker', () => {
  function deepNote(path: string, levels: number) {
    let value: unknown = 'leaf';
    for (let level = 0; level < levels; level++) value = { a: value };
    return note(path, { frontmatter: value });
  }

  it('fails with note_too_deep naming the note, leaves nothing unhandled, and answers the next search', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const notes = [note('a.md'), deepNote('deep.md', 100_000), note('b.md')];
      const err = await rejectionOf<McpError>(evaluateJsonLogic({ var: 'path' }, notes));
      expect(err.code).toBe(JsonRpcErrorCode.SerializationError);
      expect(err.data).toEqual({ reason: 'note_too_deep', path: 'deep.md' });
      expect(err.message).toBe(
        'The readable note "deep.md" holds data nested 100,001 levels deep, too deep for the server to hand to its evaluator.',
      );
      // The terminated worker's exit lands on a later turn; an orphaned rejection would surface there.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(await evaluateJsonLogic({ var: 'path' }, [note('c.md')])).toEqual([
        { filename: 'c.md', result: 'c.md' },
      ]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

/**
 * The deadline is a main-thread timer, so these cases fake the clock and move
 * it by hand: they pin when an evaluation stops, never how long the machine
 * takes. The pattern below backtracks for longer than any test runs on V8;
 * JavaScriptCore gives up after about half a second per note and reports no
 * match, so ten notes keep the worker from answering on either engine.
 */
describe('evaluateJsonLogic — deadline and cancellation', () => {
  const catastrophic = { regexp: ['^(a|a)*$', { var: 'content' }] };
  const stuck = Array.from({ length: 10 }, (_, i) =>
    note(`n${i}.md`, { content: `${'a'.repeat(40)}b` }),
  );

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Observe `promise` from now on, so a rejection is never unhandled; `settled()` reports whether it has landed. */
  function watch<T>(promise: Promise<T>) {
    let settled = false;
    const outcome = promise.finally(() => {
      settled = true;
    });
    outcome.catch(() => undefined);
    return { outcome, settled: () => settled };
  }

  it('stops a catastrophic regexp at the deadline, on a timer the main thread keeps running', async () => {
    const run = watch(evaluateJsonLogic(catastrophic, stuck, { deadlineMs: 500 }));
    await vi.advanceTimersByTimeAsync(499);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The deadline timer has fired; the rejection follows once the worker is terminated.
    expect(vi.getTimerCount()).toBe(0);
    const err = await tooCostly(run.outcome);
    expect(err.message).toBe(
      'Evaluating the JSONLogic tree over the readable notes ran past 0.5 s.',
    );
  });

  it('spends one deadline across batches', async () => {
    const evaluation = createJsonLogicEvaluation(catastrophic, { deadlineMs: 1_000 });
    const first = evaluation.evaluate([note('quick.md', { content: 'aa' })]);
    await vi.advanceTimersByTimeAsync(600);
    expect(await first).toEqual([{ filename: 'quick.md', result: true }]);
    // The second batch gets the 400 ms the first left, not a fresh second.
    const second = watch(evaluation.evaluate(stuck));
    await vi.advanceTimersByTimeAsync(399);
    expect(second.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    const err = await tooCostly(second.outcome);
    expect(err.message).toBe('Evaluating the JSONLogic tree over the readable notes ran past 1 s.');
  });

  it('rethrows the caller cancellation rather than reporting a degraded result', async () => {
    const controller = new AbortController();
    const run = rejectionOf<Error>(
      evaluateJsonLogic(catastrophic, stuck, { signal: controller.signal }),
    );
    controller.abort();
    const err = await run;
    expect(err).toBe(controller.signal.reason);
    expect(err.name).toBe('AbortError');
  });

  it('terminates its worker at the deadline and on cancellation, before any close', async () => {
    const workers = spyOnWorkers();
    const pastDeadline = watch(
      createJsonLogicEvaluation(catastrophic, { deadlineMs: 500 }).evaluate(stuck),
    );
    await vi.advanceTimersByTimeAsync(500);
    await tooCostly(pastDeadline.outcome);
    const controller = new AbortController();
    const cancelled = rejectionOf(
      createJsonLogicEvaluation(catastrophic, { signal: controller.signal }).evaluate(stuck),
    );
    controller.abort();
    expect(await cancelled).toBe(controller.signal.reason);
    expect(workers.instances().size).toBe(2);
    expect(workers.terminated()).toEqual(workers.instances());
  });

  it('rejects at once when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await rejectionOf(
        evaluateJsonLogic({ var: 'path' }, [note('a.md')], { signal: controller.signal }),
      ),
    ).toBe(controller.signal.reason);
  });
});

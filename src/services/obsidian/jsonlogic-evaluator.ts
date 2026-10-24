/**
 * @fileoverview Server-side JSONLogic evaluation for searches scoped by
 * OBSIDIAN_READ_PATHS. The caller's tree runs here, on a worker thread, over
 * the readable notes alone, instead of upstream over the whole vault: no hit,
 * result, or error reads a note outside the read scope. The notes' link
 * fields arrive cut to readable entries, but which note a link resolves to is
 * still Obsidian's vault-wide resolution (#165).
 *
 * Every evaluation is bounded — tree depth, work budgets the worker enforces
 * (per note for what each note's evaluation builds, per search for what kept
 * results hold past a 1,024-character allowance each), and a wall-clock
 * deadline — and an evaluation past a bound fails with `logic_too_costly`
 * rather than holding the process. A note nested too deep to hand to the
 * worker fails with `note_too_deep`.
 *
 * @module services/obsidian/jsonlogic-evaluator
 */

import { Worker } from 'node:worker_threads';
import { serializationError, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { EvaluationRequest, EvaluationResponse, NoteContext } from './jsonlogic-worker.js';
import type { StructuredSearchHit } from './types.js';

/**
 * Deepest object/array nesting a tree may have. The plugin evaluates every
 * shape to at least 5,000 levels; this stays well under the depth at which
 * Node's structured clone overflows the stack handing a tree to the worker
 * (about 3,500 levels).
 */
export const MAX_TREE_DEPTH = 1_000;

/**
 * Work units kept results may hold across one search, every batch included
 * (see the worker's `chargeKept`). A result whose JSON is at most 1,024
 * characters is kept free, whatever its note; a larger one pays for what its
 * JSON holds beyond its own note's JSON. Kept results live until the search
 * answers, so this bounds what an evaluation retains, since Bun ignores the
 * worker's `resourceLimits`. What a note's evaluation builds and drops is
 * bounded per note by {@link NOTE_BUILD_UNITS}; evaluation steps that build
 * nothing are bounded by {@link EVALUATION_DEADLINE_MS}, so a tree that only
 * tests note fields spends nothing however many notes it reads.
 */
export const KEPT_RESULT_UNITS = 10_000_000;

/**
 * Work units one note's evaluation may build beyond the note's own size (see
 * the worker's `charge`): the size of every value `merge`, `cat`, or `map`
 * builds and of every value an operator places in an array literal. The
 * allowance resets for each note, since what an evaluation builds is dropped
 * when it ends, so a tree that builds from every note of a broad scope is
 * bounded by its largest note rather than by the scope's total. Adding the
 * note's own size means one copy of a note always fits, at any size a batch
 * carries; the fixed part leaves room for dozens of copies of a 200 KB note
 * while holding what one evaluation can allocate to the note plus
 * 10,000,000 units.
 */
export const NOTE_BUILD_UNITS = 10_000_000;

/** Wall-clock ceiling on one search's evaluation, across its batches, worker startup included. */
export const EVALUATION_DEADLINE_MS = 10_000;

/**
 * The worker's module, next to this one: `.js` in the build, `.ts` when the
 * test suite runs the source, which both Bun and Node load directly.
 */
const WORKER_URL = new URL(
  `./jsonlogic-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

/**
 * Whether the plugin would read note bodies for `logic`: its own rule, a
 * substring test for `"content"` on the tree's JSON. A tree without it sees
 * `content` as `""` upstream, so a scoped fetch mirrors the same rule to keep
 * results identical — and it is conservative, firing on the word anywhere.
 */
export function readsContent(logic: unknown): boolean {
  return JSON.stringify(logic).includes('"content"');
}

/**
 * Reject a tree nested deeper than {@link MAX_TREE_DEPTH} before it reaches
 * anything recursive (serialization, the worker hand-off, evaluation).
 */
export function assertTreeDepth(logic: unknown): void {
  if (nestingDepth(logic, MAX_TREE_DEPTH) > MAX_TREE_DEPTH) {
    throw tooCostly(
      `The JSONLogic tree nests deeper than ${MAX_TREE_DEPTH.toLocaleString('en-US')} levels.`,
    );
  }
}

/**
 * Deepest object/array nesting in `value`, which is level 1, measured until
 * it passes `limit`. Iterative, so it measures data too deep for any
 * recursive walk.
 */
function nestingDepth(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let deepest = 0;
  const pending: Array<[unknown, number]> = [[value, 1]];
  while (pending.length > 0 && deepest <= limit) {
    const [node, depth] = pending.pop() as [unknown, number];
    if (node === null || typeof node !== 'object') continue;
    deepest = Math.max(deepest, depth);
    for (const child of Object.values(node)) pending.push([child, depth + 1]);
  }
  return deepest;
}

/**
 * One search's evaluation of `logic`. `evaluate` takes the readable notes in
 * vault order, all at once or in successive batches; the budget for kept
 * results and the deadline span every batch, and each note's build allowance
 * is its own, so batching changes memory use, not results.
 * Each call returns the batch's hits as the plugin's search would: a hit for
 * every truthy result, results shaped by a JSON round trip. It throws
 * `logic_invalid` when the tree fails on a note, `logic_too_costly` past
 * either budget or the deadline, `note_too_deep` for a note the worker
 * hand-off cannot carry, and the abort reason when `signal` aborts first.
 */
export function createJsonLogicEvaluation(
  logic: unknown,
  opts: { signal?: AbortSignal | undefined; deadlineMs?: number } = {},
): { evaluate: (notes: NoteContext[]) => Promise<StructuredSearchHit[]> } {
  const { signal, deadlineMs = EVALUATION_DEADLINE_MS } = opts;
  let keptUnitsLeft = KEPT_RESULT_UNITS;
  let msLeft = deadlineMs;
  const pastDeadline = () =>
    tooCostly(
      `Evaluating the JSONLogic tree over the readable notes ran past ${deadlineMs / 1000} s.`,
    );
  return {
    async evaluate(notes) {
      if (notes.length === 0) return [];
      signal?.throwIfAborted();
      if (msLeft <= 0) throw pastDeadline();
      const started = performance.now();
      const response = await runWorker(
        { logic, notes, keptUnits: keptUnitsLeft, noteUnits: NOTE_BUILD_UNITS },
        msLeft,
        pastDeadline,
        signal,
      );
      msLeft -= performance.now() - started;
      if (response.ok) {
        keptUnitsLeft = response.keptUnitsLeft;
        return response.hits.map((hit) => ({
          filename: hit.filename,
          result: JSON.parse(hit.json),
        }));
      }
      throw failureError(response);
    },
  };
}

function failureError(response: Extract<EvaluationResponse, { ok: false }>): Error {
  const cause = new Error(response.detail);
  switch (response.failure) {
    case 'invalid_regexp':
      return validationError(
        'A `regexp` operand in the JSONLogic tree did not compile. `regexp` takes `[PATTERN, VALUE]` — with the operands reversed, the note field is compiled as the pattern.',
        { reason: 'logic_invalid' },
        { cause },
      );
    case 'invalid':
      return validationError(
        'The JSONLogic tree could not be evaluated.',
        { reason: 'logic_invalid' },
        { cause },
      );
    case 'over_note_budget':
      return tooCostly(
        `Evaluating the JSONLogic tree on one readable note built more than the per-note work budget of ${NOTE_BUILD_UNITS.toLocaleString('en-US')} units beyond that note's own size.`,
      );
    case 'over_kept_budget':
      return tooCostly(
        `The JSONLogic tree's results over the readable notes held more than the search's work budget of ${KEPT_RESULT_UNITS.toLocaleString('en-US')} units: each result over 1,024 characters pays for what it holds beyond its own note's size.`,
      );
  }
}

/** One worker per batch, terminated however it ends. */
async function runWorker(
  request: EvaluationRequest,
  deadlineMs: number,
  pastDeadline: () => Error,
  signal: AbortSignal | undefined,
): Promise<EvaluationResponse> {
  const worker = new Worker(WORKER_URL);
  const { promise, resolve, reject } = Promise.withResolvers<EvaluationResponse>();
  const timer = setTimeout(() => reject(pastDeadline()), deadlineMs);
  const onAbort = () => reject(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) =>
    reject(new Error(`JSONLogic worker exited with code ${code} before answering`)),
  );
  try {
    worker.postMessage(request);
  } catch (err) {
    // Rejected before the await below takes the promise, so the exit `terminate` raises settles nothing.
    reject(handOffError(err, request.notes));
  }
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await worker.terminate();
  }
}

/**
 * Why `postMessage` refused a batch. Structured clone recurses, so data
 * nested deep enough overflows the stack: about 3,500 levels under Node,
 * tens of thousands under Bun. The tree is held to {@link MAX_TREE_DEPTH},
 * so the deepest note is the one that did not fit. Any other refusal is
 * returned as it came.
 */
function handOffError(err: unknown, notes: readonly NoteContext[]): unknown {
  if (!(err instanceof RangeError)) return err;
  let deepest = { path: '', levels: 0 };
  for (const note of notes) {
    const levels = nestingDepth(note);
    if (levels > deepest.levels) deepest = { path: note.path, levels };
  }
  return serializationError(
    `The readable note "${deepest.path}" holds data nested ${deepest.levels.toLocaleString('en-US')} levels deep, too deep for the server to hand to its evaluator.`,
    { reason: 'note_too_deep', path: deepest.path },
    { cause: err },
  );
}

function tooCostly(message: string): Error {
  return validationError(message, { reason: 'logic_too_costly' });
}

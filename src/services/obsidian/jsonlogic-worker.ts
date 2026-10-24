/**
 * @fileoverview Worker-thread entry that evaluates a caller's JSONLogic tree
 * against note contexts, for searches scoped by OBSIDIAN_READ_PATHS. Runs the
 * operator set the Local REST API plugin runs (json-logic-js 2.0.5 plus its
 * `glob` and `regexp`), with the plugin's hit test and JSON-shaped results, so
 * a scoped search answers as the plugin would over the same notes.
 *
 * Off the main thread so a slow tree cannot hold the event loop: the evaluator
 * terminates this worker at its deadline, which also stops a native regex
 * mid-backtrack. Memory is bounded here by work budgets, since Bun ignores
 * `resourceLimits`: one per note for what its evaluation builds and drops,
 * and one across the search for what kept results hold past a
 * 1,024-character allowance each.
 *
 * Imports only packages and builtins, never sibling modules: under Node the
 * test suite loads this file from source, where `./x.js` specifiers do not
 * resolve to `.ts`.
 *
 * @module services/obsidian/jsonlogic-worker
 */

import { parentPort } from 'node:worker_threads';
import globToRegExp from 'glob-to-regexp';
import jsonLogic from 'json-logic-js';

/** A note as the plugin's JSONLogic search evaluates it, link fields already scoped. */
export interface NoteContext {
  path: string;
  [field: string]: unknown;
}

export interface EvaluationRequest {
  /** Work units left for kept results, across every batch of the search; see {@link chargeKept}. */
  keptUnits: number;
  logic: unknown;
  notes: NoteContext[];
  /** Work units each note's evaluation may build beyond the note's own size; see {@link charge}. */
  noteUnits: number;
}

/**
 * How an evaluation ended. `json` is the hit's result serialized as the
 * plugin's response would carry it; `keptUnitsLeft` carries into the next
 * batch.
 */
export type EvaluationResponse =
  | { ok: true; hits: Array<{ filename: string; json: string }>; keptUnitsLeft: number }
  | { ok: false; failure: 'invalid' | 'invalid_regexp' | BudgetFailure; detail: string };

type BudgetFailure = 'over_note_budget' | 'over_kept_budget';

/** Thrown when a work budget runs out; never caught by json-logic-js, which has no try. */
class BudgetExhausted extends Error {
  readonly failure: BudgetFailure;
  constructor(failure: BudgetFailure) {
    super(failure);
    this.failure = failure;
  }
}

/** Units the current note's evaluation may still build; reset for every note. */
let noteUnitsLeft = 0;
/** Units kept results may still hold, across the whole search. */
let keptUnitsLeft = 0;

/**
 * Spend `units` of the current note's budget, which bounds the memory one
 * note's evaluation allocates; the deadline bounds time. The budget is the
 * note's own {@link weight} plus `noteUnits`, so a tree can always build a
 * copy of what the note holds, and it resets for the next note: what one
 * note's evaluation builds is dropped when it ends, unless it is kept, which
 * {@link chargeKept} bounds across the search. Only what a tree builds is
 * charged, at its {@link weight}: `merge` and `cat` before they build, a `map`
 * result, and the elements operators placed in an array literal
 * ({@link literalWeight}). Every other step allocates no more than its
 * operands already hold — comparisons, `var`, `in`, `missing`, `some` / `all`
 * / `none`, arithmetic, `substr`, `glob`, and `regexp` return a primitive, a
 * reference, or a string conversion of a value that was charged, is the
 * note's, or is written in the tree; `filter` returns part of its input, and
 * `if`, `and`, `or`, and `reduce` return a value another step produced — so
 * evaluation steps cost nothing. Charging what is built bounds what a tree
 * can allocate, including by multiplying references to one large string, and
 * so bounds every later string conversion of what it built.
 */
function charge(units: number): void {
  noteUnitsLeft -= units;
  if (noteUnitsLeft < 0) throw new BudgetExhausted('over_note_budget');
}

/** Spend `units` of the search's budget for kept results, which outlive their note's evaluation. */
function chargeKept(units: number): void {
  keptUnitsLeft -= units;
  if (keptUnitsLeft < 0) throw new BudgetExhausted('over_kept_budget');
}

/** Length of a plain object's string conversion, `[object Object]`. */
const OBJECT_STRING_CHARS = 15;

/**
 * Size of a value in work units, counted until it passes `limit`: one per
 * node plus the length of the node's own string conversion — a string's
 * length, `String(value).length` for a number, boolean, `null`, or
 * `undefined`, and {@link OBJECT_STRING_CHARS} plus its keys' lengths for an
 * object. An array converts to its elements joined by commas, which the
 * per-node unit covers, so no value converts to a string longer than its
 * weight. Iterative, because a `reduce` can nest values deeper than the call
 * stack.
 */
function weight(value: unknown, limit: number): number {
  let total = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0 && total <= limit) {
    const next = pending.pop();
    total += 1;
    if (typeof next === 'string') total += next.length;
    // Pushed one by one: spreading a long array overruns the argument limit.
    else if (Array.isArray(next)) for (const item of next) pending.push(item);
    else if (next !== null && typeof next === 'object') {
      total += OBJECT_STRING_CHARS;
      for (const [key, field] of Object.entries(next)) {
        total += key.length;
        pending.push(field);
      }
    } else total += String(next).length;
  }
  return total;
}

/**
 * Size of the array an array literal just built, in work units. An element
 * written in the tree — a primitive, or an array literal charged at its own
 * application — adds nothing: its slot and a literal string's length are
 * bounded by the request, and the string is shared rather than copied. An
 * element an operator produced pays its full {@link weight}.
 */
function literalWeight(logic: unknown[], built: unknown[]): number {
  let total = 0;
  for (let i = 0; i < logic.length && total <= noteUnitsLeft; i++) {
    const element = logic[i];
    if (element !== null && typeof element === 'object' && !Array.isArray(element)) {
      total += weight(built[i], noteUnitsLeft - total);
    }
  }
  return total;
}

const baseApply = jsonLogic.apply;
/**
 * json-logic-js recurses through `jsonLogic.apply`, so this wrapper sees every
 * application. A `map` result is charged its size: mapping over a long array
 * to a constant multiplies references to it without building anything the
 * other charges see.
 */
jsonLogic.apply = (logic, data) => {
  const result = baseApply(logic, data);
  if (Array.isArray(logic)) charge(literalWeight(logic, result as unknown[]));
  else if (isMap(logic)) charge(weight(result, noteUnitsLeft));
  return result;
};

/** A `map` application, by json-logic-js's own test: an object with one key. */
function isMap(logic: unknown): boolean {
  return (
    logic !== null &&
    typeof logic === 'object' &&
    Object.hasOwn(logic, 'map') &&
    Object.keys(logic).length === 1
  );
}

/** The plugin's two operators, as Local REST API 5.x registers them: pattern first, `false` for a non-string operand. */
jsonLogic.add_operation('glob', (pattern, field) =>
  typeof field === 'string' && typeof pattern === 'string'
    ? globToRegExp(pattern).test(field)
    : false,
);
jsonLogic.add_operation('regexp', (pattern, field) =>
  typeof field === 'string' && typeof pattern === 'string'
    ? new RegExp(pattern).test(field)
    : false,
);

/** json-logic-js's `log` writes to stdout, which is the JSON-RPC stream under stdio. Same value, no write. */
jsonLogic.add_operation('log', (value) => value);

/**
 * json-logic-js's `var`, reading own properties only: inherited properties are
 * out of reach, and own properties still cover every note field, array index,
 * and `length`.
 */
jsonLogic.add_operation('var', function (this: unknown, key: unknown, fallback: unknown) {
  const notFound = fallback === undefined ? null : fallback;
  if (key === undefined || key === '' || key === null) return this;
  let data = this;
  for (const segment of String(key).split('.')) {
    if (data === null || data === undefined || !Object.hasOwn(Object(data), segment)) {
      return notFound;
    }
    data = (data as Record<string, unknown>)[segment];
    if (data === undefined) return notFound;
  }
  return data;
});

/** Stock `merge` and `cat`, charged before they build, so an oversized value is never allocated. */
jsonLogic.add_operation('merge', (...args) => {
  for (const arg of args) charge(weight(arg, noteUnitsLeft));
  return args.reduce<unknown[]>((all, next) => all.concat(next), []);
});
jsonLogic.add_operation('cat', (...args) => {
  for (const arg of args) charge(weight(arg, noteUnitsLeft));
  return args.join('');
});

/** The plugin's hit test: `null`/`undefined`, `[]`, and `{}` drop a note. */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Serialized characters a kept result may hold with no charge, whatever its
 * note's size, so ordinary results skip the comparison below.
 */
const FREE_RESULT_CHARS = 1_024;

/**
 * Evaluate `request.logic` against each note in order, as the plugin's search
 * loop does, each note with a fresh budget for what it builds. A kept result
 * is held until the search answers. One whose JSON is at most
 * {@link FREE_RESULT_CHARS} is free; a larger one pays the search's budget for
 * whatever it holds beyond its own note's serialized size: a result drawn
 * from the note stays free, while one repeating the tree's large constants on
 * every note is bounded across the search.
 */
function evaluate(request: EvaluationRequest): EvaluationResponse {
  keptUnitsLeft = request.keptUnits;
  const hits: Array<{ filename: string; json: string }> = [];
  for (const note of request.notes) {
    noteUnitsLeft = request.noteUnits + weight(note, Number.POSITIVE_INFINITY);
    try {
      const result = jsonLogic.apply(request.logic, note);
      if (!isTruthy(result)) continue;
      const json = JSON.stringify(result);
      if (json.length > FREE_RESULT_CHARS) {
        chargeKept(Math.max(0, json.length - JSON.stringify(note).length));
      }
      hits.push({ filename: note.path, json });
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        return { ok: false, failure: err.failure, detail: 'work budget exhausted' };
      }
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        failure: /invalid regular expression/i.test(detail) ? 'invalid_regexp' : 'invalid',
        detail,
      };
    }
  }
  return { ok: true, hits, keptUnitsLeft };
}

parentPort?.once('message', (request: EvaluationRequest) => {
  parentPort?.postMessage(evaluate(request));
});

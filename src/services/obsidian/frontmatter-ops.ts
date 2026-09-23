/**
 * @fileoverview Read-modify-write helpers for the YAML frontmatter block of a
 * note's raw content. Used by the composed manage-frontmatter / manage-tags
 * tools when the upstream Local REST API has no single-call equivalent.
 * @module services/obsidian/frontmatter-ops
 */

import { type Document, isMap, isScalar, isSeq, parseDocument, Scalar, type YAMLSeq } from 'yaml';
import { HTML_TAG_SOURCE, scanBlocks } from './markdown-blocks.js';

/**
 * The outcome of a frontmatter mutation. A block that cannot be re-emitted
 * faithfully is reported as a value rather than written or thrown: these
 * helpers back a read-modify-write, so "cannot" means the caller would
 * otherwise hand the vault a note with properties it never asked to change —
 * or lose the block outright. The handlers turn `ok: false` into a typed,
 * declared tool error and issue no write.
 */
export type FrontmatterEdit = { ok: true; content: string } | { ok: false; problem: string };

/**
 * The one frontmatter boundary: an opening `---` alone on the first line, YAML,
 * then a `---` that starts its own line. The YAML span and the newline that
 * separates it from the closing fence are one atomic optional unit, so an empty
 * block (`---` immediately followed by `---`) matches while a `---` sitting
 * mid-scalar still cannot close the block — making the separator newline
 * independently optional would close `key: a---b` at the `---` inside it.
 */
const FM_RE = /^(---\r?\n)(?:([\s\S]*?)\r?\n)?(?:---\r?\n?)/;

/** The two halves of a note: its raw frontmatter prefix and everything after it. */
export interface Splice {
  /** Everything after the closing fence. The whole file when `hasFrontmatter` is false. */
  body: string;
  /** Closing fence with the newlines around it. Empty when `hasFrontmatter` is false. */
  close: string;
  hasFrontmatter: boolean;
  /** Opening fence and its newline. Empty when `hasFrontmatter` is false. */
  open: string;
  /** The frontmatter prefix verbatim — `open + yamlText + close`, and `''` when there is none. */
  raw: string;
  /** YAML text between the `---` fences. Empty when `hasFrontmatter` is false. */
  yamlText: string;
}

/**
 * Split a note into its raw frontmatter prefix and its body. `raw + body`
 * reconstructs the input byte for byte, which is what makes this the primitive
 * for body-scoped mutations: rebuild with the original `raw` and the frontmatter
 * block is untouched by construction. Rebuilding through `serializeFrontmatter`
 * would instead re-emit the YAML and can reformat scalars nobody asked to change.
 *
 * A file whose fence is never closed, whose `---` sits below the first line, or
 * whose opening `---` carries trailing whitespace has no frontmatter — the whole
 * thing is body, which is also how Obsidian reads each of those shapes. An empty
 * block is a block: `---` immediately followed by `---` splits with an empty
 * `yamlText`, matching the properties block Obsidian reads there.
 */
export function splice(content: string): Splice {
  const m = FM_RE.exec(content);
  if (!m) {
    return { hasFrontmatter: false, raw: '', open: '', yamlText: '', close: '', body: content };
  }
  const raw = m[0];
  const open = m[1] ?? '';
  const yamlText = m[2] ?? '';
  return {
    hasFrontmatter: true,
    raw,
    open,
    yamlText,
    /**
     * Sliced rather than taken from the closing-fence capture: the separator
     * newline belongs to `close` when there is YAML and does not exist at all
     * for an empty block, and slicing keeps `open + yamlText + close === raw`
     * in both shapes.
     */
    close: raw.slice(open.length + yamlText.length),
    body: content.slice(raw.length),
  };
}

/**
 * Describe why `yamlText` is not usable as a frontmatter block, or `undefined`
 * when it is. Catches YAML that no longer parses, YAML that parses to
 * something other than a mapping — the two states in which Obsidian reads no
 * properties at all — and YAML that parses but cannot be emitted again.
 *
 * That last one is its own class: an unresolved alias (`bad: *missing`) is
 * accepted by `parseDocument` with an empty `doc.errors` and refused only by
 * the emitter, so the round trip is what surfaces it.
 *
 * It cannot catch an edit that stays well-formed while meaning something else:
 * a renamed key, a scalar that re-parses as a different type. Those are valid
 * YAML and pass this check.
 */
export function frontmatterParseError(yamlText: string): string | undefined {
  const doc = parseDocument(yamlText);
  const first = doc.errors[0];
  if (first) return first.message;
  if (doc.contents !== null && !isMap(doc.contents)) {
    return 'Frontmatter must be a YAML mapping of properties.';
  }
  return serializeError(doc);
}

/** The emitter's own complaint about `doc`, or `undefined` when it round-trips. */
function serializeError(doc: Document): string | undefined {
  try {
    doc.toString({ lineWidth: 0 });
    return;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The line ending a rewritten block is emitted with. `doc.toString()` always
 * emits LF and the fences used to be hard-coded to it, which left a CRLF note
 * with an LF block above a CRLF body. An existing block keeps its own ending;
 * a block being created on a note that had none follows the body's first line
 * (issue #125).
 */
function blockEol(spliced: Splice): '\n' | '\r\n' {
  if (spliced.hasFrontmatter) return spliced.open.endsWith('\r\n') ? '\r\n' : '\n';
  return /\r\n|\n/.exec(spliced.body)?.[0] === '\r\n' ? '\r\n' : '\n';
}

/**
 * Re-emit the parsed frontmatter document between `---` fences, preserving the
 * comments, quoting, and scalar formatting of every untouched node — the reason
 * these helpers parse with `yaml`'s CST-backed `parseDocument` and edit nodes in
 * place rather than round-tripping the block through a plain object (which drops
 * comments and rewrites untouched scalars, e.g. `date: 2026-06-29` → an ISO
 * timestamp). When no keys remain, the whole block is dropped along with the
 * whitespace-only lines that separated it from the body.
 *
 * The body is re-attached verbatim. `FM_RE` consumes the newline that closes
 * the fence line and nothing more, so the trailing separator replaces exactly
 * what was eaten — the blank line before the body (or its absence, or several
 * of them) survives the rewrite byte for byte.
 *
 * Emitting can still fail after a mutation that parsed cleanly: deleting the
 * key that owned an anchor leaves every alias to it dangling, and the emitter
 * is the only thing that notices. That is a refusal, not a throw — the caller
 * decides what to tell the user, and no write goes out either way.
 */
function serializeFrontmatter(doc: Document, spliced: Splice): FrontmatterEdit {
  const node = doc.contents;
  if (!node || (isMap(node) && node.items.length === 0)) {
    /**
     * The block is gone, and only the whitespace-only lines that separated it
     * from the body go with it. A blanket `^\s+` also ate the first content
     * line's own indentation, which is what an indented code block is made of
     * (issue #125).
     */
    return { ok: true, content: spliced.body.replace(/^(?:[ \t]*\r?\n)+/, '') };
  }
  let yamlText: string;
  try {
    yamlText = doc.toString({ lineWidth: 0 }).trimEnd();
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  const eol = blockEol(spliced);
  return {
    ok: true,
    content: `---${eol}${yamlText.split('\n').join(eol)}${eol}---${eol}${spliced.body}`,
  };
}

/**
 * The full file content with `key` removed from the frontmatter. A file with
 * no frontmatter, or one where the key isn't present, comes back unchanged.
 *
 * Refuses — rather than writing — when the existing block does not parse as a
 * mapping or the mutation leaves YAML that cannot be emitted. Both were silent
 * data loss before: a block the parser recovered into a single malformed key
 * was "emptied" by deleting that key, taking every sibling property and the
 * block itself with it (issue #123).
 */
export function deleteFrontmatterKey(content: string, key: string): FrontmatterEdit {
  const spliced = splice(content);
  if (!spliced.hasFrontmatter) return { ok: true, content };
  const problem = frontmatterParseError(spliced.yamlText);
  if (problem) return { ok: false, problem };
  const doc = parseDocument(spliced.yamlText);
  if (!doc.has(key)) return { ok: true, content };
  doc.delete(key);
  return serializeFrontmatter(doc, spliced);
}

export interface TagReconcileResult {
  /** Tags actually changed (added/removed) at one or more locations. */
  applied: string[];
  /** Updated content with the requested tag mutations applied. */
  content: string;
  /** Tags that were already in the desired state at the targeted location(s). */
  skipped: string[];
}

export type TagOperation = 'add' | 'remove';
export type TagLocation = 'frontmatter' | 'inline' | 'both';

/** A completed reconciliation, or the reason the frontmatter half refused. */
export type TagReconcileOutcome =
  | ({ ok: true } & TagReconcileResult)
  | { ok: false; problem: string };

/**
 * Add or remove tags across frontmatter (`tags:` array) and inline `#tag`
 * syntax. Inline detection skips code spans, link spans, HTML comments, math,
 * and a `#` preceded by anything but whitespace, line start, or markup such
 * as `**` or `<br>` — see `splitProtectedSegments` and `TAG_LEFT_BOUNDARY`.
 */
export function reconcileTags(
  content: string,
  tags: string[],
  operation: TagOperation,
  location: TagLocation,
): TagReconcileOutcome {
  const norm = (t: string) => t.replace(/^#+/, '').trim();
  const wanted = tags.map(norm).filter((t) => t.length > 0);
  const applied = new Set<string>();
  const skipped = new Set<string>();

  let updated = content;

  if (location === 'frontmatter' || location === 'both') {
    const edit = mutateFrontmatterTags(updated, wanted, operation, applied, skipped);
    /**
     * A refusal ends the whole call, `both` included. The frontmatter half runs
     * first precisely so that returning here leaves the note byte-identical —
     * proceeding to the inline half would tag the body on the strength of a
     * frontmatter edit that never happened (issue #124).
     */
    if (!edit.ok) return edit;
    updated = edit.content;
  }
  if (location === 'inline' || location === 'both') {
    updated = mutateInlineTags(updated, wanted, operation, applied, skipped);
  }

  // For location='both', a tag that was already-in-frontmatter may have been
  // missing inline (or vice versa). If applied is non-empty for the tag, drop
  // it from skipped.
  for (const t of applied) skipped.delete(t);

  return { ok: true, content: updated, applied: [...applied], skipped: [...skipped] };
}

function mutateFrontmatterTags(
  content: string,
  tags: string[],
  operation: TagOperation,
  applied: Set<string>,
  skipped: Set<string>,
): FrontmatterEdit {
  const spliced = splice(content);
  if (spliced.hasFrontmatter) {
    const problem = frontmatterParseError(spliced.yamlText);
    if (problem) return { ok: false, problem };
  }
  const doc = parseDocument(spliced.hasFrontmatter ? spliced.yamlText : '');
  const node = isMap(doc.contents) ? doc.get('tags', true) : undefined;
  const changed = isSeq(node)
    ? mutateTagSeq(doc, node, tags, operation, applied, skipped)
    : rewriteTagList(doc, node, tags, operation, applied, skipped);

  if (!changed) return { ok: true, content };
  return serializeFrontmatter(doc, spliced);
}

/**
 * The tags whose state actually differs from `present`, with every tag
 * recorded as applied or skipped along the way. `present` is updated as the
 * walk goes, so a tag named twice in one call changes once and is skipped
 * thereafter — both shapes below share this bookkeeping and differ only in
 * what they then do to the document.
 */
function planTagChanges(
  tags: string[],
  operation: TagOperation,
  present: Set<string>,
  applied: Set<string>,
  skipped: Set<string>,
): string[] {
  const adding = operation === 'add';
  const changes: string[] = [];
  for (const tag of tags) {
    if (present.has(tag) === adding) {
      skipped.add(tag);
      continue;
    }
    if (adding) present.add(tag);
    else present.delete(tag);
    changes.push(tag);
    applied.add(tag);
  }
  return changes;
}

/**
 * Edit an existing `tags:` sequence node in place.
 *
 * In place rather than `doc.set('tags', [...normalized])`: replacing the node
 * discards everything the caller never named. `tags:` is free-form YAML and a
 * vault may hold entries this server has no reading of — a number, a nested
 * map — which the normalized string set silently dropped on the next write,
 * along with the comments and quoting of every item that was not being touched
 * (issue #123).
 */
function mutateTagSeq(
  doc: Document,
  seq: YAMLSeq,
  tags: string[],
  operation: TagOperation,
  applied: Set<string>,
  skipped: Set<string>,
): boolean {
  const present = new Set(seq.items.map(itemTag).filter((t): t is string => t !== undefined));
  const changes = planTagChanges(tags, operation, present, applied, skipped);
  if (changes.length === 0) return false;

  for (const tag of changes) {
    if (operation === 'add') {
      seq.items.push(new Scalar(tag));
      continue;
    }
    for (let i = seq.items.length - 1; i >= 0; i--) {
      if (itemTag(seq.items[i]) === tag) seq.items.splice(i, 1);
    }
  }

  /**
   * The key goes only once nothing at all is left. A sequence still holding
   * entries that are not string tags keeps them, and keeps the key they live
   * under.
   */
  if (seq.items.length === 0) doc.delete('tags');
  return true;
}

/** The normalized tag an item carries, or `undefined` when it is not a string scalar. */
function itemTag(item: unknown): string | undefined {
  if (!isScalar(item) || typeof item.value !== 'string') return;
  const tag = item.value.replace(/^#+/, '').trim();
  return tag.length > 0 ? tag : undefined;
}

/**
 * The two shapes with no sequence node to edit: a string-valued `tags:`
 * (`tags: alpha beta`) and a note carrying no `tags` key at all. Both are
 * written out as a fresh block sequence, which is the shape Obsidian's own
 * properties editor produces.
 */
function rewriteTagList(
  doc: Document,
  node: unknown,
  tags: string[],
  operation: TagOperation,
  applied: Set<string>,
  skipped: Set<string>,
): boolean {
  const set = new Set(normalizeTagList(isScalar(node) ? node.value : undefined));
  if (planTagChanges(tags, operation, set, applied, skipped).length === 0) return false;
  const ordered = [...set];
  if (ordered.length === 0) doc.delete('tags');
  else doc.set('tags', ordered);
  return true;
}

function normalizeTagList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/^#+/, '').trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((v) => v.replace(/^#+/, '').trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

/**
 * The opening backtick run of a code span. It closes at the next whole
 * backtick run of the same length in the paragraph, across line breaks:
 * `` a ``b ` #x`` `` is code, `` a `` #x ``` `` is not. Only the opener is a
 * regex; `codeSpanCloser` finds the closer.
 */
const INLINE_CODE = /(?<code>`+)/;

/**
 * The end of the code span each opener in `text` starts, or `undefined` when
 * it has none. Whole backtick runs are listed once, by length; openers must be
 * looked up in ascending order, so each length's list is walked once.
 */
function codeSpanCloser(text: string): (open: number, length: number) => number | undefined {
  const runs = new Map<number, number[]>();
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const start = i;
    while (text[i] === '`') i++;
    const list = runs.get(i - start);
    if (list) list.push(start);
    else runs.set(i - start, [start]);
  }
  const walked = new Map<number, number>();
  return (open, length) => {
    const list = runs.get(length);
    if (!list) return;
    let k = walked.get(length) ?? 0;
    while ((list[k] ?? Number.POSITIVE_INFINITY) <= open) k++;
    walked.set(length, k);
    const close = list[k];
    return close === undefined ? undefined : close + length;
  };
}
/**
 * `[[Target#Heading|Alias]]`. The `#` in a wikilink opens a heading anchor and
 * the text after `|` is display text — neither is a tag. Protecting the whole
 * span rather than tightening the tag's left boundary is what makes the result
 * independent of what the linked note is named: `[[Note#Overview]]` only escapes
 * a boundary rule because the name happens to end in a word character, while
 * `[[Note (Draft)#Overview]]` does not. Obsidian rejects `[` and `]` inside a
 * link target, so a span never nests.
 */
const WIKILINK = /\[\[[^[\]\n]*\]\]/;
/** `![alt](source)` and `![alt][label]` — Obsidian reads no tag in an image's alt text. */
const IMAGE = /!\[[^[\]\n]*\](?:\([^()\n]*\)|\[[^[\]\n]*\])/;
/**
 * The `](destination)` or `][label]` that makes the bracketed text before it a
 * link. Only this tail is link syntax: Obsidian reads a tag in link text
 * (`[Discord #tf](https://x.y)` is tagged `tf`) and none in a destination, a
 * title, or a label. The text must open on the same line with no bracket in it;
 * a bracketed phrase followed by a space and a second one (`[note #work] [ref]`)
 * is no link.
 */
const LINK_TAIL = /(?<linkTail>\](?<=\[[^[\]\n]*\])(?:\([^()\n]*\)|\[[^[\]\n]*\]))/;
/** The `[label]:` that opens a link reference definition. */
const LINK_DEFINITION = /\[(?<=(?:^|\n)[ ]{0,3}\[)[^[\]\n]+\]:/;

/**
 * Obsidian's metadata cache reads no tag inside an HTML comment or math. The
 * rules below are pinned against its readback (Obsidian 1.13.7) rather than a
 * spec. HTML blocks and display math blocks are block structure and live in
 * `markdown-blocks.ts`; these are the spans inside one paragraph. Issue #138.
 *
 * An **inline comment**: `<!--`, then text that does not open with `>` or `->`
 * and holds no `--`, then `-->`. `<!-- x -- y -->` is not a comment, and
 * neither is an unclosed `<!--`.
 */
const HTML_COMMENT = /<!--(?!-?>)(?:(?!--|\n *\r?\n)[\s\S])*-->/;
/** Unescaped `$$ … $$` within one paragraph, with no spacing rule. */
const INLINE_DOUBLE_MATH = /(?<=(?:^|[^\\])(?:\\\\)*)\$\$(?:(?!\n *\r?\n)[\s\S])*?\$\$/;
/**
 * Unescaped `$ … $` within one paragraph. The opener is not followed by a space
 * or tab; the closer is not preceded by one and not followed by a digit, and a
 * `$` that fails those is passed over rather than ending the span. That is what
 * keeps `cost $5 and #rc for $10` out of math while `m $a #ra b$ n` is in it.
 *
 * Only the opener is a regex; `inlineMathCloser` finds the closer. A lazy
 * regex body would rescan to the end of the paragraph from every opener that
 * never closes — quadratic in a table of prices (issue #143).
 */
const INLINE_MATH_OPEN = /(?<inlineMath>(?<=(?:^|[^\\])(?:\\\\)*)\$(?![ \t$]))/;

/** The start of an empty or spaces-only line, which inline math cannot cross. */
const PARAGRAPH_BREAK = /\n *\r?\n/y;

/**
 * The closer of the inline math span each opener in `content` starts, or
 * `undefined` when it has none. Whether a `$` can close a span does not depend
 * on where the span opened, so the closers and paragraph breaks are listed
 * once and each opener takes the first closer after it, provided no break
 * comes first. Openers must be looked up in ascending order.
 */
function inlineMathCloser(content: string): (open: number) => number | undefined {
  const closers: number[] = [];
  const breaks: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '$' && closesInlineMath(content, i)) closers.push(i);
    if (content[i] === '\n') {
      PARAGRAPH_BREAK.lastIndex = i;
      if (PARAGRAPH_BREAK.test(content)) breaks.push(i);
    }
  }
  let c = 0;
  let b = 0;
  return (open) => {
    while ((closers[c] ?? Infinity) <= open) c++;
    while ((breaks[b] ?? Infinity) <= open) b++;
    const close = closers[c];
    if (close === undefined || (breaks[b] ?? Infinity) < close) return;
    return close;
  };
}

/** Whether the `$` at `i` can close inline math: unescaped, after no space or tab, before no digit. */
function closesInlineMath(content: string, i: number): boolean {
  const before = content[i - 1];
  if (before === ' ' || before === '\t' || /[0-9]/.test(content[i + 1] ?? '')) return false;
  let backslashes = 0;
  while (content[i - 1 - backslashes] === '\\') backslashes++;
  return backslashes % 2 === 0;
}

/**
 * Markup Obsidian parses as a node of its own, so a `#` right after it opens a
 * tag the way one does after whitespace, while the same character as plain
 * text blocks the tag. Protecting each span makes the `#` after it a segment
 * start. Pinned against Obsidian 1.13.7 readback; issue #138.
 *
 * A **backslash escape** of ASCII punctuation: `\]#t` and `\\#t` are tags,
 * `\#t` is an escaped hash and not one.
 */
const ESCAPE = /(?<escape>\\[!-/:-@[-`{-~])/;
/**
 * An **inline HTML tag**: `<br>#t`, `x <b>#t</b>`, `<a href="u">#t</a>`. Only
 * a tag CommonMark's grammar accepts is one; `x <a b #t> y` is text.
 */
const HTML_TAG = new RegExp(`(?:${HTML_TAG_SOURCE})`);
/**
 * An **emphasis, highlight, or strikethrough delimiter run** directly before
 * `#` that has a partner elsewhere on its line: `**#t**`, `*#t*`, `**x**#t`,
 * `foo*#t*bar`, `==#t==`, `~~#t~~`. An unpartnered run is literal text to
 * Obsidian (`a *#t`, `a ==#t`), and so is a single `~`. The partner test is
 * the same delimiter anywhere else on the line. `_` pairs by rules of its own,
 * in `underscoreMarks`.
 */
const EMPHASIS_RUN =
  /(?<!\*)(?=\*+#)(?:(?<=\*[^\n]*?)|(?=\*+#[^\n]*?\*))\*+|(?<!=)(?===#)(?:(?<===[^\n]*?)|(?===#[^\n]*?==))==|(?<!~)(?=~~#)(?:(?<=~~[^\n]*?)|(?=~~#[^\n]*?~~))~~/;
/**
 * A **blockquote marker** directly before `#`: `>#t`, `> >#t`. A table cell
 * pipe is the same kind of node; `markupMarks` protects those, since telling a
 * table row from a pipe in prose takes the block structure around it.
 */
const QUOTE_MARKER = />(?=#)(?<=(?:^|\n)[ \t]*(?:>[ \t]*)*>)/;

/**
 * Every span a tag cannot live in, or that a `#` right after opens a tag, in
 * the order `protectedSpans` tries them: the construct that opens first wins,
 * so `$b <!-- c$` is math and `<!-- $b -->` is a comment.
 */
const INLINE_SPANS = new RegExp(
  [
    INLINE_CODE,
    WIKILINK,
    IMAGE,
    LINK_TAIL,
    LINK_DEFINITION,
    HTML_COMMENT,
    INLINE_DOUBLE_MATH,
    INLINE_MATH_OPEN,
    ESCAPE,
    HTML_TAG,
    EMPHASIS_RUN,
    QUOTE_MARKER,
  ]
    .map((r) => r.source)
    .join('|'),
  'g',
);

/**
 * The characters that end an inline tag, as the body of a character class:
 * whitespace, ASCII punctuation other than `_`, `-`, and `/`, and the General
 * (U+2000–U+206F) and Supplemental (U+2E00–U+2E7F) Punctuation blocks. Every
 * other code point — letters and digits in any script, emoji, variation
 * selectors, combining marks, symbols such as `€` or `©` — continues a tag.
 * Read off Obsidian's own metadata cache (1.13.7): `#café`, `#日本語`, and
 * `#✅done` are tags, `#tag—dash` ends at the em dash, and a zero-width joiner
 * ends a tag mid-emoji. Every regex using it carries the `u` flag, so the class
 * matches whole code points rather than surrogate halves.
 */
const TAG_STOP = String.raw`\s!-,.:-@\[-\^\x60{-~\u2000-\u206F\u2E00-\u2E7F`;

/** One code point that continues an inline tag. */
const TAG_CHAR = `[^${TAG_STOP}]`;

/**
 * A tag's left boundary: the start of a segment, or whitespace (`\s`, which
 * takes in NBSP and U+3000). A punctuation mark that is plain text before `#`
 * blocks a tag in Obsidian — `(#a`, `.#b`, `x—#c`, an unpartnered `a *#d` —
 * and so does the `\` of an escaped `\#`. A segment starts at the note body or
 * right after a protected span, and Obsidian reads a tag glued to either:
 * `[[x]]#t`, `` `c`#t ``, `**#t**`, `<br>#t`, `[#t]`, `_#t_`, and a table
 * cell's `|#t|` are tags.
 */
const TAG_LEFT_BOUNDARY = String.raw`(^|\s)`;

/** Obsidian rejects a tag made only of ASCII digits (`#1984`); `#1990s` and `#١٢٣` are tags. */
const ALL_DIGITS = /^[0-9]+$/;

/**
 * A run of tags glued end to end, `#a#b`. Obsidian reads each `#` that
 * directly follows a tag as the start of another one — `#tl#tm` is two tags,
 * `#tn/#to` is `tn/` and `to` — but not one after an all-digit run, since that
 * run was never a tag (`#1984#x` holds none).
 */
const TAG_CHAIN_SOURCE = `${TAG_LEFT_BOUNDARY}((?:#${TAG_CHAR}+)+)`;
const TAG_CHAIN = new RegExp(TAG_CHAIN_SOURCE, 'gu');
/** A chain plus the single horizontal space after it, which a removal may take. */
const TAG_CHAIN_SPACED = new RegExp(`${TAG_CHAIN_SOURCE}([ \\t]?)`, 'gu');

/** The tags in a matched chain: each name, up to the first all-digit one. */
function chainTags(chain: string): string[] {
  const tags: string[] = [];
  for (const name of chain.slice(1).split('#')) {
    if (ALL_DIGITS.test(name)) break;
    tags.push(name);
  }
  return tags;
}

/**
 * Inline `#tag` syntax lives in the body. The frontmatter block is spliced off
 * first and re-attached verbatim, so a `#` inside a YAML scalar is neither read
 * as a tag nor rewritten by a removal.
 */
function mutateInlineTags(
  content: string,
  tags: string[],
  operation: TagOperation,
  applied: Set<string>,
  skipped: Set<string>,
): string {
  const { raw, body } = splice(content);
  const segments = splitProtectedSegments(body);
  let updatedNonCode = false;

  if (operation === 'add') {
    const present = new Set(inlineTags(segments));
    for (const tag of tags) {
      if (present.has(tag)) {
        skipped.add(tag);
      } else {
        applied.add(tag);
      }
    }
    const additions = tags
      .filter((t) => applied.has(t))
      .map((t) => `#${t}`)
      .join(' ');
    if (additions.length > 0) {
      /**
       * The separator turns on everything that precedes the insertion point in
       * the finished note — `raw` and every segment — not on any one of them.
       * A note that is nothing but frontmatter has an empty body while `raw`
       * already ends in a newline, and a note whose body ends at a closing code
       * fence ends in a protected segment the tag must not be glued to.
       */
      const preceding = raw + segments.map((s) => s.text).join('');
      const sep = preceding.endsWith('\n') ? '' : '\n';
      const trailing = segments.length > 0 ? (segments[segments.length - 1] ?? null) : null;
      if (trailing && !trailing.protected) {
        trailing.text = `${trailing.text}${sep}${additions}\n`;
      } else {
        segments.push({ protected: false, text: `${sep}${additions}\n` });
      }
      updatedNonCode = true;
    }
  } else {
    for (const tag of tags) {
      /** `#1984` is text to Obsidian and to `list`, so a removal leaves it too. */
      if (ALL_DIGITS.test(tag)) {
        skipped.add(tag);
        continue;
      }
      const remove = removeFromChain(tag);
      let found = false;
      for (const s of segments) {
        if (s.protected) continue;
        /**
         * One pass is not enough: the regex consumes the space after the tag,
         * and that space is the left boundary the next occurrence needs, so a
         * single pass stops at the first of two same tags separated by one
         * space. Repeat until the segment stops changing — every pass drops at
         * least the tag itself, so this terminates.
         */
        for (
          let next = s.text.replace(TAG_CHAIN_SPACED, remove);
          next !== s.text;
          next = s.text.replace(TAG_CHAIN_SPACED, remove)
        ) {
          s.text = next;
          found = true;
        }
      }
      if (found) {
        applied.add(tag);
        updatedNonCode = true;
      } else {
        skipped.add(tag);
      }
    }
  }

  if (!updatedNonCode) return content;
  return raw + segments.map((s) => s.text).join('');
}

/**
 * Close the gap a removed tag leaves without touching anything else. Exactly one
 * adjacent horizontal space goes with the tag — the one before it when there is
 * one, otherwise the one after — so neighbouring words neither jam together nor
 * end up separated by a widened gap. Everything outside that span survives byte
 * for byte: list and code-block indentation, a trailing two-space hard line
 * break, table cell padding.
 */
function removeAt(
  full: string,
  leading: string,
  trailing: string,
  offset: number,
  whole: string,
): string {
  if (!/^[ \t]$/.test(leading)) return leading;
  // A space is all that marks the start of an immediately following tag —
  // taking it would silently stop that tag being one.
  if (trailing === '' && whole[offset + full.length] === '#') return leading;
  return trailing;
}

interface Segment {
  protected: boolean;
  text: string;
}

/**
 * A `TAG_CHAIN` replacer that drops every tag named `tag` from a chain and
 * keeps the rest. Chains are split at `#` rather than matched against the
 * name, so removing `caf` cannot strip the front off `#café`. A chain that
 * loses all its tags takes one adjacent space with it, per `removeAt`.
 */
function removeFromChain(
  tag: string,
): (
  full: string,
  leading: string,
  chain: string,
  trailing: string,
  offset: number,
  whole: string,
) => string {
  return (full, leading, chain, trailing, offset, whole) => {
    const names = chain.slice(1).split('#');
    const tagged = chainTags(chain).length;
    const kept = names.filter((name, i) => i >= tagged || name !== tag);
    if (kept.length === names.length) return full;
    if (kept.length === 0) return removeAt(full, leading, trailing, offset, whole);
    return `${leading}#${kept.join('#')}${trailing}`;
  };
}

/** Every inline tag in the segments a tag may live in, each once, in order of first appearance. */
function inlineTags(segments: Segment[]): string[] {
  const tags = new Set<string>();
  for (const seg of segments) {
    if (seg.protected) continue;
    for (const m of seg.text.matchAll(TAG_CHAIN)) {
      for (const tag of chainTags(m[2] ?? '')) tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Split the body into stretches a tag may live in and stretches it may not.
 * `scanBlocks` finds the block structure — code, HTML blocks, and display math
 * are hidden whole — and each paragraph, heading, and table row is split by
 * `splitInline`. Both the read and the write path run over the result, so
 * `list` and `remove` agree on what counts as a tag.
 */
function splitProtectedSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  const push = (isProtected: boolean, text: string) => {
    if (text.length > 0) segments.push({ protected: isProtected, text });
  };
  for (const block of scanBlocks(content)) {
    push(false, content.slice(cursor, block.start));
    const text = content.slice(block.start, block.end);
    if (block.kind === 'hidden') push(true, text);
    else for (const seg of splitInline(text, block.tableRow)) push(seg.protected, seg.text);
    cursor = block.end;
  }
  push(false, content.slice(cursor));
  return segments;
}

/** A protected span inside one paragraph, heading, or table row. */
interface InlineSpan {
  end: number;
  kind: 'escape' | 'linkTail' | 'other';
  start: number;
}

/**
 * The spans of `text` a tag cannot live in, or that a `#` right after opens a
 * tag, in order.
 */
function protectedSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const mathCloser = inlineMathCloser(text);
  const codeCloser = codeSpanCloser(text);
  INLINE_SPANS.lastIndex = 0;
  for (;;) {
    const m = INLINE_SPANS.exec(text);
    if (!m) break;
    let start = m.index;
    let end = start + m[0].length;
    if (m.groups?.code !== undefined) {
      /**
       * A run with no closer leaves its first backtick as text, and the rest of
       * the run is tried as an opener of its own — where CommonMark would make
       * the whole run text, Obsidian reads `` a ``b #x` `` as the code span
       * `` `b #x` ``. Each shorter opener is tried here rather than by
       * re-running the regex, which would rescan the run from every backtick.
       */
      const runEnd = end;
      let close = codeCloser(start, runEnd - start);
      while (close === undefined && ++start < runEnd) close = codeCloser(start, runEnd - start);
      if (close === undefined) continue;
      end = close;
      INLINE_SPANS.lastIndex = end;
    } else if (m.groups?.inlineMath !== undefined) {
      /**
       * The `$$` constructs are tried before this one and nothing after it
       * opens with `$`, so an opener with no closer leaves this position to
       * plain text and the scan resumes one character on.
       */
      const close = mathCloser(m.index);
      if (close === undefined) continue;
      end = close + 1;
      INLINE_SPANS.lastIndex = end;
    }
    const kind =
      m.groups?.escape !== undefined
        ? 'escape'
        : m.groups?.linkTail !== undefined
          ? 'linkTail'
          : 'other';
    spans.push({ start, end, kind });
  }
  return spans;
}

/**
 * Split one paragraph, heading, or table row. Beyond the spans of
 * `protectedSpans`, three kinds of markup become protected one-character (or
 * one-run) segments, since a `#` directly after each opens a tag: the brackets
 * of a bracketed span, a table row's cell pipes, and an underscore run that
 * pairs as emphasis (`underscoreMarks`).
 */
function splitInline(text: string, tableRow: boolean): Segment[] {
  const spans = protectedSpans(text);
  /** `markEnd[i]` is the end of the mark starting at `i`, or 0. */
  const markEnd = new Uint32Array(text.length);
  const linkTexts = markupMarks(text, spans, tableRow, markEnd);
  underscoreMarks(text, spans, linkTexts, markEnd);

  const segments: Segment[] = [];
  let cursor = 0;
  const cut = (start: number, end: number) => {
    if (start > cursor) segments.push({ protected: false, text: text.slice(cursor, start) });
    segments.push({ protected: true, text: text.slice(start, end) });
    cursor = end;
  };
  let s = 0;
  for (let i = 0; i < text.length; ) {
    const span = spans[s];
    if (span?.start === i) {
      cut(i, span.end);
      i = span.end;
      s++;
    } else if (markEnd[i]) {
      const end = markEnd[i] as number;
      cut(i, end);
      i = end;
    } else i++;
  }
  if (cursor < text.length) segments.push({ protected: false, text: text.slice(cursor) });
  return segments;
}

/**
 * Mark the brackets of every bracketed span and, in a table row, every cell
 * pipe; return the link texts — the ranges between a `[` and the `LINK_TAIL`
 * that closes it. Pinned against Obsidian readback: `[#t]`, `x [a]#t`, and
 * `[#t](u)` are tags, as is `[#t` closed on the next line of the paragraph,
 * while `x [#t` (never closed), `x []#t` (empty), `[^#t]` (a footnote), and
 * the outer `[` of `[#t [b] c]` (a `[` before the `]`) open none. A `]]`
 * closes a wikilink, not a bracketed span.
 */
function markupMarks(
  text: string,
  spans: InlineSpan[],
  tableRow: boolean,
  markEnd: Uint32Array,
): Array<[number, number]> {
  const linkTexts: Array<[number, number]> = [];
  let open = -1;
  let s = 0;
  for (let i = 0; i < text.length; ) {
    const span = spans[s];
    if (span?.start === i) {
      if (span.kind === 'linkTail') {
        if (open >= 0 && i > open + 1) {
          markEnd[open] = open + 1;
          linkTexts.push([open + 1, i]);
        }
        open = -1;
      }
      i = span.end;
      s++;
      continue;
    }
    const ch = text[i];
    if (ch === '[') {
      open = text[i + 1] === '^' ? -1 : i;
    } else if (ch === ']') {
      if (open >= 0 && i > open + 1 && text[i + 1] !== ']') {
        markEnd[open] = open + 1;
        markEnd[i] = i + 1;
      }
      open = -1;
    } else if (ch === '|' && tableRow) {
      markEnd[i] = i + 1;
    }
    i++;
  }
  return linkTexts;
}

const TAG_AT = new RegExp(`#${TAG_CHAR}+`, 'uy');

/**
 * Mark the underscore runs that pair as emphasis. `_` is a tag character, so
 * this decides both where a tag may start (`x _#t_ y` is tagged `t`,
 * `snake_case_#t` is tagged `t`) and where one ends (the closing `_` of
 * `_#t_` is not part of it). None of this is CommonMark's flanking rule; it is
 * fitted to more than eighty Obsidian 1.13.7 readback probes. Walking the
 * paragraph's runs in order, with at most one opener pending:
 *
 * - With none pending, a run becomes the opener.
 * - A run followed by an ASCII letter or digit cannot close (`x _#t_b` holds
 *   no tag) and is passed over.
 * - A run longer than the opener cannot close it and is passed over.
 * - When the text between opener and run both starts and ends with whitespace
 *   (`a_ _#t`), the pair fails and the run becomes the opener instead.
 * - Otherwise the two pair, and both are marks.
 *
 * A run inside a tag's name, or inside a protected span — code, math, a
 * comment, a link destination — can close but never open: `#qb_name_ x` is the
 * tag `qb_name_`, and `x `a_` b_#t` holds no tag while `x _a `_` b_#t` pairs
 * the first two runs. An escaped `\_` is text. Link text pairs on its own, as
 * CommonMark nests it: `[x _a_#t](u)` is tagged `t`, while the run in
 * `[a_](u) b_#t` cannot reach past the link.
 */
function underscoreMarks(
  text: string,
  spans: InlineSpan[],
  linkTexts: Array<[number, number]>,
  markEnd: Uint32Array,
): void {
  type Run = { start: number; end: number };
  let outer: Run | undefined;
  let inner: Run | undefined;
  /** Index of the link text the walk is in, or -1 outside every link. */
  let link = -1;
  let tagEnd = -1;
  let s = 0;
  let l = 0;

  /** Offer `run` to the pending opener; returns the opener pending afterwards. */
  const offer = (opener: Run | undefined, run: Run, closeOnly: boolean): Run | undefined => {
    if (!opener) return closeOnly ? undefined : run;
    if (/[A-Za-z0-9]/.test(text[run.end] ?? '')) return opener;
    if (run.end - run.start > opener.end - opener.start) return opener;
    if (/\s/.test(text[opener.end] ?? '') && /\s/.test(text[run.start - 1] ?? '')) {
      return closeOnly ? undefined : run;
    }
    markEnd[opener.start] = opener.end;
    markEnd[run.start] = run.end;
    return;
  };

  for (let i = 0; i < text.length; ) {
    while ((spans[s]?.end ?? Number.POSITIVE_INFINITY) <= i) s++;
    const span = spans[s];
    const inSpan = span !== undefined && span.start <= i;
    if (inSpan && span.kind === 'escape') {
      i = span.end;
      continue;
    }
    const ch = text[i];
    if (ch === '#' && !inSpan) {
      TAG_AT.lastIndex = i;
      if (TAG_AT.test(text)) tagEnd = TAG_AT.lastIndex;
    }
    if (ch !== '_') {
      i++;
      continue;
    }
    const run = { start: i, end: i };
    while (text[run.end] === '_' && (!inSpan || run.end < span.end)) run.end++;
    i = run.end;
    const closeOnly = inSpan || run.start < tagEnd;
    while ((linkTexts[l]?.[1] ?? Number.POSITIVE_INFINITY) <= run.start) l++;
    if ((linkTexts[l]?.[0] ?? Number.POSITIVE_INFINITY) <= run.start) {
      if (link !== l) inner = undefined;
      link = l;
      inner = offer(inner, run, closeOnly);
    } else {
      outer = offer(outer, run, closeOnly);
    }
  }
}

/**
 * Read-only helpers for `obsidian_manage_tags list`. Inline tags are read from
 * the body only, and through the same protected-segment split and left boundary
 * a removal uses, so what `list` reports is exactly what `remove` can reach — a
 * `#` inside a YAML scalar, code, an HTML block or comment, math, an image, or
 * a link's destination or label, or one glued to the character before it
 * (`\#`, `(#x`), is none of them. A tag runs for as long as `TAG_CHAR`
 * matches, and an all-digit run is not a tag.
 */
export function listTagsFromContent(
  content: string,
  frontmatter: Record<string, unknown>,
): {
  frontmatter: string[];
  inline: string[];
} {
  return {
    frontmatter: normalizeTagList(frontmatter.tags),
    inline: inlineTags(splitProtectedSegments(splice(content).body)),
  };
}

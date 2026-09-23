/**
 * @fileoverview Read-modify-write helpers for the YAML frontmatter block of a
 * note's raw content. Used by the composed manage-frontmatter / manage-tags
 * tools when the upstream Local REST API has no single-call equivalent.
 * @module services/obsidian/frontmatter-ops
 */

import { type Document, isMap, isScalar, isSeq, parseDocument, Scalar, type YAMLSeq } from 'yaml';

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

const FENCED_CODE_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~/;
const INLINE_CODE = /`[^`\n]+`/;
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
/** `[text](destination)` — a `#` in the link text or in a URL fragment is link syntax. */
const MARKDOWN_LINK = /\[[^[\]\n]*\]\([^()\n]*\)/;
/**
 * `[text][label]` and `[text][]` — the reference-style forms of the same link.
 * The label must follow the text immediately; a bracketed phrase on its own
 * (`[note #work]`) is not a link and its `#` stays a tag.
 */
const REFERENCE_LINK = /\[[^[\]\n]+\]\[[^[\]\n]*\]/;

/**
 * Obsidian's metadata cache reads no tag inside an HTML comment or math. The
 * rules below are pinned against its readback (Obsidian 1.13.7) rather than a
 * spec, and a few differ from CommonMark: an inline span ends at an empty or
 * spaces-only line but runs through a tab-only one. Issue #138.
 *
 * An **HTML block** opens with `<!--` at the start of a line — after up to
 * three spaces of indentation, or after list-item and blockquote markers — and
 * runs through the end of the line holding the first `-->`, or to the end of
 * the note when none follows. The whole closing line is hidden, so the tag in
 * `<!-- a --> #rd` is not one. A line opening with `<!-->` or `<!--->` closes
 * on itself.
 *
 * The prefix gives every whitespace character exactly one owner — a list
 * marker takes the one it requires, the next marker's indent takes the rest,
 * and the tail after the last marker takes what follows it — so the lookbehind
 * cannot backtrack exponentially over a long run of markers. The `(?=<!--)`
 * gate runs it only where a comment opens.
 */
const HTML_BLOCK =
  /(?=<!--)(?<=(?:^|\n)(?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])[ \t]))*(?:(?<=>)[ \t]?[ ]{0,3}|(?<=(?:[-+*]|\d[.)])[ \t])[ \t]*|[ ]{0,3}))<!--(?:-?>[^\n]*|[\s\S]*?-->[^\n]*|[\s\S]*)/;
/**
 * An **inline comment** anywhere else: `<!--`, then text that does not open
 * with `>` or `->` and holds no `--`, then `-->`, within one paragraph.
 * `<!-- x -- y -->` is not a comment, and neither is an unclosed `<!--`.
 */
const HTML_COMMENT = /<!--(?!-?>)(?:(?!--|\n *\r?\n)[\s\S])*-->/;
/**
 * A **display math block**: a line that opens with `$$` and holds no second
 * `$$`. It runs, across empty lines, to the next line that is `$$` alone, or to
 * the end of the note — `$$\na\nb$$` does not close it.
 */
const DISPLAY_MATH =
  /(?<=(?:^|\n)[ \t]*)\$\$(?![^\n]*\$\$)[\s\S]*?(?:\n[ \t]*\$\$[ \t]*(?=\r?\n|$)|$)/;
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
const ESCAPE = /\\[!-/:-@[-`{-~]/;
/** An **inline HTML tag**: `<br>#t`, `x <b>#t</b>`, `<a href="u">#t</a>`. */
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/;
/**
 * An **emphasis, highlight, or strikethrough delimiter run** directly before
 * `#` that has a partner elsewhere on its line: `**#t**`, `*#t*`, `**x**#t`,
 * `foo*#t*bar`, `==#t==`, `~~#t~~`. An unpartnered run is literal text to
 * Obsidian (`a *#t`, `a ==#t`), and so is a single `~`. The partner test is
 * the same delimiter anywhere else on the line. `_` runs are left out: `_` is a
 * tag character, so `_#t_` would read as the tag `t_`, where Obsidian reads `t`.
 */
const EMPHASIS_RUN =
  /(?<!\*)(?=\*+#)(?:(?<=\*[^\n]*?)|(?=\*+#[^\n]*?\*))\*+|(?<!=)(?===#)(?:(?<===[^\n]*?)|(?===#[^\n]*?==))==|(?<!~)(?=~~#)(?:(?<=~~[^\n]*?)|(?=~~#[^\n]*?~~))~~/;
/**
 * A **blockquote marker** directly before `#`: `>#t`, `> >#t`. A table cell
 * pipe is the same kind of node (`|#t|` in a table row is a tag), but telling
 * a table row from a pipe in prose takes the lines above it, which this
 * one-pass scan does not look at, so `|#t` stays unread either way.
 */
const QUOTE_MARKER = />(?=#)(?<=(?:^|\n)[ \t]*(?:>[ \t]*)*>)/;

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
 * `[[x]]#t`, `` `c`#t ``, `**#t**`, and `<br>#t` are tags.
 */
const TAG_LEFT_BOUNDARY = String.raw`(^|\s)`;

/** Obsidian rejects a tag made only of ASCII digits (`#1984`); `#1990s` and `#١٢٣` are tags. */
const ALL_DIGITS = /^[0-9]+$/;

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
    for (const tag of tags) {
      const re = makeInlineTagRegex(tag);
      const present = segments.some((s) => !s.protected && re.test(s.text));
      if (present) {
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
      const re = makeInlineTagRegex(tag);
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
          let next = s.text.replace(re, removeAt);
          next !== s.text;
          next = s.text.replace(re, removeAt)
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
 * Split the body into stretches a tag may live in and stretches it may not:
 * code, where a `#` is code; link syntax, where a `#` is a heading anchor or
 * link text; HTML comments and math, where Obsidian reads no tag; and the
 * markup after which a `#` opens a tag (`ESCAPE` through `QUOTE_MARKER`). The
 * construct that opens first wins, so `$b <!-- c$` is math and `<!-- $b -->`
 * is a comment. Both the read and the write path run over the result, so
 * `list` and `remove` agree on what counts as a tag.
 */
function splitProtectedSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  const re = new RegExp(
    [
      FENCED_CODE_BLOCK,
      INLINE_CODE,
      WIKILINK,
      MARKDOWN_LINK,
      REFERENCE_LINK,
      HTML_BLOCK,
      HTML_COMMENT,
      DISPLAY_MATH,
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
  const mathCloser = inlineMathCloser(content);
  for (;;) {
    const m = re.exec(content);
    if (!m) break;
    let matched = m[0] ?? '';
    if (m.groups?.inlineMath !== undefined) {
      /**
       * The `$$` constructs are tried before this one and nothing after it
       * opens with `$`, so an opener with no closer leaves this position to
       * plain text and the scan resumes one character on.
       */
      const close = mathCloser(m.index);
      if (close === undefined) continue;
      matched = content.slice(m.index, close + 1);
      re.lastIndex = close + 1;
    }
    if (m.index > cursor) {
      segments.push({ protected: false, text: content.slice(cursor, m.index) });
    }
    segments.push({ protected: true, text: matched });
    cursor = m.index + matched.length;
  }
  if (cursor < content.length) {
    segments.push({ protected: false, text: content.slice(cursor) });
  }
  return segments;
}

/**
 * Captures the character before the tag and the single horizontal space after
 * it, if any. The lookahead refuses a longer tag that merely starts with `tag`
 * — removing `caf` must not strip the front off `#café`.
 */
function makeInlineTagRegex(tag: string): RegExp {
  const escaped = tag.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(`${TAG_LEFT_BOUNDARY}#${escaped}(?!${TAG_CHAR})([ \\t]?)`, 'gu');
}

/**
 * Read-only helpers for `obsidian_manage_tags list`. Inline tags are read from
 * the body only, and through the same protected-segment split and left boundary
 * a removal uses, so what `list` reports is exactly what `remove` can reach — a
 * `#` inside a YAML scalar, a code span, a link span, an HTML comment, or math,
 * or one glued to the character before it (`\#`, `(#x`), is none of them. A tag
 * runs for as long as `TAG_CHAR` matches, and an all-digit run is not a tag.
 */
export function listTagsFromContent(
  content: string,
  frontmatter: Record<string, unknown>,
): {
  frontmatter: string[];
  inline: string[];
} {
  const fmTags = normalizeTagList(frontmatter.tags);
  const inline: string[] = [];
  const seen = new Set<string>();
  /** Each segment is scanned to exhaustion, which resets `lastIndex` between them. */
  const re = new RegExp(`${TAG_LEFT_BOUNDARY}#(${TAG_CHAR}+)`, 'gu');
  for (const seg of splitProtectedSegments(splice(content).body)) {
    if (seg.protected) continue;
    for (;;) {
      const m = re.exec(seg.text);
      if (!m) break;
      const t = m[2];
      if (t && !ALL_DIGITS.test(t) && !seen.has(t)) {
        seen.add(t);
        inline.push(t);
      }
    }
  }
  return { frontmatter: fmTags, inline };
}

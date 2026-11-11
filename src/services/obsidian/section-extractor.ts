/**
 * @fileoverview Client-side section extraction from a NoteJson body for
 * `format: 'section'`. Headings are found the way the plugin's markdown-patch
 * finds them for its document map and PATCH targeting, so a section read
 * covers the span a section write edits, sliced from the note's own bytes.
 * `marked` is pinned exact to the 17.x line markdown-patch parses with:
 * `marked` 18 reads some shapes differently (a `#tag` line over `===`, a tab
 * before an ATX closing sequence, an empty `- ` item), which would split this
 * scan from the plugin's document map.
 * @module services/obsidian/section-extractor
 */

import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getDefaults, Lexer, type Token, Tokenizer, type Tokens } from 'marked';
import { splice } from './frontmatter-ops.js';
import type { Within } from './patch-instruction.js';
import type { NoteJson, SectionTarget } from './types.js';

/** Delimiter joining a heading path, matching upstream's PATCH `Target-Delimiter`. */
const HEADING_DELIMITER = '::';

/** An extracted section value plus, for heading targets, how the locator resolved. */
export interface SectionExtraction {
  /**
   * Every full heading path the target could name, in document order: each
   * heading sharing a bare-leaf target, or each repeat of a delimited target's
   * resolved path. Present only when more than one heading matched — the read
   * still returns the first, so this is disclosure, not a new failure mode.
   */
  candidates?: string[];
  /**
   * Full `::`-joined heading path, root included, that the read resolved to.
   * Heading sections only.
   */
  sectionTarget?: string;
  /** Raw markdown (heading/block) or the JSON-typed frontmatter value. */
  value: unknown;
}

/**
 * Extract a section's raw markdown (heading/block) or JSON value (frontmatter).
 * Throws `NotFound` if the target does not exist in the note.
 */
export function extractSection(note: NoteJson, section: SectionTarget): SectionExtraction {
  switch (section.type) {
    case 'frontmatter':
      return { value: extractFrontmatterField(note, section.target) };
    case 'heading':
      return extractHeading(note.content, section.target);
    case 'block':
      return { value: extractBlock(note.content, section.target) };
  }
}

function extractFrontmatterField(note: NoteJson, key: string): unknown {
  if (!(key in note.frontmatter)) {
    throw notFound(`Frontmatter key '${key}' not found in ${note.path}.`, {
      path: note.path,
      key,
    });
  }
  return note.frontmatter[key];
}

/** A heading as the plugin's parser reads it, located in the note's own bytes. */
export interface Heading {
  /**
   * Offset just past the heading's last line — its underline, for a setext
   * heading — and that line's ending, or the note's length.
   */
  end: number;
  /** 1–6: the `#` count of an ATX heading, 1 or 2 for a setext `=` or `-` underline. */
  level: number;
  /** Offset of the heading's first byte: its `#` line (indent included), or a setext heading's first text line. */
  start: number;
  /**
   * Heading text as the document map keys it: the parser's text, trimmed.
   * Empty for an untitled heading; a multi-line setext heading keeps its
   * newlines.
   */
  text: string;
}

/**
 * The frontmatter block markdown-patch strips before it lexes: an opening
 * `---` line, then either a `---` line at once or YAML and a closing `---`
 * line, with CRLF, LF, or lone-CR endings. `splice` — the boundary block
 * extraction and the body-scoped writers use — also closes on a `---` with
 * more text after it on its line; the heading scan follows the plugin here so
 * its paths match the plugin's map.
 */
const PLUGIN_FRONTMATTER =
  /^---(?:\r\n|\r|\n)(?:---(?:\r\n|\r|\n|$)|[\s\S]*?(?:\r\n|\r|\n)---(?:\r\n|\r|\n|$))/;

/**
 * Every heading in `content`, in document order, found the way the plugin's
 * markdown-patch 2.0 finds them for its document map and PATCH targeting: the
 * frontmatter-stripped body, line endings normalized, lexed with `marked`, and
 * each top-level `heading` token located by accumulating token `raw` lengths.
 * That reads setext headings and skips `#` lines inside fences, HTML blocks,
 * list items, and blockquotes, exactly as the map does. Offsets are mapped
 * back to `content`, so a slice between them is the note's own bytes, CRs
 * included.
 */
export function scanHeadings(content: string): Heading[] {
  const { normalized, at } = pluginBody(content);
  return lexBody(normalized).tokens.flatMap((top) => {
    const heading = headingOf(normalized, top);
    return heading ? [{ ...heading, start: at(heading.start), end: at(heading.end) }] : [];
  });
}

/**
 * The body markdown-patch lexes — `content` past its frontmatter, line endings
 * read as `\n` — and a map from an offset in it back to `content`.
 */
function pluginBody(content: string): { at: (offset: number) => number; normalized: string } {
  const bodyStart = PLUGIN_FRONTMATTER.exec(content)?.[0].length ?? 0;
  const { normalized, toOriginal } = normalizeLineEndings(content.slice(bodyStart));
  return { normalized, at: (offset) => bodyStart + toOriginal(offset) };
}

/**
 * The top-level token at `offset` in `normalized` as a heading, its offsets in
 * `normalized`: `end` is just past its last line and that line's ending — or
 * `undefined` when the token is not a heading.
 */
function headingOf(normalized: string, { token, offset }: TopLevelToken): Heading | undefined {
  if (token.type !== 'heading') return;
  const { depth, text } = token as Tokens.Heading;
  const lineEnd = normalized.indexOf('\n', offset + token.raw.trimEnd().length);
  return {
    level: depth,
    text: text.trim(),
    start: offset,
    end: lineEnd === -1 ? normalized.length : lineEnd + 1,
  };
}

/** A section's own body, as markdown-patch 2.0 models it for a `within` write. */
export interface SectionBody {
  /**
   * `marked` token type of each top-level block in the section's direct body —
   * below its heading line and above its first sub-heading — in order: the
   * blocks a 2.0 `within` index counts (`paragraph`, `list`, `table`, `code`, …).
   */
  blocks: string[];
  /**
   * The section's `content` scope in the note's own bytes: below its heading
   * line through its last subsection. What 2.0's `rejectIfContentPreexists`
   * searches on a plain heading write.
   */
  content: string;
  /** Whether sub-headings follow the direct body — a plain append lands below them. */
  subsections: boolean;
}

/**
 * The body of the heading at full path `path` (its first occurrence), read
 * from one lex of the note, or `undefined` when the note has no such heading.
 * 2.0 assigns a section every top-level token between its heading and the
 * next heading of any level; a `space` token is not a block.
 */
export function sectionBody(content: string, path: string): SectionBody | undefined {
  const { normalized, at } = pluginBody(content);
  const { tokens } = lexBody(normalized);
  const { headings, paths } = indexHeadings(normalized, tokens);
  const h = paths.indexOf(path);
  const heading = headings[h];
  if (!heading) return;
  const next = headings[h + 1];
  return {
    blocks: directBody(tokens, heading, next).map(({ token }) => token.type),
    content: content.slice(at(heading.end), at(closingOf(headings, h)?.start ?? normalized.length)),
    subsections: next !== undefined && next.level > heading.level,
  };
}

/** A heading found in a body's top-level tokens, with its token's index there and `raw` text. */
interface IndexedHeading extends Heading {
  index: number;
  raw: string;
}

/** The headings among `tokens` (lexed from `normalized`), and the full path of each. */
function indexHeadings(
  normalized: string,
  tokens: readonly TopLevelToken[],
): { headings: IndexedHeading[]; paths: string[] } {
  const headings = tokens.flatMap((top, index) => {
    const heading = headingOf(normalized, top);
    return heading ? [{ ...heading, index, raw: top.token.raw }] : [];
  });
  return { headings, paths: headingPaths(headings) };
}

/** The heading closing the section of `headings[h]`: the next one at its level or shallower. */
function closingOf(headings: readonly Heading[], h: number): Heading | undefined {
  const heading = headings[h];
  return heading && headings.find((other, i) => i > h && other.level <= heading.level);
}

/**
 * The top-level blocks of `heading`'s direct body, up to `next` (the heading
 * after it, of any level): the blocks 2.0 assigns the section and a `within`
 * index counts. A `space` token is not a block.
 */
function directBody(
  tokens: readonly TopLevelToken[],
  heading: IndexedHeading,
  next: IndexedHeading | undefined,
): TopLevelToken[] {
  return tokens.slice(heading.index + 1, next?.index).filter(({ token }) => token.type !== 'space');
}

/**
 * The span markdown-patch 1.x edits for the heading at full path `path` (its
 * first occurrence; the service refuses a write to a repeated path), as
 * offsets into `content`, or `undefined` when the note has no such heading.
 * `start` is where a prepend or replace splices in: one past the heading's raw
 * text with trailing whitespace trimmed, which is just past an ordinary
 * heading line's line ending, inside a line's trailing spaces, and past the
 * end of a note whose unterminated last line is the heading. `end` is where an
 * append splices in: the next heading at the same or a shallower level, or the
 * end of the note.
 *
 * The 1.x engine lexes the frontmatter-stripped body with its line endings
 * normalized, then applies the token offsets to the note's own bytes unmapped;
 * these offsets are computed the same way, so on a CRLF note they drift as the
 * engine's do. The engine's offsets sum only the tokens `marked` keeps, so
 * below a definition it drops they fall short of these; they agree wherever a
 * write goes out, since a write whose span such a definition shifts is
 * refused first (`droppedDefinitionInReach`).
 */
export function v1HeadingSpan(
  content: string,
  path: string,
): { end: number; start: number } | undefined {
  const bodyStart = PLUGIN_FRONTMATTER.exec(content)?.[0].length ?? 0;
  const { normalized } = normalizeLineEndings(content.slice(bodyStart));
  const { headings, paths } = indexHeadings(normalized, lexBody(normalized).tokens);
  const h = paths.indexOf(path);
  const heading = headings[h];
  if (!heading) return;
  const closing = closingOf(headings, h);
  return {
    start: bodyStart + heading.start + heading.raw.trimEnd().length + 1,
    end: closing ? bodyStart + closing.start : content.length,
  };
}

/** The `marked` token type of each top-level block in `markdown`, in order. */
export function blockKinds(markdown: string): string[] {
  return lexBody(normalizeLineEndings(markdown).normalized).tokens.flatMap(({ token }) =>
    token.type === 'space' ? [] : [token.type],
  );
}

/** A link reference definition the plugin's `marked` drops, as a refused write names it. */
export interface DroppedDefinition {
  /** The label as the definition writes it, between its brackets. */
  label: string;
  /** 1-based line of `content` the definition starts on, counting `\r\n`, `\r`, and `\n` breaks. */
  line: number;
}

/** A heading write, as `droppedDefinitionInReach` judges it. */
interface HeadingWrite {
  /** Whether the write creates the heading when the note lacks it (`createTargetIfMissing`). */
  create: boolean;
  /** The heading's full `::`-joined path. */
  path: string;
  /** The direct-body block a 2.0 `within` write addresses; absent for a plain write. */
  within?: Within | undefined;
}

/**
 * The first top-level link reference definition the plugin's `marked` drops
 * — one repeating a label already defined, compared as `marked` compares
 * them: case-folded, whitespace runs collapsed — above the point a heading
 * write to full path `path` reads its offsets to, or `undefined` when none
 * does. Both markdown-patch engines place headings by summing the raw lengths
 * of the tokens `marked` keeps, so every offset below a dropped definition
 * falls short by its length; a write that reads one lands outside its
 * section. The point is, for:
 *
 * - a heading the note has (its first occurrence): the heading closing its
 *   section, or the heading itself when the section runs to the end of the
 *   note, whose end the engines take from the note's length;
 * - a 2.0 `within` write: the start of the direct-body block it addresses;
 * - a heading the note lacks, with `create`: the heading closing the section
 *   of its deepest existing ancestor, where the engines insert it — none
 *   when that section runs to the end of the note or no ancestor exists, since
 *   the engines then insert at the note's end. A path through a repeated
 *   heading resolves to a different ancestor in each engine (2.0 walks each
 *   heading's first occurrence, 1.x takes the last occurrence of the longest
 *   path the note has), so the point is the farther of their two;
 * - a heading the note lacks, without `create`: none, since no write goes in.
 *
 * Exact for the range each write reads: a prepend places by the section's
 * start and an append by its end, but each one's duplicate check and
 * empty-section test read the whole section, so both are judged by it.
 */
export function droppedDefinitionInReach(
  content: string,
  write: HeadingWrite,
): DroppedDefinition | undefined {
  if (!repeatsLabel(content)) return;
  const { normalized, at } = pluginBody(content);
  const scan = lexBody(normalized);
  const reach = writeReach(normalized, scan.tokens, write);
  const dropped = reach === undefined ? undefined : firstDropBefore(scan, reach);
  if (!dropped) return;
  const line = (content.slice(0, at(dropped.offset)).match(/\r\n?|\n/g)?.length ?? 0) + 1;
  return { label: definitionLabel(dropped.raw), line };
}

/**
 * Whether two `[label]:` anywhere in `content` share a coarse key. A
 * definition `marked` drops repeats one defined before it, so a note where
 * none share a key has none, and needs no lex.
 */
function repeatsLabel(content: string): boolean {
  const keys = new Set<string>();
  for (const label of containerLabels(content)) {
    const key = labelKey(label);
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

/** The offset in the body a heading write reads its offsets up to, as `droppedDefinitionInReach` lists them. */
function writeReach(
  normalized: string,
  tokens: readonly TopLevelToken[],
  write: HeadingWrite,
): number | undefined {
  const { headings, paths } = indexHeadings(normalized, tokens);
  const h = paths.indexOf(write.path);
  const heading = headings[h];
  if (heading) {
    const body = write.within === undefined ? [] : directBody(tokens, heading, headings[h + 1]);
    const block = write.within === 0 ? body[0] : body.at(-1);
    return block?.offset ?? (closingOf(headings, h) ?? heading).start;
  }
  if (!write.create) return;
  const ends = [
    firstOccurrenceAncestor(headings, write.path),
    lastOccurrenceAncestor(paths, write.path),
  ]
    .map((ancestor) => (ancestor === undefined ? undefined : closingOf(headings, ancestor)?.start))
    .filter((end) => end !== undefined);
  return ends.length > 0 ? Math.max(...ends) : undefined;
}

/**
 * The heading markdown-patch 2.0 creates the missing heading at `path` under:
 * `path` walked from the top a segment at a time, each step taking the first
 * child of that text of the heading reached so far, until a segment names
 * none. Headings nest at most six deep, so the walk ends within seven steps
 * whatever the length of `path`.
 */
function firstOccurrenceAncestor(headings: readonly Heading[], path: string): number | undefined {
  const parents = headingParents(headings);
  let reached = -1;
  for (const segment of path.split(HEADING_DELIMITER)) {
    const child = headings.findIndex((h, i) => parents[i] === reached && h.text === segment);
    if (child === -1) break;
    reached = child;
  }
  return reached === -1 ? undefined : reached;
}

/**
 * The heading markdown-patch 1.x creates the missing heading at `path` under:
 * the longest heading path that `path` extends by whole segments, at its last
 * occurrence — the one the 1.x map keys that path to. Each path is compared
 * once, so the search is linear in the paths' length and in `path`'s.
 */
function lastOccurrenceAncestor(paths: readonly string[], path: string): number | undefined {
  let found: number | undefined;
  let length = -1;
  paths.forEach((candidate, i) => {
    if (candidate.length >= length && path.startsWith(`${candidate}${HEADING_DELIMITER}`)) {
      found = i;
      length = candidate.length;
    }
  });
  return found;
}

/**
 * The first definition stock `marked` drops in the body `scan` lexed that
 * starts before `reach`. Two kinds: each one the scan dropped — it registers a
 * subset of the labels `marked` does, so `marked` drops it too — and each
 * `def` block the scan kept whose label a list or blockquote above it may
 * define first. The scan lexes neither container (see `HeadingScanTokenizer`),
 * so it never registers that first label; `marked` does, and drops the later
 * definition. A container's labels are read from its raw text, which also
 * finds a `[x]:` that `marked` reads as no definition — mid-line, in a fence,
 * after a task checkbox — and keys compare coarsely (`labelKey`), so this
 * finds every definition `marked` drops and some it keeps.
 */
function firstDropBefore(scan: BodyScan, reach: number): DroppedSpan | undefined {
  const [scanned] = scan.dropped;
  const limit = Math.min(reach, scanned?.offset ?? reach);
  const defined = new Set<string>();
  for (const { offset, token } of scan.tokens) {
    if (offset >= limit) break;
    if (token.type === 'list' || token.type === 'blockquote') {
      for (const label of containerLabels(token.raw)) defined.add(labelKey(label));
    } else if (token.type === 'def' && defined.has(labelKey(definitionLabel(token.raw)))) {
      return { offset, raw: token.raw };
    }
  }
  return scanned && scanned.offset < reach ? scanned : undefined;
}

/**
 * A label as `marked` tags it (`toLowerCase()`, whitespace runs collapsed),
 * coarsened: whitespace and `>` removed and `ς` read as `σ`. A multi-line
 * label inside a list item or blockquote carries the container's prefixes
 * (indentation, `>`) in the raw text, and none in the tag `marked` gives it,
 * so equal tags always give equal keys; a few unequal ones (`a>b`, `ab`) do too.
 */
function labelKey(label: string): string {
  return label.toLowerCase().replaceAll('ς', 'σ').replace(/[\s>]/g, '');
}

/** The label a definition's `raw` opens with, between its brackets as written. */
function definitionLabel(raw: string): string {
  const open = raw.indexOf('[');
  return raw.slice(open + 1, bracketAt(raw, open + 1));
}

/**
 * The offset of the first `[` or `]` at or after `from` in `text` that no
 * backslash escapes, reading each `\` and the character after it as a pair,
 * or `text.length`.
 */
function bracketAt(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] !== '[' && text[i] !== ']') i += text[i] === '\\' ? 2 : 1;
  return Math.min(i, text.length);
}

/**
 * Every `[label]:` in `text` whose label holds no unescaped bracket, in one
 * pass: at each unescaped `[`, the label runs to the next unescaped bracket,
 * and the scan resumes at it when it is a `[`, past it otherwise. Nothing is
 * read twice, which is sound because a definition's opening `[` is never
 * escaped and never inside such a run.
 */
function* containerLabels(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] !== '[') i++;
    else {
      const end = bracketAt(text, i + 1);
      if (text[end] === ']' && text[end + 1] === ':') yield text.slice(i + 1, end);
      i = text[end] === '[' ? end : end + 1;
    }
  }
}

/** A top-level block token and its offset in the text it was lexed from. */
interface TopLevelToken {
  offset: number;
  token: Token;
}

/** A top-level link reference definition `marked` reads and drops, and its offset in the text lexed. */
interface DroppedSpan {
  offset: number;
  raw: string;
}

/** One lex of a body: the top-level tokens `marked` keeps, and the definitions the scan saw it drop. */
interface BodyScan {
  /** In order, each a definition whose label the lex had already registered. */
  dropped: DroppedSpan[];
  tokens: TopLevelToken[];
}

/**
 * The top-level block tokens `marked` reads in `markdown` (line endings
 * already `\n`), each with its offset — the running sum of the `raw` lengths
 * before it — and the definitions the scan dropped. Those lengths cover the
 * input except where `marked` drops a definition, so each dropped
 * definition's length joins the sum where the definition stood.
 */
function lexBody(markdown: string): BodyScan {
  const tokenizer = new HeadingScanTokenizer();
  const lexer = new Lexer({ ...getDefaults(), tokenizer });
  const { rules } = tokenizer;
  tokenizer.rules = { ...rules, block: { ...rules.block, paragraph: PARAGRAPH } };
  const lexed = lexer.blockTokens(markdown);
  const dropped = tokenizer.droppedDefinitions.map(({ raw, remaining }) => ({
    offset: markdown.length - remaining,
    raw,
  }));
  const tokens: TopLevelToken[] = [];
  let offset = 0;
  let next = 0;
  for (const token of lexed) {
    for (let gap = dropped[next]; gap?.offset === offset; gap = dropped[++next]) {
      offset += gap.raw.length;
    }
    tokens.push({ offset, token });
    offset += token.raw.length;
  }
  return { dropped, tokens };
}

/**
 * `marked`'s GFM paragraph rule, changed in cost and not in outcome. At every
 * line a paragraph runs on to, the stock rule asks whether a table starts
 * there, and its table pattern goes on through every following row before the
 * answer comes back — a scan of the rest of the note per paragraph, so a note
 * of pipe lines over one-dash lines (`| a | b |` / `| - |`, repeated) lexes in
 * quadratic time. The rows cannot change the answer (the pattern accepts none
 * of them), so here the check ends after the header and delimiter lines.
 * Built from the stock rule's own source, so it follows the installed
 * `marked`; a source that no longer embeds the table pattern fails at load.
 */
const PARAGRAPH = ((): RegExp => {
  const { paragraph, table } = Lexer.rules.block.gfm;
  /** The table pattern as `marked` embeds it: every `^` outside a class dropped. */
  const embedded = table.source.replace(/(^|[^[])\^/g, '$1');
  const rows = embedded.indexOf('(?:\\n((?:');
  const bounded = `${embedded.slice(0, rows)}(?:\\n|$)`;
  const source = paragraph.source.replace(embedded, () => bounded);
  if (rows === -1 || source === paragraph.source) {
    throw new Error("marked's GFM paragraph rule no longer embeds its table rule as expected.");
  }
  return new RegExp(source, paragraph.flags);
})();

/**
 * `marked`'s tokenizer, changed in cost and not in the top-level tokens'
 * types and extents — all the heading scan reads.
 *
 * - `table`: the GFM table rule matches every following row before it checks
 *   the header and delimiter lines, so a line that looks like a header over
 *   one that looks like a delimiter but fails the column check (`t` over `-`,
 *   `a|b` over `-`) costs a scan of the rest of the note, repeated at each
 *   such pair. The header and delimiter lines decide the outcome on their
 *   own, so the rule runs on those two lines first and on the whole source
 *   only when they pass.
 * - `blockquote`: the stock rule lexes a blockquote's content to find where
 *   it ends, and each nested level lexes it again, so `>` nested a thousand
 *   deep costs a thousand passes over every line after it. A run of lines
 *   that each open with `>` and that ends the note or meets an empty line is
 *   the whole blockquote whatever the lines hold, so its extent is known
 *   without lexing it. The token then carries no child tokens, which nothing
 *   here reads. Any other shape — a lazy continuation line — goes to the
 *   stock rule, which costs a pass per nesting level and recurses a call
 *   deeper for each, until `MAX_LAZY_QUOTE_DEPTH` stock calls are open. Past
 *   that, a blockquote takes the rule's own match as its extent, unlexed: the
 *   lines right after innermost code then join the quote where stock `marked`
 *   ends it at the code, so a paragraph there becomes part of the quote, and
 *   a setext heading's text and underline drop out of the heading scan.
 * - `list`: the stock rule fixes every item's `raw`, and the list's, before it
 *   lexes each item's content as a document of its own — one call deeper per
 *   nesting level, so a line of list markers costs time quadratic in their
 *   count and overflows the stack. That lex only fills child tokens and
 *   looseness, so it is skipped, leaving `lexer.state.top` true as the lex
 *   would. Definitions inside an item then go unregistered, as those inside
 *   an unlexed blockquote do, so a later top-level definition of the same
 *   label stays a `def` block where stock `marked` drops it.
 * - `def`: `marked` drops a top-level definition whose label is already
 *   registered but still consumes its text. Each one is recorded in
 *   `droppedDefinitions`, so the scan's offsets cover the note exactly.
 */
class HeadingScanTokenizer extends Tokenizer {
  /**
   * Each top-level definition `marked` drops, in order: the length of the
   * source left when it was read — its position counted from the end — and
   * its text.
   */
  readonly droppedDefinitions: Array<{ raw: string; remaining: number }> = [];
  /** Stock blockquote calls open on the stack; only within one does a nested lex run. */
  #quoteDepth = 0;

  override def(src: string): Tokens.Def | undefined {
    const token = super.def(src);
    if (token && this.#quoteDepth === 0 && this.lexer.tokens.links[token.tag]) {
      this.droppedDefinitions.push({ raw: token.raw, remaining: src.length });
    }
    return token;
  }

  override list(src: string): Tokens.List | undefined {
    const { lexer } = this;
    const { blockTokens } = lexer;
    lexer.blockTokens = ((_src: string, tokens: Token[] = []) => {
      lexer.state.top = true;
      return tokens;
    }) as typeof blockTokens;
    try {
      return super.list(src);
    } finally {
      lexer.blockTokens = blockTokens;
    }
  }

  override table(src: string): Tokens.Table | undefined {
    const headerEnd = src.indexOf('\n');
    const delimiterEnd = headerEnd === -1 ? -1 : src.indexOf('\n', headerEnd + 1);
    if (delimiterEnd !== -1 && !super.table(src.slice(0, delimiterEnd + 1))) return;
    return super.table(src);
  }

  override blockquote(src: string): Tokens.Blockquote | undefined {
    const { blockquoteStart, blockquoteSetextReplace, blockquoteSetextReplace2 } = this.rules.other;
    let end = -1;
    let next = 0;
    while (next < src.length) {
      const newline = src.indexOf('\n', next);
      const lineEnd = newline === -1 ? src.length : newline;
      if (!blockquoteStart.test(src.slice(next, lineEnd))) break;
      end = lineEnd;
      next = lineEnd + 1;
    }
    if (end === -1) return super.blockquote(src);
    /**
     * A run of `>` lines that ends the note or meets an empty line is the whole
     * blockquote: only a non-empty line can continue it lazily.
     */
    let raw = src.slice(0, end);
    if (next < src.length && src[next] !== '\n') {
      if (this.#quoteDepth < MAX_LAZY_QUOTE_DEPTH) {
        this.#quoteDepth++;
        try {
          return super.blockquote(src);
        } finally {
          this.#quoteDepth--;
        }
      }
      const cap = this.rules.block.blockquote.exec(src);
      if (!cap) return;
      raw = trimTrailingLineFeeds(cap[0]);
    }
    const text = raw
      .replace(blockquoteSetextReplace, '\n    $1')
      .replace(blockquoteSetextReplace2, '');
    return { type: 'blockquote', raw, text, tokens: [] };
  }
}

/**
 * Stock blockquote calls the scan lets open at once. Each `>` level a lazy
 * line reaches through opens one, and so does each return of a nested quote
 * after a lazy line (`> > a`, `lazy`, `> > b`, …). Below the bound a lazily
 * continued quote reads as in stock `marked`, at a cost of at most this many
 * passes over its lines; past it only the lines right after innermost code
 * read differently, joining the quote.
 */
const MAX_LAZY_QUOTE_DEPTH = 16;

/**
 * `text` with every `\r\n` and lone `\r` read as `\n` — what `marked` lexes —
 * and a map from an offset in that text back to the same position in `text`.
 * A collapsed `\r\n` maps to its `\r`.
 */
function normalizeLineEndings(text: string): {
  normalized: string;
  toOriginal: (offset: number) => number;
} {
  /** Offsets in `normalized` of each `\n` that stands for a `\r\n`, ascending. */
  const collapsed: number[] = [];
  const normalized = text.replace(/\r\n?/g, (ending: string, at: number) => {
    if (ending.length === 2) collapsed.push(at - collapsed.length);
    return '\n';
  });
  return {
    normalized,
    toOriginal: (offset) => {
      let lo = 0;
      let hi = collapsed.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((collapsed[mid] ?? 0) < offset) lo = mid + 1;
        else hi = mid;
      }
      return offset + lo;
    },
  };
}

/**
 * `text` less its trailing run of `\n`, as `/\n+$/` leaves it, found by a scan
 * back from the end: the regex retries at every `\n` of a run that does not
 * end the text, in time quadratic in the run.
 */
function trimTrailingLineFeeds(text: string): string {
  let end = text.length;
  while (text[end - 1] === '\n') end--;
  return text.slice(0, end);
}

/**
 * Build the full `Parent::Child` path of every heading, in document order. A
 * heading's path is its parent's path (`headingParents`) plus its own text —
 * the serialization the document map emits, so a path built here is a locator
 * the write path resolves as an exact map entry. Untitled headings contribute
 * an empty segment (`::Request body`, `Top::::Child`), and a top-level
 * untitled heading's own path is `""`, which the map omits.
 */
function headingPaths(headings: ReadonlyArray<Pick<Heading, 'level' | 'text'>>): string[] {
  const parents = headingParents(headings);
  const paths: string[] = [];
  headings.forEach(({ text }, i) => {
    const parent = paths[parents[i] ?? -1];
    paths.push(parent === undefined ? text : `${parent}${HEADING_DELIMITER}${text}`);
  });
  return paths;
}

/**
 * The index of each heading's parent in `headings` — the nearest preceding
 * heading strictly shallower than it, as the document map nests them — or -1
 * for a heading with none.
 */
function headingParents(headings: ReadonlyArray<Pick<Heading, 'level'>>): number[] {
  const open: Array<{ index: number; level: number }> = [];
  return headings.map(({ level }, index) => {
    while ((open.at(-1)?.level ?? 0) >= level) open.pop();
    const parent = open.at(-1)?.index ?? -1;
    open.push({ index, level });
    return parent;
  });
}

/**
 * Full `::`-joined path of every heading in `content`, in document order,
 * repeats included — the markdown-patch 2.0 map's heading tree, flattened.
 * Deduplicated and with the `""` entry dropped, it is the 1.x map's `headings`
 * array.
 */
export function listHeadingPaths(content: string): string[] {
  return headingPaths(scanHeadings(content));
}

/**
 * The level of the heading at full path `path` in `content` — its first
 * occurrence. For a path the note does not have: with `create`, the level
 * markdown-patch 2.0 gives it when `createTargetIfMissing` creates it — one
 * below the deepest existing ancestor for each missing segment, counted from 0
 * when no ancestor exists — and without, `undefined`.
 */
export function sectionLevel(content: string, path: string, create: boolean): number | undefined {
  const headings = scanHeadings(content);
  const paths = headingPaths(headings);
  const own = headings[paths.indexOf(path)];
  if (own || !create) return own?.level;
  const ancestor = deepestAncestor(paths, path);
  if (ancestor === undefined) return cutsOf(path).length + 1;
  return (headings[ancestor.index] as Heading).level + ancestor.missing;
}

/**
 * The deepest proper ancestor of heading path `path` that `paths` holds — a
 * prefix ending where `path.split(HEADING_DELIMITER)` cuts it — as the index
 * of its first occurrence and the count of `path`'s segments below it, or
 * `undefined` when `paths` holds none. Each of `paths` is compared at most
 * once, at the one cut its length matches, so the search is linear in their
 * length and in `path`'s.
 */
export function deepestAncestor(
  paths: readonly string[],
  path: string,
): { index: number; missing: number } | undefined {
  const byLength = new Map<number, number[]>();
  paths.forEach((p, index) => {
    const same = byLength.get(p.length);
    if (same) same.push(index);
    else byLength.set(p.length, [index]);
  });
  const cuts = cutsOf(path);
  for (let k = cuts.length - 1; k >= 0; k--) {
    const index = byLength.get(cuts[k] as number)?.find((i) => path.startsWith(paths[i] as string));
    if (index !== undefined) return { index, missing: cuts.length - k };
  }
  return;
}

/** The offsets at which `path.split(HEADING_DELIMITER)` cuts `path`, in order. */
function cutsOf(path: string): number[] {
  const cuts: number[] = [];
  for (let at = path.indexOf(HEADING_DELIMITER); at !== -1; ) {
    cuts.push(at);
    at = path.indexOf(HEADING_DELIMITER, at + HEADING_DELIMITER.length);
  }
  return cuts;
}

/**
 * True when `blockId` is referenced in `content` by an isolated marker: a
 * `^blockId` line on its own, after a blank line (or at the body's start), so
 * the parser reads it as its own paragraph and the id names the block above.
 * A marker line with no blank line above it continues that block instead (a
 * table row, a paragraph line, a list item), and a line inside a fence or
 * indented as code is not a marker.
 */
export function isIsolatedBlockId(content: string, blockId: string): boolean {
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
  const bodyStart = frontmatterEndLine(content);
  const inFence = computeFenceMask(lines, bodyStart);
  const marker = `^${blockId}`;
  return lines.some(
    (line, i) =>
      i >= bodyStart &&
      !inFence[i] &&
      line.trim() === marker &&
      !/^(?: {4}|\t)/.test(line) &&
      (i === bodyStart || (lines[i - 1] ?? '').trim() === ''),
  );
}

/** The `#` run opening a top-level ATX heading in a markdown fragment. */
export interface AtxHeadingMarker {
  /** Length of the `#` run — the heading's level. */
  hashes: number;
  /** The heading's line, trimmed, for messages. */
  line: string;
  /** Offset of the run's first `#` in the fragment's `normalized` text. */
  start: number;
}

/** A markdown fragment with its line endings read as `\n`, and its ATX heading markers. */
export interface AtxHeadingFragment {
  markers: AtxHeadingMarker[];
  normalized: string;
}

/** An ATX heading's opening: up to three spaces or tabs, then its `#` run. */
const ATX_OPENING = /^([ \t]{0,3})(#+)/;

/**
 * The `#` run of every top-level ATX heading in `markdown`, found as
 * markdown-patch 2.0 finds the headings it re-levels in written content: line
 * endings normalized, lexed with `marked`, and each top-level `heading` token
 * whose raw text opens with a `#` run. A setext heading, a `#` line inside a
 * fence or HTML block, and a hashtag carry none.
 */
export function atxHeadingMarkers(markdown: string): AtxHeadingFragment {
  const { normalized } = normalizeLineEndings(markdown);
  const markers: AtxHeadingMarker[] = [];
  for (const { token, offset } of lexBody(normalized).tokens) {
    const opening = token.type === 'heading' ? ATX_OPENING.exec(token.raw) : null;
    if (!opening) continue;
    const [, indent = '', hashes = ''] = opening;
    markers.push({
      hashes: hashes.length,
      line: token.raw.trim().split('\n')[0] ?? '',
      start: offset + indent.length,
    });
  }
  return { markers, normalized };
}

/**
 * Walk a `::`-split target one segment at a time: each segment matches the
 * first heading with that text below the previous match, at any depth, before
 * the walk leaves the previous match's subtree. Returns the index of the heading
 * the last segment matched, or -1.
 */
function walkSegments(headings: readonly Heading[], parts: readonly string[]): number {
  let cursor = 0;
  let parentLevel = 0;
  let matched = -1;
  for (const part of parts) {
    let found = -1;
    for (let i = cursor; i < headings.length; i++) {
      const heading = headings[i];
      if (!heading) continue;
      if (parentLevel > 0 && heading.level <= parentLevel) break;
      if (heading.text === part) {
        found = i;
        break;
      }
    }
    const hit = headings[found];
    if (!hit) return -1;
    matched = found;
    cursor = found + 1;
    parentLevel = hit.level;
  }
  return matched;
}

/**
 * Match a heading by "::"-delimited hierarchy. A target carrying the delimiter
 * resolves by exact full path first, so every document-map locator reads back
 * as itself; failing that, the segments walk the hierarchy, which lets a path
 * that skips a level (`Top::Child` for `Top::::Child`) still resolve. Empty
 * segments are kept — they name untitled headings. A single-segment target
 * matches a leaf at any depth and resolves to the first such heading.
 *
 * The resolution is reported back in `sectionTarget`. When the read could have
 * meant another heading, `candidates` lists every full path it could name: for
 * a bare leaf, each heading sharing that text; for a delimited target, each
 * occurrence of the resolved path when that path repeats in the note. Which
 * heading wins never changes.
 */
function extractHeading(content: string, target: string): SectionExtraction {
  const parts = target.split(HEADING_DELIMITER).map((p) => p.trim());
  const [leaf] = parts;
  const qualified = parts.length > 1;
  if (!qualified && !leaf) {
    throw notFound('Empty heading target.', { target });
  }

  const headings = scanHeadings(content);
  const paths = headingPaths(headings);

  const exact = qualified ? paths.indexOf(parts.join(HEADING_DELIMITER)) : -1;
  const matched = exact >= 0 ? exact : walkSegments(headings, parts);
  const hit = headings[matched];
  const resolved = paths[matched];
  if (!hit || resolved === undefined) {
    throw notFound(`Heading '${target}' not found.`, { target });
  }

  // Slice from the matched heading to the next heading at the same or shallower level.
  const end = headings.find((h, i) => i > matched && h.level <= hit.level);
  const candidates = qualified
    ? paths.filter((p) => p === resolved)
    : paths.filter((_, i) => headings[i]?.text === leaf);

  return {
    value: trimTrailingLineFeeds(content.slice(hit.start, end?.start)),
    sectionTarget: resolved,
    ...(candidates.length > 1 ? { candidates } : {}),
  };
}

/**
 * Match a block by its `^blockId` reference. Returns the line containing the
 * reference plus any preceding lines belonging to the same paragraph (until a
 * blank line or a heading line — a setext underline, an untitled heading).
 */
function extractBlock(content: string, blockId: string): string {
  const lines = content.split('\n');
  const bodyStart = frontmatterEndLine(content);
  const inFence = computeFenceMask(lines, bodyStart);
  const isHeading = headingLineMask(content, lines);
  const escaped = blockId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const ref = new RegExp(`(^|\\s)\\^${escaped}\\s*$`);
  for (let i = bodyStart; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (ref.test(lines[i] ?? '')) {
      let start = i;
      while (start > bodyStart) {
        const prev = lines[start - 1] ?? '';
        if (prev.trim() === '' || isHeading[start - 1]) break;
        start--;
      }
      return lines.slice(start, i + 1).join('\n');
    }
  }
  throw notFound(`Block reference '^${blockId}' not found.`, { blockId });
}

/**
 * Mark the indices of `lines` (`content` split on `\n`) that a heading
 * occupies: an ATX heading's line, or a setext heading's text lines and
 * underline.
 */
function headingLineMask(content: string, lines: readonly string[]): boolean[] {
  const headings = scanHeadings(content);
  let h = 0;
  let lineStart = 0;
  return lines.map((line) => {
    const lineEnd = lineStart + line.length;
    while ((headings[h]?.end ?? Number.POSITIVE_INFINITY) <= lineStart) h++;
    const onHeading = (headings[h]?.start ?? Number.POSITIVE_INFINITY) <= lineEnd;
    lineStart = lineEnd + 1;
    return onHeading;
  });
}

/**
 * Return the line index where the document body starts, skipping a leading YAML
 * frontmatter block. Returns 0 when no frontmatter is present. Without this
 * guard, block extraction would scan inside the frontmatter and falsely match a
 * reference there or include the fence in a paragraph walk-back.
 *
 * The boundary comes from `splice` rather than a second line scan, so the read
 * path and every body-scoped write path agree on where the body starts —
 * notably on an opening fence carrying trailing whitespace, which Obsidian
 * reads as body and a lenient `/^---\s*$/` scan hid behind a fence that isn't
 * one.
 */
function frontmatterEndLine(content: string): number {
  const { hasFrontmatter, raw } = splice(content);
  if (!hasFrontmatter) return 0;
  /**
   * `content === raw + body`, so the newlines inside `raw` count the lines it
   * owns. A `raw` that ends mid-line shares that line with the body's first
   * bytes; skip it rather than scan a line the fence starts.
   */
  const consumed = raw.split('\n').length - 1;
  return raw.endsWith('\n') ? consumed : consumed + 1;
}

/**
 * Mark line indices that fall inside fenced code blocks (` ``` ` or `~~~`) so
 * downstream scanning doesn't false-match on markdown-about-markdown notes.
 * The closer must match the opener's fence char, have at least as many fence
 * chars, and carry no info string (per CommonMark). An unclosed fence extends
 * to EOF. Pass `from` to skip a leading frontmatter block.
 */
export function computeFenceMask(lines: string[], from = 0): boolean[] {
  const mask: boolean[] = new Array(lines.length).fill(false);
  let openChar: '`' | '~' | null = null;
  let openLen = 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^\s{0,3}([`~]{3,})/.exec(line);
    if (openChar === null) {
      if (m) {
        const fence = m[1] ?? '';
        openChar = fence[0] as '`' | '~';
        openLen = fence.length;
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    if (m && /^\s{0,3}[`~]{3,}\s*$/.test(line)) {
      const fence = m[1] ?? '';
      if (fence[0] === openChar && fence.length >= openLen) {
        openChar = null;
        openLen = 0;
      }
    }
  }
  return mask;
}

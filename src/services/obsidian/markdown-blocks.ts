/**
 * @fileoverview Block structure of a note body, reduced to what inline tag
 * detection needs: the lines where Obsidian reads no tag — fenced and indented
 * code, HTML blocks, display math — and the ranges that hold inline content —
 * paragraphs, headings, table rows. Blockquotes and list items are tracked so
 * indentation is measured from where a line's content starts. The rules follow
 * CommonMark except where Obsidian 1.13.7's metadata-cache readback differs;
 * each difference is noted where it is implemented. Issues #139 and #140.
 * @module services/obsidian/markdown-blocks
 */

/** A range of the body, `end` exclusive. Text between spans holds no tag. */
export type BlockSpan =
  | { kind: 'hidden'; start: number; end: number }
  | { kind: 'inline'; start: number; end: number; tableRow: boolean };

/** A blockquote, or a list item whose content starts `indent` columns past its parent's. */
interface Container {
  indent: number;
  quote: boolean;
}

interface Paragraph {
  /** How many `$$` delimiters the paragraph holds so far; odd leaves one open. */
  dollars: number;
  end: number;
  /** Where the first line's text starts when it had no indentation — a table header candidate — else -1. */
  header: number;
  kind: 'paragraph';
  lines: number;
  start: number;
}

type Leaf =
  | Paragraph
  | { kind: 'fence'; start: number; end: number; marker: string }
  | { kind: 'code'; start: number; end: number }
  /** `close` ends the block on the line holding it; without one, a blank line ends it. */
  | { kind: 'html'; start: number; end: number; close: RegExp | undefined }
  | { kind: 'math'; start: number; end: number }
  | { kind: 'table'; lead: boolean };

interface Line {
  /** Index of the last character that is not a space, tab, or `\r`; -1 on a blank line. */
  last: number;
  rule?: RuleSuffix;
  text: string;
}

/**
 * The longest suffix of a line made of one thematic-break character and
 * whitespace: where it starts, the character, and how many of that character
 * remain from each position in it on.
 */
interface RuleSuffix {
  char: string;
  counts: Uint32Array;
  from: number;
}

function ruleSuffix({ text, last }: Line): RuleSuffix {
  const char = text[last] ?? '';
  let from = last + 1;
  if (char === '*' || char === '-' || char === '_') {
    while (
      from > 0 &&
      (text[from - 1] === char || text[from - 1] === ' ' || text[from - 1] === '\t')
    ) {
      from--;
    }
  }
  const counts = new Uint32Array(last + 2 - from);
  for (let i = last; i >= from; i--) {
    counts[i - from] = (counts[i - from + 1] ?? 0) + (text[i] === char ? 1 : 0);
  }
  return { char, counts, from };
}

/**
 * A position in one line. Columns count from the content start of the
 * innermost blockquote, and a tab advances to the next multiple of four. A list
 * item's indent can end partway through a tab; the columns of that tab it did
 * not take are `spare`, read as spaces by whatever comes next.
 */
class LineCursor {
  pos = 0;
  col = 0;
  spare = 0;

  private constructor(private readonly line: Line) {}

  static start(text: string): LineCursor {
    let last = text.length - 1;
    while (last >= 0 && (text[last] === ' ' || text[last] === '\t' || text[last] === '\r')) last--;
    return new LineCursor({ text, last });
  }

  get text(): string {
    return this.line.text;
  }

  clone(): LineCursor {
    const c = new LineCursor(this.line);
    c.pos = this.pos;
    c.col = this.col;
    c.spare = this.spare;
    return c;
  }

  /** Whether only whitespace is left on the line. */
  get atEnd(): boolean {
    return this.pos > this.line.last;
  }

  /**
   * Whether the rest of the line from `pos` is a thematic break: three or more
   * of one of `*`, `-`, `_`, with only spaces and tabs between. A line of
   * nested list markers asks this once per marker, so the answer comes from
   * one backward pass per line rather than a regex run to the end each time.
   */
  thematicBreakAt(pos: number): boolean {
    this.line.rule ??= ruleSuffix(this.line);
    const { from, char, counts } = this.line.rule;
    return pos >= from && this.text[pos] === char && (counts[pos - from] ?? 0) >= 3;
  }

  /** Width of the whitespace ahead, counted no further than `limit` columns. */
  columns(limit = Number.POSITIVE_INFINITY): number {
    let n = this.spare;
    let col = this.col + this.spare;
    for (let i = this.pos; n < limit; i++) {
      const ch = this.text[i];
      if (ch === ' ') {
        n++;
        col++;
      } else if (ch === '\t') {
        const w = 4 - (col % 4);
        n += w;
        col += w;
      } else break;
    }
    return n;
  }

  /** Consume exactly `cols` columns of whitespace. When fewer are there, consumes nothing and returns false. */
  take(cols: number): boolean {
    const { pos, col, spare } = this;
    let left = cols;
    while (left > 0) {
      if (this.spare > 0) {
        const t = Math.min(this.spare, left);
        this.spare -= t;
        this.col += t;
        left -= t;
        continue;
      }
      const ch = this.text[this.pos];
      if (ch === ' ') {
        this.pos++;
        this.col++;
        left--;
      } else if (ch === '\t') {
        const t = Math.min(4 - (this.col % 4), left);
        this.spare = 4 - (this.col % 4) - t;
        this.pos++;
        this.col += t;
        left -= t;
      } else {
        this.pos = pos;
        this.col = col;
        this.spare = spare;
        return false;
      }
    }
    return true;
  }

  skipWhitespace(): void {
    this.take(this.columns());
  }
}

const ATX_HEADING = /#{1,6}(?:[ \t]|\r?$)/y;
const LIST_MARKER = /(?:[-+*]|(?<start>\d{1,9})[.)])(?=[ \t]|\r?$)/y;
/** A backtick fence's info string cannot hold a backtick — ```` ``` a`b ```` is inline code. */
const FENCE_OPEN = /`{3,}(?=[^`]*$)|~{3,}/y;
const FENCE_CLOSE = /(`{3,}|~{3,})[ \t]*\r?$/y;
const MATH_CLOSE = /[ \t]*\$\$[ \t]*\r?$/y;
const SETEXT_UNDERLINE = /(?:=+|-+)[ \t]*\r?$/y;
const LINK_DEFINITION = /\[[^[\]]+\]:/y;
/** Obsidian's blank line: empty or spaces only. A line holding a tab continues an open paragraph or HTML block. */
const BLANK = / *\r?$/y;
/** A table delimiter row after its optional leading pipe: `-|-`, `:--|--:|`. */
const DELIMITER_ROW = /[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*(?:[ \t]*\|)?[ \t]*\r?$/y;

/**
 * CommonMark's open tag and closing tag (raw HTML): a tag name, attributes —
 * each a name and an optional `=` value, unquoted, single-quoted, or
 * double-quoted — and an optional `/` before `>`; a closing tag takes no
 * attributes. Whitespace between the parts may hold one line ending and a
 * quoted value any number, which only an inline tag can use: a block start is
 * matched one line at a time. Obsidian 1.13.7 reads both uses by this grammar
 * — `x <a b #t> y` and `x </a #t> y` are plain text around a tag, while
 * `<a\nb="c">#t` is an element followed by one. Issue #144.
 */
export const HTML_TAG_SOURCE = ((): string => {
  const ws = String.raw`[ \t]*(?:\r?\n[ \t]*)?`;
  const value = String.raw`[^ \t\r\n"'=<>\x60]+|'[^']*'|"[^"]*"`;
  const attribute = String.raw`(?=[ \t]|\r?\n)${ws}[A-Za-z_:][\w.:-]*(?:${ws}=${ws}(?:${value}))?`;
  const name = '[A-Za-z][A-Za-z0-9-]*';
  return String.raw`<${name}(?:${attribute})*${ws}\/?>|<\/${name}${ws}>`;
})();

/**
 * CommonMark's seven HTML block starts, in order: the start pattern, the
 * pattern whose line ends the block (none: a blank line ends it), and whether
 * the block can interrupt a paragraph. Read back from Obsidian: `<div>`,
 * `<p>`, `<pre>`, a lone `<span>`, `<?…?>`, `<!DOCTYPE`, and `<![CDATA[`
 * blocks all hide their tags, while `<span>x #t</span>` is a paragraph.
 */
const HTML_BLOCKS: ReadonlyArray<readonly [RegExp, RegExp | undefined, boolean]> = [
  [/<(?:pre|script|style|textarea)(?=[ \t>]|\r?$)/iy, /<\/(?:pre|script|style|textarea)>/gi, true],
  [/<!--/y, /-->/g, true],
  [/<\?/y, /\?>/g, true],
  [/<![A-Za-z]/y, />/g, true],
  [/<!\[CDATA\[/y, /\]\]>/g, true],
  [
    /<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t]|\/?>|\r?$)/iy,
    undefined,
    true,
  ],
  [new RegExp(String.raw`(?:${HTML_TAG_SOURCE})[ \t]*\r?$`, 'y'), undefined, false],
];

function sticky(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** Whether `close` occurs in `text` at or after `from`. */
function closes(close: RegExp, text: string, from: number): boolean {
  close.lastIndex = from;
  return close.test(text);
}

/** The HTML block opening at `pos`, if any: the pattern that ends it, or `undefined` when a blank line does. */
function htmlBlockAt(
  text: string,
  pos: number,
  paragraphOpen: boolean,
): { close: RegExp | undefined } | undefined {
  if (text[pos] !== '<') return;
  for (const [open, close, interruptsParagraph] of HTML_BLOCKS) {
    if (paragraphOpen && !interruptsParagraph) continue;
    if (sticky(open, text, pos)) return { close };
  }
  return;
}

/** A display math block opens with `$$` on a line that holds no second `$$`. */
function mathOpensAt(text: string, pos: number): boolean {
  return text.startsWith('$$', pos) && !text.includes('$$', pos + 2);
}

/** The unescaped `$$` delimiters in `text` from `from` on. */
function doubleDollars(text: string, from: number): number {
  let n = 0;
  for (let i = text.indexOf('$$', from); i !== -1; ) {
    let slashes = 0;
    while (text[i - 1 - slashes] === '\\') slashes++;
    if (slashes % 2 === 0) {
      n++;
      i = text.indexOf('$$', i + 2);
    } else {
      i = text.indexOf('$$', i + 1);
    }
  }
  return n;
}

/**
 * The list item whose marker sits at `c`: a cursor at its content and the
 * columns the marker and the spaces after it take. `null` when there is none,
 * or when it may not interrupt an open paragraph — an empty item, or an
 * ordered one not starting at 1.
 *
 * One Obsidian difference is left unmodelled: under a `1.`-style item (not
 * `1)`), a line after an empty line indented exactly seven columns is text to
 * Obsidian unless some line of the item is indented three, so `1. a`, empty,
 * then seven spaces and `#t` is tagged `t` there and read as code here.
 * Matching it would take the item's later lines into account.
 */
function listItemAt(
  c: LineCursor,
  paragraphOpen: boolean,
): { cursor: LineCursor; width: number } | null {
  if (c.thematicBreakAt(c.pos)) return null;
  const m = sticky(LIST_MARKER, c.text, c.pos);
  if (!m) return null;
  const marker = m[0].length;
  const cursor = c.clone();
  cursor.pos += marker;
  cursor.col += marker;
  const empty = cursor.atEnd;
  if (paragraphOpen) {
    const start = m.groups?.start;
    if (empty || (start !== undefined && Number(start) !== 1)) return null;
  }
  if (empty) return { cursor, width: marker + 1 };
  /** Five or more spaces after the marker: the item's text is indented code, and the marker takes one. */
  const spaces = cursor.columns(5);
  const taken = spaces >= 5 ? 1 : spaces;
  cursor.take(taken);
  return { cursor, width: marker + taken };
}

/** Whether `text[from, to)` holds a `|` that is not escaped. */
function hasPipe(text: string, from: number, to: number): boolean {
  let escaped = false;
  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (ch === '|' && !escaped) return true;
    escaped = ch === '\\' && !escaped;
  }
  return false;
}

/**
 * Whether the text at `c` opens a block that ends a paragraph. Such a line
 * cannot continue a paragraph lazily, nor a fence, math, or HTML block.
 * `mathOpen` is whether a `$$` line may open display math here — see
 * `BlockScanner.startLeaf`.
 */
function interrupts(c: LineCursor, mathOpen: boolean): boolean {
  if (c.columns(4) >= 4) return false;
  const t = c.clone();
  t.skipWhitespace();
  const { text, pos } = t;
  return (
    text[pos] === '>' ||
    t.thematicBreakAt(pos) ||
    listItemAt(t, true) !== null ||
    sticky(ATX_HEADING, text, pos) !== null ||
    sticky(FENCE_OPEN, text, pos) !== null ||
    htmlBlockAt(text, pos, true) !== undefined ||
    (mathOpen && mathOpensAt(text, pos))
  );
}

class BlockScanner {
  private readonly spans: BlockSpan[] = [];
  private readonly stack: Container[] = [];
  /** Indices into `stack` of its blockquotes, outermost first. A blank line continues every list item and no blockquote. */
  private readonly quotes: number[] = [];
  private leaf: Leaf | undefined;
  private prevBlank = false;

  constructor(private readonly body: string) {}

  run(): BlockSpan[] {
    for (let start = 0; ; ) {
      const nl = this.body.indexOf('\n', start);
      this.line(start, this.body.slice(start, nl === -1 ? this.body.length : nl));
      if (nl === -1) break;
      start = nl + 1;
    }
    this.closeContainers(0);
    this.closeLeaf();
    return this.spans;
  }

  private inline(start: number, end: number, tableRow = false): void {
    this.spans.push({ kind: 'inline', start, end, tableRow });
  }

  private closeLeaf(): void {
    const leaf = this.leaf;
    this.leaf = undefined;
    if (!leaf || leaf.kind === 'table') return;
    if (leaf.kind === 'paragraph') this.inline(leaf.start, leaf.end);
    else this.spans.push({ kind: 'hidden', start: leaf.start, end: leaf.end });
  }

  private closeContainers(depth: number): void {
    if (depth < this.stack.length) this.closeLeaf();
    this.stack.length = depth;
    while ((this.quotes.at(-1) ?? -1) >= depth) this.quotes.pop();
  }

  private line(start: number, text: string): void {
    const end = start + text.length;
    const c = LineCursor.start(text);
    const whitespaceLine = c.atEnd;

    let matched = 0;
    if (whitespaceLine) {
      matched = this.quotes[0] ?? this.stack.length;
    } else {
      for (; matched < this.stack.length; matched++) {
        const k = this.stack[matched] as Container;
        if (k.quote ? !this.quoteMarker(c) : !c.atEnd && !c.take(k.indent)) break;
      }
    }
    const blank = sticky(BLANK, text, c.pos) !== null;
    const afterBlank = this.prevBlank;
    this.prevBlank = whitespaceLine;

    if (matched === this.stack.length) {
      if (this.leaf && this.continueLeaf(this.leaf, c, start, end, blank)) return;
    } else {
      if (this.lazy(c, matched, end, afterBlank)) return;
      this.closeContainers(matched);
    }

    if (c.atEnd) {
      /** A line of tabs continues an open paragraph; only an empty or spaces-only line ends one. */
      if (this.leaf?.kind === 'paragraph' && !blank) return;
      this.closeLeaf();
      return;
    }

    let cur = c;
    while (cur.columns(4) < 4) {
      const t = cur.clone();
      t.skipWhitespace();
      if (text[t.pos] === '>') {
        this.closeLeaf();
        this.quoteMarker(cur);
        this.quotes.push(this.stack.length);
        this.stack.push({ quote: true, indent: 0 });
        continue;
      }
      const item = listItemAt(t, this.leaf?.kind === 'paragraph');
      if (!item) break;
      this.closeLeaf();
      this.stack.push({ quote: false, indent: cur.columns(4) + item.width });
      cur = item.cursor;
    }
    if (!cur.atEnd) this.startLeaf(cur, start, end);
  }

  /**
   * A lazy line: CommonMark lets a paragraph run on over a line that drops its
   * container's markers, and Obsidian lets a fence, math, or HTML block run on
   * the same way — `- ```` then an unindented line is still code, and an
   * unindented fence cannot close it. That stops at a blank line or a line
   * that opens a block. One more Obsidian rule: a line indented four columns
   * never continues a blockquote lazily (`> para` then `    #t` is code).
   */
  private lazy(c: LineCursor, matched: number, end: number, afterBlank: boolean): boolean {
    const leaf = this.leaf;
    if (!leaf || leaf.kind === 'code' || leaf.kind === 'table') return false;
    if (c.atEnd || (afterBlank && leaf.kind !== 'paragraph')) return false;
    if (interrupts(c, leaf.kind !== 'paragraph' || leaf.dollars % 2 === 0)) return false;
    if ((this.quotes.at(-1) ?? -1) >= matched && c.columns(4) >= 4) return false;
    if (leaf.kind === 'paragraph') this.grow(leaf, c, end);
    else leaf.end = end;
    if (leaf.kind === 'html' && leaf.close && closes(leaf.close, c.text, 0)) this.closeLeaf();
    return true;
  }

  /** Add the rest of the line at `c` to the open paragraph. */
  private grow(paragraph: Paragraph, c: LineCursor, end: number): void {
    paragraph.end = end;
    paragraph.lines++;
    paragraph.dollars += doubleDollars(c.text, c.pos);
  }

  /**
   * Consume a blockquote marker: up to three columns of indentation, `>`, and
   * one following space. Obsidian then measures the rest of the line from
   * column zero, so a tab after `>` is four columns wide (`>\t#t` is indented
   * code), where CommonMark would have the marker take one of its columns.
   */
  private quoteMarker(c: LineCursor): boolean {
    if (c.columns(4) >= 4) return false;
    const t = c.clone();
    t.skipWhitespace();
    if (t.text[t.pos] !== '>') return false;
    c.pos = t.pos + 1;
    if (c.text[c.pos] === ' ') c.pos++;
    c.col = 0;
    c.spare = 0;
    return true;
  }

  /** Continue the open leaf with this line. False when the line ends it and is read as a new block. */
  private continueLeaf(
    leaf: Leaf,
    c: LineCursor,
    start: number,
    end: number,
    blank: boolean,
  ): boolean {
    const { text } = c;
    switch (leaf.kind) {
      case 'fence': {
        leaf.end = end;
        if (c.columns(4) < 4) {
          const t = c.clone();
          t.skipWhitespace();
          const run = sticky(FENCE_CLOSE, text, t.pos)?.[1];
          if (run && run[0] === leaf.marker[0] && run.length >= leaf.marker.length)
            this.closeLeaf();
        }
        return true;
      }
      case 'math':
        leaf.end = end;
        if (sticky(MATH_CLOSE, text, c.pos)) this.closeLeaf();
        return true;
      case 'html':
        if (!leaf.close && blank) {
          this.closeLeaf();
          return false;
        }
        leaf.end = end;
        if (leaf.close && closes(leaf.close, text, 0)) this.closeLeaf();
        return true;
      case 'code':
        /** Blank lines stay inside indented code without extending its span. */
        if (c.atEnd) return true;
        if (c.columns(4) >= 4) {
          leaf.end = end;
          return true;
        }
        this.closeLeaf();
        return false;
      case 'table':
        if (this.tableRow(c, leaf.lead)) {
          this.inline(start, end, true);
          return true;
        }
        this.closeLeaf();
        return false;
      case 'paragraph':
        return false;
    }
  }

  /**
   * Obsidian reads a table row only at the container's content start — one
   * leading space and the table is gone — and only in the header's style: a
   * table whose header opens with `|` takes rows that open with `|`, and one
   * whose header does not takes rows that hold a `|` without opening with one.
   */
  private tableRow(c: LineCursor, lead: boolean): boolean {
    if (c.atEnd || c.columns(1) > 0) return false;
    const { text, pos } = c;
    if (lead) return text[pos] === '|';
    return text[pos] !== '|' && hasPipe(text, pos, text.length);
  }

  private startLeaf(c: LineCursor, start: number, end: number): void {
    const { text } = c;
    const leaf = this.leaf;
    const cols = c.columns(4);
    if (cols >= 4) {
      /** Indented code cannot interrupt a paragraph; the line continues it. */
      if (leaf?.kind === 'paragraph') {
        this.grow(leaf, c, end);
      } else {
        this.closeLeaf();
        this.leaf = { kind: 'code', start, end };
      }
      return;
    }
    c.skipWhitespace();
    const { pos } = c;
    const at = start + pos;

    if (leaf?.kind === 'paragraph') {
      if (sticky(SETEXT_UNDERLINE, text, pos)) {
        this.closeLeaf();
        return;
      }
      if (
        leaf.lines === 1 &&
        leaf.header >= 0 &&
        cols === 0 &&
        this.delimiterRow(text, pos, leaf)
      ) {
        return;
      }
    }
    if (c.thematicBreakAt(pos)) {
      this.closeLeaf();
      return;
    }
    if (sticky(ATX_HEADING, text, pos)) {
      this.closeLeaf();
      this.inline(start, end);
      return;
    }
    const fence = sticky(FENCE_OPEN, text, pos);
    if (fence) {
      this.closeLeaf();
      this.leaf = { kind: 'fence', start, end, marker: fence[0] };
      return;
    }
    const html = htmlBlockAt(text, pos, leaf?.kind === 'paragraph');
    if (html) {
      this.closeLeaf();
      this.leaf = { kind: 'html', start: at, end, close: html.close };
      if (html.close && closes(html.close, text, pos)) this.closeLeaf();
      return;
    }
    /**
     * A `$$` line opens display math, interrupting a paragraph — unless the
     * paragraph already holds an unpaired inline `$$`, which Obsidian closes on
     * this line instead: `a $$` then `#t` then `$$ b` hides `#t` as inline math.
     */
    if (mathOpensAt(text, pos) && !(leaf?.kind === 'paragraph' && leaf.dollars % 2 === 1)) {
      this.closeLeaf();
      this.leaf = { kind: 'math', start: at, end };
      return;
    }
    if (leaf?.kind === 'paragraph') {
      this.grow(leaf, c, end);
      return;
    }
    this.closeLeaf();
    /** Obsidian does not read a link reference definition as a paragraph: an indented line after `[a]: u` is code. */
    if (sticky(LINK_DEFINITION, text, pos)) {
      this.inline(start, end);
      return;
    }
    this.leaf = {
      kind: 'paragraph',
      start,
      end,
      lines: 1,
      header: cols === 0 ? at : -1,
      dollars: doubleDollars(text, pos),
    };
  }

  /**
   * Turn a one-line paragraph into a table when this line is a delimiter row
   * in the header's style. Obsidian does not require the column counts to
   * agree, and does not let a table interrupt a paragraph.
   */
  private delimiterRow(text: string, pos: number, paragraph: Paragraph): boolean {
    const lead = this.body[paragraph.header] === '|';
    if ((text[pos] === '|') !== lead) return false;
    const from = lead ? pos + 1 : pos;
    if (!sticky(DELIMITER_ROW, text, from) || !text.includes('|', from)) return false;
    if (!hasPipe(this.body, lead ? paragraph.header + 1 : paragraph.header, paragraph.end)) {
      return false;
    }
    this.leaf = { kind: 'table', lead };
    this.inline(paragraph.start, paragraph.end, true);
    return true;
  }
}

/**
 * The hidden and inline ranges of `body`, in order and non-overlapping.
 * Linear in the length of the body: each line is read a bounded number of
 * times, and a blank line matches its containers without walking them.
 */
export function scanBlocks(body: string): BlockSpan[] {
  return new BlockScanner(body).run();
}

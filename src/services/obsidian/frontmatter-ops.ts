/**
 * @fileoverview Read-modify-write helpers for the YAML frontmatter block of a
 * note's raw content. Used by the composed manage-frontmatter / manage-tags
 * tools when the upstream Local REST API has no single-call equivalent.
 * @module services/obsidian/frontmatter-ops
 */

import { type Document, isMap, parseDocument } from 'yaml';

const FM_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

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
 * thing is body, which is also how Obsidian reads each of those shapes.
 */
export function splice(content: string): Splice {
  const m = FM_RE.exec(content);
  if (!m) {
    return { hasFrontmatter: false, raw: '', open: '', yamlText: '', close: '', body: content };
  }
  return {
    hasFrontmatter: true,
    raw: m[0],
    open: m[1] ?? '',
    yamlText: m[2] ?? '',
    close: m[3] ?? '',
    body: content.slice(m[0].length),
  };
}

/**
 * Describe why `yamlText` is not usable as a frontmatter block, or `undefined`
 * when it is. Catches YAML that no longer parses and YAML that parses to
 * something other than a mapping — the two states in which Obsidian reads no
 * properties at all.
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
  return;
}

/**
 * Re-emit the parsed frontmatter document between `---` fences, preserving the
 * comments, quoting, and scalar formatting of every untouched node — the reason
 * these helpers parse with `yaml`'s CST-backed `parseDocument` and edit nodes in
 * place rather than round-tripping the block through a plain object (which drops
 * comments and rewrites untouched scalars, e.g. `date: 2026-06-29` → an ISO
 * timestamp). When no keys remain, the whole block is dropped and the body's
 * leading whitespace trimmed.
 *
 * The body is re-attached verbatim. `FM_RE` consumes the newline that closes
 * the fence line and nothing more, so the template's trailing `\n` replaces
 * exactly what was eaten — the blank separator line before the body (or its
 * absence, or several of them) survives the rewrite byte for byte.
 */
function serializeFrontmatter(doc: Document, body: string): string {
  const node = doc.contents;
  if (!node || (isMap(node) && node.items.length === 0)) {
    return body.replace(/^\s+/, '');
  }
  const yamlText = doc.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}

/**
 * Returns the full file content with `key` removed from the frontmatter.
 * If the file has no frontmatter or the key isn't present, returns content
 * unchanged.
 */
export function deleteFrontmatterKey(content: string, key: string): string {
  const { hasFrontmatter, yamlText, body } = splice(content);
  if (!hasFrontmatter) return content;
  const doc = parseDocument(yamlText);
  if (!doc.has(key)) return content;
  doc.delete(key);
  return serializeFrontmatter(doc, body);
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

/**
 * Add or remove tags across frontmatter (`tags:` array) and inline `#tag`
 * syntax. Inline occurrences inside fenced code blocks are left alone — they
 * are code, not tags.
 */
export function reconcileTags(
  content: string,
  tags: string[],
  operation: TagOperation,
  location: TagLocation,
): TagReconcileResult {
  const norm = (t: string) => t.replace(/^#+/, '').trim();
  const wanted = tags.map(norm).filter((t) => t.length > 0);
  const applied = new Set<string>();
  const skipped = new Set<string>();

  let updated = content;

  if (location === 'frontmatter' || location === 'both') {
    updated = mutateFrontmatterTags(updated, wanted, operation, applied, skipped);
  }
  if (location === 'inline' || location === 'both') {
    updated = mutateInlineTags(updated, wanted, operation, applied, skipped);
  }

  // For location='both', a tag that was already-in-frontmatter may have been
  // missing inline (or vice versa). If applied is non-empty for the tag, drop
  // it from skipped.
  for (const t of applied) skipped.delete(t);

  return { content: updated, applied: [...applied], skipped: [...skipped] };
}

function mutateFrontmatterTags(
  content: string,
  tags: string[],
  operation: TagOperation,
  applied: Set<string>,
  skipped: Set<string>,
): string {
  const { hasFrontmatter, yamlText, body } = splice(content);
  const doc = parseDocument(hasFrontmatter ? yamlText : '');
  const fm = (doc.toJS() ?? {}) as Record<string, unknown>;

  const existing = normalizeTagList(fm.tags);
  const set = new Set(existing);
  let changed = false;

  for (const tag of tags) {
    if (operation === 'add') {
      if (set.has(tag)) skipped.add(tag);
      else {
        set.add(tag);
        applied.add(tag);
        changed = true;
      }
    } else {
      if (set.has(tag)) {
        set.delete(tag);
        applied.add(tag);
        changed = true;
      } else {
        skipped.add(tag);
      }
    }
  }

  if (!changed) return content;

  const ordered = [...set];
  if (ordered.length === 0) {
    doc.delete('tags');
  } else {
    doc.set('tags', ordered);
  }

  return serializeFrontmatter(doc, body);
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

const FENCED_CODE_BLOCK = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const INLINE_CODE = /(`[^`\n]+`)/g;

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

function splitProtectedSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  const re = new RegExp(`${FENCED_CODE_BLOCK.source}|${INLINE_CODE.source}`, 'g');
  for (;;) {
    const m = re.exec(content);
    if (!m) break;
    const matched = m[0] ?? '';
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

/** Captures the character before the tag and the single horizontal space after it, if any. */
function makeInlineTagRegex(tag: string): RegExp {
  const escaped = tag.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(`(^|[^\\w/])#${escaped}(?![\\w/-])([ \\t]?)`, 'g');
}

/**
 * Read-only helpers for `obsidian_manage_tags list`. Inline tags are read from
 * the body only, matching where a removal can actually reach — a `#` inside a
 * YAML scalar is frontmatter, not a tag.
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
  for (const seg of splitProtectedSegments(splice(content).body)) {
    if (seg.protected) continue;
    const re = /(^|[^\w/])#([a-zA-Z][\w/-]*)/g;
    for (;;) {
      const m = re.exec(seg.text);
      if (!m) break;
      const t = m[2];
      if (t && !seen.has(t)) {
        seen.add(t);
        inline.push(t);
      }
    }
  }
  return { frontmatter: fmTags, inline };
}

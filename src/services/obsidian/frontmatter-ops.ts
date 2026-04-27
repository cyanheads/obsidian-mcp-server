/**
 * @fileoverview Read-modify-write helpers for the YAML frontmatter block of a
 * note's raw content. Used by the composed manage-frontmatter / manage-tags
 * tools when the upstream Local REST API has no single-call equivalent.
 * @module services/obsidian/frontmatter-ops
 */

import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface Splice {
  body: string;
  hasFrontmatter: boolean;
  /** YAML text between the `---` fences. Empty when `hasFrontmatter` is false. */
  yamlText: string;
}

function splice(content: string): Splice {
  const m = FM_RE.exec(content);
  if (!m) return { hasFrontmatter: false, yamlText: '', body: content };
  return {
    hasFrontmatter: true,
    yamlText: m[1] ?? '',
    body: content.slice(m[0].length),
  };
}

function loadFrontmatter(yamlText: string): Record<string, unknown> {
  const loaded = yamlLoad(yamlText) as Record<string, unknown> | null | undefined;
  return loaded && typeof loaded === 'object' ? loaded : {};
}

function emit(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) {
    return body.replace(/^\s+/, '');
  }
  const yamlText = yamlDump(frontmatter, { lineWidth: 1000, noRefs: true });
  return `---\n${yamlText.trimEnd()}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

/**
 * Returns the full file content with `key` removed from the frontmatter.
 * If the file has no frontmatter or the key isn't present, returns content
 * unchanged.
 */
export function deleteFrontmatterKey(content: string, key: string): string {
  const { hasFrontmatter, yamlText, body } = splice(content);
  if (!hasFrontmatter) return content;
  const fm = loadFrontmatter(yamlText);
  if (!(key in fm)) return content;
  delete fm[key];
  return emit(fm, body);
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
  const fm = hasFrontmatter ? { ...loadFrontmatter(yamlText) } : {};

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
    delete fm.tags;
  } else {
    fm.tags = ordered;
  }

  if (Object.keys(fm).length === 0) {
    return body.replace(/^\s+/, '');
  }
  return emit(fm, body);
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

function mutateInlineTags(
  content: string,
  tags: string[],
  operation: TagOperation,
  applied: Set<string>,
  skipped: Set<string>,
): string {
  const segments = splitProtectedSegments(content);
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
      const trailing = segments.length > 0 ? (segments[segments.length - 1] ?? null) : null;
      if (trailing && !trailing.protected) {
        const sep = trailing.text.endsWith('\n') ? '' : '\n';
        trailing.text = `${trailing.text}${sep}${additions}\n`;
        updatedNonCode = true;
      } else {
        segments.push({ protected: false, text: `\n${additions}\n` });
        updatedNonCode = true;
      }
    }
  } else {
    for (const tag of tags) {
      const re = makeInlineTagRegex(tag);
      let found = false;
      for (const s of segments) {
        if (s.protected) continue;
        if (re.test(s.text)) {
          s.text = s.text.replace(re, (_full, leading: string) => leading);
          // collapse double spaces left behind
          s.text = s.text.replace(/[ \t]{2,}/g, ' ').replace(/ \n/g, '\n');
          found = true;
          updatedNonCode = true;
        }
      }
      if (found) applied.add(tag);
      else skipped.add(tag);
    }
  }

  if (!updatedNonCode) return content;
  return segments.map((s) => s.text).join('');
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

function makeInlineTagRegex(tag: string): RegExp {
  const escaped = tag.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  return new RegExp(`(^|[^\\w/])#${escaped}(?![\\w/-])`, 'g');
}

/** Read-only helpers for `obsidian_manage_tags list`. */
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
  for (const seg of splitProtectedSegments(content)) {
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

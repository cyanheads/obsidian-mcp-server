/**
 * @fileoverview Shared types for the Obsidian Local REST API service layer.
 * Mirrors the upstream plugin's response shapes (NoteJson, document map, etc.).
 * @module services/obsidian/types
 */

export type PeriodicPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export type NoteTarget =
  | { type: 'path'; path: string }
  | { type: 'active' }
  | { type: 'periodic'; period: PeriodicPeriod; date?: string | undefined };

export type SectionType = 'heading' | 'block' | 'frontmatter';

export interface SectionTarget {
  /** Heading name ("::" delimits nesting), block reference, or frontmatter field name. */
  target: string;
  type: SectionType;
}

export interface NoteStat {
  ctime: number;
  mtime: number;
  size: number;
}

export interface NoteJson {
  content: string;
  frontmatter: Record<string, unknown>;
  path: string;
  stat: NoteStat;
  tags: string[];
}

export interface DocumentMap {
  blocks: string[];
  frontmatterFields: string[];
  headings: string[];
}

export interface FileListing {
  files: string[];
}

export interface VaultStatus {
  authenticated: boolean;
  manifest?: { id: string; name: string; version: string };
  service: string;
  status: string;
  versions?: { obsidian?: string; self?: string };
}

export interface ObsidianTag {
  count: number;
  name: string;
}

export interface ObsidianCommand {
  id: string;
  name: string;
}

export type SearchMode = 'text' | 'jsonlogic' | 'omnisearch';

export interface TextSearchHit {
  filename: string;
  matches: Array<{
    context: string;
    match: { start: number; end: number };
  }>;
  score?: number;
}

export interface StructuredSearchHit {
  filename: string;
  result: unknown;
}

/**
 * Normalized Omnisearch hit. The upstream `path` is renamed to `filename` so
 * the shape composes with `PathPolicy.filterReadable`. `excerpt` has had its
 * HTML entities decoded and `<br>` tags converted to newlines. `vault` is
 * dropped — this server is single-vault.
 */
export interface OmnisearchHit {
  basename: string;
  excerpt: string;
  filename: string;
  foundWords: string[];
  matches: Array<{ match: string; offset: number }>;
  score: number;
}

export interface PatchHeaders {
  /**
   * When false/undefined (the protective default), the patch is rejected if
   * matching content already exists in the target. Set to true to force-apply
   * even when it would duplicate. The wire header is `Reject-If-Content-
   * Preexists` (markdown-patch 1.0+) — the service inverts this flag on the
   * way out. Replace operations are exempt at the plugin layer.
   */
  applyIfContentPreexists?: boolean | undefined;
  contentType?: 'markdown' | 'json' | undefined;
  createTargetIfMissing?: boolean | undefined;
  operation: 'append' | 'prepend' | 'replace';
  target: string;
  targetDelimiter?: string | undefined;
  targetType: SectionType;
  trimTargetWhitespace?: boolean | undefined;
}

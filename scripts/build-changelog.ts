#!/usr/bin/env node
/**
 * @fileoverview Generate CHANGELOG.md as a navigation index from per-version files.
 *
 * Source of truth: `changelog/<major.minor>.x/<version>.md` — each file opens with
 * YAML frontmatter declaring:
 *   • summary (required)  — ≤350-char headline, no markdown, one line
 *   • breaking (optional) — `true` flags releases with breaking changes
 *   • security (optional) — `true` flags releases with security fixes
 *
 * The rollup is a thin **index**, not a copy of bodies — each entry is just a
 * clickable header + one-line summary. Full content stays in the per-version files.
 *
 * Rendered rollup entry:
 *   ## [X.Y.Z](changelog/N.N.x/X.Y.Z.md) — YYYY-MM-DD · ⚠️ Breaking · 🛡️ Security
 *
 *   <summary>
 *
 * Badges only render when their flag is `true`. Order is fixed: Breaking before
 * Security when both are set.
 *
 * Modes:
 *   • default   → regenerate CHANGELOG.md
 *   • --check   → exit 1 if CHANGELOG.md differs from what would be generated
 *
 * Missing `summary`: warning (not failure) — the entry renders header-only.
 * Summary > 350 chars, or malformed `breaking` / `security`: hard error.
 *
 * @module scripts/build-changelog
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const CHANGELOG_DIR = resolve('changelog');
const CHANGELOG_PATH = resolve('CHANGELOG.md');
const EXCLUDED_FILES = new Set(['template.md', 'README.md']);
const SERIES_PATTERN = /^\d+\.\d+\.x$/;
const SUMMARY_MAX_LENGTH = 350;

const HEADER = `# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).
`;

interface VersionEntry {
  path: string;
  series: string;
  version: string;
}

interface Frontmatter {
  breaking: boolean;
  security: boolean;
  summary: string | null;
}

/**
 * Semver descending compare. Final releases rank above their prereleases
 * (`0.6.0 > 0.6.0-rc.1 > 0.6.0-beta.1`). Prereleases compared lexicographically.
 */
function compareSemverDesc(a: string, b: string): number {
  const parse = (v: string): [number[], string | null] => {
    const [base, pre = null] = v.split('-', 2) as [string, string | undefined];
    return [base.split('.').map(Number), pre ?? null];
  };
  const [aParts, aPre] = parse(a);
  const [bParts, bPre] = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === bPre) return 0;
  if (aPre === null) return -1;
  if (bPre === null) return 1;
  return bPre.localeCompare(aPre);
}

/**
 * Parse minimal YAML frontmatter. Only recognizes `summary`, `breaking`, and
 * `security` — other keys are ignored, so the format stays extensible without
 * touching the parser. Throws on malformed values we actually care about.
 */
function parseFrontmatter(content: string, fileLabel: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { summary: null, breaking: false, security: false };

  const block = match[1] as string;

  // summary: quoted or bare, single line
  let summary: string | null = null;
  const summaryMatch = block.match(/^summary:\s*(.*)$/m);
  if (summaryMatch) {
    let raw = (summaryMatch[1] ?? '').trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    }
    summary = raw.length > 0 ? raw : null;
  }
  if (summary !== null && summary.length > SUMMARY_MAX_LENGTH) {
    throw new Error(
      `${fileLabel}: summary is ${summary.length} chars, exceeds cap of ${SUMMARY_MAX_LENGTH}. Keep it tight — headline, not paragraph.`,
    );
  }

  const parseBool = (key: string): boolean => {
    const m = block.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm'));
    if (!m) return false;
    const val = m[1];
    if (val !== 'true' && val !== 'false') {
      throw new Error(`${fileLabel}: ${key} must be 'true' or 'false', got '${val}'.`);
    }
    return val === 'true';
  };

  return {
    summary,
    breaking: parseBool('breaking'),
    security: parseBool('security'),
  };
}

/** Extract the release date from the H1 heading. */
function extractDate(body: string, fileLabel: string): string {
  const match = body.match(/^#\s+\S+\s+[—–-]\s+(\d{4}-\d{2}-\d{2})/m);
  if (!match) {
    throw new Error(
      `${fileLabel}: H1 heading missing or malformed. Expected '# <version> — YYYY-MM-DD'.`,
    );
  }
  return match[1] as string;
}

function renderEntry(entry: VersionEntry, fm: Frontmatter, date: string): string {
  const link = `changelog/${entry.series}/${entry.version}.md`;
  const badges = [fm.breaking ? '⚠️ Breaking' : null, fm.security ? '🛡️ Security' : null].filter(
    (b): b is string => b !== null,
  );
  const badgeSuffix = badges.length > 0 ? ` · ${badges.join(' · ')}` : '';
  const header = `## [${entry.version}](${link}) — ${date}${badgeSuffix}`;
  if (fm.summary) {
    return `${header}\n\n${fm.summary}\n`;
  }
  return `${header}\n`;
}

function collectVersionFiles(): VersionEntry[] {
  const entries: VersionEntry[] = [];
  for (const entry of readdirSync(CHANGELOG_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SERIES_PATTERN.test(entry.name)) continue;
    const seriesDir = resolve(CHANGELOG_DIR, entry.name);
    for (const file of readdirSync(seriesDir)) {
      if (!file.endsWith('.md') || EXCLUDED_FILES.has(file)) continue;
      entries.push({
        version: file.replace(/\.md$/, ''),
        series: entry.name,
        path: resolve(seriesDir, file),
      });
    }
  }
  return entries.sort((a, b) => compareSemverDesc(a.version, b.version));
}

function buildRollup(): { content: string; missingSummary: string[] } {
  const entries = collectVersionFiles();

  if (entries.length === 0) {
    throw new Error(`No per-version changelog files found under ${CHANGELOG_DIR}/<major.minor>.x/`);
  }

  const missingSummary: string[] = [];
  const sections: string[] = [];

  for (const entry of entries) {
    const fileLabel = `changelog/${entry.series}/${entry.version}.md`;
    const content = readFileSync(entry.path, 'utf-8');
    const fm = parseFrontmatter(content, fileLabel);
    const date = extractDate(content, fileLabel);

    if (!fm.summary) {
      missingSummary.push(fileLabel);
    }

    sections.push(renderEntry(entry, fm, date));
  }

  return {
    content: `${HEADER}\n${sections.join('\n')}`,
    missingSummary,
  };
}

function reportMissingSummaries(missing: string[]): void {
  if (missing.length === 0) return;
  const shown = missing.slice(0, 10);
  const extra = missing.length - shown.length;
  console.warn(`\nWarning: ${missing.length} file(s) missing 'summary' frontmatter:`);
  for (const file of shown) console.warn(`  - ${file}`);
  if (extra > 0) console.warn(`  ... and ${extra} more`);
  console.warn(`\nBackfill these — see CLAUDE.md § Changelog for the frontmatter format.`);
}

function main(): void {
  const checkOnly = process.argv.includes('--check');

  if (!existsSync(CHANGELOG_DIR)) {
    console.log(`Skipped: ${CHANGELOG_DIR} does not exist (single-file CHANGELOG.md project).`);
    process.exit(0);
  }

  const { content: generated, missingSummary } = buildRollup();

  if (checkOnly) {
    let existing = '';
    try {
      existing = readFileSync(CHANGELOG_PATH, 'utf-8');
    } catch {
      // missing file counts as drift
    }
    if (existing === generated) {
      console.log('CHANGELOG.md is in sync with changelog/ directory.');
      reportMissingSummaries(missingSummary);
      process.exit(0);
    }
    console.error('CHANGELOG.md is out of sync with changelog/ directory.');
    console.error('Fix: run `bun run changelog:build` to regenerate.');
    reportMissingSummaries(missingSummary);
    process.exit(1);
  }

  writeFileSync(CHANGELOG_PATH, generated);
  console.log(`Wrote ${CHANGELOG_PATH} (${generated.split('\n').length - 1} lines).`);
  reportMissingSummaries(missingSummary);
}

main();

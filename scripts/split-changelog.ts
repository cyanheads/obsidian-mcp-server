#!/usr/bin/env node
/**
 * @fileoverview One-shot migration: split the monolithic CHANGELOG.md into
 * per-version files under `changelog/<major.minor>.x/<version>.md`.
 *
 * After the initial migration, this script is no longer needed — the
 * per-version files become the source of truth and `scripts/build-changelog.ts`
 * regenerates CHANGELOG.md from them. Keep this around only long enough to
 * verify the round-trip (split → build → diff).
 *
 * Behavior:
 *   • Reads CHANGELOG.md, splits on `## [X.Y.Z] - YYYY-MM-DD` headers
 *   • Groups by minor series: 0.1.4 → changelog/0.1.x/0.1.4.md
 *   • Writes each version block with an H1 heading
 *   • Creates changelog/template.md template if missing
 *   • Overwrites existing per-version files (idempotent)
 *   • Drops the preamble (title + description) — that's handled by the build script
 *
 * Usage: bun run scripts/split-changelog.ts
 *
 * @module scripts/split-changelog
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHANGELOG_PATH = resolve('CHANGELOG.md');
const CHANGELOG_DIR = resolve('changelog');
const TEMPLATE_PATH = resolve(CHANGELOG_DIR, 'template.md');

const TEMPLATE_CONTENT = `# <version> — YYYY-MM-DD

<!-- Brief summary of the upcoming release — delete this comment when filled in. -->

## Added

-

## Changed

-

## Fixed

-
`;

interface Section {
  body: string;
  date: string;
  version: string;
}

function extractSections(content: string): Section[] {
  const regex = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm;
  const matches = [...content.matchAll(regex)];
  if (matches.length === 0) {
    throw new Error('No version sections found in CHANGELOG.md (expected ## [X.Y.Z] - YYYY-MM-DD)');
  }

  const sections: Section[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i] as RegExpMatchArray & { index: number };
    const next = matches[i + 1] as (RegExpMatchArray & { index: number }) | undefined;
    const start = match.index + match[0].length;
    const end = next ? next.index : content.length;

    let body = content.slice(start, end);
    body = body.replace(/^\n+/, '');
    body = body.replace(/\n+---\n*$/, '\n');
    body = body.replace(/\n*$/, '\n');

    sections.push({
      version: match[1] as string,
      date: match[2] as string,
      body,
    });
  }
  return sections;
}

/**
 * Promote heading levels by stripping one `#` from H2+ lines. Assumes no H1
 * or H2 in section bodies (the version H2 was already stripped); the existing
 * CHANGELOG.md uses H3 for Added/Changed/Fixed etc., which become H2 here.
 */
function promoteHeadings(body: string): string {
  return body.replace(/^(#{2,6}) /gm, (_, hashes: string) => `${hashes.slice(1)} `);
}

function toPerVersionFile(section: Section): string {
  return `# ${section.version} — ${section.date}\n\n${promoteHeadings(section.body)}`;
}

/** Extract the `major.minor.x` series directory for a version string. */
function seriesOf(version: string): string {
  const [major, minor] = version.split('.');
  if (!major || !minor) throw new Error(`Cannot derive series from version: ${version}`);
  return `${major}.${minor}.x`;
}

function main(): void {
  const content = readFileSync(CHANGELOG_PATH, 'utf-8');
  const sections = extractSections(content);

  mkdirSync(CHANGELOG_DIR, { recursive: true });

  const seriesCounts = new Map<string, number>();

  for (const section of sections) {
    const series = seriesOf(section.version);
    const seriesDir = resolve(CHANGELOG_DIR, series);
    mkdirSync(seriesDir, { recursive: true });
    const path = resolve(seriesDir, `${section.version}.md`);
    writeFileSync(path, toPerVersionFile(section));
    seriesCounts.set(series, (seriesCounts.get(series) ?? 0) + 1);
  }

  for (const [series, count] of [...seriesCounts.entries()].sort()) {
    console.log(`  + changelog/${series}/ (${count} file${count === 1 ? '' : 's'})`);
  }

  if (!existsSync(TEMPLATE_PATH)) {
    writeFileSync(TEMPLATE_PATH, TEMPLATE_CONTENT);
    console.log('  + changelog/template.md (format reference)');
  }

  console.log(`\nSplit ${sections.length} versions into ${seriesCounts.size} series.`);
  console.log('Next: `bun run scripts/build-changelog.ts` to regenerate CHANGELOG.md,');
  console.log('      then `diff` against the original to verify byte-equality.');
}

main();

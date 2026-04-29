#!/usr/bin/env node
/**
 * @fileoverview Verifies that `skills/` (canonical) has been propagated to the
 * local mirrors `.agents/skills/` and `.claude/skills/`. The maintenance skill
 * updates `skills/` for downstream servers; the mirrors are what local agent
 * toolchains actually read, and silent drift means agents run on stale guidance.
 *
 * Propagation is one-way (`skills/` → mirrors), so only missing or
 * content-drifted files are reported. Files that exist *only* in a mirror are
 * typically unrelated skills (globally installed, other sources) and are left
 * alone.
 *
 * Behavior:
 *   • In sync                          → pass
 *   • Mirrors missing entirely         → skip (no mirrors to sync)
 *   • Drift (missing or changed files) → exit 1 with details (devcheck demotes to warning)
 *
 * Ignore specific skills or files via `devcheck.config.json`:
 *
 *   {
 *     "skillsSync": {
 *       "ignore": ["some-skill", "other-skill/SKILL.md"]
 *     }
 *   }
 *
 * Patterns match relative paths under `skills/`. A bare name like `add-tool`
 * ignores the whole directory; `add-tool/SKILL.md` ignores a single file.
 * `.DS_Store` and other OS cruft are ignored by default.
 *
 * Runs as a devcheck step and standalone: `bun run scripts/check-skills-sync.ts`.
 *
 * @module scripts/check-skills-sync
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import process from 'node:process';

const ROOT = resolve('.');
const SKILLS_DIR = resolve(ROOT, 'skills');
const MIRRORS: { label: string; path: string }[] = [
  { label: '.agents/skills', path: resolve(ROOT, '.agents/skills') },
  { label: '.claude/skills', path: resolve(ROOT, '.claude/skills') },
];

interface DevcheckConfig {
  skillsSync?: { ignore?: string[] };
}

/** OS/editor noise we never want to flag as drift. */
const DEFAULT_IGNORES = ['.DS_Store', 'Thumbs.db'];

function loadIgnorePatterns(): string[] {
  try {
    const cfg = JSON.parse(
      readFileSync(resolve(ROOT, 'devcheck.config.json'), 'utf-8'),
    ) as DevcheckConfig;
    return [...DEFAULT_IGNORES, ...(cfg.skillsSync?.ignore ?? [])];
  } catch {
    return [...DEFAULT_IGNORES];
  }
}

function isIgnored(relPath: string, patterns: string[]): boolean {
  const basename = relPath.split('/').pop() ?? relPath;
  return patterns.some((p) => p === relPath || p === basename || relPath.startsWith(`${p}/`));
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return files;
}

if (!existsSync(SKILLS_DIR)) {
  console.log('Skipped: no skills/ directory.');
  process.exit(0);
}

const presentMirrors = MIRRORS.filter((m) => existsSync(m.path));
if (presentMirrors.length === 0) {
  console.log('Skipped: no skill mirrors (.agents/skills, .claude/skills) present.');
  process.exit(0);
}

const ignore = loadIgnorePatterns();
const canonical = walkFiles(SKILLS_DIR).filter((f) => !isIgnored(f, ignore));

const missing: Record<string, string[]> = {};
const drifted: Record<string, string[]> = {};

for (const mirror of presentMirrors) {
  const missingHere: string[] = [];
  const driftedHere: string[] = [];
  for (const file of canonical) {
    const mirrorFile = resolve(mirror.path, file);
    if (!existsSync(mirrorFile)) {
      missingHere.push(file);
      continue;
    }
    const a = readFileSync(resolve(SKILLS_DIR, file), 'utf-8');
    const b = readFileSync(mirrorFile, 'utf-8');
    if (a !== b) driftedHere.push(file);
  }

  if (missingHere.length) missing[mirror.label] = missingHere.sort();
  if (driftedHere.length) drifted[mirror.label] = driftedHere.sort();
}

const totals = {
  missing: Object.values(missing).reduce((n, arr) => n + arr.length, 0),
  drifted: Object.values(drifted).reduce((n, arr) => n + arr.length, 0),
};
const driftCount = totals.missing + totals.drifted;

if (driftCount === 0) {
  console.log(`skills/ is in sync with ${presentMirrors.map((m) => m.label).join(' and ')}.`);
  process.exit(0);
}

const lines: string[] = [];
lines.push(
  `skills/ has drifted from ${presentMirrors.length > 1 ? 'mirrors' : 'its mirror'} ` +
    `(${totals.missing} missing, ${totals.drifted} changed).`,
);

const renderSection = (title: string, groups: Record<string, string[]>) => {
  for (const [label, files] of Object.entries(groups)) {
    lines.push('');
    lines.push(`${title} ${label}/:`);
    for (const file of files) lines.push(`  - ${file}`);
  }
};

renderSection('Missing in', missing);
renderSection('Content differs in', drifted);

lines.push('');
lines.push('Fix: propagate skills/ to the mirror(s), or add entries to');
lines.push('     devcheck.config.json `skillsSync.ignore` to silence specific paths.');

console.log(lines.join('\n'));
process.exit(1);

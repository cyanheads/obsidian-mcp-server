#!/usr/bin/env node
/**
 * @fileoverview Verifies that `framework-skills/` (canonical) has been propagated to the
 * local mirrors `.agents/skills/` and `.claude/skills/`. The maintenance skill
 * updates `framework-skills/` for downstream servers; the mirrors are what local agent
 * toolchains actually read, and silent drift means agents run on stale guidance.
 *
 * Propagation is one-way (`framework-skills/` → mirrors), so missing or content-drifted
 * files are reported. A skill that exists *only* in a mirror is left alone when
 * it's externally sourced (globally installed, other tools), but flagged as
 * stale when its `SKILL.md` carries `metadata.audience: external` — a framework
 * skill removed from `framework-skills/` upstream that the mirror never had pruned.
 *
 * Behavior:
 *   • In sync                          → pass
 *   • Mirrors missing entirely         → skip (no mirrors to sync)
 *   • Drift (missing or changed files) → exit 1 with details (devcheck demotes to warning)
 *   • Stale framework skill in mirror  → exit 1 (mirror-only dir with audience: external)
 *   • Unmigrated pre-0.13 `skills/`    → exit 1 with the `git mv` step
 *   • Leftover pre-0.13 `skills/`      → exit 1 with the removal step (both trees present)
 *
 * Ignore specific skills or files via `devcheck.config.json`:
 *
 *   {
 *     "skillsSync": {
 *       "ignore": ["some-skill", "other-skill/SKILL.md"]
 *     }
 *   }
 *
 * Patterns match relative paths under `framework-skills/`. A bare name like `add-tool`
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
const SKILLS_DIR = resolve(ROOT, 'framework-skills');
/**
 * Where the tree lived before 0.13. Claude Code and Codex auto-load a plugin's
 * root `skills/`, so a server shipping a plugin manifest handed its development
 * skills to every installing agent — hence the move.
 */
const LEGACY_SKILLS_DIR = resolve(ROOT, 'skills');
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

/** Top-level skill directory names under a path (empty when the path is absent). */
function skillDirNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** True when a skill is framework-managed — its SKILL.md carries `audience: external`. */
function isFrameworkManaged(skillMdPath: string): boolean {
  if (!existsSync(skillMdPath)) return false;
  return /^\s*audience:\s*external\s*$/m.test(readFileSync(skillMdPath, 'utf-8'));
}

/** Skill directories under `root` whose `SKILL.md` carries `audience: external`. */
function frameworkManagedDirs(root: string): string[] {
  return skillDirNames(root).filter((name) => isFrameworkManaged(resolve(root, name, 'SKILL.md')));
}

if (!existsSync(SKILLS_DIR)) {
  const unmigrated = frameworkManagedDirs(LEGACY_SKILLS_DIR).length > 0;
  if (unmigrated) {
    console.log(
      [
        'skills/ still holds framework-managed skills and framework-skills/ is absent.',
        'The framework moved its skill tree in 0.13.0: plugin hosts auto-load a root skills/,',
        'which surfaced these development skills to every agent that installed the server.',
        '',
        'Fix: git mv skills framework-skills',
        '     then update the path in CLAUDE.md/AGENTS.md, .mcpbignore (/framework-skills/),',
        '     and .github/CONTRIBUTING.md, and regenerate docs/tree.md.',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log('Skipped: no framework-skills/ directory.');
  process.exit(0);
}

// Both trees present. `init` run in place never overwrites an existing file, so an
// upgrade creates `framework-skills/` and leaves the old copies where a plugin host
// still auto-loads them. Only a name carried by both trees is a leftover — a `skills/`
// name of its own is the reserved server-published kind.
const canonicalDirs = new Set(skillDirNames(SKILLS_DIR));
const leftover = frameworkManagedDirs(LEGACY_SKILLS_DIR).filter((name) => canonicalDirs.has(name));
if (leftover.length > 0) {
  console.log(
    [
      `skills/ still holds ${leftover.length} framework skill(s) that framework-skills/ also carries.`,
      'Plugin hosts auto-load a root skills/, so those development skills still reach every',
      'agent that installs the server.',
      '',
      `Fix: rm -rf ${leftover.map((name) => `skills/${name}`).join(' ')}`,
      '     Keep skills/ for skills the server publishes to the agents that use it.',
    ].join('\n'),
  );
  process.exit(1);
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

// Stale framework skills: a skill dir present only in a mirror (absent from
// canonical framework-skills/) is fine when externally sourced, but stale when it carries
// `audience: external` — a framework skill removed from framework-skills/ that was never
// pruned from the mirror. User/external skills (no marker) are left alone.
const stale: Record<string, string[]> = {};
for (const mirror of presentMirrors) {
  const staleHere = skillDirNames(mirror.path)
    .filter((name) => !canonicalDirs.has(name) && !isIgnored(name, ignore))
    .filter((name) => isFrameworkManaged(resolve(mirror.path, name, 'SKILL.md')))
    .sort();
  if (staleHere.length) stale[mirror.label] = staleHere;
}

const totals = {
  missing: Object.values(missing).reduce((n, arr) => n + arr.length, 0),
  drifted: Object.values(drifted).reduce((n, arr) => n + arr.length, 0),
  stale: Object.values(stale).reduce((n, arr) => n + arr.length, 0),
};
const driftCount = totals.missing + totals.drifted + totals.stale;

if (driftCount === 0) {
  console.log(
    `framework-skills/ is in sync with ${presentMirrors.map((m) => m.label).join(' and ')}.`,
  );
  process.exit(0);
}

const lines: string[] = [];
lines.push(
  `framework-skills/ has drifted from ${presentMirrors.length > 1 ? 'mirrors' : 'its mirror'} ` +
    `(${totals.missing} missing, ${totals.drifted} changed, ${totals.stale} stale).`,
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
renderSection('Stale framework skill (deleted upstream) in', stale);

lines.push('');
lines.push(
  'Fix: propagate framework-skills/ to the mirror(s) and delete stale framework skills from them,',
);
lines.push(
  '     or add entries to devcheck.config.json `skillsSync.ignore` to silence specific paths.',
);

console.log(lines.join('\n'));
process.exit(1);

#!/usr/bin/env node
/**
 * @fileoverview Enforces the skill-versioning policy (#98 → #99): a change to a
 * `skills/<name>/SKILL.md` body must bump `metadata.version` in the same edit.
 * Documenting the policy made the expectation visible; this check makes it stick.
 * The triggering incident was 7 missed bumps across 2 consecutive releases — the
 * kind of low-salience checklist item that needs tooling, not vigilance.
 *
 * For each `skills/<name>/SKILL.md` that differs from `HEAD` (working tree, staged
 * or not), it compares the frontmatter `metadata.version` and the body across
 * `HEAD` → working tree. A changed body with an unchanged version is a violation.
 * Whitespace-only body edits never trigger it (the policy's typo/whitespace
 * carve-out); a genuine typo fix opts out via `devcheck.config.json`:
 *
 *   {
 *     "skillVersions": {
 *       "ignore": ["add-tool", "api-linter/SKILL.md"]
 *     }
 *   }
 *
 * A bare name (`add-tool`) and the file path (`add-tool/SKILL.md`) both match.
 *
 * Diffing against `HEAD` keeps the per-release-cycle carve-out automatic: once the
 * version line is bumped, later commits in the same cycle no longer re-trigger.
 * Severity mirrors `check-skills-sync.ts` — exits 1, demoted to a warning by
 * devcheck. New skills (no `HEAD` version) and non-git trees are skipped.
 *
 * Runs standalone (`bun run scripts/check-skill-versions.ts`) and as a devcheck step.
 *
 * @module scripts/check-skill-versions
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve('.');
const SKILL_MD_RE = /^skills\/[^/]+\/SKILL\.md$/;

interface DevcheckConfig {
  skillVersions?: { ignore?: string[] };
}

function loadIgnorePatterns(): string[] {
  try {
    const cfg = JSON.parse(
      readFileSync(resolve(ROOT, 'devcheck.config.json'), 'utf-8'),
    ) as DevcheckConfig;
    return cfg.skillVersions?.ignore ?? [];
  } catch {
    return [];
  }
}

/** Match check-skills-sync semantics: full `<name>/SKILL.md` path or the bare `<name>`. */
function isIgnored(relPath: string, patterns: string[]): boolean {
  const name = relPath.split('/')[1]; // skills/<name>/SKILL.md → <name>
  return patterns.some(
    (p) => p === relPath || p === name || (name !== undefined && p === `${name}/SKILL.md`),
  );
}

/** Skill `SKILL.md` files that differ from `HEAD` (staged + unstaged). */
function changedSkillFiles(): string[] {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD', '--'], { encoding: 'utf-8' });
  if (result.status !== 0) return []; // not a git repo / no HEAD commit
  return result.stdout
    .trim()
    .split('\n')
    .filter((p) => SKILL_MD_RE.test(p));
}

/** Content of a path at `HEAD`, or null when it didn't exist there (new file). */
function headContent(relPath: string): string | null {
  const result = spawnSync('git', ['show', `HEAD:${relPath}`], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout : null;
}

/** `metadata.version` from skill frontmatter, or null when absent/unparseable. */
function extractVersion(content: string): string | null {
  const block = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!block) return null;
  const version = block.match(/^\s*version:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
  return version?.trim() ?? null;
}

/** Body = everything after the frontmatter block. */
function extractBody(content: string): string {
  const fm = content.match(/^---\n[\s\S]*?\n---/)?.[0];
  return fm ? content.slice(fm.length) : content;
}

/** Whitespace-insensitive comparison (`git diff -w` style). */
function bodiesDiffer(a: string, b: string): boolean {
  return a.replace(/\s+/g, '') !== b.replace(/\s+/g, '');
}

if (!existsSync(resolve(ROOT, 'skills'))) {
  console.log('Skipped: no skills/ directory.');
  process.exit(0);
}

const ignore = loadIgnorePatterns();
const changed = changedSkillFiles().filter((f) => !isIgnored(f, ignore));

const violations: { file: string; version: string }[] = [];
for (const file of changed) {
  const oldContent = headContent(file);
  if (oldContent === null) continue; // new skill — no prior version to compare
  if (!existsSync(resolve(ROOT, file))) continue; // deleted in worktree — no body to compare, can't violate
  const newContent = readFileSync(resolve(ROOT, file), 'utf-8');

  if (!bodiesDiffer(extractBody(oldContent), extractBody(newContent))) continue; // whitespace-only

  const oldVersion = extractVersion(oldContent);
  const newVersion = extractVersion(newContent);
  if (oldVersion !== null && oldVersion === newVersion) {
    violations.push({ file, version: oldVersion });
  }
}

if (violations.length === 0) {
  console.log('Skill versions are in step with body changes.');
  process.exit(0);
}

const lines = [
  `${violations.length} skill${violations.length === 1 ? '' : 's'} changed body without a metadata.version bump:`,
  '',
];
for (const v of violations) {
  lines.push(`  - ${v.file} body changed but metadata.version is still "${v.version}"`);
}
lines.push('');
lines.push('Fix: bump metadata.version in the SKILL.md frontmatter, or add the skill to');
lines.push('     devcheck.config.json `skillVersions.ignore` for the typo/whitespace carve-out.');
console.log(lines.join('\n'));
process.exit(1);

#!/usr/bin/env node
/**
 * @fileoverview Enforces the skill-versioning policy (#98 → #99): a change to a
 * `framework-skills/<name>/SKILL.md` body must bump `metadata.version` in the same edit.
 * Documenting the policy made the expectation visible; this check makes it stick.
 * The triggering incident was 7 missed bumps across 2 consecutive releases — the
 * kind of low-salience checklist item that needs tooling, not vigilance.
 *
 * For each `framework-skills/<name>/SKILL.md` that differs from `HEAD` (working tree, staged
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
 * In the framework repo, a skill whose version already moved since the last `v*`
 * release tag — or that is new since it — is covered: a later body edit in the
 * same cycle shares that bump instead of needing another.
 *
 * The inverse also holds: a skill moves at most one step per release. In the
 * framework repo itself, each skill's version is compared with its version at the
 * last `v*` release tag, and anything past the next minor (`1.4` → `1.5`) or the
 * next major (`1.4` → `2.0`) is a violation — repeated edits in one cycle share a
 * single bump. Consumer repos skip this: a skill sync can legitimately jump
 * several framework releases at once.
 *
 * Severity mirrors `check-skills-sync.ts` — exits 1, demoted to a warning by
 * devcheck. New skills (no prior version) and non-git trees are skipped.
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
const SKILL_MD_RE = /^framework-skills\/[^/]+\/SKILL\.md$/;
const FRAMEWORK_PACKAGE = '@cyanheads/mcp-ts-core';

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
  const name = relPath.split('/')[1]; // framework-skills/<name>/SKILL.md → <name>
  return patterns.some(
    (p) => p === relPath || p === name || (name !== undefined && p === `${name}/SKILL.md`),
  );
}

/** Skill `SKILL.md` files that differ from `ref` in the working tree (staged + unstaged). */
function changedSkillFiles(ref: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', ref, '--'], { encoding: 'utf-8' });
  if (result.status !== 0) return []; // not a git repo / no such ref
  return result.stdout
    .trim()
    .split('\n')
    .filter((p) => SKILL_MD_RE.test(p));
}

/**
 * Content of a path at `ref`, or null when it didn't exist there (new file).
 * A tree renamed from the pre-0.13 `skills/` reads its old copy from the old
 * path, so the release that carries the rename still checks every body edit.
 */
function contentAt(ref: string, relPath: string): string | null {
  const show = (p: string) => spawnSync('git', ['show', `${ref}:${p}`], { encoding: 'utf-8' });
  const result = show(relPath);
  if (result.status === 0) return result.stdout;
  const legacy = show(relPath.replace(/^framework-skills\//, 'skills/'));
  return legacy.status === 0 ? legacy.stdout : null;
}

/** True when this tree is the framework itself, where skill versions are authored. */
function isFrameworkRepo(): boolean {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as {
      name?: string;
    };
    return pkg.name === FRAMEWORK_PACKAGE;
  } catch {
    return false;
  }
}

/** The latest `v*` release tag reachable from `HEAD`, or null when there is none. */
function lastReleaseTag(): string | null {
  const result = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
    encoding: 'utf-8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** True when `to` is `from`, its next minor, or its next major at `.0`. */
function withinOneStep(from: string, to: string): boolean {
  const [fromMajor, fromMinor] = from.split('.').map(Number);
  const [toMajor, toMinor] = to.split('.').map(Number);
  if ([fromMajor, fromMinor, toMajor, toMinor].some((n) => n === undefined || Number.isNaN(n))) {
    return true; // not `X.Y` — out of this check's scope
  }
  if (from === to) return true;
  if (toMajor === fromMajor) return toMinor === (fromMinor as number) + 1;
  return toMajor === (fromMajor as number) + 1 && toMinor === 0;
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

if (!existsSync(resolve(ROOT, 'framework-skills'))) {
  console.log('Skipped: no framework-skills/ directory.');
  process.exit(0);
}

const ignore = loadIgnorePatterns();
const tag = isFrameworkRepo() ? lastReleaseTag() : null;

/**
 * True when the skill's current version already differs from its version at the
 * release tag — or the skill is new since it — so this cycle's one step is taken
 * and a further body edit shares it rather than needing another bump.
 */
function bumpedThisRelease(file: string, version: string | null): boolean {
  if (tag === null) return false;
  const released = contentAt(tag, file);
  if (released === null) return true;
  const releasedVersion = extractVersion(released);
  return releasedVersion !== null && releasedVersion !== version;
}

const missing: { file: string; version: string }[] = [];
for (const file of changedSkillFiles('HEAD').filter((f) => !isIgnored(f, ignore))) {
  const oldContent = contentAt('HEAD', file);
  if (oldContent === null) continue; // new skill — no prior version to compare
  if (!existsSync(resolve(ROOT, file))) continue; // deleted in worktree — no body to compare, can't violate
  const newContent = readFileSync(resolve(ROOT, file), 'utf-8');

  if (!bodiesDiffer(extractBody(oldContent), extractBody(newContent))) continue; // whitespace-only

  const oldVersion = extractVersion(oldContent);
  const newVersion = extractVersion(newContent);
  if (oldVersion !== null && oldVersion === newVersion && !bumpedThisRelease(file, newVersion)) {
    missing.push({ file, version: oldVersion });
  }
}

const overshot: { file: string; tag: string; released: string; version: string }[] = [];
if (tag !== null) {
  for (const file of changedSkillFiles(tag)) {
    const released = contentAt(tag, file);
    if (released === null || !existsSync(resolve(ROOT, file))) continue;
    const releasedVersion = extractVersion(released);
    const version = extractVersion(readFileSync(resolve(ROOT, file), 'utf-8'));
    if (releasedVersion === null || version === null) continue;
    if (!withinOneStep(releasedVersion, version)) {
      overshot.push({ file, tag, released: releasedVersion, version });
    }
  }
}

const count = missing.length + overshot.length;
if (count === 0) {
  console.log('Skill versions are in step with body changes.');
  process.exit(0);
}

const lines = [
  `${count} skill${count === 1 ? '' : 's'} out of step with the versioning policy:`,
  '',
];
for (const v of missing) {
  lines.push(`  - ${v.file} body changed but metadata.version is still "${v.version}"`);
}
for (const v of overshot) {
  lines.push(
    `  - ${v.file} is "${v.version}", more than one step past "${v.released}" at ${v.tag}`,
  );
}
lines.push('');
if (missing.length > 0) {
  lines.push('Fix: bump metadata.version in the SKILL.md frontmatter, or add the skill to');
  lines.push('     devcheck.config.json `skillVersions.ignore` for the typo/whitespace carve-out.');
}
if (overshot.length > 0) {
  lines.push('Fix: set metadata.version to one step past the release tag — edits in one');
  lines.push('     release cycle share a single bump.');
}
console.log(lines.join('\n'));
process.exit(1);

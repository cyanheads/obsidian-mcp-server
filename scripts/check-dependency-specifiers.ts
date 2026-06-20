#!/usr/bin/env node
/**
 * @fileoverview Rejects floating dependency specifiers — `latest`, `*`, and
 * pre-release dist-tags (`next`/`beta`/`canary`/`rc`) — in the manifests we
 * control: `package.json`'s dependency sections and `bun.lock`'s `workspaces`
 * specifier maps. `bun update --latest` bumps `package.json` to a caret range
 * but writes the literal `latest` dist-tag into the lock's workspace map; the
 * concrete resolution is correct at write time, so it clears every other gate
 * and ships unnoticed, letting the next `bun install` re-resolve the dep past
 * the `package.json` range and past any intentional version hold (#246).
 *
 * Section-specific rules — `peer`/`optional` may legitimately float to "any
 * host version", so `*` and dist-tags are allowed there; `latest` never is:
 *
 *   | specifier                 | dependencies / devDependencies | peer / optional |
 *   |---------------------------|:------------------------------:|:---------------:|
 *   | latest                    | fail                           | fail            |
 *   | *                         | fail                           | allow           |
 *   | next / beta / canary / rc | fail                           | allow           |
 *
 * Only the `workspaces` section of `bun.lock` is inspected — the `packages`
 * section records third-party packages' own nested declarations, which can
 * legitimately be `latest`/`*` (e.g. a vendored `"@edge-runtime/vm": "*"`), so
 * a naive whole-file grep false-positives on those. The lock is JSONC (trailing
 * commas), so it is normalized before parsing.
 *
 * Shipped to consumers via `package.json` `files:` because `devcheck` invokes
 * it. Runs standalone (`bun run scripts/check-dependency-specifiers.ts`) and as
 * a devcheck step; no network, no git — runs in the default and `--fast` passes.
 *
 * @module scripts/check-dependency-specifiers
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve('.');

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
type DepSection = (typeof DEP_SECTIONS)[number];

/** Sections where a host project legitimately accepts "any version" (`*`/dist-tag). */
const HOST_SECTIONS = new Set<DepSection>(['peerDependencies', 'optionalDependencies']);

/** Pre-release dist-tags that float like `latest`, narrower in reach. */
const FLOATING_DIST_TAGS = new Set(['next', 'beta', 'canary', 'rc']);

interface Offender {
  location: string;
  name: string;
  specifier: string;
}

type DepMap = Record<string, string>;
type SectionedManifest = Partial<Record<DepSection, DepMap>>;

/** A specifier floats if it can re-resolve to a different version over time. */
function isFloating(specifier: string, section: DepSection): boolean {
  const spec = specifier.trim();
  if (spec === 'latest') return true; // never reproducible, in any section
  if (HOST_SECTIONS.has(section)) return false; // `*` / dist-tags are legitimate here
  return spec === '*' || FLOATING_DIST_TAGS.has(spec);
}

/** Scan the four dependency sections of one manifest object. */
function scanManifest(manifest: SectionedManifest, label: string): Offender[] {
  const offenders: Offender[] = [];
  for (const section of DEP_SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (typeof specifier === 'string' && isFloating(specifier, section)) {
        offenders.push({ name, specifier, location: `${label} ${section}` });
      }
    }
  }
  return offenders;
}

/**
 * Minimal JSONC → object parse: strips `//` and block comments and trailing
 * commas while preserving string contents verbatim, then `JSON.parse`s.
 * `bun.lock` is emitted with trailing commas, which strict `JSON.parse` rejects.
 */
function parseJsonc<T>(text: string): T {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === '"') {
      // Copy a string literal verbatim, honoring escapes.
      out += ch;
      i++;
      while (i < n) {
        const c = text[i] as string;
        out += c;
        if (c === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === ',') {
      // Drop the comma when the next significant char closes an object/array.
      let j = i + 1;
      while (j < n && /\s/.test(text[j] as string)) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return JSON.parse(out) as T;
}

const offenders: Offender[] = [];

// ── package.json (all four dependency sections) ──
const pkgPath = resolve(ROOT, 'package.json');
if (existsSync(pkgPath)) {
  try {
    offenders.push(
      ...scanManifest(
        JSON.parse(readFileSync(pkgPath, 'utf-8')) as SectionedManifest,
        'package.json',
      ),
    );
  } catch (err) {
    console.error(`Failed to parse package.json: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

// ── bun.lock (workspaces specifier maps only — never the `packages` section) ──
const lockPath = resolve(ROOT, 'bun.lock');
if (existsSync(lockPath)) {
  try {
    const lock = parseJsonc<{ workspaces?: Record<string, SectionedManifest> }>(
      readFileSync(lockPath, 'utf-8'),
    );
    for (const [ws, manifest] of Object.entries(lock.workspaces ?? {})) {
      const label = ws === '' ? 'bun.lock workspaces[root]' : `bun.lock workspaces["${ws}"]`;
      offenders.push(...scanManifest(manifest, label));
    }
  } catch (err) {
    console.error(`Failed to parse bun.lock: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

if (offenders.length === 0) {
  console.log('No floating dependency specifiers found.');
  process.exit(0);
}

const lines = [
  `${offenders.length} floating dependency specifier(s) found:`,
  '',
  ...offenders.map((o) => `  - ${o.name} → ${o.specifier} (${o.location})`),
  '',
  'Fix: pin to a concrete semver range (e.g. ^1.2.3). A `latest`/`*`/dist-tag',
  'specifier lets `bun install` re-resolve the dep past the package.json range',
  'and past any intentional hold. After `bun update --latest`, run a plain',
  '`bun install` to reconcile bun.lock to the package.json ranges.',
];
console.error(lines.join('\n'));
process.exit(1);

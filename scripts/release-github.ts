#!/usr/bin/env node
/**
 * @fileoverview Create (or repair) a GitHub Release on the current package version's
 * annotated tag, enforcing the `v<VERSION>: <tag subject>` title format that
 * `--notes-from-tag` alone cannot set.
 *
 * What it does:
 *   1. Reads `version` from `package.json`.
 *   2. Derives the tag subject via `git for-each-ref refs/tags/v<version>`.
 *   3. Runs `gh release create v<version> --verify-tag --notes-from-tag
 *         --title "v<version>: <subject>"` plus `dist/*.mcpb` when
 *      `manifest.json` exists (MCPB bundle attach).
 *   4. On "release already exists" (re-invocation after partial run):
 *      - If `manifest.json` exists: `gh release upload v<version> --clobber dist/*.mcpb`
 *        to attach/replace the asset, then `gh release edit` to set the title.
 *      - Otherwise: `gh release edit` to set the title on the existing release.
 *
 * The framework itself has no `manifest.json`/`.mcpb`, so the attach path is
 * skipped here but scaffolded servers that do have a manifest get the full flow.
 *
 * Before any `gh` call it validates the tag — `--notes-from-tag` publishes the
 * message verbatim as the release body, so a malformed tag becomes a malformed
 * public release. `--check` runs only that validation, for use right after
 * `git tag -a` and before the tag is pushed. The rules are the ones the
 * `release-and-publish` skill states for the annotation: an annotated tag, a
 * subject of at most 72 characters with no version and no `;`, flat bullets
 * with no section headers, no signature block leaked into the body, and the
 * `[CHANGELOG v<version>](…)` link as the final line.
 *
 * @module scripts/release-github
 *
 * @example
 * // Create a GitHub Release for the current package version:
 * // bun run release:github
 *
 * @example
 * // Validate the tag annotation only (exit 1 on a violation, no gh calls):
 * // bun run release:github -- --check
 *
 * @example
 * // Dry-run — print the command that would be executed without running it:
 * // bun run release:github -- --dry-run
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.argv.includes('--dry-run');
const CHECK_ONLY = process.argv.includes('--check');

/** A tag subject longer than this reads as a digest, not a release title. */
const MAX_SUBJECT_LENGTH = 72;

/**
 * Section headers belong in the changelog entry, never in the tag body: a
 * markdown heading, a Keep a Changelog section name, or any other line that is
 * not a bullet and ends in a colon (`Dependency bumps:`, `Highlights:`).
 */
const SECTION_HEADER =
  /^(?:#{1,6}\s.*|(?:Added|Changed|Deprecated|Removed|Fixed|Security|Dependencies)\s*:?|[^\s\-*+[].*:)$/;

/** The parts of an annotated tag that become the GitHub Release title and body. */
export interface TagMessage {
  body: string;
  /** `git for-each-ref %(objecttype)` — `tag` for an annotated tag, `commit` for a lightweight one. */
  objectType: string;
  subject: string;
}

/**
 * Validates a tag annotation against the release-body rules. Returns one
 * message per violation; an empty array means the tag is publishable.
 */
export function checkTagMessage(tag: TagMessage, version: string): string[] {
  if (tag.objectType !== 'tag') {
    return [
      `v${version} is a lightweight tag — recreate it annotated: git tag -a v${version} -F <file>`,
    ];
  }

  const errors: string[] = [];
  const { subject } = tag;
  if (subject.length > MAX_SUBJECT_LENGTH) {
    errors.push(
      `subject is ${subject.length} characters — keep it one short theme (≤${MAX_SUBJECT_LENGTH}); the bullets carry the digest`,
    );
  }
  if (subject.includes(version)) {
    errors.push(
      `subject contains the version "${version}" — GitHub prepends "v${version}:" to the title`,
    );
  }
  if (subject.includes(';')) {
    errors.push('subject contains ";" — one theme, not a list of changes');
  }

  if (tag.body.includes('-----BEGIN')) {
    errors.push(
      'body contains a signature block — the signature did not parse (usually --cleanup=verbatim); recreate the tag with --cleanup=whitespace before it is pushed',
    );
  }

  const lines = tag.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const headers = lines.filter((line) => SECTION_HEADER.test(line));
  if (headers.length > 0) {
    errors.push(
      `body has section headers (${headers.map((h) => `"${h}"`).join(', ')}) — flat bullets only; sections belong in the changelog entry`,
    );
  }

  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const changelogLink = new RegExp(
    `^\\[CHANGELOG v${escaped}\\]\\(\\S+/changelog/\\d+\\.\\d+\\.x/${escaped}\\.md\\)`,
  );
  if (!changelogLink.test(lines.at(-1) ?? '')) {
    errors.push(
      `final line is not the changelog link — end the body with "[CHANGELOG v${version}](https://github.com/<OWNER>/<REPO>/blob/main/changelog/<major.minor>.x/${version}.md)"`,
    );
  }

  return errors;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run a command synchronously and return its trimmed stdout.
 * Exits the process on non-zero exit when `required` is true.
 */
function run(
  cmd: string,
  args: string[],
  options: { required?: boolean; capture?: boolean } = {},
): string {
  const { required = true, capture = true } = options;
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'pipe'],
  });
  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();

  if (result.error) {
    console.error(`Failed to spawn '${cmd}': ${result.error.message}`);
    if (required) process.exit(1);
    return '';
  }

  if ((result.status ?? 1) !== 0) {
    if (required) {
      console.error(`Command failed: ${cmd} ${args.join(' ')}`);
      if (stderr) console.error(stderr);
      process.exit(1);
    }
    // Return stderr concatenated so callers can inspect the failure reason.
    return `__ERROR__:${stderr}`;
  }

  return stdout;
}

/**
 * Run a `gh` CLI command.
 * On "release already exists" the return value starts with `__ERROR__:`.
 */
function gh(args: string[], options: { required?: boolean } = {}): string {
  return run('gh', args, { required: options.required ?? true, capture: true });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  // 1. Read version from package.json
  const pkgPath = resolve('package.json');
  if (!existsSync(pkgPath)) {
    console.error('package.json not found in current directory. Run from the project root.');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
  const version = pkg.version?.trim();
  if (!version) {
    console.error('package.json has no version field.');
    process.exit(1);
  }

  const tag = `v${version}`;

  // 2. Derive tag subject via git for-each-ref
  const subject = run('git', ['for-each-ref', `refs/tags/${tag}`, '--format=%(contents:subject)']);

  if (!subject) {
    console.error(
      `Tag ${tag} not found locally or has no subject line. ` +
        `Create the annotated tag first: git tag -a ${tag} -F <file>`,
    );
    process.exit(1);
  }

  // 3. Validate the annotation — it becomes the public release body verbatim
  const errors = checkTagMessage(
    {
      subject,
      body: run('git', ['for-each-ref', `refs/tags/${tag}`, '--format=%(contents:body)']),
      objectType: run('git', ['for-each-ref', `refs/tags/${tag}`, '--format=%(objecttype)']),
    },
    version,
  );
  if (errors.length > 0) {
    console.error(`Tag ${tag} is not publishable:`);
    for (const error of errors) console.error(`  ✗ ${error}`);
    process.exit(1);
  }
  if (CHECK_ONLY) {
    console.log(`Tag ${tag} OK.`);
    return;
  }

  const title = `${tag}: ${subject}`;
  const hasMcpb = existsSync('manifest.json');

  // 4. Build the gh release create command
  const createArgs = [
    'release',
    'create',
    tag,
    '--verify-tag',
    '--notes-from-tag',
    '--title',
    title,
  ];
  if (hasMcpb) {
    createArgs.push('dist/*.mcpb');
  }

  if (DRY_RUN) {
    console.log(`[dry-run] gh ${createArgs.join(' ')}`);
    if (hasMcpb) {
      console.log(
        `[dry-run] fallback (if release exists): gh release upload ${tag} dist/*.mcpb --clobber`,
      );
      console.log(
        `[dry-run] fallback (if release exists): gh release edit ${tag} --title "${title}"`,
      );
    } else {
      console.log(
        `[dry-run] fallback (if release exists): gh release edit ${tag} --title "${title}"`,
      );
    }
    return;
  }

  console.log(`Creating GitHub Release ${tag}…`);
  console.log(`  title: ${title}`);
  if (hasMcpb) {
    console.log('  asset: dist/*.mcpb');
  }

  // 5. Try to create the release
  const createResult = gh(createArgs, { required: false });

  if (!createResult.startsWith('__ERROR__:')) {
    // Success — print the release URL returned by gh
    if (createResult) console.log(createResult);
    console.log(`Release ${tag} created.`);
    return;
  }

  const errText = createResult.slice('__ERROR__:'.length);
  const alreadyExists = /release already exists/i.test(errText);

  if (!alreadyExists) {
    console.error(`gh release create failed:\n${errText}`);
    process.exit(1);
  }

  // 6. Release already exists — repair: upload asset (if applicable) and set title.
  console.log(`Release ${tag} already exists. Repairing…`);

  if (hasMcpb) {
    console.log('  uploading dist/*.mcpb (--clobber)…');
    gh(['release', 'upload', tag, 'dist/*.mcpb', '--clobber']);
  }

  console.log(`  setting title: ${title}`);
  gh(['release', 'edit', tag, '--title', title]);

  console.log(`Release ${tag} repaired.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

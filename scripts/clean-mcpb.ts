#!/usr/bin/env node
/**
 * @fileoverview Post-pack MCPB bundle cleaner. Runs after `mcpb pack` (wired
 * into the `bundle` package script) to remove bundle content the pack step
 * cannot exclude:
 *
 *   1. `mcpb clean <bundle>` — official dev-dependency prune + manifest
 *      validation (a measured real-world bundle dropped 61 MB → 12.9 MB).
 *   2. Exact-name strip of two entry classes nested under `node_modules/`,
 *      which root-anchored `.mcpbignore` patterns cannot reach by design
 *      (issues #146/#207):
 *        a. Dependency-shipped agent docs — `skills/`, `.claude/`, `.agents/`
 *           trees and stray `SKILL.md` files (issue #230).
 *        b. Platform-specific native bindings, which would otherwise lock the
 *           bundle to the build host's platform and push it past the 25 MB cap
 *           registries enforce (issue #274).
 *   3. Re-list and assert zero matching entries remain.
 *
 * Entry names are passed to `zip -d` with `-nw` (no-wildcard) so they match
 * literally — bracketed runtime filenames like `pages/[slug].js` exist in
 * real packages and must not glob. Bundles are unsigned in this flow; if
 * `mcpb sign` is ever adopted, this script must run before signing.
 *
 * Usage: `bun run scripts/clean-mcpb.ts dist/<name>.mcpb`
 *
 * @module scripts/clean-mcpb
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Agent-doc entries under `node_modules/` that must not ship in a bundle.
 * KEEP IN SYNC with `AGENT_DOC_ENTRY` in `scripts/lint-packaging.ts`
 * (post-bundle content check) — a unit test asserts the two are identical.
 */
export const AGENT_DOC_ENTRY =
  /^node_modules\/.*(?:\/skills\/|\/\.claude\/|\/\.agents\/|\/SKILL\.md$)/;

/**
 * Platform-specific native binding packages, which must not ship in a bundle.
 * KEEP IN SYNC with `NATIVE_BINDING_ENTRY` in `scripts/lint-packaging.ts`
 * (post-bundle content check) — a unit test asserts the two are identical.
 *
 * `mcpb pack` archives the whole project directory, so a native dependency
 * contributes the build host's platform slice and nothing else — for
 * `@duckdb/node-api` that is a ~108 MB `libduckdb` shared library. The bundle
 * then runs only on the platform it was packed on, contradicting the
 * cross-platform "Install in Claude Desktop" badge, and blows past the 25 MB
 * cap registries enforce. Stripping them keeps the bundle portable and small;
 * DuckDB is an optional peer loaded through `lazyImport`, so a server whose
 * canvas is disabled (`CANVAS_PROVIDER_TYPE=none`, the default) is unaffected
 * and one that enables it gets the helper's actionable install hint.
 */
export const NATIVE_BINDING_ENTRY = /^node_modules\/@duckdb\/node-bindings-[^/]+\//;

/** Filter a bundle entry listing down to the agent-doc entries to strip. */
export function filterAgentDocEntries(entries: string[]): string[] {
  return entries.filter((entry) => AGENT_DOC_ENTRY.test(entry));
}

/** Filter a bundle entry listing down to the native-binding entries to strip. */
export function filterNativeBindingEntries(entries: string[]): string[] {
  return entries.filter((entry) => NATIVE_BINDING_ENTRY.test(entry));
}

/** Listing a 12k-entry bundle exceeds execFileSync's 1 MB default buffer. */
const MAX_LIST_BUFFER = 64 * 1024 * 1024;

/** `zip -d` argv batch size — stays clear of ARG_MAX with long entry names. */
const DELETE_BATCH = 200;

function listEntries(bundle: string): string[] {
  return execFileSync('unzip', ['-Z1', bundle], { encoding: 'utf-8', maxBuffer: MAX_LIST_BUFFER })
    .split('\n')
    .filter((line) => line.length > 0);
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function main(): void {
  const bundleArg = process.argv[2];
  if (!bundleArg) {
    console.error('Usage: clean-mcpb.ts <bundle.mcpb> — run after `mcpb pack`.');
    process.exit(1);
  }
  const bundle = resolve(bundleArg);
  if (!existsSync(bundle)) {
    console.error(`No bundle at ${bundle} — run \`mcpb pack\` first (see the \`bundle\` script).`);
    process.exit(1);
  }

  const sizeBefore = statSync(bundle).size;

  // 1. Official prune: removes dev dependencies, validates the manifest.
  try {
    run('npx', ['-y', '@anthropic-ai/mcpb', 'clean', bundle]);
  } catch {
    console.error('✗ `mcpb clean` failed — bundle left as packed.');
    process.exit(1);
  }

  // 2. Exact-name strip of dependency-shipped agent docs and platform natives.
  let agentDocs: string[] = [];
  let natives: string[] = [];
  try {
    const entries = listEntries(bundle);
    agentDocs = filterAgentDocEntries(entries);
    natives = filterNativeBindingEntries(entries);
    const doomed = [...agentDocs, ...natives];
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      run('zip', ['-q', '-d', '-nw', bundle, ...doomed.slice(i, i + DELETE_BATCH)]);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('✗ Info-ZIP `zip`/`unzip` not found on PATH — required for the strip step.');
    } else {
      console.error(`✗ Bundle strip failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }

  // 3. Verify: zero matching entries remain in either class.
  const remainingEntries = listEntries(bundle);
  const remaining = [
    ...filterAgentDocEntries(remainingEntries),
    ...filterNativeBindingEntries(remainingEntries),
  ];
  if (remaining.length > 0) {
    console.error(`✗ ${remaining.length} entries still present after strip, e.g.:`);
    for (const entry of remaining.slice(0, 5)) console.error(`    ${entry}`);
    process.exit(1);
  }

  const sizeAfter = statSync(bundle).size;
  console.log(
    `Bundle cleaned: ${mb(sizeBefore)} → ${mb(sizeAfter)} ` +
      `(${agentDocs.length} agent-doc, ${natives.length} native-binding entries stripped).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

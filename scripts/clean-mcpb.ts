#!/usr/bin/env node
/**
 * @fileoverview Post-pack MCPB bundle cleaner. Runs after `mcpb pack` (wired
 * into the `bundle` package script) to remove bundle content the pack step
 * cannot exclude:
 *
 *   1. `mcpb clean <bundle>` — official dev-dependency prune + manifest
 *      validation (a measured real-world bundle dropped 61 MB → 12.9 MB).
 *   2. Exact-name strip of four entry classes nested under `node_modules/`,
 *      which root-anchored `.mcpbignore` patterns cannot reach by design
 *      (issues #146/#207):
 *        a. Dependency-shipped agent docs — `framework-skills/`, `skills/`,
 *           `.claude/`, `.agents/` trees and stray `SKILL.md` files (issue #230).
 *        b. Platform-specific native bindings, which would otherwise lock the
 *           bundle to the build host's platform and push it past the 25 MB cap
 *           registries enforce (issue #274).
 *        c. node-gyp build output beside a `binding.gyp` — generator files,
 *           intermediate trees, and link inputs, which record the packing
 *           host's paths; compiled `*.node` addons stay (issue #783).
 *        d. Build-only package files — mcp-ts-core's `changelog/`, `config/`,
 *           `scripts/`, `templates/`, `CLAUDE.md`, `AGENTS.md`, `biome.json`,
 *           and `vitest.config.base.mjs`, and better-sqlite3's `deps/` and
 *           `src/` C sources (issue #791).
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
 * (post-bundle content check) — edit both literals together. The assertion that
 * they match lives in the mcp-ts-core repository's own test suite; `tests/` is
 * not part of the published package, so nothing enforces the pair in a server
 * these scripts were copied into.
 */
export const AGENT_DOC_ENTRY =
  /^node_modules\/.*(?:\/framework-skills\/|\/skills\/|\/\.claude\/|\/\.agents\/|\/SKILL\.md$)/;

/**
 * Platform-specific native binding packages, which must not ship in a bundle.
 * KEEP IN SYNC with `NATIVE_BINDING_ENTRY` in `scripts/lint-packaging.ts`
 * (post-bundle content check) — edit both literals together. The assertion that
 * they match lives in the mcp-ts-core repository's own test suite; `tests/` is
 * not part of the published package, so nothing enforces the pair in a server
 * these scripts were copied into.
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

/**
 * node-gyp output, matched against an entry's path below a `build/` directory
 * that has a sibling `binding.gyp` (see `filterNodeGypBuildEntries`).
 * KEEP IN SYNC with `NODE_GYP_OUTPUT` and `filterNodeGypBuildEntries` in
 * `scripts/lint-packaging.ts` (post-bundle content check) — edit both together.
 * The assertion that they select the same entries lives in the mcp-ts-core
 * repository's own test suite; `tests/` is not part of the published package,
 * so nothing enforces the pair in a server these scripts were copied into.
 *
 * Generator files (`config.gypi` records the packing host's node-gyp cache as
 * `nodedir`; `Makefile` records the checkout path), MSBuild projects,
 * `gyp-*-tool`, the `obj.target/`, `obj/`, `.deps/`, and `node_gyp_bins/`
 * intermediate trees, and link inputs and debug symbols. None is loaded at
 * runtime. Everything else under `build/` ships, so a compiled `*.node` addon
 * (loaders search `build/`, `build/Debug/`, and `build/Release/`) and any
 * shared library beside it survive.
 */
export const NODE_GYP_OUTPUT =
  /(?:^|\/)(?:(?:obj\.target|obj|\.deps|node_gyp_bins)\/|(?:config\.gypi|Makefile|gyp-mac-tool|gyp-flock-tool|[^/]+\.(?:Makefile|mk|sln|vcxproj|vcxproj\.filters|a|o|lib|obj|exp|pdb|ilk|iobj|ipdb))$)/;

/**
 * Build-only package files that must not ship in a bundle.
 * KEEP IN SYNC with `BUILD_ONLY_ENTRY` in `scripts/lint-packaging.ts`
 * (post-bundle content check) — edit both literals together. The assertion that
 * they match lives in the mcp-ts-core repository's own test suite; `tests/` is
 * not part of the published package, so nothing enforces the pair in a server
 * these scripts were copied into.
 *
 * mcp-ts-core publishes `changelog/`, `scripts/`, `templates/`, `CLAUDE.md`,
 * and `AGENTS.md` for `init`, maintenance, and agents editing a server's
 * source, and the config bases a server's own tooling extends — `biome.json`,
 * `vitest.config.base.mjs`, and `config/tsconfig.base.json`, the only file in
 * `config/`. The running server reads none of them (its `framework-skills/`
 * is an agent-doc entry). better-sqlite3 publishes its `deps/` and `src/` C
 * sources for a source build; at runtime it loads a prebuilt or compiled addon.
 */
export const BUILD_ONLY_ENTRY =
  /^node_modules\/(?:.+\/node_modules\/)?(?:@cyanheads\/mcp-ts-core\/(?:(?:changelog|config|scripts|templates)\/|(?:(?:CLAUDE|AGENTS)\.md|biome\.json|vitest\.config\.base\.mjs)$)|better-sqlite3\/(?:deps|src)\/)/;

/** Filter a bundle entry listing down to the agent-doc entries to strip. */
export function filterAgentDocEntries(entries: string[]): string[] {
  return entries.filter((entry) => AGENT_DOC_ENTRY.test(entry));
}

/** Filter a bundle entry listing down to the native-binding entries to strip. */
export function filterNativeBindingEntries(entries: string[]): string[] {
  return entries.filter((entry) => NATIVE_BINDING_ENTRY.test(entry));
}

/**
 * Filter a bundle entry listing down to the node-gyp output to strip: entries
 * under `<dir>/build/` matching `NODE_GYP_OUTPUT`, for each `<dir>/binding.gyp`
 * in the listing. A `build/` with no sibling `binding.gyp` is never touched —
 * `@opentelemetry/semantic-conventions/build/src/` is a runtime entry.
 * KEEP IN SYNC with `filterNodeGypBuildEntries` in `scripts/lint-packaging.ts`.
 */
export function filterNodeGypBuildEntries(entries: string[]): string[] {
  const buildDirs = entries
    .filter((entry) => /(?:^|\/)binding\.gyp$/.test(entry))
    .map((entry) => `${entry.slice(0, -'binding.gyp'.length)}build/`);
  return entries.filter((entry) =>
    buildDirs.some((dir) => entry.startsWith(dir) && NODE_GYP_OUTPUT.test(entry.slice(dir.length))),
  );
}

/** Filter a bundle entry listing down to the build-only package files to strip. */
export function filterBuildOnlyEntries(entries: string[]): string[] {
  return entries.filter((entry) => BUILD_ONLY_ENTRY.test(entry));
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

  // 2. Exact-name strip of agent docs, platform natives, node-gyp output, and build-only files.
  let agentDocs: string[] = [];
  let natives: string[] = [];
  let nodeGyp: string[] = [];
  let buildOnly: string[] = [];
  try {
    const entries = listEntries(bundle);
    agentDocs = filterAgentDocEntries(entries);
    natives = filterNativeBindingEntries(entries);
    nodeGyp = filterNodeGypBuildEntries(entries);
    buildOnly = filterBuildOnlyEntries(entries);
    // An entry in two classes is named once: a `zip -d` batch naming only deleted entries exits 12.
    const doomed = [...new Set([...agentDocs, ...natives, ...nodeGyp, ...buildOnly])];
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

  // 3. Verify: zero matching entries remain in any class.
  const remainingEntries = listEntries(bundle);
  const remaining = [
    ...filterAgentDocEntries(remainingEntries),
    ...filterNativeBindingEntries(remainingEntries),
    ...filterNodeGypBuildEntries(remainingEntries),
    ...filterBuildOnlyEntries(remainingEntries),
  ];
  if (remaining.length > 0) {
    console.error(`✗ ${remaining.length} entries still present after strip, e.g.:`);
    for (const entry of remaining.slice(0, 5)) console.error(`    ${entry}`);
    process.exit(1);
  }

  const sizeAfter = statSync(bundle).size;
  console.log(
    `Bundle cleaned: ${mb(sizeBefore)} → ${mb(sizeAfter)} ` +
      `(${agentDocs.length} agent-doc, ${natives.length} native-binding, ${nodeGyp.length} node-gyp build, ` +
      `${buildOnly.length} build-only entries stripped).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

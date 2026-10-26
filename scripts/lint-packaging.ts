#!/usr/bin/env node
/**
 * @fileoverview MCPB packaging linter — validates env var alignment between
 * `manifest.json` (MCPB bundle install UX) and `server.json` (MCP Registry
 * discovery) for stdio packages, and guards against bundle-content and
 * identity mistakes.
 *
 * Used by devcheck and as a standalone script: `bun run lint:packaging` /
 * `npm run lint:packaging`.
 *
 * Checks:
 *   1. Manifest `name` must not contain a scope prefix (`@scope/`).
 *   2. Every `user_config` entry must include `title` and `type` fields.
 *   3. Every `${user_config.X}` reference in manifest `mcp_config.env` must
 *      appear in server.json stdio `environmentVariables[]` (the registry
 *      advertises the configurable knob the bundle surfaces).
 *   4. Every required stdio env var in server.json (no default) must appear
 *      as a key in manifest `mcp_config.env` (the bundle can receive it).
 *   5. Bundle-content guard: `.mcpbignore` must exclude every known root dev
 *      directory (`KNOWN_DEV_DIRS`) and dev file (`KNOWN_DEV_FILES`), whether
 *      or not the path exists yet — `mcpb pack` reads `.mcpbignore`, not
 *      `.gitignore`, so source, tests, agent docs, and gitignored local files
 *      ship otherwise. Each error names the anchored line to add (issue #508).
 *      Root `skills/` is never required: it holds skills the server publishes.
 *   6. Bundle-content guard: `.mcpbignore` must not use unanchored patterns
 *      for root dev dirs or files — an unanchored `docs/` or `CLAUDE.md` also
 *      strips `node_modules/x/docs/` and `node_modules/x/CLAUDE.md` (runtime
 *      path bypass, issues #172/#207).
 *   7. Bundle-content guard: `.mcpbignore` patterns must not strip critical
 *      runtime package paths (e.g. `node_modules/@opentelemetry/api/dist/`).
 *   8. Post-bundle content: a built `.mcpb` under `dist/` must contain zero
 *      entries of the classes `scripts/clean-mcpb.ts` strips at bundle time,
 *      all nested under `node_modules/` where root-anchored `.mcpbignore`
 *      patterns cannot reach: dependency-shipped agent docs (`framework-skills/`,
 *      `skills/`, `.claude/`, `.agents/`, `SKILL.md`; issue #230), platform-specific
 *      native bindings (issue #274), node-gyp build output beside a `binding.gyp`
 *      (issue #783), and build-only package files — mcp-ts-core's `changelog/`,
 *      `config/`, `scripts/`, `templates/`, `CLAUDE.md`, `AGENTS.md`,
 *      `biome.json`, `vitest.config.base.mjs`, better-sqlite3's `deps/` and
 *      `src/` (issue #791). Each class reports its count and a sample.
 *   9. Identity: `name`/`title` literals in `createApp()` /
 *      `createWorkerHandler()` (src/index.ts, src/worker.ts) and manifest
 *      `display_name` must equal the unscoped package name; a partial
 *      `name`/`title` pair warns without failing (issue #231).
 *  10. Plugin marketplace manifests (`.claude-plugin/plugin.json`,
 *      `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`): non-empty
 *      descriptions, and identity/install correctness — display fields
 *      (`name`, server key, `interface.displayName`) carry the unscoped machine
 *      name while the `npx -y` install arg carries the full `package.json`
 *      name (scoped if scoped). An unscoped install arg for a scoped package
 *      is a guaranteed install 404. Each present plugin manifest's `version`
 *      must equal `package.json`'s, so a release cannot ship stale plugin
 *      metadata (issue #393); `.codex-plugin/mcp.json` is connection config and
 *      carries no version. No server `env` value may be the empty string: the
 *      client sets it on the child process, so the placeholder replaces a key
 *      the user exported and the framework then reads it as unset. Claude Code
 *      takes user values through `userConfig` + `${user_config.<key>}` (every
 *      reference must be declared); Codex forwards host variables named in
 *      `env_vars`. Gated by `devcheck.config.json` `packaging.pluginManifests`
 *      (default on); each manifest is skipped cleanly when absent (issue #240).
 *      The Agent Plugins 1.0.0 root pair (`plugin.json` + `mcp.json`) is
 *      checked when root `plugin.json` is present. Codex, Cursor, and the
 *      other Agent Plugins clients reject the whole plugin when that manifest
 *      breaks its schema, and load MCP servers only from root `mcp.json`. So
 *      `plugin.json` must carry the 1.0.0 `$schema`, only the closed set of
 *      top-level fields (`extensions` included, which would replace the
 *      overlay's `interface` in Codex), a §5.5 `name` equal to the unscoped
 *      package name, a non-empty `description`, and the package version, and
 *      needs `mcp.json` beside it. `mcp.json` must carry the 1.0.0 `$schema`
 *      and closed stdio entries keyed by the unscoped name (bare `command`,
 *      full package name as install arg) whose `env` holds fixed values only
 *      — no `""`, no `PLUGIN_ROOT`/`PLUGIN_DATA` key, no `${…}` besides those
 *      two — and equals `.codex-plugin/mcp.json`'s `env`. Codex ≥ 0.150.0
 *      merges the overlay's `env_vars` into the root entry only through
 *      `.codex-plugin/plugin.json` `"mcpServers": "./.codex-plugin/mcp.json"`,
 *      so a missing overlay or pointer drops every forwarded variable without
 *      an error. A root `mcp.json` without root `plugin.json` is a
 *      client-config sample and is not checked (issue #426).
 *  11. MCPB `user_config` wiring: every declared option is referenced from
 *      `mcp_config` as `${user_config.<key>}`, every reference is declared,
 *      `mcp_config` carries no other `${…}` placeholder besides the host's
 *      path variables (the host delivers anything else as the literal string),
 *      and an optional string option has `"default": ""` so a blank answer
 *      arrives as empty rather than as the unsubstituted placeholder.
 *  12. README version badge parity: a shields.io `Version-<semver>-` badge in
 *      `README.md` must carry the `package.json` `version`. The badge is the
 *      package's headline version on GitHub and npmjs.com and ships in the
 *      tarball, so a half-finished bump is publicly visible. Skipped when the
 *      README, the badge, or the package version is absent (issue #418).
 *  13. npm `files` excludes the built bundle: when `manifest.json` exists and
 *      `package.json` `files` covers `dist/` wholesale, it must also carry
 *      `"!dist/*.mcpb"`. The `bundle` script writes the `.mcpb` into `dist/`,
 *      so without the entry a release that bundles before publishing ships the
 *      server and its production dependencies inside the npm tarball
 *      (issue #469). Skipped when `manifest.json` or `files` is absent.
 *  14. manifest.json version parity: `version` must equal `package.json`'s, the
 *      same rule check 10 applies to the plugin manifests — the bundle's install
 *      dialog shows it. Skipped when `manifest.json` or the package version is
 *      absent.
 *  15. Dockerfile build platform: a stage that does not start
 *      `FROM --platform=$BUILDPLATFORM` must not run JavaScript while it
 *      builds — no `RUN` invoking `bun` for anything but `install`/`add`
 *      (`bun run build`, `bun -e`, a script, `bunx`), and no `bun install`/
 *      `bun add` once `bunfig.toml` is in the stage, since its security scanner
 *      runs as a Bun program. The non-native leg of a multi-arch `docker buildx`
 *      build runs such a stage under QEMU, where bun >= 1.4 aborts and no image
 *      publishes for either architecture — and the image publishes last, after
 *      npm and the MCP Registry. `HEALTHCHECK`/`CMD`/`ENTRYPOINT` run at
 *      container start and never count. One error per stage, naming each
 *      offending line (issue #575). Skipped when there is no `Dockerfile`.
 *  16. server.json npm launch shape: a registry client runs an npm entry as
 *      `npx <identifier>@<version> <packageArguments>` with the entry's
 *      `environmentVariables`, so the package's bin starts, never an npm
 *      script. No npm entry may carry the positional `run` + `start:*` pair
 *      (npm-script syntax the bin receives as ignored argv), and a
 *      `streamable-http` npm entry must fix `MCP_TRANSPORT_TYPE` as
 *      `"value": "http"` — absent, or only a user-editable `default`, the
 *      server starts on stdio. Runs with or without `manifest.json`; skipped
 *      when there is no `server.json` (issue #622).
 *  17. Published skills: when root `skills/` exists, the tree must load whole
 *      under the MCP SDK's strict skill loader (`validateSkillTree` from
 *      `@cyanheads/mcp-ts-core/linter`: the Agent Skills frontmatter rules,
 *      the SDK's YAML subset, symlinks, size limits, a `SKILL.md` directly
 *      under `skills/`), plus the project rules: `description` at most 500
 *      characters, `allowed-tools` a string, `SKILL.md` at most 150 lines,
 *      every `skills/<name>/` holding a `SKILL.md`, no `SKILL.md` below
 *      `skills/<name>/` (plugin hosts discover immediate children only), and no
 *      `metadata.audience: external` (the framework-managed marker). No
 *      `.mcpbignore` pattern may strip a file of the tree — a pre-0.13
 *      `.mcpbignore` still carries `/skills/`. Skipped, `.mcpbignore` included,
 *      when there is no root `skills/` (issue #429).
 *
 * Every check skips cleanly when its input is absent — consumers who deleted
 * `manifest.json` for an HTTP-only deploy, or who haven't built a bundle,
 * should not fail the checks that need those files.
 *
 * @module scripts/lint-packaging
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ServerJsonEnvVar {
  default?: string;
  isRequired?: boolean;
  name: string;
}

interface ServerJsonPackage {
  environmentVariables?: ServerJsonEnvVar[];
  transport?: { type?: string };
}

interface ServerJson {
  packages?: ServerJsonPackage[];
}

interface ManifestUserConfigEntry {
  title?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

interface Manifest {
  display_name?: unknown;
  name?: string;
  server?: { mcp_config?: { args?: unknown[]; env?: Record<string, string> } };
  user_config?: Record<string, ManifestUserConfigEntry>;
  version?: unknown;
}

const USER_CONFIG_REF = /^\$\{user_config\.([\w-]+)\}$/;

/**
 * Root dev directories the scaffold template excludes from the bundle, and
 * whose `.mcpbignore` patterns must be anchored with `/` to avoid also
 * stripping nested runtime paths like `node_modules/x/framework-skills/`. Keep
 * in step with the directory entries in the mcp-ts-core repository's
 * `templates/_.mcpbignore`, whose `_` prefix `init` drops on copy. Root
 * `skills/` is deliberately absent: it ships the skills a server publishes.
 */
export const KNOWN_DEV_DIRS = [
  'framework-skills/',
  '.agents/',
  '.claude/',
  'src/',
  'scripts/',
  'tests/',
  'docs/',
  'changelog/',
  'coverage/',
  'logs/',
  '.cache/',
  '.github/',
  '.vscode/',
  '.claude-plugin/',
  '.codex-plugin/',
];

/**
 * Root dev files the scaffold template excludes from the bundle, under the same
 * anchoring rule as `KNOWN_DEV_DIRS` — an unanchored `CLAUDE.md` also strips
 * `node_modules/x/CLAUDE.md`. Each one has a root-anchored line in
 * `templates/_.mcpbignore`; the template's other file lines (`/Dockerfile`,
 * `/bun.lock`, …) are not required here.
 */
export const KNOWN_DEV_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'plugin.json',
  'mcp.json',
  '.dockerignore',
  '.gitattributes',
  'devcheck.config.json',
];

/**
 * Critical runtime paths that must NOT be stripped by any `.mcpbignore` pattern.
 * Sampled from a current install, so an unanchored `dist/` or `build/` (or a
 * pattern over all of `node_modules/`) names the runtime code it would strip.
 * `@opentelemetry/semantic-conventions` loads from `build/src/` whenever the
 * server's optional OTel peers are installed.
 */
export const CRITICAL_RUNTIME_PATHS = [
  'node_modules/@opentelemetry/api/dist/',
  'node_modules/@opentelemetry/semantic-conventions/build/src/',
  'node_modules/@modelcontextprotocol/server/dist/',
  'node_modules/@cyanheads/mcp-ts-core/dist/',
  'dist/index.js',
];

/**
 * Agent-doc entries under `node_modules/` that must not ship in a bundle.
 * `framework-skills/` is this framework's tree; `skills/` covers any other
 * dependency that vendors agent skills.
 * KEEP IN SYNC with `AGENT_DOC_ENTRY` in `scripts/clean-mcpb.ts` (the strip
 * step this check verifies) — edit both literals together. The assertion that
 * they match lives in the mcp-ts-core repository's own test suite; `tests/` is
 * not part of the published package, so nothing enforces the pair in a server
 * these scripts were copied into.
 */
export const AGENT_DOC_ENTRY =
  /^node_modules\/.*(?:\/framework-skills\/|\/skills\/|\/\.claude\/|\/\.agents\/|\/SKILL\.md$)/;

/**
 * Platform-specific native binding packages that must not ship in a bundle.
 * KEEP IN SYNC with `NATIVE_BINDING_ENTRY` in `scripts/clean-mcpb.ts` (the
 * strip step this check verifies) — edit both literals together. The assertion
 * that they match lives in the mcp-ts-core repository's own test suite;
 * `tests/` is not part of the published package, so nothing enforces the pair
 * in a server these scripts were copied into.
 */
export const NATIVE_BINDING_ENTRY = /^node_modules\/@duckdb\/node-bindings-[^/]+\//;

/**
 * node-gyp output, matched against an entry's path below a `build/` directory
 * that has a sibling `binding.gyp`: generator files that record the packing
 * host's paths, intermediate trees, link inputs, and debug symbols. Compiled
 * `*.node` addons and shared libraries are not matched.
 * KEEP IN SYNC with `NODE_GYP_OUTPUT` and `filterNodeGypBuildEntries` in
 * `scripts/clean-mcpb.ts` (the strip step this check verifies) — edit both
 * together. The assertion that they select the same entries lives in the
 * mcp-ts-core repository's own test suite; `tests/` is not part of the
 * published package, so nothing enforces the pair in a server these scripts
 * were copied into.
 */
export const NODE_GYP_OUTPUT =
  /(?:^|\/)(?:(?:obj\.target|obj|\.deps|node_gyp_bins)\/|(?:config\.gypi|Makefile|gyp-mac-tool|gyp-flock-tool|[^/]+\.(?:Makefile|mk|sln|vcxproj|vcxproj\.filters|a|o|lib|obj|exp|pdb|ilk|iobj|ipdb))$)/;

/**
 * Build-only package files that must not ship in a bundle: mcp-ts-core's
 * `changelog/`, `config/`, `scripts/`, `templates/`, `CLAUDE.md`, `AGENTS.md`,
 * `biome.json`, and `vitest.config.base.mjs`, and better-sqlite3's `deps/` and
 * `src/` C sources.
 * KEEP IN SYNC with `BUILD_ONLY_ENTRY` in `scripts/clean-mcpb.ts` (the strip
 * step this check verifies) — edit both literals together. The assertion that
 * they match lives in the mcp-ts-core repository's own test suite; `tests/` is
 * not part of the published package, so nothing enforces the pair in a server
 * these scripts were copied into.
 */
export const BUILD_ONLY_ENTRY =
  /^node_modules\/(?:.+\/node_modules\/)?(?:@cyanheads\/mcp-ts-core\/(?:(?:changelog|config|scripts|templates)\/|(?:(?:CLAUDE|AGENTS)\.md|biome\.json|vitest\.config\.base\.mjs)$)|better-sqlite3\/(?:deps|src)\/)/;

/**
 * The node-gyp output in a bundle listing: entries under `<dir>/build/`
 * matching `NODE_GYP_OUTPUT`, for each `<dir>/binding.gyp` in the listing. A
 * `build/` with no sibling `binding.gyp` is never matched.
 * KEEP IN SYNC with `filterNodeGypBuildEntries` in `scripts/clean-mcpb.ts`.
 */
export function filterNodeGypBuildEntries(entries: string[]): string[] {
  const buildDirs = entries
    .filter((entry) => /(?:^|\/)binding\.gyp$/.test(entry))
    .map((entry) => `${entry.slice(0, -'binding.gyp'.length)}build/`);
  return entries.filter((entry) =>
    buildDirs.some((dir) => entry.startsWith(dir) && NODE_GYP_OUTPUT.test(entry.slice(dir.length))),
  );
}

/** The canonical in-code identity pair — both must equal the unscoped package name. */
const IDENTITY_PAIR = ['name', 'title'] as const;

function tryReadJson<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    console.error(`Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
    return;
  }
}

/**
 * Run bundle-content checks (5–7) against raw `.mcpbignore` content.
 *
 * Uses the `ignore` package (already a devDependency in scaffolded servers)
 * to evaluate which paths survive the ignore rules. Returns an array of error
 * strings; empty means all checks passed.
 *
 * **Context note:** `ignore` is a devDependency of the framework and of every
 * scaffold (`templates/package.json`), so it resolves wherever
 * `bun run lint:packaging` runs against an `.mcpbignore` — a server project, or
 * mcp-ts-core itself. Where it cannot load, the guard is skipped.
 */
interface IgnoreMatcher {
  add(patterns: string[]): IgnoreMatcher;
  ignores(path: string): boolean;
}

/**
 * The `ignore` package's factory, typed structurally — the CJS interop shape
 * of `import('ignore')` differs between the script and test tsconfig programs,
 * so naming the module's own types breaks one or the other.
 */
type IgnoreFactory = (options?: unknown) => IgnoreMatcher;

/**
 * The `ignore` factory, or undefined when the package is not installed (e.g. a
 * minimal CI environment that omits devDependencies) — the `.mcpbignore`
 * guards then skip without failing. Imported dynamically so the rest of the
 * linter still runs.
 */
async function loadIgnore(): Promise<IgnoreFactory | undefined> {
  try {
    const mod: unknown = await import('ignore');
    return ((mod as { default?: unknown }).default ?? mod) as IgnoreFactory;
  } catch {
    return;
  }
}

/** The pattern lines of an `.mcpbignore`: trimmed, comments and blanks dropped. */
const ignorePatterns = (raw: string): string[] =>
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

export async function checkBundleContent(raw: string): Promise<string[]> {
  const errors: string[] = [];

  const createIgnore = await loadIgnore();
  if (!createIgnore) return errors;

  const lines = ignorePatterns(raw);

  const ig = createIgnore().add(lines);

  // Check 5: dev dirs and files must be excluded at bundle root.
  for (const dir of KNOWN_DEV_DIRS) {
    if (!ig.ignores(`${dir}README.md`)) {
      errors.push(
        `.mcpbignore does not exclude root dev directory "${dir}" — the bundle ships it; ` +
          `add the line "/${dir}"`,
      );
    }
  }
  for (const file of KNOWN_DEV_FILES) {
    if (!ig.ignores(file)) {
      errors.push(
        `.mcpbignore does not exclude root dev file "${file}" — the bundle ships it; ` +
          `add the line "/${file}"`,
      );
    }
  }

  // Check 6: unanchored dev-dir and dev-file patterns also strip runtime paths
  // inside node_modules. Any pattern that excludes a known dev path must be
  // anchored (leading "/") so it only matches at root. A pattern written
  // against node_modules/ (`/node_modules/**/tests/`) targets dependencies on
  // purpose and is left to check 7.
  const rootLines = lines.filter((p) => !/^!?\/?node_modules\//.test(p));
  const rootIg = createIgnore().add(rootLines);
  for (const devPath of [...KNOWN_DEV_DIRS, ...KNOWN_DEV_FILES]) {
    // A dir probes a file inside it; a file probes itself.
    const runtimeProbe = `node_modules/some-pkg/${devPath}${devPath.endsWith('/') ? 'index.js' : ''}`;
    if (rootIg.ignores(runtimeProbe)) {
      // Find the offending pattern.
      const offending = rootLines.filter((p) => {
        try {
          return createIgnore().add([p]).ignores(runtimeProbe);
        } catch {
          return false;
        }
      });
      errors.push(
        `.mcpbignore uses an unanchored pattern that also strips runtime paths under node_modules: ` +
          `[${offending.join(', ')}]. Use a leading "/" to anchor to root (e.g. "/${devPath}").`,
      );
    }
  }

  // Check 7: no pattern should strip critical runtime paths.
  for (const critPath of CRITICAL_RUNTIME_PATHS) {
    if (ig.ignores(critPath)) {
      const offending = lines.filter((p) => {
        try {
          return createIgnore().add([p]).ignores(critPath);
        } catch {
          return false;
        }
      });
      errors.push(
        `.mcpbignore pattern(s) [${offending.join(', ')}] would strip critical runtime path ` +
          `"${critPath}" — add a leading "/" to anchor to root (e.g. "/${offending[0] ?? '?'}").`,
      );
    }
  }

  return errors;
}

/**
 * Check 8: a built bundle must contain zero `node_modules/**` agent-doc
 * entries, platform-specific native bindings, node-gyp build output, and
 * build-only package files. `scripts/clean-mcpb.ts` (wired into the `bundle`
 * script) strips all four after `mcpb pack`. One error per class.
 */
export function checkBundleEntries(entries: string[], bundleLabel: string): string[] {
  const sampleOf = (offending: string[]) =>
    offending
      .slice(0, 5)
      .map((entry) => `\n      ${entry}`)
      .join('');

  const errors: string[] = [];

  const agentDocs = entries.filter((entry) => AGENT_DOC_ENTRY.test(entry));
  if (agentDocs.length > 0) {
    errors.push(
      `${bundleLabel} contains ${agentDocs.length} node_modules agent-doc entries ` +
        `(dependency-shipped framework-skills/, skills/, .claude/, .agents/, SKILL.md) — re-run the \`bundle\` ` +
        `script (scripts/clean-mcpb.ts strips them):${sampleOf(agentDocs)}`,
    );
  }

  const natives = entries.filter((entry) => NATIVE_BINDING_ENTRY.test(entry));
  if (natives.length > 0) {
    errors.push(
      `${bundleLabel} contains ${natives.length} platform-specific native binding entries — ` +
        `the bundle would run only on the platform it was packed on. Re-run the \`bundle\` ` +
        `script (scripts/clean-mcpb.ts strips them):${sampleOf(natives)}`,
    );
  }

  const nodeGyp = filterNodeGypBuildEntries(entries);
  if (nodeGyp.length > 0) {
    errors.push(
      `${bundleLabel} contains ${nodeGyp.length} node-gyp build entries (generator files and ` +
        `intermediates under a build/ beside binding.gyp, which record the packing host's paths) — ` +
        `re-run the \`bundle\` script (scripts/clean-mcpb.ts strips them):${sampleOf(nodeGyp)}`,
    );
  }

  const buildOnly = entries.filter((entry) => BUILD_ONLY_ENTRY.test(entry));
  if (buildOnly.length > 0) {
    errors.push(
      `${bundleLabel} contains ${buildOnly.length} build-only package entries (mcp-ts-core's ` +
        `changelog/, config/, scripts/, templates/, agent docs, and config bases; better-sqlite3's deps/ and src/) — ` +
        `re-run the \`bundle\` script (scripts/clean-mcpb.ts strips them):${sampleOf(buildOnly)}`,
    );
  }

  return errors;
}

/**
 * Collect the direct (depth-1) property lines of the options object passed to
 * `createApp()` / `createWorkerHandler()`. Returns undefined when no call with
 * an inline options object exists (e.g. the framework's bare `createApp()`
 * dev entry).
 *
 * Line-based, no AST: nested object literals (a `setup(core) { … }` body,
 * `extensions: { … }`) are excluded by brace-depth tracking so an inner
 * `name:`/`title:` key can't false-positive the identity check. Reliable for
 * the template-scaffolded entrypoint shape with single-line string literals.
 */
function identityCandidateLines(source: string): string[] | undefined {
  const call = source.match(/\b(?:createApp|createWorkerHandler)\s*\(\s*\{/);
  if (call?.index === undefined) return;

  const lines: string[] = [];
  let depth = 0;
  let lineStartDepth = 0;
  let buf = '';
  let inString: string | undefined;
  let inBlockComment = false;

  const flush = (): void => {
    const trimmed = buf.trim();
    if (
      lineStartDepth === 1 &&
      trimmed.length > 0 &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('*')
    ) {
      lines.push(trimmed);
    }
    buf = '';
  };

  for (let i = call.index + call[0].length - 1; i < source.length; i++) {
    const ch = source[i] as string;
    if (ch === '\n') {
      flush();
      lineStartDepth = depth;
      continue;
    }
    buf += ch;
    if (inBlockComment) {
      if (ch === '/' && source[i - 1] === '*') inBlockComment = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        buf += source[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? source.length : nl;
      buf += source.slice(i + 1, end);
      i = end - 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      inBlockComment = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) {
        flush();
        return lines;
      }
    }
  }
  flush();
  return lines;
}

/**
 * Check 9 (entrypoint surface): `name`/`title` literals passed to
 * `createApp()` / `createWorkerHandler()` must equal the unscoped package
 * name. A partial pair (one or both missing) warns without failing — explicit
 * `name` also keeps scoped npm names out of the served `server_name`.
 */
export function checkEntrypointIdentity(
  source: string,
  unscopedName: string,
  fileLabel: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const optionLines = identityCandidateLines(source);
  if (!optionLines) return { errors, warnings };

  const present = new Set<string>();
  for (const field of IDENTITY_PAIR) {
    const fieldRe = new RegExp(`^['"\`]?${field}['"\`]?\\s*:`);
    const literalRe = new RegExp(`^['"\`]?${field}['"\`]?\\s*:\\s*(['"\`])((?:(?!\\1).)*)\\1`);
    for (const line of optionLines) {
      if (!fieldRe.test(line)) continue;
      present.add(field);
      const literal = line.match(literalRe)?.[2];
      if (literal !== undefined && literal !== unscopedName) {
        errors.push(
          `${fileLabel} sets ${field}: "${literal}" — must equal the unscoped package name ` +
            `"${unscopedName}" (display identity is the machine name on every surface)`,
        );
      }
    }
  }

  const missing = IDENTITY_PAIR.filter((field) => !present.has(field));
  if (missing.length > 0) {
    warnings.push(
      `${fileLabel} identity pair is partial — missing: ${missing.join(', ')} ` +
        `(set both name and title to the unscoped package name "${unscopedName}")`,
    );
  }

  return { errors, warnings };
}

/** Check 9 (manifest surface): `display_name`, when present, must be the unscoped package name. */
export function checkManifestIdentity(manifest: Manifest, unscopedName: string): string[] {
  if (typeof manifest.display_name === 'string' && manifest.display_name !== unscopedName) {
    return [
      `manifest.json "display_name" is "${manifest.display_name}" — must equal the unscoped ` +
        `package name "${unscopedName}"`,
    ];
  }
  return [];
}

/** Placeholders the MCPB host substitutes in `mcp_config` besides `${user_config.<key>}`. */
const MCPB_HOST_VARS = new Set([
  '__dirname',
  'HOME',
  'DESKTOP',
  'DOCUMENTS',
  'DOWNLOADS',
  'pathSeparator',
  '/',
]);

/**
 * Check 11: MCPB `user_config` wiring. A value the host collects from the
 * user reaches the server only through a `${user_config.<key>}` reference in
 * `mcp_config`; the host substitutes nothing else except its own path
 * placeholders, so `${API_KEY}` is delivered as that literal string. Every
 * declared option must therefore be referenced, every reference must be
 * declared, and an optional string option needs `"default": ""` so a blank
 * answer arrives as empty rather than as the unsubstituted placeholder.
 */
export function checkManifestUserConfigWiring(manifest: Manifest): string[] {
  const errors: string[] = [];
  const userConfig = manifest.user_config ?? {};
  const env = manifest.server?.mcp_config?.env ?? {};
  const args = manifest.server?.mcp_config?.args ?? [];
  const referenced = new Set<string>();

  const scan = (value: unknown, where: string): void => {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
      const token = match[1] ?? '';
      if (token.startsWith('user_config.')) {
        const key = token.slice('user_config.'.length);
        referenced.add(key);
        if (!(key in userConfig)) {
          errors.push(
            `manifest.json ${where} references "\${user_config.${key}}" but user_config["${key}"] is not declared`,
          );
        }
      } else if (!MCPB_HOST_VARS.has(token)) {
        errors.push(
          `manifest.json ${where} references "\${${token}}" — MCPB substitutes only \${user_config.<key>} and its ` +
            `own path placeholders, so the server receives that literal string; declare the option under user_config ` +
            `and reference "\${user_config.${token}}"`,
        );
      }
    }
  };
  for (const [key, value] of Object.entries(env)) scan(value, `mcp_config.env.${key}`);
  for (const [i, value] of args.entries()) scan(value, `mcp_config.args[${i}]`);

  for (const [key, entry] of Object.entries(userConfig)) {
    if (!referenced.has(key)) {
      errors.push(
        `manifest.json user_config["${key}"] is never referenced from mcp_config — the host collects the value ` +
          `and then drops it; add "${key}": "\${user_config.${key}}" to mcp_config.env`,
      );
    }
    if (
      typeof entry === 'object' &&
      entry !== null &&
      entry.type === 'string' &&
      entry.required !== true &&
      !('default' in entry)
    ) {
      errors.push(
        `manifest.json user_config["${key}"] is an optional string with no "default" — a blank answer reaches ` +
          `the server as the literal "\${user_config.${key}}"; add "default": ""`,
      );
    }
  }

  return errors;
}

/**
 * Parsed plugin marketplace manifests; an absent manifest is `undefined`. A
 * root `plugin.json` or `mcp.json` that exists but does not parse is `null`.
 */
export interface PluginManifestInputs {
  claudePlugin?: unknown;
  codexMcp?: unknown;
  codexPlugin?: unknown;
  /** Agent Plugins root `mcp.json`. */
  rootMcp?: unknown;
  /** Agent Plugins root `plugin.json`. */
  rootPlugin?: unknown;
}

/** Agent Plugins 1.0.0 schema identifiers — Codex accepts no other version. */
const AGENT_PLUGINS_PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const AGENT_PLUGINS_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/**
 * Root `plugin.json` top-level fields. The schema is closed; `extensions` is
 * part of it but excluded here, because an `extensions["com.openai"]` object
 * replaces the overlay's `interface` in Codex.
 */
const ROOT_PLUGIN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
]);

/** The closed Agent Plugins stdio server variant. */
const ROOT_STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);

/** Agent Plugins §5.5: 1–64 of `a-z0-9.-`, alphanumeric at both ends, no `--` or `..`. */
const AGENT_PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

/** The stdio `cwd` forms Agent Plugins accepts. */
const AGENT_PLUGIN_CWD = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

/** The only placeholders an Agent Plugins client expands. */
const AGENT_PLUGIN_PLACEHOLDERS = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);

/** The overlay pointer Codex follows to merge `env_vars` into a root `mcp.json` entry. */
const CODEX_MCP_POINTER = './.codex-plugin/mcp.json';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** The `npx -y <pkg>` install target is the arg after the `-y` flag (args[1]). */
function installArg(entry: Record<string, unknown>): unknown {
  return Array.isArray(entry.args) ? entry.args[1] : undefined;
}

/** A server entry's `env` object, or an empty one when absent or malformed. */
function serverEnv(entry: Record<string, unknown>): Record<string, unknown> {
  return isRecord(entry.env) ? entry.env : {};
}

/** A JSON value as an error message shows it; `absent` for a missing field. */
const shown = (value: unknown): string =>
  value === undefined ? 'absent' : (JSON.stringify(value) ?? String(value));

/** Why a root `plugin.json` metadata field breaks the 1.0.0 schema; undefined when it fits. */
function rootFieldTypeError(field: string, value: unknown): string | undefined {
  if (field === 'keywords') {
    return Array.isArray(value) && value.every((keyword) => typeof keyword === 'string')
      ? undefined
      : 'must be an array of strings';
  }
  if (field === 'author') {
    return isRecord(value) &&
      Object.entries(value).every(
        ([key, item]) => ['name', 'email', 'url'].includes(key) && typeof item === 'string',
      )
      ? undefined
      : 'must be an object carrying only string "name", "email", and "url"';
  }
  return typeof value === 'string' ? undefined : 'must be a string';
}

/** The variable names a `.codex-plugin/mcp.json` file forwards through `env_vars`, in file order. */
function forwardedEnvVars(codexMcp: unknown): string[] {
  if (!isRecord(codexMcp)) return [];
  return Object.values(codexMcp).flatMap((entry) =>
    isRecord(entry) && Array.isArray(entry.env_vars)
      ? entry.env_vars
          .map((variable: unknown) => (isRecord(variable) ? variable.name : variable))
          .filter((name: unknown): name is string => isNonEmptyString(name))
      : [],
  );
}

/**
 * Root `mcp.json` beside a root `plugin.json`: the 1.0.0 `$schema`, nothing at
 * the top level but `mcpServers`, and closed stdio entries keyed by the
 * unscoped name whose `env` carries only fixed values and equals the Codex
 * overlay's. A client disables MCP for a malformed file and skips a malformed
 * entry, both without failing the install.
 */
function checkRootMcp(
  rootMcp: unknown,
  codexMcp: unknown,
  unscopedName: string,
  fullName: string,
): string[] {
  const f = 'mcp.json';
  if (!isRecord(rootMcp)) {
    return [`${f} is not a JSON object — Agent Plugins clients disable MCP for the plugin`];
  }
  const errors: string[] = [];

  if (rootMcp.$schema !== AGENT_PLUGINS_MCP_SCHEMA) {
    errors.push(
      `${f} "$schema" is ${shown(rootMcp.$schema)} — must be "${AGENT_PLUGINS_MCP_SCHEMA}"; Codex accepts only ` +
        'Agent Plugins 1.0.0 and disables MCP for the plugin otherwise',
    );
  }
  for (const field of Object.keys(rootMcp)) {
    if (field !== '$schema' && field !== 'mcpServers') {
      errors.push(
        `${f} carries "${field}" — mcp.json may carry only "$schema" and "mcpServers"; clients disable MCP for the plugin otherwise`,
      );
    }
  }

  const servers = rootMcp.mcpServers;
  if (!isRecord(servers)) {
    errors.push(
      `${f} "mcpServers" is ${shown(servers)} — must be an object with a "${unscopedName}" entry`,
    );
    return errors;
  }
  if (!(unscopedName in servers)) {
    errors.push(
      `${f} mcpServers has no "${unscopedName}" entry — the server key must be the unscoped package name`,
    );
  }

  const codexEntry =
    isRecord(codexMcp) && isRecord(codexMcp[unscopedName]) ? codexMcp[unscopedName] : undefined;
  for (const [key, entry] of Object.entries(servers)) {
    const at = `${f} mcpServers["${key}"]`;
    if (key !== unscopedName) {
      errors.push(`${at} — every server key must be the unscoped package name "${unscopedName}"`);
      continue;
    }
    if (!isRecord(entry)) {
      errors.push(`${at} is ${shown(entry)} — must be a stdio server object`);
      continue;
    }

    for (const field of Object.keys(entry)) {
      if (ROOT_STDIO_FIELDS.has(field)) continue;
      errors.push(
        `${at} carries "${field}" — a stdio entry may carry only type, command, args, env, and cwd, and clients ` +
          `skip the server otherwise${field === 'env_vars' ? '; list env_vars in .codex-plugin/mcp.json, which Codex merges into this entry' : ''}`,
      );
    }
    if (entry.type !== 'stdio') {
      errors.push(`${at} "type" is ${shown(entry.type)} — must be "stdio"`);
    }
    if (typeof entry.command !== 'string' || !/^[^\s/\\]+$/.test(entry.command)) {
      errors.push(
        `${at} "command" is ${shown(entry.command)} — must be a bare executable name such as "npx"`,
      );
    }
    if (
      entry.args !== undefined &&
      !(Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string'))
    ) {
      errors.push(`${at} "args" is ${shown(entry.args)} — must be an array of strings`);
    }
    if (installArg(entry) !== fullName) {
      errors.push(
        `${at} install arg is "${String(installArg(entry))}" — must be the full package name "${fullName}" (the npx -y target)`,
      );
    }
    if (
      entry.cwd !== undefined &&
      !(typeof entry.cwd === 'string' && AGENT_PLUGIN_CWD.test(entry.cwd))
    ) {
      errors.push(
        `${at} "cwd" is ${shown(entry.cwd)} — must start with "./", "\${PLUGIN_ROOT}", or "\${PLUGIN_DATA}"`,
      );
    }

    if (entry.env !== undefined && !isRecord(entry.env)) {
      errors.push(`${at} "env" is ${shown(entry.env)} — must be an object of strings`);
    }
    const env = serverEnv(entry);
    for (const [name, value] of Object.entries(env)) {
      const where = `${at}.env.${name}`;
      if (AGENT_PLUGIN_PLACEHOLDERS.has(name)) {
        errors.push(
          `${where} — ${name} is reserved: the client sets it on the child process, and an entry naming it makes the server invalid`,
        );
      } else if (typeof value !== 'string') {
        errors.push(`${where} is ${shown(value)} — env values must be strings`);
      } else if (value === '') {
        errors.push(
          `${where} is "" — an empty value replaces the user's exported ${name} and is read as unset; remove it and ` +
            `forward the variable through .codex-plugin/mcp.json "env_vars" and .claude-plugin/plugin.json "userConfig"`,
        );
      } else {
        for (const [placeholder, token = ''] of value.matchAll(/\$\{([^}]*)\}/g)) {
          if (AGENT_PLUGIN_PLACEHOLDERS.has(token)) continue;
          errors.push(
            `${where} references "${placeholder}" — Agent Plugins clients expand only \${PLUGIN_ROOT} and ` +
              `\${PLUGIN_DATA}, so the server receives the literal string; forward user values through ` +
              '.codex-plugin/mcp.json "env_vars" and .claude-plugin/plugin.json "userConfig"',
          );
        }
      }
    }

    if (codexEntry) {
      const codexEnv = serverEnv(codexEntry);
      const differing = [...new Set([...Object.keys(env), ...Object.keys(codexEnv)])].filter(
        (name) => env[name] !== codexEnv[name],
      );
      if (differing.length > 0) {
        errors.push(
          `${at}.env differs from .codex-plugin/mcp.json "${unscopedName}".env at ${differing.join(', ')} — keep ` +
            'the two identical: Codex starts the server from root mcp.json, and other Agent Plugins clients read nothing else',
        );
      }
    }
  }

  return errors;
}

/**
 * Check 10: plugin marketplace manifests. Display fields (`name`, server key,
 * `interface.displayName`) must equal the unscoped machine name; the install
 * arg must equal the full `package.json` name (the real `npx` target); the
 * declared `version` must equal `package.json`'s, so a release cannot ship a
 * manifest advertising an earlier one. Empty descriptions ship blank
 * marketplace cards. Each manifest is validated only when present, so HTTP-only
 * and non-plugin consumers are unaffected. The caller gates the whole check on
 * `packaging.pluginManifests`.
 *
 * A server `env` value of `""` is rejected in both connection configs. The
 * client sets the entry on the child process, so the placeholder replaces a
 * key the user exported and the framework's empty-string-as-unset parsing then
 * drops it — the user's real value never reaches the server. Claude Code
 * collects user values through `userConfig` and substitutes
 * `${user_config.<key>}` in `env`; every such reference must name a declared
 * option. Codex launches stdio servers with a whitelisted environment, so a
 * host variable reaches the server only when `env_vars` names it.
 *
 * `.codex-plugin/mcp.json` is connection configuration and carries no version.
 *
 * The Agent Plugins root pair is checked only when root `plugin.json` exists;
 * see the check 10 notes in this file's header for each rule and its reason.
 */
export function checkPluginManifests(
  inputs: PluginManifestInputs,
  unscopedName: string,
  fullName: string,
  packageVersion?: string,
): string[] {
  const errors: string[] = [];
  const optOut =
    '(or set "packaging": { "pluginManifests": false } in devcheck.config.json to opt out)';

  /** Version parity for one plugin manifest; skipped when package.json has none. */
  const checkVersion = (file: string, manifest: Record<string, unknown>): void => {
    if (!isNonEmptyString(packageVersion)) return;
    if (manifest.version === packageVersion) return;
    errors.push(
      manifest.version === undefined
        ? `${file} has no "version" — must declare the package.json version "${packageVersion}"`
        : `${file} "version" is "${String(manifest.version)}" — must equal the package.json version "${packageVersion}"`,
    );
  };

  // ── .claude-plugin/plugin.json ──
  const claude = inputs.claudePlugin;
  if (isRecord(claude)) {
    const f = '.claude-plugin/plugin.json';
    if (!isNonEmptyString(claude.description)) {
      errors.push(`${f} "description" is empty — populate it ${optOut}`);
    }
    checkVersion(f, claude);
    if (claude.name !== unscopedName) {
      errors.push(
        `${f} "name" is "${String(claude.name)}" — must equal the unscoped package name "${unscopedName}"`,
      );
    }
    const servers = claude.mcpServers;
    if (isRecord(servers)) {
      if (!(unscopedName in servers)) {
        errors.push(
          `${f} mcpServers has no "${unscopedName}" entry — the server key must be the unscoped package name`,
        );
      }
      const entry = servers[unscopedName];
      if (isRecord(entry)) {
        if (installArg(entry) !== fullName) {
          errors.push(
            `${f} mcpServers["${unscopedName}"] install arg is "${String(installArg(entry))}" — ` +
              `must be the full package name "${fullName}" (the npx -y target; an unscoped arg for a scoped package 404s)`,
          );
        }
        const userConfig = isRecord(claude.userConfig) ? claude.userConfig : {};
        for (const [key, value] of Object.entries(serverEnv(entry))) {
          if (value === '') {
            errors.push(
              `${f} mcpServers["${unscopedName}"].env.${key} is "" — an empty placeholder replaces the ` +
                `user's exported ${key} and is read as unset; declare the option under "userConfig" ` +
                `and set the value to "\${user_config.<option>}"`,
            );
          } else if (typeof value === 'string') {
            const ref = USER_CONFIG_REF.exec(value)?.[1];
            if (ref !== undefined && !isRecord(userConfig[ref])) {
              errors.push(
                `${f} mcpServers["${unscopedName}"].env.${key} references "\${user_config.${ref}}" but ` +
                  `"userConfig.${ref}" is not declared — Claude Code prompts only for declared options`,
              );
            }
          }
        }
      }
    }
  }

  // ── .codex-plugin/plugin.json ──
  const codex = inputs.codexPlugin;
  if (isRecord(codex)) {
    const f = '.codex-plugin/plugin.json';
    if (!isNonEmptyString(codex.description)) {
      errors.push(`${f} "description" is empty — populate it ${optOut}`);
    }
    checkVersion(f, codex);
    if (codex.name !== unscopedName) {
      errors.push(
        `${f} "name" is "${String(codex.name)}" — must equal the unscoped package name "${unscopedName}"`,
      );
    }
    const iface = codex.interface;
    if (isRecord(iface)) {
      if (iface.displayName !== unscopedName) {
        errors.push(
          `${f} interface.displayName is "${String(iface.displayName)}" — must equal the unscoped package name "${unscopedName}"`,
        );
      }
      if (!isNonEmptyString(iface.shortDescription)) {
        errors.push(`${f} interface.shortDescription is empty — populate it ${optOut}`);
      }
      if (!isNonEmptyString(iface.longDescription)) {
        errors.push(`${f} interface.longDescription is empty — populate it ${optOut}`);
      }
    } else {
      errors.push(
        `${f} is missing the "interface" object (displayName / shortDescription / longDescription)`,
      );
    }
  }

  // ── .codex-plugin/mcp.json ──
  const codexMcp = inputs.codexMcp;
  if (isRecord(codexMcp)) {
    const f = '.codex-plugin/mcp.json';
    if (!(unscopedName in codexMcp)) {
      errors.push(
        `${f} has no "${unscopedName}" server entry — the server key must be the unscoped package name`,
      );
    }
    const entry = codexMcp[unscopedName];
    if (isRecord(entry)) {
      if (installArg(entry) !== fullName) {
        errors.push(
          `${f} "${unscopedName}" install arg is "${String(installArg(entry))}" — ` +
            `must be the full package name "${fullName}" (the npx -y target)`,
        );
      }
      for (const [key, value] of Object.entries(serverEnv(entry))) {
        if (value === '') {
          errors.push(
            `${f} "${unscopedName}".env.${key} is "" — Codex starts stdio servers with a whitelisted ` +
              `environment, so an empty placeholder adds nothing; remove it and list "${key}" in ` +
              `"env_vars" to forward the user's value`,
          );
        }
      }
    }
  }

  // ── plugin.json + mcp.json (Agent Plugins 1.0.0 root pair) ──
  const root = inputs.rootPlugin;
  if (root !== undefined) {
    const f = 'plugin.json';
    if (isRecord(root)) {
      if (root.$schema !== AGENT_PLUGINS_PLUGIN_SCHEMA) {
        errors.push(
          `${f} "$schema" is ${shown(root.$schema)} — must be "${AGENT_PLUGINS_PLUGIN_SCHEMA}"; Codex accepts only ` +
            'Agent Plugins 1.0.0 and rejects the plugin otherwise',
        );
      }
      for (const [field, value] of Object.entries(root)) {
        if (!ROOT_PLUGIN_FIELDS.has(field)) {
          errors.push(
            field === 'extensions'
              ? `${f} carries "extensions" — an extensions["com.openai"] object replaces the .codex-plugin/plugin.json ` +
                  'interface in Codex; keep client metadata in the .codex-plugin/ and .claude-plugin/ overlays'
              : `${f} carries "${field}", outside the closed Agent Plugins manifest (${[...ROOT_PLUGIN_FIELDS].join(', ')}) — ` +
                  'move client metadata to the .codex-plugin/ and .claude-plugin/ overlays',
          );
          continue;
        }
        const problem =
          field === '$schema' || field === 'name' ? undefined : rootFieldTypeError(field, value);
        if (problem) {
          errors.push(
            `${f} "${field}" ${problem} — Agent Plugins clients reject a manifest that breaks its schema`,
          );
        }
      }
      if (!isNonEmptyString(root.description)) {
        errors.push(`${f} "description" is empty — populate it ${optOut}`);
      }
      checkVersion(f, root);
      if (root.name !== unscopedName) {
        errors.push(
          `${f} "name" is "${String(root.name)}" — must equal the unscoped package name "${unscopedName}"`,
        );
      }
      if (!AGENT_PLUGIN_NAME.test(unscopedName)) {
        errors.push(
          `${f} "name" must be the unscoped package name "${unscopedName}", which breaks Agent Plugins §5.5 — ` +
            'a plugin name is 1–64 characters from a-z, 0-9, "-", and ".", alphanumeric at both ends, with no "--" ' +
            'or ".."; Codex and the other Agent Plugins clients reject the plugin, so rename the package to comply',
        );
      }
    } else {
      errors.push(`${f} is not a JSON object — Agent Plugins clients reject the plugin`);
    }

    if (inputs.rootMcp === undefined) {
      errors.push(
        `${f} has no mcp.json beside it — Agent Plugins clients load MCP servers only from root mcp.json, so the ` +
          'plugin installs without its server; add mcp.json',
      );
    } else {
      errors.push(...checkRootMcp(inputs.rootMcp, inputs.codexMcp, unscopedName, fullName));

      const forwarded = forwardedEnvVars(inputs.codexMcp);
      const pointer = isRecord(inputs.codexPlugin) ? inputs.codexPlugin.mcpServers : undefined;
      if (forwarded.length > 0 && pointer !== CODEX_MCP_POINTER) {
        const overlay = isRecord(inputs.codexPlugin)
          ? `.codex-plugin/plugin.json "mcpServers" is ${shown(pointer)}`
          : '.codex-plugin/plugin.json is absent';
        errors.push(
          `.codex-plugin/mcp.json forwards ${forwarded.join(', ')} through "env_vars", but ${overlay} — with root ` +
            'mcp.json present, Codex merges env_vars into its server only through .codex-plugin/plugin.json ' +
            `"mcpServers": "${CODEX_MCP_POINTER}", so it drops each of those variables without an error`,
        );
      }
    }
  }

  return errors;
}

/**
 * The shields.io static version badge, anchored on the `Version-` label and the
 * `-` that closes the version segment. A literal `-` inside a badge segment is
 * escaped as `--`, so the segment is "runs of non-dash characters joined by
 * escaped dashes" — which also keeps the scan linear, since the alternation
 * cannot match the same character two ways. Anchoring on the label and the
 * trailing `-` tolerates colour, extension, and query-string variation without
 * enumerating them, and matches no other badge: a live `img.shields.io/npm/v/…`
 * badge has no `badge/Version-` path.
 */
const README_VERSION_BADGE = /img\.shields\.io\/badge\/Version-([^-]*(?:--[^-]*)*)-/;

/**
 * A version the badge can be compared against once its `--` escapes are
 * decoded: the semver core, then at most one `-` prerelease segment and one
 * `+` build segment. The two are separate optionals rather than one repeated
 * `(?:[-+]…)*`, because `-` is itself a member of the segment character class
 * — a repeated group can split a run of dashes two ways and backtracks
 * exponentially on a segment the check is about to reject (CodeQL `js/redos`,
 * CWE-1333). `+` is outside the class, so each segment's end is determined and
 * the scan stays linear.
 */
const READABLE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Check 12: README version badge parity. When `README.md` carries a shields.io
 * `Version-<semver>-` badge, its version must equal `package.json` `version` —
 * the badge is the package's headline version on GitHub and npmjs.com, and it
 * ships in the tarball, so a half-finished bump is publicly visible.
 *
 * Skipped when the README, the badge, or the package version is absent: a
 * server that replaced the static badge with a live `npm/v` one has nothing to
 * check, and a version-less `package.json` is the same fail-safe the
 * plugin-manifest parity check applies. A badge that exists but cannot be read
 * is drift the check cannot rule out, so it fails rather than skips.
 */
export function checkReadmeVersionBadge(readme: string, packageVersion?: string): string[] {
  if (!packageVersion) return [];

  const segment = README_VERSION_BADGE.exec(readme)?.[1];
  if (segment === undefined) return [];

  const badgeVersion = segment.replaceAll('--', '-');
  if (!READABLE_VERSION.test(badgeVersion)) {
    return [
      `README.md version badge segment is "${segment}" — not a readable version, so it cannot be ` +
        `checked against the package.json version "${packageVersion}"; write the badge as ` +
        `"Version-${packageVersion.replaceAll('-', '--')}-"`,
    ];
  }
  if (badgeVersion === packageVersion) return [];
  return [
    `README.md version badge is "${badgeVersion}" — must equal the package.json version "${packageVersion}"`,
  ];
}

/** The `files` entry that keeps the `bundle` script's `dist/<name>.mcpb` out of the npm tarball. */
const BUNDLE_EXCLUSION = '!dist/*.mcpb';

/**
 * Check 13: a `files` allowlist that covers `dist/` wholesale must exclude the
 * `.mcpb` the `bundle` script writes there. npm and Bun both honor `!` entries
 * in `files`, and both ignore `.npmignore` once `files` is set, so the entry is
 * the only place the exclusion can live. The caller runs this only when
 * `manifest.json` exists — a project without one never builds a bundle.
 */
export function checkBundleExcludedFromFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  const entries = files.filter((entry): entry is string => typeof entry === 'string');

  const coversDist = entries.some(
    (entry) => entry.replace(/^\.\//, '').replace(/\/(?:\*\*(?:\/\*)?|\*)?$/, '') === 'dist',
  );
  if (!coversDist) return [];
  if (entries.includes(BUNDLE_EXCLUSION) || entries.includes('!dist/**/*.mcpb')) return [];

  return [
    `package.json "files" covers dist/ without "${BUNDLE_EXCLUSION}" — the bundle script writes ` +
      `dist/<name>.mcpb, so a release that bundles before publishing ships it in the npm tarball; ` +
      `add "${BUNDLE_EXCLUSION}" to "files"`,
  ];
}

/**
 * Check 14: manifest.json `version` must equal `package.json`'s. Skipped when
 * the package version is absent — the same fail-safe as checks 10 and 12.
 */
export function checkManifestVersion(manifest: Manifest, packageVersion?: string): string[] {
  if (!packageVersion || manifest.version === packageVersion) return [];
  return [
    manifest.version === undefined
      ? `manifest.json has no "version" — must declare the package.json version "${packageVersion}"`
      : `manifest.json "version" is "${String(manifest.version)}" — must equal the package.json version "${packageVersion}"`,
  ];
}

/** One Dockerfile instruction: continuations joined, a `RUN` heredoc body folded in. */
interface DockerInstruction {
  args: string;
  keyword: string;
  /** 1-based line the instruction starts on. */
  line: number;
  text: string;
}

const DOCKERFILE_SKIPPED_LINE = /^\s*(?:#|$)/;
const DOCKERFILE_CONTINUATION = /\\\s*$/;
const DOCKERFILE_HEREDOC = /<<-?(["']?)([A-Za-z_]\w*)\1/g;

/**
 * Splits a Dockerfile into instructions the way BuildKit reads it: a trailing
 * `\` continues onto the next line, comment and blank lines inside a
 * continuation are dropped, and a `RUN` heredoc's body belongs to its `RUN`.
 */
function dockerInstructions(dockerfile: string): DockerInstruction[] {
  const lines = dockerfile.split(/\r?\n/);
  const instructions: DockerInstruction[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DOCKERFILE_SKIPPED_LINE.test(lines[i] ?? '')) continue;
    const line = i + 1;
    let text = (lines[i] ?? '').trim();
    while (DOCKERFILE_CONTINUATION.test(text) && i + 1 < lines.length) {
      text = text.replace(DOCKERFILE_CONTINUATION, ' ');
      do i++;
      while (i < lines.length && DOCKERFILE_SKIPPED_LINE.test(lines[i] ?? ''));
      text += (lines[i] ?? '').trim();
    }
    const keyword = (text.split(/\s/, 1)[0] ?? '').toUpperCase();
    if (keyword === 'RUN') {
      for (const [, , delimiter] of text.matchAll(DOCKERFILE_HEREDOC)) {
        while (i + 1 < lines.length && (lines[++i] ?? '').trim() !== delimiter) {
          text += `\n${lines[i]}`;
        }
      }
    }
    instructions.push({ keyword, args: text.slice(keyword.length).trim(), line, text });
  }
  return instructions;
}

/** Words that may precede the command itself in a simple shell command. */
const SHELL_COMMAND_PREFIX = new Set([
  '!',
  'command',
  'do',
  'elif',
  'else',
  'env',
  'exec',
  'if',
  'then',
  'time',
  'until',
  'while',
]);

/** A `bun`/`bunx` invocation in a `RUN`: the command word and the words after it. */
interface BunInvocation {
  args: string[];
  command: 'bun' | 'bunx';
}

function bunCommand(word: string | undefined): BunInvocation['command'] | undefined {
  const name = word?.split('/').pop();
  return name === 'bun' || name === 'bunx' ? name : undefined;
}

/**
 * The `bun`/`bunx` invocations a `RUN` instruction's command makes, read from
 * command position only — `chown bun:bun`, `/root/.bun/`, and a quoted
 * mention are not invocations. Quoted strings are opaque, so a `bun -e '…'`
 * program never splits into commands of its own.
 */
function bunInvocations(runArgs: string): BunInvocation[] {
  const command = runArgs.replace(/^(?:--[\w-]+=\S+\s+)*/, '');
  if (command.startsWith('[')) {
    try {
      const argv: unknown = JSON.parse(command);
      if (Array.isArray(argv)) {
        const name = bunCommand(String(argv[0]));
        return name ? [{ command: name, args: argv.slice(1).map(String) }] : [];
      }
    } catch {
      // Not a JSON exec form: fall through and read it as shell.
    }
  }
  return command
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "'…'")
    .split(/&&|\|\||[;|&(){}`\n]/)
    .flatMap((segment) => {
      const words = segment.trim().split(/\s+/);
      const start = words.findIndex(
        (word) => !SHELL_COMMAND_PREFIX.has(word) && !/^[A-Za-z_]\w*=/.test(word),
      );
      const name = bunCommand(words[start]);
      return name ? [{ command: name, args: words.slice(start + 1) }] : [];
    });
}

const DOCKERFILE_BUILD_PLATFORM = /--platform=\$\{?BUILDPLATFORM\}?(?:\s|$)/;
const BUN_INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add', 'a']);
const BUNFIG_SOURCE = /(?:^|[\s/"'[,])bunfig\.toml(?=[\s"',\]]|$)/;

/** Whether a `COPY`/`ADD` brings `bunfig.toml` into the stage, by name or with the whole context. */
function copiesBunfig(args: string): boolean {
  if (BUNFIG_SOURCE.test(args)) return true;
  const words = args.split(/\s+/);
  if (words.some((word) => word.startsWith('--from='))) return false;
  const sources = words.filter((word) => !word.startsWith('--')).slice(0, -1);
  return sources.some((source) => source === '.' || source === './');
}

/**
 * Check 15: a Dockerfile stage built for the target platform must not run
 * JavaScript while it builds. A multi-arch `docker buildx` build runs every
 * such stage under QEMU on the non-native leg, where bun >= 1.4 aborts, and the
 * image publishes last — after npm and the MCP Registry. A stage counts as
 * running JavaScript when a `RUN` invokes `bun` for anything but
 * `install`/`add` (`bun run build`, `bun -e`, a script, `bunx`), or runs
 * `bun install`/`bun add` once `bunfig.toml` is in the stage, since its
 * `[install.security]` scanner runs as a Bun program. A stage whose `FROM`
 * carries `--platform=$BUILDPLATFORM` is exempt, and so are `HEALTHCHECK`,
 * `CMD`, and `ENTRYPOINT`, which run at container start on the real target.
 * One error per stage, naming each offending line.
 */
export function checkDockerfileBuildPlatform(dockerfile: string): string[] {
  const stages: {
    alias: string | undefined;
    bunfig: boolean;
    findings: string[];
    from: DockerInstruction;
    pinned: boolean;
  }[] = [];

  for (const instruction of dockerInstructions(dockerfile)) {
    if (instruction.keyword === 'FROM') {
      const [image = '', , alias] = instruction.args
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => !word.startsWith('--'));
      stages.push({
        alias,
        // A stage built FROM an earlier one starts with that stage's files.
        bunfig: stages.find((earlier) => earlier.alias === image)?.bunfig ?? false,
        findings: [],
        from: instruction,
        pinned: DOCKERFILE_BUILD_PLATFORM.test(instruction.args),
      });
      continue;
    }
    const stage = stages.at(-1);
    if (!stage) continue;
    if (instruction.keyword === 'COPY' || instruction.keyword === 'ADD') {
      stage.bunfig ||= copiesBunfig(instruction.args);
    } else if (instruction.keyword === 'RUN' && !stage.pinned) {
      const finding = bunInvocations(instruction.args)
        .map(({ command, args }) => {
          const subcommand = args.find((arg) => !arg.startsWith('-'));
          if (command === 'bun' && BUN_INSTALL_SUBCOMMANDS.has(subcommand ?? '')) {
            return stage.bunfig
              ? `\`bun ${subcommand}\` after bunfig.toml is in the stage, which starts its security scanner as a Bun program`
              : undefined;
          }
          return `\`${[command, args[0]].filter(Boolean).join(' ')}\``;
        })
        .find(Boolean);
      if (finding) stage.findings.push(`Dockerfile:${instruction.line} runs ${finding}`);
    }
  }

  return stages
    .filter((stage) => stage.findings.length > 0)
    .map(
      ({ from, findings }) =>
        `Dockerfile:${from.line} "${from.text}" builds for the target platform but runs JavaScript while ` +
        `building — ${findings.join('; ')}. A multi-arch buildx build runs that under QEMU on the non-native ` +
        `leg, where bun aborts and no image publishes. Move these steps into a stage that starts ` +
        `"FROM --platform=$BUILDPLATFORM" (cross-install with \`bun install --os=<os> --cpu=<x64|arm64>\`) and ` +
        `copy their output (dist/, node_modules/) into this stage`,
    );
}

/** The environment entry a `streamable-http` npm package carries, as the mcp-ts-core scaffold writes it. */
const HTTP_TRANSPORT_ENV =
  '{ "name": "MCP_TRANSPORT_TYPE", "description": "Selects the HTTP transport.", "format": "string", "value": "http" }';

/** An npm script name the `run` positional selects: `start` or `start:<variant>`. */
const NPM_START_SCRIPT = /^start(?::|$)/;

/** The `value` of a positional package argument; undefined for anything else. */
function positionalValue(arg: unknown): string | undefined {
  return isRecord(arg) && arg.type === 'positional' && typeof arg.value === 'string'
    ? arg.value
    : undefined;
}

/**
 * Check 16: the launch shape of `server.json` npm entries. A registry client
 * runs an npm entry as `npx <identifier>@<version> <packageArguments>` with the
 * entry's `environmentVariables`, so the package's bin starts, never an npm
 * script. A positional `run` followed by `start` or `start:<variant>` is
 * npm-script syntax the bin receives as argv and ignores. The transport comes
 * only from `MCP_TRANSPORT_TYPE`, so a `streamable-http` npm entry must fix it
 * as `"value": "http"`: absent, it starts on stdio, and a `default` is
 * user-editable. Entries of other registry types are left alone. Every error
 * names the entry's index and the change that fixes it.
 */
export function checkServerJsonLaunch(serverJson: unknown): string[] {
  const errors: string[] = [];
  const packages =
    isRecord(serverJson) && Array.isArray(serverJson.packages) ? serverJson.packages : [];

  for (const [index, entry] of packages.entries()) {
    if (!isRecord(entry) || entry.registryType !== 'npm') continue;
    const label = `server.json packages[${index}]`;

    const args: unknown[] = Array.isArray(entry.packageArguments) ? entry.packageArguments : [];
    const runAt = args.findIndex(
      (arg, i) =>
        positionalValue(arg) === 'run' && NPM_START_SCRIPT.test(positionalValue(args[i + 1]) ?? ''),
    );
    if (runAt !== -1) {
      errors.push(
        `${label} packageArguments carry "run" "${positionalValue(args[runAt + 1])}" — npm-script ` +
          'syntax: a registry client launches the entry as `npx <identifier>@<version> <packageArguments>`, ' +
          "so the package's bin receives both as argv it ignores; remove both arguments",
      );
    }

    if (!isRecord(entry.transport) || entry.transport.type !== 'streamable-http') continue;
    const envVars: unknown[] = Array.isArray(entry.environmentVariables)
      ? entry.environmentVariables
      : [];
    const transportVar = envVars.find((v) => isRecord(v) && v.name === 'MCP_TRANSPORT_TYPE');
    if (!isRecord(transportVar)) {
      errors.push(
        `${label} (streamable-http) does not set MCP_TRANSPORT_TYPE, so the server it launches ` +
          `starts on stdio; add ${HTTP_TRANSPORT_ENV} to its environmentVariables`,
      );
    } else if (transportVar.value === undefined) {
      const reason =
        transportVar.default === 'http'
          ? '"default": "http" is user-editable, so the HTTP transport is not guaranteed'
          : 'the server it launches starts on stdio';
      errors.push(
        `${label} (streamable-http) MCP_TRANSPORT_TYPE has no "value" — ${reason}; set "value": "http"`,
      );
    } else if (transportVar.value !== 'http') {
      errors.push(
        `${label} (streamable-http) MCP_TRANSPORT_TYPE "value" is "${String(transportVar.value)}" — ` +
          'set it to "http"',
      );
    }
  }

  return errors;
}

/** One problem `validateSkillTree` reports; `path` is relative to the tree root (`.` for the root). */
interface SkillTreeProblem {
  message: string;
  path: string;
}

/**
 * `validateSkillTree` from `@cyanheads/mcp-ts-core/linter`: the MCP SDK's
 * strict skill loader over a tree. Passed into {@link checkPublishedSkills}
 * rather than imported, so the check runs only when a tree exists and the
 * framework's own tests can supply the source implementation.
 */
export type SkillTreeValidator = (root: string) => Promise<SkillTreeProblem[]>;

/** Project budgets for a published skill: hosts keep every installed skill's description resident. */
const SKILL_DESCRIPTION_MAX_CHARS = 500;
const SKILL_MD_MAX_LINES = 150;

/** YAML plain scalars the SDK's loader resolves to null, a boolean, or a number. */
const YAML_NON_STRING =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[+-]?(?:\.\d+|\d+(?:\.\d*)?)(?:[Ee][+-]?\d+)?|0o[0-7]+|0x[\dA-Fa-f]+|[+-]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

/**
 * `audience: external` at any indentation in frontmatter, as `check-skills-sync`
 * reads it, and also quoted or followed by a comment — spellings `init` and
 * `check-skills-sync` do not read as the marker, refused so none of them ships.
 */
const FRAMEWORK_AUDIENCE = /^[\t ]*audience:[\t ]*(["']?)external\1[\t ]*(?:#.*)?$/m;

/** A directory's entries in code-unit order, so errors come out the same on every filesystem. */
const sortedEntries = (dir: string) =>
  readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));

/** Files under `dir`, relative to it and `/`-separated. Symlinks are listed, never followed. */
function listTree(dir: string, prefix = ''): string[] {
  return sortedEntries(dir).flatMap((entry) =>
    entry.isDirectory()
      ? listTree(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/**
 * A frontmatter field's value as the SDK's loader reads it: the string, or
 * `null` for anything else (a list, a mapping, a number, a boolean, no value).
 * `inline` is the text after `key:`; `rest` the indented lines below it.
 */
function frontmatterValue(inline: string, rest: string[]): string | null {
  const content = rest.filter((line) => line.trim() !== '');
  if (inline === '' || inline.startsWith('#')) {
    const [first, ...more] = content;
    // A value on the next line is a scalar unless it opens a list or a mapping.
    if (first === undefined || /^(?:-(?:\s|$)|["']?[\w-]+["']?:(?:\s|$))/.test(first.trim())) {
      return null;
    }
    return frontmatterValue(first.trim(), more);
  }
  const block = /^([>|])([+-]?)/.exec(inline);
  if (block) {
    const indent = Math.min(...content.map((line) => /^ */.exec(line)?.[0].length ?? 0));
    const lines = rest.map((line) => line.slice(indent));
    while (lines.at(-1)?.trim() === '') lines.pop();
    // Folding joins adjacent lines with a space; each blank line becomes a line break.
    const text =
      block[1] === '|'
        ? lines.join('\n')
        : lines.reduce((out, line, i) => {
            if (i === 0) return line;
            if (line === '') return `${out}\n`;
            return `${out}${lines[i - 1] === '' ? '' : ' '}${line}`;
          }, '');
    return block[2] === '-' ? text : `${text}\n`;
  }
  if (inline.startsWith('"')) {
    const quoted = /^"(?:\\.|[^"\\])*"/.exec(inline)?.[0] ?? inline;
    try {
      return JSON.parse(quoted) as string;
    } catch {
      return quoted.slice(1, -1);
    }
  }
  if (inline.startsWith("'")) {
    return (/^'((?:''|[^'])*)'/.exec(inline)?.[1] ?? inline.slice(1)).replaceAll("''", "'");
  }
  if (inline.startsWith('[') || inline.startsWith('{')) return null;
  const plain = [inline, ...content.map((line) => line.trim())]
    .map((part) => part.replace(/[\t ]#.*$/, ''))
    .join(' ');
  return YAML_NON_STRING.test(plain) ? null : plain;
}

/**
 * The top-level fields of a `SKILL.md` frontmatter, read only as far as the
 * project rules need. The SDK's strict loader owns the YAML subset and reports
 * a frontmatter it cannot parse, so this never rejects one: a file with no
 * frontmatter yields no fields.
 */
function frontmatterFields(frontmatter: string): Map<string, string | null> {
  const fields = new Map<string, string | null>();
  const lines = frontmatter.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = /^([\w-]+):(?:[\t ]+(.*))?$/.exec(lines[i] ?? '');
    if (!field?.[1]) continue;
    const rest: string[] = [];
    while (i + 1 < lines.length && /^(?:[\t ]|$)/.test(lines[i + 1] ?? '')) {
      rest.push(lines[++i] ?? '');
    }
    fields.set(field[1], frontmatterValue((field[2] ?? '').trim(), rest));
  }
  return fields;
}

/** The project rules for one `skills/<name>/SKILL.md`; `label` is its path from the project root. */
function skillMdProblems(markdown: string, label: string): string[] {
  const errors: string[] = [];
  const lineCount = markdown.replace(/\r?\n$/, '').split(/\r?\n/).length;
  if (lineCount > SKILL_MD_MAX_LINES) {
    errors.push(
      `${label} is ${lineCount} lines — keep it at ${SKILL_MD_MAX_LINES} or fewer and move long material into ` +
        `${label.slice(0, -'SKILL.md'.length)}references/`,
    );
  }

  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/.exec(markdown)?.[1];
  if (frontmatter === undefined) return errors;
  const fields = frontmatterFields(frontmatter);

  const description = fields.get('description');
  const descriptionChars = typeof description === 'string' ? [...description].length : 0;
  if (descriptionChars > SKILL_DESCRIPTION_MAX_CHARS) {
    errors.push(
      `${label} "description" is ${descriptionChars} characters — keep it at ${SKILL_DESCRIPTION_MAX_CHARS} or ` +
        "fewer: a host keeps every installed skill's description in context for the whole session",
    );
  }
  if (fields.has('allowed-tools') && typeof fields.get('allowed-tools') !== 'string') {
    errors.push(
      `${label} "allowed-tools" is not a string — the Agent Skills specification defines it as one ` +
        'space-separated string of tool names',
    );
  }
  if (FRAMEWORK_AUDIENCE.test(frontmatter)) {
    errors.push(
      `${label} "metadata.audience" is "external" — the value reserved for framework-managed skills, which ` +
        'init copies and the skills sync tracks by it; remove "audience", which a published skill never carries',
    );
  }
  return errors;
}

/**
 * Check 17: the published root `skills/` tree. Every problem the SDK's strict
 * loader reports (through `validateSkillTree`) fails, so a tree that passes is
 * served whole; the project rules run on top. `skillsDir` is the absolute path
 * of root `skills/`; every error names its path from the project root.
 */
export async function checkPublishedSkills(
  skillsDir: string,
  validateSkillTree: SkillTreeValidator,
): Promise<string[]> {
  const errors = (await validateSkillTree(skillsDir)).map(
    ({ path, message }) => `skills/${path === '.' ? '' : path}: ${message}`,
  );

  for (const entry of sortedEntries(skillsDir)) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const files = listTree(dir);
    if (!files.includes('SKILL.md')) {
      errors.push(
        `skills/${entry.name}/ has no SKILL.md — plugin hosts and the MCP server skip a skill folder without ` +
          `one; add skills/${entry.name}/SKILL.md or remove the folder`,
      );
    }
    for (const nested of files.filter((file) => file.endsWith('/SKILL.md'))) {
      errors.push(
        `skills/${entry.name}/${nested} sits below skills/${entry.name}/ — plugin hosts discover only ` +
          `skills/<name>/SKILL.md, while the MCP server serves it as a separate skill; move that skill to ` +
          `skills/${nested.split('/').at(-2)}/, or rename the file if it is reference material`,
      );
    }
    const skillMd = join(dir, 'SKILL.md');
    if (files.includes('SKILL.md') && !lstatSync(skillMd).isSymbolicLink()) {
      errors.push(
        ...skillMdProblems(readFileSync(skillMd, 'utf-8'), `skills/${entry.name}/SKILL.md`),
      );
    }
  }

  return errors;
}

/**
 * Check 17 (bundle surface): no `.mcpbignore` pattern may strip a file of the
 * published tree. A pre-0.13 `.mcpbignore` excluded `/skills/` when that path
 * held development skills; with the tree now published, the line strips it
 * from the bundle the Claude Directory serves it from. `skillFiles` are the
 * tree's files from the project root (`skills/<name>/SKILL.md`). One error per
 * pattern, naming the first file it strips.
 */
export async function checkSkillsKeptInBundle(
  raw: string,
  skillFiles: string[],
): Promise<string[]> {
  const createIgnore = await loadIgnore();
  if (!createIgnore) return [];

  const lines = ignorePatterns(raw);
  const all = createIgnore().add(lines);
  const stripped = skillFiles.filter((file) => all.ignores(file));
  if (stripped.length === 0) return [];

  return lines.flatMap((pattern) => {
    if (pattern.startsWith('!')) return [];
    const single = createIgnore().add([pattern]);
    const file = stripped.find((candidate) => single.ignores(candidate));
    return file === undefined
      ? []
      : [
          `.mcpbignore pattern "${pattern}" strips ${file} from the bundle — root skills/ holds the skills ` +
            'this server publishes, which the Claude Directory reads from the bundle; remove the line',
        ];
  });
}

/**
 * `validateSkillTree` from the installed framework. In the framework's own
 * repository the package self-reference resolves to `dist/`, so a build that
 * predates the export, or none at all, falls back to the source.
 */
async function loadSkillTreeValidator(): Promise<SkillTreeValidator> {
  try {
    const linter: object = await import('@cyanheads/mcp-ts-core/linter');
    if ('validateSkillTree' in linter && typeof linter.validateSkillTree === 'function') {
      return linter.validateSkillTree as SkillTreeValidator;
    }
  } catch {
    // Not built: the framework's own repository.
  }
  return (await import('../src/mcp-server/skills.js')).validateSkillTree;
}

/** Read `packaging.pluginManifests` from devcheck.config.json; default on. */
function pluginManifestsEnabled(): boolean {
  const cfg = tryReadJson<{ packaging?: { pluginManifests?: boolean } }>(
    resolve('devcheck.config.json'),
  );
  return cfg?.packaging?.pluginManifests ?? true;
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const pkg = tryReadJson<{ files?: unknown; name?: string; version?: string }>(
    resolve('package.json'),
  );
  const unscopedName = pkg?.name?.split('/').pop();
  const serverJson = tryReadJson<ServerJson>(resolve('server.json'));

  // ── Manifest-dependent checks (1–4 + manifest identity) ──
  const manifestPath = resolve('manifest.json');
  let manifest: Manifest | undefined;
  if (existsSync(manifestPath)) {
    manifest = tryReadJson<Manifest>(manifestPath);
    if (!manifest) {
      console.error('manifest.json is unreadable or malformed.');
      process.exit(1);
    }

    if (manifest.name?.includes('/')) {
      errors.push(
        `manifest.json "name" contains a scope prefix ("${manifest.name}") — use the bare package name (e.g. "${manifest.name.split('/').pop()}")`,
      );
    }

    const userConfig = manifest.user_config ?? {};
    for (const [key, entry] of Object.entries(userConfig)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const missing = (['title', 'type'] as const).filter(
        (f) => typeof entry[f] !== 'string' || (entry[f] as string).length === 0,
      );
      if (missing.length > 0) {
        errors.push(
          `manifest.json user_config["${key}"] is missing required field(s): ${missing.join(', ')} — mcpb pack will reject this`,
        );
      }
    }

    errors.push(...checkManifestUserConfigWiring(manifest));

    if (serverJson) {
      const manifestEnv = manifest.server?.mcp_config?.env ?? {};
      const manifestEnvKeys = new Set(Object.keys(manifestEnv));

      const manifestUserConfigKeys = new Set(
        Object.entries(manifestEnv)
          .filter(([, v]) => typeof v === 'string' && USER_CONFIG_REF.test(v))
          .map(([k]) => k),
      );

      const stdioEnvVars = (serverJson.packages ?? [])
        .filter((p) => p.transport?.type === 'stdio')
        .flatMap((p) => p.environmentVariables ?? []);
      const stdioEnvNames = new Set(stdioEnvVars.map((v) => v.name));
      const requiredStdioEnvNames = new Set(
        stdioEnvVars.filter((v) => v.isRequired === true && v.default == null).map((v) => v.name),
      );

      const missingInServerJson = [...manifestUserConfigKeys].filter((k) => !stdioEnvNames.has(k));
      const missingInManifest = [...requiredStdioEnvNames].filter((k) => !manifestEnvKeys.has(k));

      if (missingInServerJson.length > 0) {
        errors.push(
          `manifest.json references user_config env var(s) not advertised in server.json stdio environmentVariables[]: ${missingInServerJson.join(', ')}`,
        );
      }
      if (missingInManifest.length > 0) {
        errors.push(
          `server.json declares required stdio env var(s) without default missing from manifest.json mcp_config.env: ${missingInManifest.join(', ')}`,
        );
      }
    }

    if (unscopedName) {
      errors.push(...checkManifestIdentity(manifest, unscopedName));
    }

    errors.push(...checkManifestVersion(manifest, pkg?.version));
    errors.push(...checkBundleExcludedFromFiles(pkg?.files));
  } else {
    notes.push('No manifest.json — skipping manifest/server.json alignment checks.');
  }

  // ── server.json npm launch shape (check 16) ──
  if (serverJson) {
    errors.push(...checkServerJsonLaunch(serverJson));
  }

  // ── Bundle-content guard (checks 5–7) ──
  const mcpbignorePath = resolve('.mcpbignore');
  const mcpbignore = existsSync(mcpbignorePath) ? readFileSync(mcpbignorePath, 'utf-8') : undefined;
  if (mcpbignore !== undefined) {
    errors.push(...(await checkBundleContent(mcpbignore)));
  }

  // ── Published skills (check 17) ──
  const skillsDir = resolve('skills');
  if (existsSync(skillsDir)) {
    errors.push(...(await checkPublishedSkills(skillsDir, await loadSkillTreeValidator())));
    if (mcpbignore !== undefined) {
      const skillFiles = listTree(skillsDir).map((file) => `skills/${file}`);
      errors.push(...(await checkSkillsKeptInBundle(mcpbignore, skillFiles)));
    }
  }

  // ── Post-bundle content check (8) ──
  const distDir = resolve('dist');
  if (existsSync(distDir)) {
    for (const file of readdirSync(distDir).filter((f) => f.endsWith('.mcpb'))) {
      try {
        const listing = execFileSync('unzip', ['-Z1', join(distDir, file)], {
          encoding: 'utf-8',
          maxBuffer: 64 * 1024 * 1024,
        });
        errors.push(
          ...checkBundleEntries(
            listing.split('\n').filter((line) => line.length > 0),
            `dist/${file}`,
          ),
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          notes.push(`unzip not available — skipping bundle content check for dist/${file}.`);
        } else {
          errors.push(
            `failed to list entries of dist/${file}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }

  // ── Entrypoint identity check (9) ──
  if (unscopedName) {
    for (const entry of ['src/index.ts', 'src/worker.ts']) {
      const entryPath = resolve(entry);
      if (!existsSync(entryPath)) continue;
      const result = checkEntrypointIdentity(readFileSync(entryPath, 'utf-8'), unscopedName, entry);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
  }

  // ── Dockerfile build platform (check 15) ──
  const dockerfilePath = resolve('Dockerfile');
  if (existsSync(dockerfilePath)) {
    errors.push(...checkDockerfileBuildPlatform(readFileSync(dockerfilePath, 'utf-8')));
  }

  // ── README version badge (check 12) ──
  const readmePath = resolve('README.md');
  if (existsSync(readmePath)) {
    errors.push(...checkReadmeVersionBadge(readFileSync(readmePath, 'utf-8'), pkg?.version));
  }

  // ── Plugin marketplace manifests (check 10) ──
  if (unscopedName && pkg?.name) {
    if (pluginManifestsEnabled()) {
      /** A root Agent Plugins file: undefined when absent, null when present but unparseable. */
      const readRoot = (file: string): unknown =>
        existsSync(resolve(file)) ? (tryReadJson(resolve(file)) ?? null) : undefined;
      errors.push(
        ...checkPluginManifests(
          {
            claudePlugin: tryReadJson(resolve('.claude-plugin/plugin.json')),
            codexPlugin: tryReadJson(resolve('.codex-plugin/plugin.json')),
            codexMcp: tryReadJson(resolve('.codex-plugin/mcp.json')),
            rootPlugin: readRoot('plugin.json'),
            rootMcp: readRoot('mcp.json'),
          },
          unscopedName,
          pkg.name,
          pkg.version,
        ),
      );
    } else {
      notes.push(
        'Plugin-manifest checks disabled via devcheck.config.json packaging.pluginManifests.',
      );
    }
  }

  for (const note of notes) console.log(note);
  for (const warning of warnings) console.warn(`  ⚠ ${warning}`);

  if (errors.length === 0) {
    console.log('Packaging alignment OK.');
    process.exit(0);
  }
  for (const err of errors) console.error(`  ✗ ${err}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

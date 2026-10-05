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
 *   5. Bundle-content guard: known root dev directories must not appear at
 *      bundle root after `.mcpbignore` evaluation (dev dir not excluded).
 *   6. Bundle-content guard: `.mcpbignore` must not use unanchored patterns
 *      for root dev dirs — an unanchored `framework-skills/` also strips
 *      `node_modules/x/framework-skills/` (runtime path bypass, issues #172/#207).
 *   7. Bundle-content guard: `.mcpbignore` patterns must not strip critical
 *      runtime package paths (e.g. `node_modules/@opentelemetry/api/build/src/`).
 *   8. Post-bundle content: a built `.mcpb` under `dist/` must contain zero
 *      `node_modules/**` agent-doc entries (dependency-shipped `framework-skills/`,
 *      `skills/`, `.claude/`, `.agents/`, `SKILL.md`) — unreachable by root-anchored
 *      `.mcpbignore` patterns; `scripts/clean-mcpb.ts` strips them at bundle
 *      time (issue #230).
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
 *
 * Every check skips cleanly when its input is absent — consumers who deleted
 * `manifest.json` for an HTTP-only deploy, or who haven't built a bundle,
 * should not fail the checks that need those files.
 *
 * @module scripts/lint-packaging
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * in step with the directory entries in this project's `.mcpbignore` — seeded
 * from the mcp-ts-core repository's `templates/_.mcpbignore`, whose `_` prefix
 * `init` drops on copy.
 */
export const KNOWN_DEV_DIRS = ['framework-skills/', '.agents/', '.claude/'];

/**
 * Critical runtime paths that must NOT be stripped by any `.mcpbignore` pattern.
 * These are sampled representative paths — enough to catch a bare `framework-skills/`
 * pattern accidentally stripping `node_modules/…/framework-skills/`.
 */
export const CRITICAL_RUNTIME_PATHS = [
  'node_modules/@opentelemetry/api/build/src/',
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

export async function checkBundleContent(raw: string): Promise<string[]> {
  const errors: string[] = [];

  let createIgnore: IgnoreFactory;
  try {
    // Dynamic import so the rest of the linter still runs when `ignore` is absent.
    const mod: unknown = await import('ignore');
    createIgnore = ((mod as { default?: unknown }).default ?? mod) as IgnoreFactory;
  } catch {
    // `ignore` not installed — skip the guard without failing (e.g. in a minimal
    // CI environment that omits devDependencies).
    return errors;
  }

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const ig = createIgnore().add(lines);

  // Check 5: dev dirs must be excluded at bundle root.
  for (const dir of KNOWN_DEV_DIRS) {
    const probe = `${dir}README.md`;
    if (!ig.ignores(probe)) {
      errors.push(
        `.mcpbignore does not exclude root dev directory "${dir}" — ` +
          `bundle will include dev files. Add a pattern like "/${dir}" to exclude it.`,
      );
    }
  }

  // Check 6: unanchored dev-dir patterns also strip runtime paths inside
  // node_modules. Any pattern that excludes a known dev dir must be anchored
  // (leading "/") so it only matches at root.
  for (const dir of KNOWN_DEV_DIRS) {
    // Strip trailing slash for the node_modules probe path.
    const name = dir.replace(/\/$/, '');
    const runtimeProbe = `node_modules/some-pkg/${name}/index.js`;
    if (ig.ignores(runtimeProbe)) {
      // Find the offending pattern.
      const offending = lines.filter((p) => {
        try {
          return createIgnore().add([p]).ignores(runtimeProbe);
        } catch {
          return false;
        }
      });
      errors.push(
        `.mcpbignore uses an unanchored pattern that also strips runtime paths under node_modules: ` +
          `[${offending.join(', ')}]. Use a leading "/" to anchor to root (e.g. "/${dir}").`,
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
 * entries and zero platform-specific native bindings. `scripts/clean-mcpb.ts`
 * (wired into the `bundle` script) strips both after `mcpb pack`.
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

/** Parsed plugin marketplace manifests; an absent manifest is `undefined`. */
export interface PluginManifestInputs {
  claudePlugin?: unknown;
  codexMcp?: unknown;
  codexPlugin?: unknown;
}

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
  if (existsSync(mcpbignorePath)) {
    errors.push(...(await checkBundleContent(readFileSync(mcpbignorePath, 'utf-8'))));
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
      errors.push(
        ...checkPluginManifests(
          {
            claudePlugin: tryReadJson(resolve('.claude-plugin/plugin.json')),
            codexPlugin: tryReadJson(resolve('.codex-plugin/plugin.json')),
            codexMcp: tryReadJson(resolve('.codex-plugin/mcp.json')),
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

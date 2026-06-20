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
 *      for root dev dirs — an unanchored `skills/` also strips
 *      `node_modules/x/skills/` (runtime path bypass, issues #172/#207).
 *   7. Bundle-content guard: `.mcpbignore` patterns must not strip critical
 *      runtime package paths (e.g. `node_modules/@opentelemetry/api/build/src/`).
 *   8. Post-bundle content: a built `.mcpb` under `dist/` must contain zero
 *      `node_modules/**` agent-doc entries (dependency-shipped `skills/`,
 *      `.claude/`, `.agents/`, `SKILL.md`) — unreachable by root-anchored
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
 *      is a guaranteed install 404. Gated by `devcheck.config.json`
 *      `packaging.pluginManifests` (default on); each manifest is skipped
 *      cleanly when absent (issue #240).
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
  server?: { mcp_config?: { env?: Record<string, string> } };
  user_config?: Record<string, ManifestUserConfigEntry>;
}

const USER_CONFIG_REF = /^\$\{user_config\.([\w-]+)\}$/;

/**
 * Root dev directories the scaffold template excludes from the bundle, and
 * whose `.mcpbignore` patterns must be anchored with `/` to avoid also
 * stripping nested runtime paths like `node_modules/x/skills/`. Keep in step
 * with the directory entries in `templates/_.mcpbignore`.
 */
export const KNOWN_DEV_DIRS = ['skills/', '.agents/', '.claude/'];

/**
 * Critical runtime paths that must NOT be stripped by any `.mcpbignore` pattern.
 * These are sampled representative paths — enough to catch a bare `skills/`
 * pattern accidentally stripping `node_modules/…/skills/`.
 */
export const CRITICAL_RUNTIME_PATHS = [
  'node_modules/@opentelemetry/api/build/src/',
  'node_modules/@modelcontextprotocol/sdk/dist/',
  'node_modules/@cyanheads/mcp-ts-core/dist/',
  'dist/index.js',
];

/**
 * Agent-doc entries under `node_modules/` that must not ship in a bundle.
 * KEEP IN SYNC with `AGENT_DOC_ENTRY` in `scripts/clean-mcpb.ts` (the strip
 * step this check verifies) — a unit test asserts the two are identical.
 */
export const AGENT_DOC_ENTRY =
  /^node_modules\/.*(?:\/skills\/|\/\.claude\/|\/\.agents\/|\/SKILL\.md$)/;

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
 * **Context note:** this guard runs inside the scaffolded server project, not
 * inside mcp-ts-core itself. `ignore` is listed in `templates/package.json`
 * devDependencies (`^7.0.5`) and is therefore available in the server's
 * `node_modules` when `bun run lint:packaging` is invoked there.
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
 * entries. `scripts/clean-mcpb.ts` (wired into the `bundle` script) strips
 * them after `mcpb pack`.
 */
export function checkBundleEntries(entries: string[], bundleLabel: string): string[] {
  const offending = entries.filter((entry) => AGENT_DOC_ENTRY.test(entry));
  if (offending.length === 0) return [];
  const sample = offending
    .slice(0, 5)
    .map((entry) => `\n      ${entry}`)
    .join('');
  return [
    `${bundleLabel} contains ${offending.length} node_modules agent-doc entries ` +
      `(dependency-shipped skills/, .claude/, .agents/, SKILL.md) — re-run the \`bundle\` ` +
      `script (scripts/clean-mcpb.ts strips them):${sample}`,
  ];
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

/**
 * Check 10: plugin marketplace manifests. Display fields (`name`, server key,
 * `interface.displayName`) must equal the unscoped machine name; the install
 * arg must equal the full `package.json` name (the real `npx` target). Empty
 * descriptions ship blank marketplace cards. Each manifest is validated only
 * when present, so HTTP-only and non-plugin consumers are unaffected. The
 * caller gates the whole check on `packaging.pluginManifests`.
 */
export function checkPluginManifests(
  inputs: PluginManifestInputs,
  unscopedName: string,
  fullName: string,
): string[] {
  const errors: string[] = [];
  const optOut =
    '(or set "packaging": { "pluginManifests": false } in devcheck.config.json to opt out)';

  // ── .claude-plugin/plugin.json ──
  const claude = inputs.claudePlugin;
  if (isRecord(claude)) {
    const f = '.claude-plugin/plugin.json';
    if (!isNonEmptyString(claude.description)) {
      errors.push(`${f} "description" is empty — populate it ${optOut}`);
    }
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
      if (isRecord(entry) && installArg(entry) !== fullName) {
        errors.push(
          `${f} mcpServers["${unscopedName}"] install arg is "${String(installArg(entry))}" — ` +
            `must be the full package name "${fullName}" (the npx -y target; an unscoped arg for a scoped package 404s)`,
        );
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
    if (isRecord(entry) && installArg(entry) !== fullName) {
      errors.push(
        `${f} "${unscopedName}" install arg is "${String(installArg(entry))}" — ` +
          `must be the full package name "${fullName}" (the npx -y target)`,
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

  const pkg = tryReadJson<{ name?: string }>(resolve('package.json'));
  const unscopedName = pkg?.name?.split('/').pop();

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

    const serverJson = tryReadJson<ServerJson>(resolve('server.json'));
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
  } else {
    notes.push('No manifest.json — skipping manifest/server.json alignment checks.');
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

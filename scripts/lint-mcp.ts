#!/usr/bin/env node
/**
 * @fileoverview MCP definition linter CLI.
 * Discovers tool/resource/prompt definitions from conventional locations,
 * runs `validateDefinitions()`, and reports results.
 *
 * Used by devcheck and as a standalone script: `bun run lint:mcp` / `npm run lint:mcp`
 *
 * Discovery strategy:
 *   1. Globs for `*.tool.ts`, `*.resource.ts`, `*.prompt.ts` in known paths
 *   2. Dynamically imports each file
 *   3. Extracts exported definitions by duck-typing (has name/handler/input etc.)
 *   4. Feeds them into `validateDefinitions()`
 *
 * A definition file whose `import()` rejects, and a `server.json` that exists
 * but does not parse, are errors (`definition-import-failed`,
 * `server-json-parse`): what they declare cannot be checked, so the run fails
 * instead of passing without them. The remaining files are still linted.
 *
 * Runtime-agnostic: works with bun, tsx, and Node.js (via ts-node/esm).
 *
 * Rule knobs come from the project's `devcheck.config.json` `lint` block, so one
 * declaration covers every entrypoint that shells out to this script.
 *
 * @module scripts/lint-mcp
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Import validateDefinitions — resolve from package or local source
// ---------------------------------------------------------------------------

let validateDefinitions: typeof import('../src/linter/validate.js').validateDefinitions;

try {
  // Consumer path: installed as a dependency
  const pkg = await import('@cyanheads/mcp-ts-core/linter');
  validateDefinitions = pkg.validateDefinitions;
} catch {
  // Framework path: running from the framework repo itself
  const local = await import('../src/linter/validate.js');
  validateDefinitions = local.validateDefinitions;
}

// ---------------------------------------------------------------------------
// Definition detection (duck-typing)
// ---------------------------------------------------------------------------

function isToolLike(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.handler === 'function' && o.input != null && o.output != null;
}

function isResourceLike(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.uriTemplate === 'string' && typeof o.handler === 'function';
}

function isPromptLike(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.generate === 'function' && typeof o.name === 'string' && !('handler' in o);
}

// ---------------------------------------------------------------------------
// File discovery (no bun dependency — uses Node.js fs)
// ---------------------------------------------------------------------------

const SEARCH_DIRS = ['examples/mcp-server', 'src/mcp-server'];

const DEFINITION_SUFFIXES = [
  '.tool.ts',
  '.resource.ts',
  '.prompt.ts',
  '.app-tool.ts',
  '.app-resource.ts',
];

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (DEFINITION_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      results.push(full);
    }
  }
  return results;
}

function discoverFiles(): string[] {
  const files: string[] = [];
  for (const dir of SEARCH_DIRS) {
    const resolved = resolve(dir);
    files.push(...walkDir(resolved));
  }
  return [...new Set(files)];
}

// ---------------------------------------------------------------------------
// Load failures
// ---------------------------------------------------------------------------

/** Where the rule reference lives — the breadcrumb `validateDefinitions()` appends too. */
const SKILL_REFERENCE_PATH = 'framework-skills/api-linter/SKILL.md';

/** A file the CLI could not load, shaped like the diagnostics it is printed beside. */
interface LoadFailure {
  message: string;
  rule: 'definition-import-failed' | 'server-json-parse';
}

/**
 * The text of a thrown value. An `AggregateError` keeps its causes in `errors`
 * — Bun rejects a definition that fails to transpile with one whose own message
 * only counts them ("2 errors building …") — so each cause is appended.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const message = err.message || err.name;
  if (!(err instanceof AggregateError) || err.errors.length === 0) return message;
  return `${message} (${err.errors.map(describeError).join('; ')})`;
}

function loadFailure(rule: LoadFailure['rule'], file: string, err: unknown): LoadFailure {
  const anchor = rule === 'server-json-parse' ? 'server-json-rules' : rule;
  return {
    rule,
    message: `${file}: ${describeError(err)}\nSee: ${SKILL_REFERENCE_PATH}#${anchor}`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** A parsed JSON file, or the error an existing one failed to read or parse with. */
type JsonRead = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Reads and parses a JSON file. `undefined` when the file does not exist. */
function readJson(path: string): JsonRead | undefined {
  if (!existsSync(path)) return;
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf-8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Try to read and parse a JSON file. Returns undefined when absent, and warns when unparseable. */
function tryReadJson(path: string): unknown {
  const read = readJson(path);
  if (read?.ok === false) {
    console.warn(`Warning: Failed to parse ${path}: ${describeError(read.error)}`);
    return;
  }
  return read?.value;
}

/** The `lint` block of `devcheck.config.json`, as far as this script reads it. */
interface LintConfig {
  lint?: { truncationAllowlist?: unknown };
}

/** The `LintInput` knobs a project declares in `devcheck.config.json`. */
export interface LintOptions {
  truncationAllowlist?: ReadonlyArray<string> | false;
}

/**
 * Reads `lint.truncationAllowlist` from the project's `devcheck.config.json`.
 *
 * An absent or unreadable key yields `{}`, which leaves `validateDefinitions()`
 * to fall back to `MCP_LINT_TRUNCATION_ALLOWLIST`. A declared value is passed as
 * `LintInput.truncationAllowlist` and therefore wins over that env var — a
 * reviewed, version-controlled exemption is not something ambient environment
 * should override.
 */
export function readLintOptions(configPath = resolve('devcheck.config.json')): LintOptions {
  const allowlist = (tryReadJson(configPath) as LintConfig | undefined)?.lint?.truncationAllowlist;
  if (allowlist === undefined) return {};
  if (allowlist === false) return { truncationAllowlist: false };
  if (Array.isArray(allowlist) && allowlist.every((name) => typeof name === 'string')) {
    return { truncationAllowlist: allowlist as string[] };
  }
  console.warn(
    `Warning: ${configPath} "lint.truncationAllowlist" must be an array of tool names or false — ignoring it.`,
  );
  return {};
}

async function main(): Promise<void> {
  const files = discoverFiles();
  const failures: LoadFailure[] = [];

  // Discover server.json and package.json at project root
  const serverJsonRead = readJson(resolve('server.json'));
  if (serverJsonRead?.ok === false) {
    failures.push(loadFailure('server-json-parse', 'server.json', serverJsonRead.error));
  }
  const serverJson = serverJsonRead?.ok ? serverJsonRead.value : undefined;
  const packageJson = tryReadJson(resolve('package.json')) as { version?: string } | undefined;

  if (files.length === 0 && serverJson == null && failures.length === 0) {
    console.log('No MCP definition files or server.json found. Skipping lint.');
    process.exit(0);
  }

  const tools: unknown[] = [];
  const resources: unknown[] = [];
  const prompts: unknown[] = [];
  let failedImports = 0;

  for (const file of files) {
    let mod: Record<string, unknown>;
    try {
      mod = await import(file);
    } catch (err) {
      failures.push(loadFailure('definition-import-failed', relative(process.cwd(), file), err));
      failedImports++;
      continue;
    }
    for (const exported of Object.values(mod)) {
      if (isToolLike(exported)) tools.push(exported);
      else if (isResourceLike(exported)) resources.push(exported);
      else if (isPromptLike(exported)) prompts.push(exported);
    }
  }

  const defTotal = tools.length + resources.length + prompts.length;
  if (defTotal === 0 && serverJson == null && failures.length === 0) {
    console.log(`Scanned ${files.length} files but found no definitions. Skipping lint.`);
    process.exit(0);
  }

  const parts: string[] = [];
  if (defTotal > 0 || failedImports > 0) {
    const fileCount =
      failedImports === 0
        ? `${files.length}`
        : `${files.length - failedImports} of ${files.length}`;
    parts.push(
      `${tools.length} tool(s), ${resources.length} resource(s), ${prompts.length} prompt(s) from ${fileCount} file(s)`,
    );
  }
  if (serverJson != null) parts.push('server.json');
  if (parts.length > 0) console.log(`Linting ${parts.join(' + ')}...`);

  const report = validateDefinitions({
    tools,
    resources,
    prompts,
    serverJson,
    ...(packageJson ? { packageJson } : {}),
    ...readLintOptions(),
  });

  const errors = [...failures, ...report.errors];
  for (const w of report.warnings) {
    console.warn(`  ⚠ [${w.rule}] ${w.message}`);
  }
  for (const e of errors) {
    console.error(`  ✗ [${e.rule}] ${e.message}`);
  }

  if (errors.length === 0) {
    if (report.warnings.length > 0) {
      console.log(`\nPassed with ${report.warnings.length} warning(s).`);
    } else {
      console.log('\nAll definitions valid.');
    }
    process.exit(0);
  } else {
    console.error(`\nFailed: ${errors.length} error(s), ${report.warnings.length} warning(s).`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((err) => {
    console.error('lint-mcp failed:', err);
    process.exit(1);
  });
}

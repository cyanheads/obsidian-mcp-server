#!/usr/bin/env tsx
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * @fileoverview Comprehensive development script for quality and security checks.
 * @module scripts/devcheck
 * @description
 *   This script runs a series of checks (linting, types, formatting, security, etc.).
 *   It is optimized for speed with caching, incremental builds, and parallel execution.
 *   Pre-commit hooks analyze only staged files for maximum performance.
 *
 * @performance
 *   - Uses Biome for unified linting and formatting
 *   - Uses TypeScript incremental builds (.tsbuildinfo) for faster type checking
 *   - Runs all checks in parallel using Promise.allSettled
 *   - Fast mode (--fast) skips slow network-bound checks
 *
 * @example
 * // Run all checks (Auto-fixing enabled):
 * // bun run scripts/devcheck.ts
 *
 * // Run in read-only mode:
 * // bun run scripts/devcheck.ts --no-fix
 *
 * // Fast mode (skip network-bound checks like audit, outdated):
 * // bun run scripts/devcheck.ts --fast
 *
 * // Skip specific checks:
 * // bun run scripts/devcheck.ts --no-lint --no-audit
 *
 * // Enable optional checks (e.g., tests are off by default):
 * // bun run scripts/devcheck.ts --test
 *
 * // Run only a single check (case-insensitive partial match):
 * // bun run scripts/devcheck.ts --only lint
 */
/** Track active child processes for clean shutdown on SIGINT/SIGTERM. */
const activeProcs = new Set<ChildProcess>();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const proc of activeProcs) {
      proc.kill();
    }
    process.exit(130);
  });
}

// =============================================================================
// Embedded Dependencies
// =============================================================================

// picocolors (https://github.com/alexeyraspopov/picocolors) - MIT License
// Embedded so the script runs without needing 'npm install'.
// Respects NO_COLOR (https://no-color.org/) and FORCE_COLOR conventions.
const isColorSupported =
  !process.env.NO_COLOR &&
  ((!!process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') || !!process.stdout.isTTY);

const createColor = (open: string, close: string, closeRe: RegExp) => (str: string | number) => {
  if (!isColorSupported) return `${str}`;
  // Replace any inner close sequences so outer color is restored
  return open + `${str}`.replace(closeRe, close + open) + close;
};

const esc = (code: string) => new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
const c = {
  bold: createColor('\x1b[1m', '\x1b[22m', esc('\x1b[22m')),
  dim: createColor('\x1b[2m', '\x1b[22m', esc('\x1b[22m')),
  red: createColor('\x1b[31m', '\x1b[39m', esc('\x1b[39m')),
  green: createColor('\x1b[32m', '\x1b[39m', esc('\x1b[39m')),
  yellow: createColor('\x1b[33m', '\x1b[39m', esc('\x1b[39m')),
  blue: createColor('\x1b[34m', '\x1b[39m', esc('\x1b[39m')),
  magenta: createColor('\x1b[35m', '\x1b[39m', esc('\x1b[39m')),
  cyan: createColor('\x1b[36m', '\x1b[39m', esc('\x1b[39m')),
};

/** A type alias for the picocolors object. */
type Colors = typeof c;

// =============================================================================
// Types & Interfaces
// =============================================================================

type RunMode = 'check' | 'fix';
type UIMode = 'Checking' | 'Fixing';

interface AppContext {
  fastMode: boolean;
  flags: Set<string>;
  isHuskyHook: boolean;
  noFix: boolean;
  /** When set, only run checks whose name matches (case-insensitive). */
  onlyCheck: string | null;
  rootDir: string;
  /** List of staged files, populated only if isHuskyHook is true. */
  stagedFiles: string[];
}

interface CommandResult {
  checkName: string;
  duration: number;
  exitCode: number;
  /** Buffered log lines captured during parallel execution. */
  logLines: string[];
  skipped: boolean;
  stderr: string;
  stdout: string;
  /** If set, check passed but with a warning (e.g., upstream-only vulnerabilities). */
  warning?: string;
}

/** Represents the raw result from a shell execution. */
type ShellResult = Omit<CommandResult, 'checkName' | 'duration' | 'skipped' | 'logLines'>;

interface Check {
  /** Indicates if the check supports auto-fixing. */
  canFix: boolean;
  /** The flag to skip this check (e.g., '--no-lint'). */
  flag: string;
  /** Function that returns the command array based on the context and mode. Returns null to skip. */
  getCommand: (ctx: AppContext, mode: RunMode) => string[] | null;
  /**
   * Optional predicate to determine success.
   * Useful for tools that signal issues via stdout or have non-standard exit codes.
   * Return `{ success, warning }` to pass with a visible warning (e.g., upstream-only vulns).
   */
  isSuccess?: (
    result: ShellResult,
    mode: RunMode,
  ) => boolean | { success: boolean; warning?: string };
  name: string;
  /** If true, check is off by default — only runs when its flag is explicitly provided. */
  requiresFlag?: boolean;
  /** If true, this check is skipped in fast mode (typically network-bound or very slow). */
  slowCheck?: boolean;
  tip?: (c: Colors) => string;
}

// =============================================================================
// Shell Operations
// =============================================================================

const Shell = {
  /**
   * Executes a shell command using child_process.spawn and returns a structured result.
   */
  exec(cmd: string[], options: { cwd: string }): Promise<ShellResult> {
    const [command = '', ...args] = cmd;
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(command, args, {
          cwd: options.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        resolve({
          exitCode: 127,
          stdout: '',
          stderr: `Failed to execute command: ${command}\nError: ${errorMessage}`,
        });
        return;
      }

      activeProcs.add(proc);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let spawnError: Error | undefined;

      proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      proc.on('error', (err) => {
        spawnError = err;
      });

      proc.on('close', (code) => {
        activeProcs.delete(proc);
        if (spawnError) {
          resolve({
            exitCode: 127,
            stdout: '',
            stderr: `Failed to execute command: ${command}\nError: ${spawnError.message}`,
          });
        } else {
          resolve({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdoutChunks).toString('utf-8').trim(),
            stderr: Buffer.concat(stderrChunks).toString('utf-8').trim(),
          });
        }
      });
    });
  },

  /**
   * Retrieves the list of currently staged files, filtering out deleted files.
   */
  async getStagedFiles(rootDir: string): Promise<string[]> {
    // ACMR = Added, Copied, Modified, Renamed. We exclude D (Deleted).
    const { stdout, exitCode, stderr } = await Shell.exec(
      ['git', 'diff', '--name-only', '--cached', '--diff-filter=ACMR'],
      { cwd: rootDir },
    );

    if (exitCode !== 0) {
      UI.log(
        c.yellow(
          'Warning: Could not retrieve staged files. Is this a Git repository? Proceeding with full scan.',
        ),
      );
      UI.log(c.dim(stderr));
      return [];
    }

    return stdout.split('\n').filter(Boolean);
  },
};

// =============================================================================
// Configuration
// =============================================================================

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Project-local config (devcheck.config.json) ─────────────────────

interface DevcheckConfig {
  depcheck?: {
    ignores?: string[];
    ignorePatterns?: string[];
  };
  outdated?: {
    allowlist?: string[];
  };
  skillsSync?: {
    ignore?: string[];
  };
}

function loadDevcheckConfig(rootDir: string): DevcheckConfig {
  try {
    return JSON.parse(
      readFileSync(path.join(rootDir, 'devcheck.config.json'), 'utf-8'),
    ) as DevcheckConfig;
  } catch {
    return {};
  }
}

const DEVCHECK_CONFIG = loadDevcheckConfig(ROOT_DIR);

const OUTDATED_ALLOWLIST = new Set(DEVCHECK_CONFIG.outdated?.allowlist ?? []);

/** Use bun for package management commands if available, otherwise npm. */
const PM_CMD = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0 ? 'bun' : 'npm';

/**
 * Direct dependencies from package.json, used to classify audit vulnerabilities
 * as direct (fixable by us) vs transitive/upstream (requires upstream fix).
 */
const DIRECT_DEPS: ReadonlySet<string> = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
    return new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return new Set<string>();
  }
})();

/**
 * Parses `bun audit` output and classifies high/critical vulnerabilities as
 * direct (in our package.json) or upstream (transitive dependency we can't fix).
 *
 * Bun audit format per vulnerability block:
 *   <package>  <version-range>        ← header (no indent, 2+ spaces before range)
 *     <parent> › <child> [› ...]      ← dependency path (indented, › = transitive)
 *     <severity>: <description>       ← advisory (indented)
 *
 * Returns null if parsing yields no results (caller should fall back to default behavior).
 */
function classifyAuditVulns(output: string): { direct: string[]; upstream: string[] } | null {
  try {
    const lines = output.split('\n');
    const direct: string[] = [];
    const upstream: string[] = [];
    let i = 0;

    while (i < lines.length) {
      // Package header: non-indented, name followed by 2+ spaces then version constraint
      const pkgMatch = lines[i]?.match(/^([@\w][\w./-]*)\s{2,}(.+)$/);
      if (!pkgMatch) {
        i++;
        continue;
      }

      const [, pkg, versionRange] = pkgMatch;
      i++;

      let hasHighCritical = false;
      const paths: string[] = [];

      // Collect indented lines belonging to this block
      while (i < lines.length && (lines[i]?.startsWith('  ') ?? false)) {
        const trimmed = (lines[i] ?? '').trim();
        if (/^(critical|high):/i.test(trimmed)) {
          hasHighCritical = true;
        } else if (trimmed && !/^(moderate|low):/i.test(trimmed)) {
          paths.push(trimmed);
        }
        i++;
      }

      if (!hasHighCritical) continue;

      // Direct if: the vulnerable package is in our package.json,
      // or any dependency path lacks › (meaning it's not pulled in transitively)
      const pkgName = pkg ?? '';
      const isDirect = DIRECT_DEPS.has(pkgName) || paths.some((p) => !p.includes('\u203a'));
      if (isDirect) {
        direct.push(`${pkgName} ${versionRange}`);
      } else {
        const via = paths[0]?.split(/\s*\u203a\s*/)[0] ?? 'unknown';
        upstream.push(`${pkgName} ${versionRange} (via ${via})`);
      }
    }

    // If we found nothing despite high/critical text existing, parsing may have failed
    if (direct.length === 0 && upstream.length === 0) return null;

    return { direct, upstream };
  } catch {
    return null;
  }
}

// Define file extensions for linting and formatting
const LINT_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

const ALL_CHECKS: Check[] = [
  // Fast checks first (local operations, no network)
  {
    name: 'TODOs/FIXMEs',
    flag: '--no-todos',
    canFix: false,
    getCommand: (ctx) => {
      // git grep -n (line number) -E (extended regex) -i (case-insensitive)
      const baseCmd = ['git', 'grep', '-nEi', '\\b(TODO|FIXME)\\b'];
      // Exclude files where TODO/FIXME appears as prose or intentional stubs
      const excludes = [
        ':!CHANGELOG.md',
        ':!changelog/',
        ':!*.lock',
        ':!scripts/devcheck.ts',
        ':!tests/',
      ];
      if (ctx.isHuskyHook && ctx.stagedFiles.length > 0) {
        // Check only staged files in the working tree
        return [...baseCmd, '--', ...excludes, ...ctx.stagedFiles];
      }
      // Check the entire tracked repository (default behavior of git grep)
      return [...baseCmd, '--', ...excludes];
    },
    // git grep: exit 0 = matches found, exit 1 = no matches, exit 2+ = error.
    isSuccess: (result) => {
      if (result.exitCode === 0) return false; // Found TODOs — fail
      if (result.exitCode === 1) return true; // No matches — pass
      // Exit code >= 2 means git grep itself errored. Treat as failure
      // but override stdout so the summary shows the actual error, not "TODOs found".
      return false;
    },
    tip: (c) => `Resolve ${c.bold('TODO')} or ${c.bold('FIXME')} comments before committing.`,
  },
  {
    name: 'Tracked Secrets',
    flag: '--no-secrets',
    canFix: false,
    // Check if common sensitive files are tracked by git.
    getCommand: () => [
      'git',
      'ls-files',
      '*.env*',
      '**/.npmrc',
      '**/.netrc',
      '**/credentials.json',
      '**/*.pem',
      '**/*.key',
      '**/secret*',
      '**/.htpasswd',
    ],
    // Success if output is empty OR only contains safe patterns.
    isSuccess: (result, _mode) => {
      if (result.exitCode !== 0) return false;
      const SAFE_PATTERNS = ['.env.example', '.env.template', '.env.sample'];
      const files = result.stdout.trim().split('\n').filter(Boolean);
      const dangerous = files.filter((f) => !SAFE_PATTERNS.some((safe) => f.endsWith(safe)));
      return dangerous.length === 0;
    },
    tip: (c) =>
      `Add sensitive files to ${c.bold('.gitignore')} and run ${c.bold('git rm --cached <file>')}.`,
  },
  {
    name: 'MCP Definitions',
    flag: '--no-mcp-lint',
    canFix: false,
    getCommand: () => ['bun', 'run', 'scripts/lint-mcp.ts'],
    tip: (c) =>
      `Fix definition errors above — each diagnostic links to its rule in ${c.bold('skills/api-linter/SKILL.md')}.`,
  },
  {
    name: 'Framework Antipatterns',
    flag: '--no-framework-antipatterns',
    canFix: false,
    getCommand: () => ['bun', 'run', 'scripts/check-framework-antipatterns.ts'],
    tip: (c) =>
      `Remove the flagged SDK-coupling shortcut. See ${c.bold('scripts/check-framework-antipatterns.ts')} for rule rationale.`,
  },
  {
    name: 'Docs Sync',
    flag: '--no-docs-sync',
    canFix: false,
    getCommand: () => ['bun', 'run', 'scripts/check-docs-sync.ts'],
    tip: (c) =>
      `Edit both files together, or run ${c.bold('cp CLAUDE.md AGENTS.md')} (or reverse) to resync.`,
  },
  {
    name: 'Skills Sync',
    flag: '--no-skills-sync',
    canFix: false,
    // Compares canonical skills/ against local mirrors (.agents/skills, .claude/skills).
    // Skipped when skills/ or both mirrors are absent (non-mirrored projects).
    // Drift is demoted to a warning via isSuccess — intentional ignores live in
    // devcheck.config.json `skillsSync.ignore`.
    getCommand: () => {
      const hasSkills = existsSync(path.join(ROOT_DIR, 'skills'));
      const hasMirrors =
        existsSync(path.join(ROOT_DIR, '.agents/skills')) ||
        existsSync(path.join(ROOT_DIR, '.claude/skills'));
      if (!hasSkills || !hasMirrors) return null;
      return ['bun', 'run', 'scripts/check-skills-sync.ts'];
    },
    isSuccess: (result) => {
      if (result.exitCode === 0) return true;
      const firstLine = result.stdout.split('\n')[0]?.trim() || 'Skills mirrors have drifted.';
      return { success: true, warning: firstLine };
    },
    tip: (c) =>
      `Propagate ${c.bold('skills/')} to ${c.bold('.agents/skills/')} and ${c.bold('.claude/skills/')}, or add entries to ${c.bold('devcheck.config.json')} ${c.bold('skillsSync.ignore')}.`,
  },
  {
    name: 'Changelog Sync',
    flag: '--no-changelog-sync',
    canFix: false,
    // --check exits non-zero if CHANGELOG.md drifts from changelog/*.md.
    // Skipped cleanly when the directory-based changelog isn't in use — CHANGELOG.md
    // alone is a supported configuration (runtime-only consumers, opt-out per #41).
    getCommand: () => {
      if (!existsSync(path.join(ROOT_DIR, 'changelog'))) return null;
      return ['bun', 'run', 'scripts/build-changelog.ts', '--check'];
    },
    tip: (c) =>
      `Edit the per-version file in ${c.bold('changelog/')} and run ${c.bold('bun run changelog:build')} to regenerate ${c.bold('CHANGELOG.md')}.`,
  },
  {
    name: 'Biome',
    flag: '--no-lint',
    canFix: true,
    getCommand: (ctx, mode) => {
      const command = [path.join(ctx.rootDir, 'node_modules', '.bin', 'biome'), 'check'];
      if (mode === 'fix') {
        command.push('--write');
      }
      // In husky mode, target only staged files; otherwise let biome.json includes handle it
      if (ctx.isHuskyHook && ctx.stagedFiles.length > 0) {
        const relevant = ctx.stagedFiles.filter((file) =>
          [...LINT_EXTS, '.json'].includes(path.extname(file)),
        );
        if (relevant.length === 0) return null;
        command.push(...relevant);
      }
      return command;
    },
    tip: (c) => `Run without ${c.bold('--no-fix')} to automatically fix issues.`,
  },
  {
    name: 'TypeScript',
    flag: '--no-types',
    canFix: false,
    // TypeScript generally needs the whole project context for accurate checking.
    getCommand: (ctx) => [path.join(ctx.rootDir, 'node_modules', '.bin', 'tsc'), '--noEmit'],
    tip: () => 'Check TypeScript errors in your IDE or the console output.',
  },
  {
    name: 'Tests',
    flag: '--test',
    canFix: false,
    requiresFlag: true,
    getCommand: (ctx) => [path.join(ctx.rootDir, 'node_modules', '.bin', 'vitest'), 'run'],
    tip: () => 'Fix failing tests before committing.',
  },
  {
    name: 'Unused Dependencies',
    flag: '--no-depcheck',
    canFix: false,
    slowCheck: true,
    getCommand: (ctx) => {
      const cmd = [path.join(ctx.rootDir, 'node_modules', '.bin', 'depcheck')];
      const ignores = DEVCHECK_CONFIG.depcheck?.ignores ?? ['@types/*'];
      if (ignores.length > 0) cmd.push(`--ignores=${ignores.join(',')}`);
      const patterns = DEVCHECK_CONFIG.depcheck?.ignorePatterns ?? [];
      if (patterns.length > 0) cmd.push(`--ignore-patterns=${patterns.join(',')}`);
      return cmd;
    },
    tip: (c) =>
      `Remove unused packages with ${c.bold(`${PM_CMD} remove <pkg>`)} or add to ${c.bold('devcheck.config.json')} ignores.`,
  },
  // Slow checks last (network-bound operations)
  {
    name: 'Security Audit',
    flag: '--no-audit',
    canFix: false, // audit --fix exists but often requires manual review.
    slowCheck: true,
    getCommand: () => [PM_CMD, 'audit'],
    isSuccess: (result, _mode) => {
      // If the command exits 0, no vulnerabilities were found.
      if (result.exitCode === 0) return true;

      const output = result.stdout;
      if (output.includes('0 vulnerabilities found')) return true;

      // Detect audit failures (connection errors, registry issues, etc.)
      // If the output doesn't look like a valid audit response, warn rather than silently passing.
      const looksLikeAuditOutput = /vulnerabilit|severity|advisori/i.test(output);
      if (!looksLikeAuditOutput) {
        return {
          success: true,
          warning: `Audit command failed (exit ${result.exitCode}) — could not reach registry. Output: ${output.slice(0, 200).trim() || '(empty)'}`,
        };
      }

      // Pass if only low/moderate severity
      const hasHighOrCritical = /high|critical/i.test(output);
      if (!hasHighOrCritical) return true;

      // Classify: direct deps we can fix vs transitive deps we can't
      const classified = classifyAuditVulns(output);

      // If parsing failed, fall back to failing (conservative)
      if (!classified) return false;

      // Direct dep vulnerabilities — we can and should fix these
      if (classified.direct.length > 0) return false;

      // All high/critical are upstream/transitive — warn but don't fail
      if (classified.upstream.length > 0) {
        const n = classified.upstream.length;
        return {
          success: true,
          warning: [
            `${n} high/critical vulnerabilit${n === 1 ? 'y' : 'ies'} in transitive deps (upstream, no direct fix available):`,
            ...classified.upstream.map((v) => `  - ${v}`),
          ].join('\n'),
        };
      }

      return true;
    },
    tip: (c) =>
      `Direct dependency vulnerabilities found. Run ${c.bold(`${PM_CMD} update`)} or ${c.bold(`${PM_CMD} audit --fix`)} to resolve.`,
  },
  {
    name: 'Dependencies (Outdated)',
    flag: '--no-deps',
    canFix: false,
    slowCheck: true,
    getCommand: () => [PM_CMD, 'outdated'],
    isSuccess: (result) => {
      // Exit 0 with empty output = everything up to date
      if (result.exitCode === 0 && result.stdout.trim() === '') return true;

      // Non-zero exit with no tabular output likely means a network/lockfile error — fail hard
      const output = result.stdout.trim();
      if (result.exitCode !== 0 && !output.includes('|')) return false;

      // Parse the tabular output. Package lines contain '|' separators.
      // Filter out header/separator rows and allowlisted packages.
      const lines = output.split('\n');
      const packageLines = lines.filter((line) => {
        if (!line.includes('|')) return false;
        // Skip table chrome: header row and separator (e.g., "---")
        const firstCell = line.split('|')[0]?.trim() ?? '';
        if (!firstCell || firstCell === 'Package' || /^-+$/.test(firstCell)) return false;
        return true;
      });

      // Check if every outdated package is in the allowlist
      const unexpected = packageLines.filter((line) => {
        const pkgName = line.split('|')[0]?.trim() ?? '';
        return !OUTDATED_ALLOWLIST.has(pkgName);
      });

      return unexpected.length === 0;
    },
    tip: (c) =>
      `Run ${c.bold(`${PM_CMD} update`)} to upgrade; the ${c.bold('maintenance')} skill then investigates changelogs and adopts upstream changes. Configure allowlist in ${c.bold('devcheck.config.json')}.`,
  },
];

// =============================================================================
// UI & Logging
// =============================================================================

const UI = {
  log: console.log,

  // ---------------------------------------------------------------------------
  // Format helpers — return strings for buffered output during parallel execution
  // ---------------------------------------------------------------------------

  formatCheckStart(check: Check, command: string[], mode: UIMode): string {
    let commandStr = command.join(' ');
    if (commandStr.length > 150) {
      commandStr = `${commandStr.substring(0, 147)}... (truncated)`;
    }
    return [
      `${c.bold(c.blue('🔷'))} ${mode} ${c.yellow(check.name)}${c.blue('...')} `,
      c.dim(`   $ ${commandStr}`),
    ].join('\n');
  },

  formatSkipped(check: Check, reason: string): string {
    return `${c.bold(c.yellow(`🔶 Skipping ${check.name}...`))}${c.dim(` (${reason})`)}`;
  },

  formatCheckResult(result: CommandResult, _mode: UIMode): string {
    const { checkName, exitCode, duration } = result;
    if (exitCode === 0) {
      return `${c.bold(c.green('✅'))} ${c.yellow(checkName)} ${c.green(`finished successfully in ${duration}ms.`)}`;
    }
    return `${c.bold(c.red('❌'))} ${c.yellow(checkName)} ${c.red(`failed (Code ${exitCode}) in ${duration}ms.`)}`;
  },

  // ---------------------------------------------------------------------------
  // Print helpers — write directly to stdout (used outside parallel sections)
  // ---------------------------------------------------------------------------

  /** Flush buffered log lines from a completed check result. */
  flushCheckLog(result: CommandResult) {
    for (const line of result.logLines) {
      UI.log(line);
    }
  },

  printHeader(ctx: AppContext) {
    let modeMessage: string;
    if (ctx.isHuskyHook) {
      const fileCount = ctx.stagedFiles.length;
      const mode = ctx.noFix ? 'Read-only' : 'Auto-fixing';
      modeMessage = c.magenta(
        `(Husky Hook: ${mode} - ${fileCount} file${fileCount === 1 ? '' : 's'} staged)`,
      );
    } else {
      const fixMode = ctx.noFix ? 'Read-only' : 'Auto-fixing';
      const speedMode = ctx.fastMode ? ' - Fast mode' : '';
      modeMessage = ctx.noFix
        ? c.dim(`(${fixMode} mode${speedMode})`)
        : c.magenta(`(${fixMode} mode${speedMode})`);
    }

    UI.log(`${c.bold('🚀 DevCheck: Kicking off comprehensive checks...')} ${modeMessage}\n`);
  },

  printSummary(results: CommandResult[], ctx: AppContext): boolean {
    UI.log(`\n${c.bold('📊 Checkup Summary:')}`);
    UI.log('------------------------------------------------');

    let overallSuccess = true;
    const failedChecks: Check[] = [];

    for (const result of results) {
      let status: string;
      if (result.skipped) {
        status = `${c.yellow('⚪ SKIPPED')}`;
      } else if (result.exitCode === 0 && result.warning) {
        status = `${c.yellow('⚠️  WARNING')}`;
      } else if (result.exitCode === 0) {
        status = `${c.green('✅ PASSED')}`;
      } else {
        status = `${c.red('❌ FAILED')}`;
        overallSuccess = false;
        const foundCheck = ALL_CHECKS.find((check) => check.name === result.checkName);
        if (foundCheck) failedChecks.push(foundCheck);
      }

      const durationStr = result.skipped ? '' : c.dim(`(${result.duration}ms)`);
      UI.log(`${c.bold(result.checkName.padEnd(25))} ${status} ${durationStr}`);

      // Display warning details for passing checks with warnings
      if (result.exitCode === 0 && result.warning) {
        UI.log(c.yellow(result.warning.replace(/^/gm, '   | ')));
        UI.log('');
      }

      // Display check output (dimmed for passing, red stderr for failures)
      if (!result.skipped && (result.stdout || result.stderr)) {
        if (result.stdout) UI.log(c.dim(result.stdout.replace(/^/gm, '   | ')));
        if (result.stderr) {
          UI.log(
            result.exitCode !== 0
              ? c.red(result.stderr.replace(/^/gm, '   | '))
              : c.dim(result.stderr.replace(/^/gm, '   | ')),
          );
        }
        UI.log('');
      }
    }

    UI.log('\n------------------------------------------------');

    if (!overallSuccess) {
      if (ctx.noFix || failedChecks.some((check) => !check.canFix)) {
        UI.log(`\n${c.bold(c.cyan('💡 Tips & Actions:'))}`);
        for (const check of failedChecks) {
          if (check.tip) {
            UI.log(`   - ${c.bold(check.name)}: ${c.dim(check.tip(c))}`);
          }
        }
      }
      if (!ctx.noFix) {
        UI.log(
          `\n${c.yellow('⚠️ Note: Some issues may have been fixed automatically, but others require manual intervention.')}`,
        );
      }
    }

    return overallSuccess;
  },

  printFooter(success: boolean, totalDuration: number) {
    const timeStr = c.dim(`(total: ${totalDuration}ms)`);
    if (success) {
      UI.log(`\n${c.bold(c.green('🎉 All checks passed! Ship it!'))} ${timeStr}`);
    } else {
      UI.log(`\n${c.bold(c.red('🛑 Found issues. Please review the output above.'))} ${timeStr}`);
    }
  },

  printError(error: unknown) {
    console.error(`${c.red('\nAn unexpected error occurred in the check script:')}`, error);
  },
};

// =============================================================================
// Core Logic
// =============================================================================

/** Global flags handled separately from per-check skip flags. */
const GLOBAL_FLAGS = new Set(['--no-fix', '--husky-hook', '--fast', '--help', '--only']);

/** All recognized flags (global + per-check skip flags). */
const KNOWN_FLAGS = new Set([...GLOBAL_FLAGS, ...ALL_CHECKS.map((check) => check.flag)]);

function printHelp() {
  UI.log(`${c.bold('Usage:')} bun run devcheck [options]\n`);
  UI.log(`${c.bold('Options:')}`);
  UI.log(`  ${c.yellow('--no-fix')}        Run in read-only mode (no auto-fixing)`);
  UI.log(`  ${c.yellow('--fast')}          Skip slow network-bound checks (audit, outdated)`);
  UI.log(
    `  ${c.yellow('--husky-hook')}    Run in pre-commit hook mode (analyze staged files only)`,
  );
  UI.log(
    `  ${c.yellow('--only <name>')}   Run only the named check (case-insensitive partial match)`,
  );
  UI.log(`  ${c.yellow('--help')}          Show this help message\n`);
  const optOutChecks = ALL_CHECKS.filter((ch) => !ch.requiresFlag);
  const optInChecks = ALL_CHECKS.filter((ch) => ch.requiresFlag);

  UI.log(`${c.bold('Skip individual checks:')}`);
  for (const check of optOutChecks) {
    const slow = check.slowCheck ? c.dim(' (slow)') : '';
    UI.log(`  ${c.yellow(check.flag.padEnd(18))} Skip ${check.name}${slow}`);
  }

  if (optInChecks.length > 0) {
    UI.log(`\n${c.bold('Enable optional checks (off by default):')}`);
    for (const check of optInChecks) {
      UI.log(`  ${c.yellow(check.flag.padEnd(18))} Run ${check.name}`);
    }
  }
  UI.log('');
}

/**
 * Parses CLI arguments and determines the initial run context.
 * Returns null if the program should exit (e.g., --help).
 */
function parseArgs(args: string[]): Omit<AppContext, 'rootDir' | 'stagedFiles'> | null {
  const flags = new Set<string>();
  let noFix = false;
  let isHuskyHook = false;
  let fastMode = false;
  let onlyCheck: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--help') {
      printHelp();
      return null;
    } else if (arg === '--no-fix') {
      noFix = true;
    } else if (arg === '--husky-hook') {
      isHuskyHook = true;
    } else if (arg === '--fast') {
      fastMode = true;
    } else if (arg === '--only') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        UI.log(c.red('Error: --only requires a check name argument.'));
        UI.log(c.dim(`  Example: ${c.bold('bun run devcheck --only lint')}\n`));
        UI.log(c.dim('Available checks:'));
        for (const check of ALL_CHECKS) {
          UI.log(c.dim(`  - ${check.name}`));
        }
        return null;
      }
      onlyCheck = next;
      i++; // consume the next arg
    } else if (arg.startsWith('--')) {
      if (!KNOWN_FLAGS.has(arg)) {
        UI.log(c.yellow(`Warning: Unknown flag '${arg}' — ignoring.`));
        UI.log(c.dim(`  Run with ${c.bold('--help')} to see available options.\n`));
      } else {
        flags.add(arg);
      }
    }
  }

  // Also detect if running inside environment set by Husky
  if (process.env.HUSKY === '1' || process.env.GIT_PARAMS) {
    isHuskyHook = true;
  }

  return { flags, noFix, isHuskyHook, fastMode, onlyCheck };
}

async function runCheck(check: Check, ctx: AppContext): Promise<CommandResult> {
  const { name, getCommand, isSuccess } = check;
  const log: string[] = [];
  const baseResult: CommandResult = {
    checkName: name,
    exitCode: 0,
    stdout: '',
    stderr: '',
    duration: 0,
    skipped: false,
    logLines: log,
  };

  // 1. Check for --only filter
  if (ctx.onlyCheck) {
    const match = check.name.toLowerCase().includes(ctx.onlyCheck.toLowerCase());
    if (!match) {
      log.push(UI.formatSkipped(check, `--only ${ctx.onlyCheck}`));
      return { ...baseResult, skipped: true };
    }
  }

  // 2. Handle opt-in vs opt-out flags
  if (check.requiresFlag) {
    // Opt-in: only runs when flag is explicitly provided
    if (!ctx.flags.has(check.flag)) {
      log.push(UI.formatSkipped(check, `Pass ${check.flag} to enable`));
      return { ...baseResult, skipped: true };
    }
  } else {
    // Opt-out: runs by default, skip when flag is provided
    if (ctx.flags.has(check.flag)) {
      log.push(UI.formatSkipped(check, `Flag ${check.flag} provided`));
      return { ...baseResult, skipped: true };
    }
  }

  // 3. Skip slow checks in fast mode
  if (ctx.fastMode && check.slowCheck) {
    log.push(UI.formatSkipped(check, 'Skipped in fast mode'));
    return { ...baseResult, skipped: true };
  }

  // 4. Determine command and mode
  const useFixCommand = !ctx.noFix && check.canFix;
  const runMode: RunMode = useFixCommand ? 'fix' : 'check';
  const uiMode: UIMode = useFixCommand ? 'Fixing' : 'Checking';

  const command = getCommand(ctx, runMode);

  // 5. Check if command generation resulted in no action (e.g., no relevant staged files)
  if (!command || command.length === 0) {
    log.push(UI.formatSkipped(check, 'No relevant files to check'));
    return { ...baseResult, skipped: true };
  }

  log.push(UI.formatCheckStart(check, command, uiMode));

  // 6. Execute the command
  const startTime = performance.now();
  const result = await Shell.exec(command, { cwd: ctx.rootDir });
  const duration = Math.round(performance.now() - startTime);

  const finalResult: CommandResult = {
    ...baseResult,
    ...result,
    duration,
    logLines: log,
  };

  // 7. Determine success (using custom logic if provided)
  if (isSuccess) {
    const raw = isSuccess(result, runMode);
    const { success, warning } =
      typeof raw === 'boolean' ? { success: raw, warning: undefined } : raw;

    if (!success && finalResult.exitCode === 0) {
      finalResult.exitCode = 1;
    }
    if (success && finalResult.exitCode !== 0) {
      // Preserve stderr in stdout for the summary when the tool errored but isSuccess normalized it
      if (finalResult.stderr && !finalResult.stdout) {
        finalResult.stdout = finalResult.stderr;
      }
      finalResult.exitCode = 0;
    }
    if (warning) {
      finalResult.warning = warning;
    }
  }

  log.push(UI.formatCheckResult(finalResult, uiMode));

  return finalResult;
}

/**
 * Handles the specific logic required for git pre-commit hooks, primarily re-staging
 * files that were modified by auto-fixers (like Biome).
 * Returns false if re-staging failed (should fail the commit).
 */
async function handleHuskyReStaging(ctx: AppContext): Promise<boolean> {
  // We only need to re-stage if auto-fixing was enabled.
  if (ctx.noFix) return true;

  // If no files were staged initially, there's nothing to re-stage.
  if (ctx.stagedFiles.length === 0) return true;

  UI.log(`\n${c.bold(c.cyan('✨ Husky: Checking for modifications by fixers...'))}`);

  try {
    const { stdout: gitStatus } = await Shell.exec(['git', 'status', '--porcelain'], {
      cwd: ctx.rootDir,
    });

    // Identify files modified by fixers after staging.
    // Porcelain format: XY path — X=index status, Y=working tree status.
    // We want files where X is staged (not ' ' or '?') and Y='M' (modified since staging).
    const stagedSet = new Set(ctx.stagedFiles);
    const modifiedStagedFiles = gitStatus
      .split('\n')
      .filter((line) => line.length > 3 && line[1] === 'M' && line[0] !== ' ' && line[0] !== '?')
      .map((line) => line.substring(3).trim())
      // Only re-stage files that were originally staged — avoid pulling in unrelated changes
      .filter((file) => stagedSet.has(file));

    if (modifiedStagedFiles.length > 0) {
      UI.log(c.yellow(`   Re-staging ${modifiedStagedFiles.length} files modified by fixers...`));

      const cmd = ['git', 'add', ...modifiedStagedFiles];
      const addResult = await Shell.exec(cmd, { cwd: ctx.rootDir });

      let cmdStr = cmd.join(' ');
      if (cmdStr.length > 100) {
        cmdStr = `${cmdStr.substring(0, 97)}...`;
      }
      UI.log(c.dim(`     $ ${cmdStr}`));

      if (addResult.exitCode !== 0) {
        UI.log(c.red(`   ✗ Failed to re-stage files (exit ${addResult.exitCode}).`));
        if (addResult.stderr) UI.log(c.red(`     ${addResult.stderr}`));
        return false;
      }

      UI.log(c.green('   ✓ Successfully re-staged files.'));
    } else {
      UI.log(c.green('   ✓ No staged files were modified by fixers.'));
    }

    return true;
  } catch (error: unknown) {
    UI.log(c.red('🛑 Error during Husky hook file management. Fixes might not be staged.'));
    UI.printError(error);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) process.exit(0);

  // Initialize context
  const appContext: AppContext = {
    ...args,
    rootDir: ROOT_DIR,
    stagedFiles: [],
  };

  // If in husky mode, populate staged files early for optimized command generation.
  if (appContext.isHuskyHook) {
    appContext.stagedFiles = await Shell.getStagedFiles(ROOT_DIR);
  }

  // If it's a husky hook and nothing is staged, we can exit early.
  if (appContext.isHuskyHook && appContext.stagedFiles.length === 0) {
    UI.log(c.green('\nNo files staged. Skipping pre-commit checks.'));
    process.exit(0);
  }

  UI.printHeader(appContext);

  // Run checks concurrently, buffering output per check
  const totalStart = performance.now();
  const checkPromises = ALL_CHECKS.map((check) => runCheck(check, appContext));
  const settledResults = await Promise.allSettled(checkPromises);
  const totalDuration = Math.round(performance.now() - totalStart);

  // Collect results, then flush buffered output in definition order (no interleaving)
  const results: CommandResult[] = settledResults.map((res, index) => {
    if (res.status === 'fulfilled') {
      return res.value;
    }
    const checkName = ALL_CHECKS[index]?.name || 'Unknown';
    return {
      checkName,
      exitCode: 1,
      stdout: '',
      stderr: `Check runner failed: ${String(res.reason)}`,
      duration: 0,
      skipped: false,
      logLines: [`${c.bold(c.red('❌'))} ${c.yellow(checkName)} ${c.red('runner crashed')}`],
    };
  });

  for (const result of results) {
    UI.flushCheckLog(result);
  }

  // If running in Husky hook, manage file staging.
  // We do this BEFORE summarizing success, so that even if checks failed, partial fixes are staged.
  let reStagingOk = true;
  if (appContext.isHuskyHook) {
    reStagingOk = await handleHuskyReStaging(appContext);
  }

  const overallSuccess = UI.printSummary(results, appContext) && reStagingOk;

  UI.printFooter(overallSuccess, totalDuration);
  process.exit(overallSuccess ? 0 : 1);
}

// Entry point
main().catch((error) => {
  UI.printError(error);
  process.exit(1);
});

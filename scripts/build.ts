/**
 * @fileoverview Build script with progress feedback and output stats.
 * @module scripts/build
 *
 * Wraps tsc + tsc-alias with timing, file counts, and size reporting.
 * Exits non-zero on failure with captured compiler output.
 *
 * @example
 * // Standard build:
 * // bun run scripts/build.ts
 *
 * // With a specific tsconfig:
 * // bun run scripts/build.ts --project tsconfig.custom.json
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(ROOT_DIR, 'dist');

async function exec(
  cmd: string[],
  label: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; ms: number }> {
  const start = performance.now();
  const [bin, ...args] = cmd;

  const { stdout, stderr, exitCode } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>((resolve) => {
    execFile(bin ?? '', args, { cwd: ROOT_DIR }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
        exitCode: error ? Number(error.code) || 1 : 0,
      });
    });
  });

  const ms = Math.round(performance.now() - start);

  if (exitCode !== 0) {
    console.error(`  \x1b[31m✗ ${label} failed (${ms}ms)\x1b[0m`);
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
  } else {
    console.log(`  \x1b[32m✓\x1b[0m ${label} \x1b[2m(${ms}ms)\x1b[0m`);
  }

  return { ok: exitCode === 0, stdout, stderr, ms };
}

/** Recursively count files and total size under a directory. */
async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          const sub = await dirStats(full);
          files += sub.files;
          bytes += sub.bytes;
        } else {
          files++;
          const s = await stat(full);
          bytes += s.size;
        }
      }),
    );
  } catch {
    // dist doesn't exist yet — fine
  }
  return { files, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

async function main() {
  // Read package info
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf-8'));
  const projectIdx = process.argv.indexOf('--project');
  const project =
    projectIdx !== -1
      ? (process.argv[projectIdx + 1] ?? 'tsconfig.build.json')
      : 'tsconfig.build.json';

  console.log(`\x1b[1mBuilding ${pkg.name}@${pkg.version}\x1b[0m`);
  console.log(`\x1b[2m  tsconfig: ${project}\x1b[0m`);

  const totalStart = performance.now();

  // Step 1: tsc
  const tsc = await exec([join(ROOT_DIR, 'node_modules', '.bin', 'tsc'), '-p', project], 'tsc');
  if (!tsc.ok) process.exit(1);

  // Step 2: tsc-alias
  const alias = await exec(
    [join(ROOT_DIR, 'node_modules', '.bin', 'tsc-alias'), '-p', project],
    'tsc-alias',
  );
  if (!alias.ok) process.exit(1);

  const totalMs = Math.round(performance.now() - totalStart);

  // Output stats
  const stats = await dirStats(DIST_DIR);
  console.log(
    `\n\x1b[32m\x1b[1mBuild complete\x1b[0m \x1b[2m— ${stats.files} files, ${formatBytes(stats.bytes)}, ${totalMs}ms\x1b[0m`,
  );
}

main().catch((err) => {
  console.error('\x1b[31mBuild script failed:\x1b[0m', err);
  process.exit(1);
});

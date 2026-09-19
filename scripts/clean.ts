/**
 * @fileoverview Utility script to clean build artifacts and temporary directories.
 * @module scripts/clean
 *   By default, it removes the 'dist' and 'logs' directories plus every
 *   TypeScript build-info file the project's tsconfigs write — in the root and
 *   in 'config/', where a tsconfig kept there resolves its relative
 *   `tsBuildInfoFile` against itself.
 *   Custom directories can be specified as command-line arguments, which
 *   replace the default set entirely.
 *   Works on all platforms using Node.js path normalization.
 *
 * @example
 * // Default targets (dist, logs, build info):
 * // bun run scripts/clean.ts
 *
 * // Custom directories:
 * // bun run scripts/clean.ts temp coverage
 */
import { readdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

interface CleanResult {
  dir: string;
  reason?: string;
  status: 'cleaned' | 'skipped' | 'error';
}

/**
 * A TypeScript build-info file: the plain `.tsbuildinfo`, a `<name>.tsbuildinfo`,
 * and the lane-suffixed `.tsbuildinfo.<lane>` forms a multi-tsconfig project
 * writes (`tsBuildInfoFile: ".tsbuildinfo.worker"`).
 */
const BUILD_INFO_FILE = /\.tsbuildinfo(\.[^.]*)?$/;

/**
 * Directories a tsconfig may write its build info into. A `tsBuildInfoFile` is
 * resolved against the tsconfig that declares it, so a project keeping its
 * tsconfigs in `config/` leaves build info there rather than at the root.
 */
const BUILD_INFO_DIRS = ['.', 'config'];

/** Every build-info file under the scanned directories, as root-relative paths. */
async function findBuildInfoFiles(root: string): Promise<string[]> {
  const found = await Promise.all(
    BUILD_INFO_DIRS.map(async (dir) => {
      let entries: string[];
      try {
        entries = await readdir(resolve(root, dir));
      } catch {
        return []; // directory absent — nothing to clean there
      }
      return entries
        .filter((entry) => BUILD_INFO_FILE.test(entry))
        .map((entry) => (dir === '.' ? entry : `${dir}/${entry}`));
    }),
  );
  return found.flat();
}

/**
 * Validates that a resolved path stays within the project root.
 * Rejects absolute paths, '..' traversal, and paths that escape cwd.
 */
function validatePath(dir: string, root: string): string {
  if (!dir || dir.trim() === '') {
    throw new Error('Empty directory name not allowed');
  }
  if (/^[a-zA-Z]:/.test(dir) || dir.startsWith('/') || dir.startsWith('\\')) {
    throw new Error(`Absolute paths not allowed: ${dir}`);
  }
  if (dir.split(/[/\\]/).includes('..')) {
    throw new Error(`Path traversal not allowed: ${dir}`);
  }
  const resolved = resolve(root, dir);
  if (!resolved.startsWith(root + sep)) {
    throw new Error(`Path escapes project root: ${dir}`);
  }
  return resolved;
}

const clean = async (): Promise<void> => {
  try {
    const root = process.cwd();
    const args = process.argv.slice(2);
    const buildInfoFiles = await findBuildInfoFiles(root);
    const dirsToClean = [...new Set(args.length > 0 ? args : ['dist', 'logs', ...buildInfoFiles])];

    console.log(`Cleaning directories: ${dirsToClean.join(', ')}`);

    const results = await Promise.all(
      dirsToClean.map(async (dir): Promise<CleanResult> => {
        try {
          const dirPath = validatePath(dir, root);
          await rm(dirPath, { recursive: true });
          return { dir, status: 'cleaned' };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { dir, status: 'skipped', reason: 'does not exist' };
          }
          const message = error instanceof Error ? error.message : String(error);
          return { dir, status: 'error', reason: message };
        }
      }),
    );

    let hasErrors = false;
    for (const { dir, status, reason } of results) {
      if (status === 'cleaned') {
        console.log(`  ✓ ${dir}`);
      } else if (status === 'skipped') {
        console.log(`  - ${dir} (${reason})`);
      } else {
        console.error(`  ✗ ${dir}: ${reason}`);
        hasErrors = true;
      }
    }

    if (hasErrors) {
      process.exit(1);
    }
  } catch (error: unknown) {
    console.error('Clean script failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

void clean();

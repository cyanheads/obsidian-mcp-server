/**
 * @fileoverview Generates a visual tree representation of the project's directory structure.
 * @module scripts/tree
 *   Respects .gitignore patterns and common exclusions (e.g., node_modules).
 *   Saves the tree to a markdown file (default: docs/tree.md).
 *   Supports custom output path, depth limitation, and additional ignore patterns.
 *
 * @example
 * // Generate tree with default settings:
 * // bun run tree
 *
 * @example
 * // Specify custom output path and depth:
 * // bun run scripts/tree.ts ./documentation/structure.md --depth=3
 *
 * @example
 * // Add additional ignore patterns:
 * // bun run scripts/tree.ts --ignore=coverage --ignore="*.log"
 *
 * @example
 * // Preview tree without writing to disk:
 * // bun run scripts/tree.ts --dry-run
 */
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import ignore from 'ignore';

type Ignore = ReturnType<typeof ignore>;

const KNOWN_FLAGS = ['--depth', '--ignore', '--help', '--dry-run'] as const;

const DEFAULT_IGNORE_PATTERNS: string[] = [
  '.git',
  'node_modules',
  '.DS_Store',
  'dist',
  'build',
  'coverage',
  'logs',
  '.husky/_',
  // Directory-based changelog — keep series dirs visible (0.1.x/, 0.5.x/) for structural
  // orientation, but collapse out the per-version files. Top-level template.md stays.
  'changelog/*/*.md',
];

interface ParsedArgs {
  dryRun: boolean;
  extraIgnorePatterns: string[];
  maxDepth: number;
  outputPath: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    outputPath: 'docs/tree.md',
    maxDepth: Infinity,
    extraIgnorePatterns: [],
    dryRun: false,
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg.startsWith('--depth=')) {
      const depthValue = parseInt(arg.split('=')[1] ?? '', 10);
      if (!Number.isNaN(depthValue) && depthValue >= 0) {
        result.maxDepth = depthValue;
      } else {
        console.warn(`Invalid depth value: "${arg}". Using unlimited depth.`);
      }
    } else if (arg.startsWith('--ignore=')) {
      const pattern = arg.slice('--ignore='.length);
      if (pattern) {
        result.extraIgnorePatterns.push(pattern);
      }
    } else if (arg.startsWith('--')) {
      const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (!KNOWN_FLAGS.some((known) => flagName === known)) {
        console.warn(`Unknown flag: "${arg}". Ignoring.`);
      }
    } else {
      result.outputPath = arg;
    }
  }

  return result;
}

function validateOutputPath(outputPath: string, root: string): string {
  const resolved = resolve(root, outputPath);
  if (!resolved.startsWith(root + sep)) {
    throw new Error(`Output path "${outputPath}" resolves outside project root: ${resolved}`);
  }
  const resolvedDir = dirname(resolved);
  if (resolvedDir !== root && !resolvedDir.startsWith(root + sep)) {
    throw new Error(`Output directory "${resolvedDir}" is outside project root`);
  }
  return resolved;
}

async function loadIgnoreHandler(
  root: string,
  extraPatterns: string[],
  outputFile: string,
): Promise<Ignore> {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE_PATTERNS);

  if (extraPatterns.length > 0) {
    ig.add(extraPatterns);
  }

  // Auto-ignore the output file so the generated artifact doesn't list itself
  const outputRelative = relative(root, outputFile).split(sep).join(posix.sep);
  ig.add(outputRelative);

  try {
    const gitignoreContent = await readFile(join(root, '.gitignore'), 'utf-8');
    ig.add(gitignoreContent);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      console.warn(
        'Info: No .gitignore file found at project root. Using default ignore patterns only.',
      );
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error reading .gitignore: ${msg}`);
    }
  }
  return ig;
}

function isIgnored(entryPath: string, root: string, ig: Ignore): boolean {
  const rel = relative(root, entryPath).split(sep).join(posix.sep);
  return ig.ignores(rel);
}

/**
 * Recursively generates a string representation of the directory tree.
 * Uses sequential traversal to avoid unbounded file-descriptor pressure.
 * Tracks visited real paths to prevent symlink cycles.
 */
async function generateTree(
  dir: string,
  root: string,
  ig: Ignore,
  maxDepth: number,
  prefix = '',
  currentDepth = 0,
  visited = new Set<string>(),
): Promise<string> {
  const resolvedDir = resolve(dir);
  if (!resolvedDir.startsWith(root + sep) && resolvedDir !== root) {
    console.warn(`Security: Skipping directory outside project root: ${resolvedDir}`);
    return '';
  }

  if (currentDepth > maxDepth) {
    return '';
  }

  // Resolve symlinks and detect cycles
  let realDir: string;
  try {
    realDir = await realpath(resolvedDir);
  } catch {
    return '';
  }
  if (visited.has(realDir)) {
    return '';
  }
  visited.add(realDir);

  let entries: Dirent[];
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error reading directory ${resolvedDir}: ${msg}`);
    return '';
  }

  const filteredEntries = entries
    .filter((entry) => !isIgnored(join(resolvedDir, entry.name), root, ig))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  // Sequential traversal — prevents unbounded concurrent readdir calls
  let result = '';
  for (let i = 0; i < filteredEntries.length; i++) {
    const entry = filteredEntries[i];
    const isLast = i === filteredEntries.length - 1;
    const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ';
    const newPrefix = prefix + (isLast ? '    ' : '\u2502   ');
    const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;

    result += `${prefix + connector + displayName}\n`;

    if (entry.isDirectory()) {
      result += await generateTree(
        join(resolvedDir, entry.name),
        root,
        ig,
        maxDepth,
        newPrefix,
        currentDepth + 1,
        visited,
      );
    }
  }

  return result;
}

/**
 * Extracts the raw tree body from an existing output file for diffing.
 * Returns null if the file doesn't exist or the tree block can't be parsed.
 */
async function readExistingTree(outputFile: string, projectName: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(outputFile, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: Could not read existing output file for comparison: ${msg}`);
    return null;
  }

  const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `^\\s*\`\`\`(?:[^\\n]*)\\n${escaped}/?\\n([\\s\\S]*?)\\n\`\`\`\\s*$`,
    'm',
  );
  const match = content.match(regex);
  return match && typeof match[1] === 'string' ? match[1] : null;
}

function buildOutputContent(projectName: string, treeContent: string, maxDepth: number): string {
  const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const header = `# ${projectName} - Directory Structure\n\nGenerated on: ${timestamp}\n`;
  const depthInfo = maxDepth !== Infinity ? `\n_Depth limited to ${maxDepth} levels_\n\n` : '\n';
  const treeBlock = `\`\`\`text\n${projectName}/\n${treeContent}\`\`\`\n`;
  const footer = `\n_Note: This tree excludes files and directories matched by .gitignore and default patterns._\n`;
  return header + depthInfo + treeBlock + footer;
}

const normalize = (str: string | null) => str?.replace(/\r\n/g, '\n').trimEnd() ?? null;

const generateDirectoryTree = async (): Promise<void> => {
  try {
    const root = process.cwd();
    const args = process.argv.slice(2);

    if (args.includes('--help')) {
      console.log(`
Generate Tree - Project directory structure visualization tool

Usage:
  bun run scripts/tree.ts [output-path] [options]

Options:
  output-path        Custom file path for the tree output (relative to project root, default: docs/tree.md)
  --depth=<number>   Maximum directory depth to display (default: unlimited)
  --ignore=<pattern> Additional ignore pattern (can be specified multiple times)
  --dry-run          Print tree to stdout without writing to disk
  --help             Show this help message
`);
      process.exit(0);
    }

    const parsed = parseArgs(args);
    const projectName = basename(root);
    const resolvedOutputFile = validateOutputPath(parsed.outputPath, root);
    const ignoreHandler = await loadIgnoreHandler(
      root,
      parsed.extraIgnorePatterns,
      resolvedOutputFile,
    );

    console.log(`Generating directory tree for project: ${projectName}`);
    if (!parsed.dryRun) {
      console.log(`Output will be saved to: ${resolvedOutputFile}`);
    }
    if (parsed.maxDepth !== Infinity) {
      console.log(`Maximum depth set to: ${parsed.maxDepth}`);
    }
    if (parsed.extraIgnorePatterns.length > 0) {
      console.log(`Additional ignore patterns: ${parsed.extraIgnorePatterns.join(', ')}`);
    }

    const treeContent = await generateTree(root, root, ignoreHandler, parsed.maxDepth);

    if (parsed.dryRun) {
      console.log(`\n${projectName}/`);
      process.stdout.write(treeContent);
      return;
    }

    const existingTree = await readExistingTree(resolvedOutputFile, projectName);

    if (normalize(existingTree) === normalize(treeContent)) {
      console.log(
        `Directory structure is unchanged. Output file not updated: ${resolvedOutputFile}`,
      );
      return;
    }

    await mkdir(dirname(resolvedOutputFile), { recursive: true });
    await writeFile(
      resolvedOutputFile,
      buildOutputContent(projectName, treeContent, parsed.maxDepth),
    );
    console.log(`Successfully generated and updated tree structure in: ${resolvedOutputFile}`);
  } catch (error: unknown) {
    console.error(
      `Error generating tree: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};

void generateDirectoryTree();

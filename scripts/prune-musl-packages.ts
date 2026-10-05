#!/usr/bin/env bun
/**
 * @fileoverview Deletes musl-only packages from a production `node_modules` —
 * the Dockerfile `deps` stage's step after the OTel install.
 *
 * `bun install --os/--cpu` has no libc filter, so an optional dependency
 * published in glibc and musl variants installs both: DuckDB's native
 * bindings add a ~70 MB musl copy per image. The runtime image
 * (`oven/bun:<version>-slim`) is Debian, glibc, and never loads it. Every
 * installed package whose own `package.json` `libc` lists `musl` and not
 * `glibc` is deleted, at any depth — hoisted, scoped, nested `node_modules`,
 * and Bun's isolated `node_modules/.bun` store — along with each symlink that
 * pointed into it. The manifest decides, never the package name. A later
 * `bun install` restores what this removes, so it runs after every install.
 * A server whose runtime image is musl-based (Alpine) drops the step.
 *
 * @example
 * // In the Dockerfile deps stage, after the OTel step:
 * // bun scripts/prune-musl-packages.ts
 * @module scripts/prune-musl-packages
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Manifest {
  libc?: string | string[];
  name: string;
  version: string;
}

/** An installed package the prune deleted. */
export interface PrunedPackage {
  /** Absolute path of the deleted package directory. */
  dir: string;
  name: string;
  version: string;
}

/** What one prune deleted. */
export interface PruneResult {
  removed: PrunedPackage[];
  /** Absolute paths of the symlinks removed because they pointed into a deleted package. */
  unlinked: string[];
}

/** True when a manifest's `libc` admits musl and not glibc — a package a glibc runtime cannot load. */
export function isMuslOnly(manifest: Pick<Manifest, 'libc'>): boolean {
  const libc = [manifest.libc ?? []].flat();
  return libc.includes('musl') && !libc.includes('glibc');
}

/**
 * Deletes every musl-only package under `nodeModules`, plus the symlinks into
 * them. Symlinks are never followed, so each package is visited once, at its
 * real directory.
 */
export function pruneMuslPackages(nodeModules: string): PruneResult {
  const removed: PrunedPackage[] = [];
  const links: string[] = [];

  const visitPackage = (dir: string): void => {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    if (isMuslOnly(manifest)) {
      removed.push({ dir, name: manifest.name, version: manifest.version });
      return;
    }
    const nested = join(dir, 'node_modules');
    if (existsSync(nested)) scanNodeModules(nested);
  };

  /** Visits each package position of a `node_modules` directory: `<name>` and `@scope/<name>`. */
  const scanNodeModules = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(path);
      else if (!entry.isDirectory()) continue;
      else if (entry.name === '.bun') scanBunStore(path);
      else if (entry.name.startsWith('@')) {
        for (const scoped of readdirSync(path, { withFileTypes: true })) {
          const scopedPath = join(path, scoped.name);
          if (scoped.isSymbolicLink()) links.push(scopedPath);
          else if (scoped.isDirectory()) visitPackage(scopedPath);
        }
      } else if (!entry.name.startsWith('.')) visitPackage(path);
    }
  };

  /** Bun's isolated store: `.bun/<entry>/node_modules` per package, plus the hoisted `.bun/node_modules`. */
  const scanBunStore = (store: string): void => {
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modules =
        entry.name === 'node_modules'
          ? join(store, entry.name)
          : join(store, entry.name, 'node_modules');
      if (existsSync(modules)) scanNodeModules(modules);
    }
  };

  scanNodeModules(nodeModules);

  const insideRemoved = (target: string): boolean =>
    removed.some(({ dir }) => target === dir || target.startsWith(`${dir}${sep}`));
  const unlinked = links.filter((path) =>
    insideRemoved(resolve(dirname(path), readlinkSync(path))),
  );
  for (const { dir } of removed) rmSync(dir, { recursive: true, force: true });
  for (const path of unlinked) rmSync(path);
  return { removed, unlinked };
}

function main(): number {
  const nodeModules = join(process.cwd(), 'node_modules');
  if (!existsSync(nodeModules)) {
    console.error(
      `prune-musl-packages: ${nodeModules} does not exist — run it from the project root after bun install.`,
    );
    return 1;
  }

  const { removed, unlinked } = pruneMuslPackages(nodeModules);
  if (removed.length === 0) {
    console.log('prune-musl-packages: no musl-only packages in node_modules.');
    return 0;
  }
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  console.log(
    `prune-musl-packages: removed ${plural(removed.length, 'musl-only package')} a glibc runtime cannot load:`,
  );
  for (const { dir, name, version } of removed) {
    console.log(`  ${name}@${version} (${relative(process.cwd(), dir)})`);
  }
  if (unlinked.length > 0) {
    console.log(
      `prune-musl-packages: removed ${plural(unlinked.length, 'symlink')} into those packages.`,
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

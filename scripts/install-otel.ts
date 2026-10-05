#!/usr/bin/env bun
/**
 * @fileoverview Installs the OpenTelemetry packages the framework loads at
 * runtime into a production dependency tree — the Dockerfile's OTel step.
 *
 * The list is every `peerDependencies` entry named `@opentelemetry/*`, plus
 * `@hono/otel`, in `@cyanheads/mcp-ts-core/package.json` resolved from the
 * project root: the installed framework in a server, the package itself (by
 * self-reference) in the framework. Each package moves into the project's
 * `dependencies` at its declared peer range, out of `peerDependencies`,
 * `peerDependenciesMeta`, and `devDependencies`, so `--omit=peer` keeps it
 * while every other optional peer stays out. Then `bun install --omit=dev
 * --omit=peer --ignore-scripts` runs with every argument given to this script
 * appended, under the project's `bunfig.toml`, and its exit code is this
 * script's. Not `--production`: it implies `--frozen-lockfile`, which fails
 * once the manifest gains packages the lockfile lacks.
 *
 * @example
 * // In a Dockerfile stage on $BUILDPLATFORM, cross-installing for the target:
 * // bun scripts/install-otel.ts --os=linux --cpu=x64
 * @module scripts/install-otel
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
}

/** The OTel optional peers a framework manifest declares, keyed by name, at their declared ranges. */
export function otelPeers(framework: Manifest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(framework.peerDependencies ?? {}).filter(
      ([name]) => name.startsWith('@opentelemetry/') || name === '@hono/otel',
    ),
  );
}

function main(args: string[]): number {
  const manifestPath = join(process.cwd(), 'package.json');
  const frameworkPath = createRequire(manifestPath).resolve('@cyanheads/mcp-ts-core/package.json');
  const peers = otelPeers(JSON.parse(readFileSync(frameworkPath, 'utf8')) as Manifest);
  const names = Object.keys(peers);
  if (names.length === 0) {
    console.error(
      `install-otel: ${frameworkPath} declares no @opentelemetry/* or @hono/otel peerDependencies — nothing to install.`,
    );
    return 1;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  manifest.dependencies = { ...manifest.dependencies, ...peers };
  for (const name of names) {
    delete manifest.peerDependencies?.[name];
    delete manifest.peerDependenciesMeta?.[name];
    delete manifest.devDependencies?.[name];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `install-otel: ${names.length} OpenTelemetry packages from ${frameworkPath}: ` +
      names.map((name) => `${name}@${peers[name]}`).join(' '),
  );

  const install = spawnSync(
    'bun',
    ['install', '--omit=dev', '--omit=peer', '--ignore-scripts', ...args],
    { stdio: 'inherit' },
  );
  if (install.error) {
    console.error(`install-otel: could not run bun install: ${install.error.message}`);
    return 1;
  }
  return install.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

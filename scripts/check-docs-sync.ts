#!/usr/bin/env node
/**
 * @fileoverview Verifies that CLAUDE.md and AGENTS.md stay in sync. The init CLI
 * ships both files byte-identical and each agent tool reads the file named for
 * it — silent drift after edits leaves one agent on a stale protocol.
 *
 * Behavior:
 *   • Both exist, identical   → pass
 *   • Both exist, drift       → fail, print first divergent lines + fix hint
 *   • Only one exists         → pass (report which file is present)
 *   • Neither exists          → skip (not an mcp-ts-core project)
 *
 * Runs as a devcheck step and standalone: `bun run scripts/check-docs-sync.ts`.
 *
 * @module scripts/check-docs-sync
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const CLAUDE_PATH = resolve('CLAUDE.md');
const AGENTS_PATH = resolve('AGENTS.md');
const MAX_DIFF_LINES = 20;

/**
 * Line-by-line drift summary. Not a true unified diff — tools that move lines
 * will show every shifted line as divergent, which is fine for the enforcement
 * use case (the fix is always "reconcile both files" regardless).
 */
function summarizeDrift(a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const lines: string[] = [];
  let drifts = 0;

  for (let i = 0; i < max; i++) {
    if (aLines[i] !== bLines[i]) {
      drifts++;
      if (drifts <= MAX_DIFF_LINES) {
        const lineNo = String(i + 1).padStart(4);
        if (aLines[i] !== undefined) lines.push(`${lineNo}  - CLAUDE.md: ${aLines[i]}`);
        if (bLines[i] !== undefined) lines.push(`${lineNo}  + AGENTS.md: ${bLines[i]}`);
      }
    }
  }

  if (drifts > MAX_DIFF_LINES) {
    lines.push(`      ... and ${drifts - MAX_DIFF_LINES} more diverging line(s)`);
  }
  return lines.join('\n');
}

const hasClaude = existsSync(CLAUDE_PATH);
const hasAgents = existsSync(AGENTS_PATH);

if (!hasClaude && !hasAgents) {
  console.log('Skipped: neither CLAUDE.md nor AGENTS.md exists.');
  process.exit(0);
}

if (hasClaude !== hasAgents) {
  const present = hasClaude ? 'CLAUDE.md' : 'AGENTS.md';
  const absent = hasClaude ? 'AGENTS.md' : 'CLAUDE.md';
  console.log(`${present} found. No ${absent} found — nothing to sync.`);
  process.exit(0);
}

const claude = readFileSync(CLAUDE_PATH, 'utf-8');
const agents = readFileSync(AGENTS_PATH, 'utf-8');

if (claude === agents) {
  console.log('CLAUDE.md and AGENTS.md are in sync.');
  process.exit(0);
}

console.error('CLAUDE.md and AGENTS.md have drifted:');
console.error('');
console.error(summarizeDrift(claude, agents));
console.error('');
console.error(
  'Fix: edit both files together, or `cp CLAUDE.md AGENTS.md` (or reverse) if one is canonical.',
);
process.exit(1);

#!/usr/bin/env node
/**
 * @fileoverview Guards framework source against three SDK-coupling antipatterns
 * tempting to reach for when fixing tool input-validation error shape (#66) or
 * similar SDK-adjacent bugs. Each rule is narrow and mechanical — the goal is to
 * pin an architectural decision so it does not have to be re-litigated per PR.
 *
 * Rules:
 *   1. Framework must not downgrade the Zod `inputSchema` passed to
 *      `server.registerTool()` — the SDK rederives JSON Schema from it for
 *      `tools/list`, so `z.unknown()` / `z.any()` / `.passthrough()` breaks
 *      schema advertising. Consumer-side `.passthrough()` on output schemas
 *      is a documented escape hatch and stays legal (rule is scoped to
 *      `src/mcp-server/tools/`).
 *   2. Mutating `RegisteredTool.inputSchema` after register breaks
 *      `tools/list` the same way — the SDK reads the stored Zod object at list
 *      time.
 *   3. Matching the MCP SDK's error text at the transport layer (e.g. regex on
 *      `"Input validation error"`) is brittle across SDK versions. Any fix for
 *      #66 that intervenes at transport should use a structural signal, not a
 *      string match.
 *
 * Runs standalone (`bun run scripts/check-framework-antipatterns.ts`) and as
 * a devcheck step.
 *
 * @module scripts/check-framework-antipatterns
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

interface Rule {
  id: string;
  /** Human-readable message printed when the rule fires. */
  message: string;
  /** Pathspecs to scan. Exclusions use `:!` prefix. */
  pathspec: string[];
  /** Extended regex (POSIX ERE) passed to `git grep -E`. */
  pattern: string;
}

const RULES: Rule[] = [
  {
    id: 'inputSchema-downgrade',
    pattern: 'inputSchema:\\s*z\\.(unknown|any)\\(\\)|inputSchema:[^,]*\\.passthrough\\(\\)',
    pathspec: ['src/mcp-server/tools/', ':!**/*.test.ts'],
    message: 'Framework must not downgrade tool inputSchema — breaks tools/list advertising',
  },
  {
    id: 'inputSchema-mutation',
    pattern: '\\.inputSchema\\s*=([^=]|$)',
    pathspec: ['src/', ':!src/linter/', ':!**/*.test.ts'],
    message: 'Post-register inputSchema mutation breaks tools/list advertising',
  },
  {
    id: 'transport-text-match',
    pattern: '[\'"`]Input validation error',
    pathspec: ['src/mcp-server/transports/'],
    message: 'Matching SDK error text in transport layer is brittle across SDK versions',
  },
];

interface Finding {
  file: string;
  line: string;
  lineNo: number;
  ruleId: string;
  ruleMessage: string;
}

function runRule(rule: Rule): Finding[] {
  const result = spawnSync('git', ['grep', '-nE', rule.pattern, '--', ...rule.pathspec], {
    encoding: 'utf-8',
  });

  // git grep: exit 0 = matches, exit 1 = no matches, exit >=2 = error
  if (result.status === 1) return [];
  if (result.status !== 0) {
    console.error(`git grep failed for rule '${rule.id}':`);
    console.error(result.stderr);
    process.exit(2);
  }

  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((raw) => {
      // format: `path:line:content`
      const firstColon = raw.indexOf(':');
      const secondColon = raw.indexOf(':', firstColon + 1);
      const file = raw.slice(0, firstColon);
      const lineNo = Number(raw.slice(firstColon + 1, secondColon));
      const line = raw.slice(secondColon + 1);
      return { file, lineNo, line, ruleId: rule.id, ruleMessage: rule.message };
    });
}

const findings = RULES.flatMap(runRule);

if (findings.length === 0) {
  console.log(`No framework antipatterns found (${RULES.length} rule(s) scanned).`);
  process.exit(0);
}

console.error(`Found ${findings.length} framework antipattern violation(s):`);
console.error('');
for (const f of findings) {
  console.error(`  ${f.file}:${f.lineNo} [${f.ruleId}]`);
  console.error(`    ${f.ruleMessage}`);
  console.error(`    ${f.line.trim()}`);
  console.error('');
}
console.error(
  'See skills/api-linter/SKILL.md or scripts/check-framework-antipatterns.ts for rule rationale.',
);
process.exit(1);

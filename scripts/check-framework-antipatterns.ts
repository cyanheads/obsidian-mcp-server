#!/usr/bin/env node
/**
 * @fileoverview Guards against framework antipatterns via `git grep` over
 * `src/`. Rules 1–3 are SDK-coupling regressions scoped to framework-internal
 * paths — they no-op in consumer projects, where those paths either don't exist
 * or hold consumer code under different conventions. Rule 4 (`z.coerce.boolean()`)
 * is intentionally consumer-facing: it catches the env-boolean footgun in both
 * framework and scaffolded-server config. Shipped to consumers via
 * `package.json` `files:` because `devcheck` invokes it. Defense-in-depth:
 * harmless when nothing matches, catches real regressions.
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
 *   4. `z.coerce.boolean()` on an env flag can't be turned off through the
 *      environment — `Boolean("false") === true`, so `"false"`/`"0"`/`"no"`
 *      all coerce to `true` and the only `false` is omitting the variable.
 *      Use `z.stringbool()` (parses `true/false/1/0/yes/no/on/off`, rejects
 *      the rest). Scoped to `src/` so it fires in consumer config too.
 *
 * Runs standalone (`bun run scripts/check-framework-antipatterns.ts`) and as
 * a devcheck step.
 *
 * @module scripts/check-framework-antipatterns
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

// All rules scan via `git grep`, which exits 128 (not a finding) outside a repo.
// A fresh `init` scaffold has no `.git` until the user runs `git init`, so skip
// cleanly rather than crash on the first run. Mirrors build-changelog.ts's
// early-exit when its source directory is absent.
if (!existsSync('.git')) {
  console.log('Skipped: not a git repository.');
  process.exit(0);
}

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
  {
    id: 'coerce-boolean-env-flag',
    pattern: 'z\\.coerce\\.boolean\\(\\)',
    pathspec: ['src/', ':!**/*.test.ts'],
    message:
      'z.coerce.boolean() can\'t be disabled via env (Boolean("false") is true) — use z.stringbool() for boolean env flags',
  },
];

interface Finding {
  file: string;
  line: string;
  lineNo: number;
  ruleId: string;
  ruleMessage: string;
}

/**
 * A matched line that is itself a comment is a mention (e.g. JSDoc naming the
 * antipattern to document the rule), not a real usage. Real violations are
 * code. Skipping comment lines keeps the rules sound when docs name the pattern.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
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
    })
    .filter((finding) => !isCommentLine(finding.line));
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

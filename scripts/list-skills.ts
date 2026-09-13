#!/usr/bin/env bun
/**
 * @fileoverview Surfaces the YAML frontmatter of all SKILL.md files in this
 * project's `.claude/skills/` directory (falling back to `framework-skills/`). Mirrors
 * how the Claude Code harness lists available skills, but as plain stdout an
 * agent can read.
 *
 * Sub-agents spawned via the Agent tool do NOT inherit the parent session's
 * skill registry — they see only the parent's skills, not the project-local
 * skills in their working directory. Running this script gives a sub-agent
 * operating in this project a quick index of available local skills. The
 * agent can then read any relevant SKILL.md by the printed path before
 * following its steps.
 *
 * @module scripts/list-skills
 *
 * Usage:
 *   bun run scripts/list-skills.ts
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const CANDIDATE_DIRS = ['.claude/skills', 'framework-skills'] as const;

interface SkillEntry {
  description: string;
  name: string;
  path: string;
  references: string[];
}

/**
 * Naive YAML frontmatter parser. Handles flat `key: value` pairs (with
 * optional surrounding `"` / `'` quotes stripped) and folded (`>`) / literal
 * (`|`) block scalars over indented continuation lines — folded joins lines
 * with spaces, literal preserves newlines. Sufficient for SKILL.md
 * frontmatter — do not extend to general YAML; pull in a real parser if the
 * format outgrows this.
 */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const body = match?.[1];
  if (!body) return {};
  const out: Record<string, string> = {};
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const kv = line.match(/^(\w+):\s*(.*)$/);
    const key = kv?.[1];
    if (!kv || !key) {
      i++;
      continue;
    }
    const val = (kv[2] ?? '').trim();
    const block = val.match(/^([>|])[-+]?$/);
    if (block) {
      const buf: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next === undefined || !/^\s+\S/.test(next)) break;
        buf.push(next.trim());
        i++;
      }
      out[key] = buf.join(block[1] === '|' ? '\n' : ' ').trim();
      continue;
    }
    out[key] = stripQuotes(val);
    i++;
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1);
  }
  return s;
}

async function listReferences(skillDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(skillDir, 'references'));
    return entries.filter((e) => e.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function findSkillsDir(): { rel: string; abs: string } | null {
  // Resolve candidates relative to the script's parent dir (project root),
  // not CWD — invocation may be from a sub-agent's worktree or subdirectory.
  const root = resolve(import.meta.dirname, '..');
  for (const dir of CANDIDATE_DIRS) {
    const abs = join(root, dir);
    if (existsSync(abs)) return { rel: dir, abs };
  }
  return null;
}

async function main(): Promise<void> {
  const dir = findSkillsDir();
  const root = resolve(import.meta.dirname, '..');
  if (!dir) {
    console.error(
      `No skills directory found. Expected one of: ${CANDIDATE_DIRS.join(', ')} relative to project root (${root}).`,
    );
    process.exit(1);
  }

  const entries = await readdir(dir.abs, { withFileTypes: true });
  const skills = (
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (entry): Promise<SkillEntry | null> => {
          const skillDir = join(dir.abs, entry.name);
          const skillPath = join(skillDir, 'SKILL.md');
          let content: string;
          try {
            content = await readFile(skillPath, 'utf-8');
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw err;
          }
          const fm = parseFrontmatter(content);
          return {
            name: fm.name ?? entry.name,
            description: fm.description ?? '',
            path: skillPath,
            references: await listReferences(skillDir),
          };
        }),
    )
  ).filter((s): s is SkillEntry => s !== null);

  skills.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`# Skills available in ${dir.rel}/`);
  console.log(`# Project root: ${root}`);
  console.log(`#`);
  console.log(`# Sub-agents: this list mimics the parent harness's skill registry.`);
  console.log(
    `# Read the full SKILL.md at the listed path before following a skill's procedure.\n`,
  );

  for (const s of skills) {
    console.log(`- ${s.name} (${s.path})`);
    if (s.description) console.log(`  ${s.description}`);
    if (s.references.length > 0) {
      console.log(`  references: ${s.references.join(', ')}`);
    }
    console.log();
  }

  console.log(`Total: ${skills.length} skills`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

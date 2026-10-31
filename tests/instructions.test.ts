/**
 * @fileoverview Tests for the server-level `instructions` string sent on every
 * `initialize`. Clients render it as markdown, so identifiers stay wrapped in
 * backticks; its scope lines must state what `path_forbidden` enforces for
 * each combination of OBSIDIAN_READ_PATHS, OBSIDIAN_WRITE_PATHS,
 * OBSIDIAN_DENY_PATHS, and OBSIDIAN_READ_ONLY, without naming a deny prefix.
 * @module tests/instructions.test
 */

import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '@/config/server-config.js';
import { buildInstructions } from '@/instructions.js';
import { PathPolicy } from '@/services/obsidian/path-policy.js';
import { makeTestConfig } from './helpers.js';

function instructionsFor(
  overrides: Partial<ServerConfig> = {},
  omnisearchReachable = false,
): string {
  const config = makeTestConfig(overrides);
  return buildInstructions({
    enableCommands: config.enableCommands,
    omnisearchReachable,
    policy: new PathPolicy(config),
    readOnly: config.readOnly,
  });
}

/** The tool family, the example path, and the tag notation are backticked for markdown clients. */
const BASELINE =
  'Use the `obsidian_*` tools to access the Obsidian vault via the Local REST API plugin: search, read, write, and patch notes, including targeted edits to headings, blocks, and YAML frontmatter. Notes are addressed by vault-relative path including the file extension (e.g. `Folder/Note.md`); tags support hierarchical `parent/child` notation, and counts roll up to parents.';
const RECOVERY =
  'Paths outside scope reject with `path_forbidden` — error data carries the active scope so you can self-correct.';
const WITHHELD = 'Withheld paths reject with subreason `denied_path` and carry no scope.';
const READ_ONLY =
  'Read-only mode is active (OBSIDIAN_READ_ONLY=true): write tools are unavailable. `obsidian_open_in_ui` still opens notes that exist, but rejects an open against a missing path — Obsidian would create the file.';
const COMMANDS =
  'Command-palette tools (`obsidian_list_commands`, `obsidian_execute_command`) are enabled and can fire any Obsidian command. Commands are opaque and may be destructive — prefer dedicated tools when one fits.';
/** Only filters Omnisearch applies before its 50-hit cap are offered as a way to narrow (#172). */
const OMNISEARCH =
  '`obsidian_search_notes` includes an `omnisearch` mode: BM25-ranked, typo-tolerant, with PDF/OCR coverage (via the Text Extractor plugin). Omnisearch keeps only its top 50 matches: narrow with `path:` / `ext:` filters or more plain terms, which apply before that cap. Quoted phrases and `-exclusion` filter only those 50, so a result using them is marked `truncated`.';
/** Under a read scope the cap runs over the whole vault before the scope filters (#163). */
const OMNISEARCH_SCOPED = `${OMNISEARCH} Under the read scope the cap ranks the whole vault before the scope filters it, so \`truncated\` is always true; a \`path:\` term naming a readable folder ranks within that folder.`;

const join = (...sections: string[]) => sections.join('\n\n');

describe('server instructions — the effective path scope', () => {
  it.each([
    ['no policy: the baseline alone', {}, BASELINE],
    [
      'write paths alone',
      { writePaths: ['work'] },
      join(
        BASELINE,
        `Vault path policy is enforced. Readable: full vault. Writable: 'work'. ${RECOVERY}`,
      ),
    ],
    [
      'read paths alone: writes are confined to the read scope too',
      { readPaths: ['work'] },
      join(
        BASELINE,
        `Vault path policy is enforced. Readable: 'work'. Writable: 'work'. ${RECOVERY}`,
      ),
    ],
    [
      'read and write paths: write paths are readable',
      { readPaths: ['work'], writePaths: ['inbox'] },
      join(
        BASELINE,
        `Vault path policy is enforced. Readable: 'work', 'inbox'. Writable: 'inbox'. ${RECOVERY}`,
      ),
    ],
    ['read-only alone: no prefixes', { readOnly: true }, join(BASELINE, READ_ONLY)],
    [
      'read-only with read paths: the readable prefixes',
      { readOnly: true, readPaths: ['work'] },
      join(BASELINE, READ_ONLY, `Vault path policy is enforced. Readable: 'work'. ${RECOVERY}`),
    ],
    [
      'read-only with read and write paths: write paths are not readable',
      { readOnly: true, readPaths: ['work'], writePaths: ['inbox'] },
      join(BASELINE, READ_ONLY, `Vault path policy is enforced. Readable: 'work'. ${RECOVERY}`),
    ],
    [
      'read-only with write paths alone: no prefixes',
      { readOnly: true, writePaths: ['inbox'] },
      join(BASELINE, READ_ONLY),
    ],
  ] as Array<[string, Partial<ServerConfig>, string]>)('%s', (_label, config, expected) => {
    expect(instructionsFor(config)).toBe(expected);
  });

  it.each([
    [
      'deny list alone: the full vault, minus what is withheld',
      { denyPaths: ['private', 'journal/therapy'] },
      join(
        BASELINE,
        `Vault path policy is enforced. Readable: full vault, except paths the operator withholds. Writable: full vault, except paths the operator withholds. ${RECOVERY} ${WITHHELD}`,
      ),
    ],
    [
      'read paths with a denied subfolder',
      { readPaths: ['projects'], denyPaths: ['projects/secret'] },
      join(
        BASELINE,
        `Vault path policy is enforced. Readable: 'projects', except paths the operator withholds. Writable: 'projects', except paths the operator withholds. ${RECOVERY} ${WITHHELD}`,
      ),
    ],
    [
      'read-only keeps the scope line when paths are withheld',
      { readOnly: true, denyPaths: ['private'] },
      join(
        BASELINE,
        READ_ONLY,
        `Vault path policy is enforced. Readable: full vault, except paths the operator withholds. ${RECOVERY} ${WITHHELD}`,
      ),
    ],
    [
      'an allowlist the deny list covers whole: nothing reachable',
      { readPaths: ['journal/public'], denyPaths: ['journal'] },
      join(
        BASELINE,
        `Vault path policy is enforced. Readable: none. Writable: none. ${RECOVERY} ${WITHHELD}`,
      ),
    ],
  ] as Array<[string, Partial<ServerConfig>, string]>)('%s', (_label, config, expected) => {
    const text = instructionsFor(config);
    expect(text).toBe(expected);
    // The deny prefixes stay out: they name exactly what the list hides.
    for (const prefix of config.denyPaths ?? []) expect(text).not.toContain(prefix);
  });

  it('keeps the command-palette and Omnisearch lines after the scope line', () => {
    expect(instructionsFor({ writePaths: ['work', 'inbox'], enableCommands: true }, true)).toBe(
      join(
        BASELINE,
        `Vault path policy is enforced. Readable: full vault. Writable: 'work', 'inbox'. ${RECOVERY}`,
        COMMANDS,
        OMNISEARCH,
      ),
    );
    // Commands are off under read-only whatever the flag says.
    expect(instructionsFor({ readOnly: true, enableCommands: true })).toBe(
      join(BASELINE, READ_ONLY),
    );
  });

  it.each([
    ['read paths', { readPaths: ['work'] }, `Readable: 'work'. Writable: 'work'. ${RECOVERY}`],
    [
      'a deny list alone',
      { denyPaths: ['private'] },
      `Readable: full vault, except paths the operator withholds. Writable: full vault, except paths the operator withholds. ${RECOVERY} ${WITHHELD}`,
    ],
  ] as Array<[string, Partial<ServerConfig>, string]>)(
    'tells a scoped server that Omnisearch is always truncated: %s',
    (_label, config, scope) => {
      const text = instructionsFor(config, true);
      expect(text).toBe(
        join(BASELINE, `Vault path policy is enforced. ${scope}`, OMNISEARCH_SCOPED),
      );
      expect(text).not.toContain('private');
    },
  );

  it('keeps the unscoped Omnisearch line for write paths alone, which leave reads vault-wide', () => {
    expect(instructionsFor({ writePaths: ['inbox'] }, true)).toContain(`\n\n${OMNISEARCH}`);
    expect(instructionsFor({ writePaths: ['inbox'] }, true)).not.toContain('Under the read scope');
  });
});

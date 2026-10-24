/**
 * @fileoverview Tests for the server-level `instructions` string sent on every
 * `initialize`. Clients render it as markdown, so identifiers stay wrapped in
 * backticks; its scope lines must state what `path_forbidden` enforces for
 * each combination of OBSIDIAN_READ_PATHS, OBSIDIAN_WRITE_PATHS, and
 * OBSIDIAN_READ_ONLY.
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
const READ_ONLY =
  'Read-only mode is active (OBSIDIAN_READ_ONLY=true): write tools are unavailable. `obsidian_open_in_ui` still opens notes that exist, but rejects an open against a missing path — Obsidian would create the file.';
const COMMANDS =
  'Command-palette tools (`obsidian_list_commands`, `obsidian_execute_command`) are enabled and can fire any Obsidian command. Commands are opaque and may be destructive — prefer dedicated tools when one fits.';
const OMNISEARCH =
  '`obsidian_search_notes` includes an `omnisearch` mode: BM25-ranked, typo-tolerant, with PDF/OCR coverage (via the Text Extractor plugin). Results cap at 50 upstream — narrow the query (quoted phrases, `-exclusion`, `path:` / `ext:` filters) to surface more.';

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
});

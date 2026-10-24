/**
 * @fileoverview The server-level `instructions` string sent on every
 * `initialize`: baseline orientation, then deployment-specific lines for
 * read-only mode, the effective path scope, the command-palette toggle, and
 * Omnisearch availability.
 * @module instructions
 */

import type { PathPolicy } from '@/services/obsidian/path-policy.js';

const BASELINE =
  'Use the `obsidian_*` tools to access the Obsidian vault via the Local REST API plugin: search, read, write, and patch notes, including targeted edits to headings, blocks, and YAML frontmatter. Notes are addressed by vault-relative path including the file extension (e.g. `Folder/Note.md`); tags support hierarchical `parent/child` notation, and counts roll up to parents.';

const SCOPE_RECOVERY =
  'Paths outside scope reject with `path_forbidden` — error data carries the active scope so you can self-correct.';

/** Prefixes as the instructions quote them; `undefined` is an unrestricted op. */
function renderScope(scope: readonly string[] | undefined): string {
  return scope === undefined ? 'full vault' : scope.map((p) => `'${p}'`).join(', ');
}

/**
 * Build the instructions. The scope lines state what `path_forbidden`
 * enforces (`PathPolicy.effectiveScope`), not the configured lists the
 * startup banner reports.
 */
export function buildInstructions(opts: {
  enableCommands: boolean;
  omnisearchReachable: boolean;
  policy: PathPolicy;
  readOnly: boolean;
}): string {
  const { enableCommands, omnisearchReachable, policy, readOnly } = opts;
  const { readable, writable } = policy.effectiveScope();
  const sections = [BASELINE];
  if (readOnly) {
    sections.push(
      'Read-only mode is active (OBSIDIAN_READ_ONLY=true): write tools are unavailable. `obsidian_open_in_ui` still opens notes that exist, but rejects an open against a missing path — Obsidian would create the file.',
    );
    if (readable !== undefined) {
      sections.push(
        `Vault path policy is enforced. Readable: ${renderScope(readable)}. ${SCOPE_RECOVERY}`,
      );
    }
  } else if (!policy.isUnrestricted) {
    sections.push(
      `Vault path policy is enforced. Readable: ${renderScope(readable)}. Writable: ${renderScope(writable)}. ${SCOPE_RECOVERY}`,
    );
  }
  if (enableCommands && !readOnly) {
    sections.push(
      'Command-palette tools (`obsidian_list_commands`, `obsidian_execute_command`) are enabled and can fire any Obsidian command. Commands are opaque and may be destructive — prefer dedicated tools when one fits.',
    );
  }
  if (omnisearchReachable) {
    sections.push(
      '`obsidian_search_notes` includes an `omnisearch` mode: BM25-ranked, typo-tolerant, with PDF/OCR coverage (via the Text Extractor plugin). Results cap at 50 upstream — narrow the query (quoted phrases, `-exclusion`, `path:` / `ext:` filters) to surface more.',
    );
  }
  return sections.join('\n\n');
}

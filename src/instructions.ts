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

const WITHHELD_RECOVERY = 'Withheld paths reject with subreason `denied_path` and carry no scope.';

/**
 * Prefixes as the instructions quote them; `undefined` is an unrestricted op,
 * `[]` an op that reaches nothing. `withheld` notes that OBSIDIAN_DENY_PATHS
 * carves paths out of the scope, without naming them: the deny prefixes name
 * exactly what the list hides.
 */
function renderScope(scope: readonly string[] | undefined, withheld: boolean): string {
  if (scope?.length === 0) return 'none';
  const reach = scope === undefined ? 'full vault' : scope.map((p) => `'${p}'`).join(', ');
  return withheld ? `${reach}, except paths the operator withholds` : reach;
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
  const withheld = policy.withholdsPaths;
  const recovery = withheld ? `${SCOPE_RECOVERY} ${WITHHELD_RECOVERY}` : SCOPE_RECOVERY;
  const sections = [BASELINE];
  if (readOnly) {
    sections.push(
      'Read-only mode is active (OBSIDIAN_READ_ONLY=true): write tools are unavailable. `obsidian_open_in_ui` still opens notes that exist, but rejects an open against a missing path — Obsidian would create the file.',
    );
    if (readable !== undefined || withheld) {
      sections.push(
        `Vault path policy is enforced. Readable: ${renderScope(readable, withheld)}. ${recovery}`,
      );
    }
  } else if (!policy.isUnrestricted) {
    sections.push(
      `Vault path policy is enforced. Readable: ${renderScope(readable, withheld)}. Writable: ${renderScope(writable, withheld)}. ${recovery}`,
    );
  }
  if (enableCommands && !readOnly) {
    sections.push(
      'Command-palette tools (`obsidian_list_commands`, `obsidian_execute_command`) are enabled and can fire any Obsidian command. Commands are opaque and may be destructive — prefer dedicated tools when one fits.',
    );
  }
  if (omnisearchReachable) {
    const omnisearch =
      '`obsidian_search_notes` includes an `omnisearch` mode: BM25-ranked, typo-tolerant, with PDF/OCR coverage (via the Text Extractor plugin). Omnisearch keeps only its top 50 matches: narrow with `path:` / `ext:` filters or more plain terms, which apply before that cap. Quoted phrases and `-exclusion` filter only those 50, so a result using them is marked `truncated`.';
    sections.push(
      policy.restrictsReads
        ? `${omnisearch} Under the read scope the cap ranks the whole vault before the scope filters it, so \`truncated\` is always true; a \`path:\` term naming a readable folder ranks within that folder.`
        : omnisearch,
    );
  }
  return sections.join('\n\n');
}

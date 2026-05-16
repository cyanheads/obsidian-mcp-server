/**
 * @fileoverview Regression tests for the server-level `instructions` string in
 * `src/index.ts`. The string is sent on every `initialize` and is rendered as
 * markdown by clients that support it (Claude Desktop, etc.), so identifiers
 * like `obsidian_*`, `Folder/Note.md`, and `parent/child` must stay wrapped in
 * backticks. `src/index.ts` runs `await createApp(...)` at module top-level,
 * so we can't import it under test — we read the source as text and assert on
 * the literal string passed to `sections`.
 * @module tests/instructions.test
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(resolve(here, '../src/index.ts'), 'utf-8');

/**
 * Find the first single-quoted string literal in `src/index.ts` that mentions
 * `obsidian_*`. That's the baseline instructions sentence — everything else
 * (read-only mode, scoped paths, command-palette toggle) is layered in
 * conditionally.
 */
function baselineInstructionsLiteral(): string {
  const match = indexSource.match(/'[^']*obsidian_\*[^']*'/);
  if (!match) {
    throw new Error('Could not locate the baseline instructions string literal in src/index.ts');
  }
  return match[0];
}

describe('server instructions — markdown backtick wrapping', () => {
  it('wraps the tool family identifier in backticks', () => {
    expect(baselineInstructionsLiteral()).toMatch(/`obsidian_\*`/);
  });

  it('wraps the example path in backticks', () => {
    expect(baselineInstructionsLiteral()).toMatch(/`Folder\/Note\.md`/);
  });

  it('wraps the hierarchical tag notation in backticks', () => {
    expect(baselineInstructionsLiteral()).toMatch(/`parent\/child`/);
  });
});

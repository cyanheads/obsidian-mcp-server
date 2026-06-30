/**
 * @fileoverview Static safety guards for user-supplied `nameRegex` filters.
 * JavaScript's RegExp engine has no native execution timeout, so we statically
 * reject the textbook catastrophic-backtracking shapes before calling
 * `new RegExp(...)`. Shared by every tool that compiles a user-supplied regex:
 * the name filters on `obsidian_list_tags` / `obsidian_list_commands` /
 * `obsidian_list_notes`, and the `useRegex` search patterns on
 * `obsidian_replace_in_note` (which raises the length cap for note-body input).
 * @module mcp-server/tools/definitions/_shared/regex-safety
 */

/** Maximum allowed pattern length — bounds compile cost and AST surface. */
export const NAME_REGEX_MAX_LENGTH = 256;

/**
 * Detects the canonical catastrophic-backtracking shape: a `+`/`*`/`{N,}`
 * quantifier immediately following a `)` whose interior already ends in a
 * `+`/`*`/`}` quantifier (e.g. `(a+)+`, `(.*)*`, `(a{2,})*`). Not exhaustive —
 * patterns with overlapping alternation like `(a|a)*` still slip through —
 * but eliminates the textbook ReDoS vector at zero runtime cost.
 */
const NESTED_QUANTIFIER = /[+*}]\)[*+{]/;

/**
 * Returns a human-readable reason string when the pattern is unsafe, or
 * `undefined` when it passes the static guards. `maxLength` defaults to
 * {@link NAME_REGEX_MAX_LENGTH}; callers running patterns over larger input
 * (e.g. a full note body) may raise it. The nested-quantifier check is applied
 * unchanged regardless of the cap. Callers compile with `new RegExp(pattern)`
 * after this returns `undefined` and surface the returned reason via the
 * tool's `regex_unsafe` error.
 */
export function nameRegexSafetyIssue(
  pattern: string,
  maxLength = NAME_REGEX_MAX_LENGTH,
): string | undefined {
  if (pattern.length > maxLength) {
    return `pattern exceeds ${maxLength}-character limit`;
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return 'pattern contains nested quantifiers (catastrophic-backtracking risk)';
  }
  return;
}

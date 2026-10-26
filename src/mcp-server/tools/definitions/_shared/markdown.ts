/**
 * @fileoverview Code-span encoding for the values `format()` and enrichment
 * notices show as code — paths, tags, keys, command IDs, regexes, search terms.
 * Free text outside a span goes through the framework's `escapeMarkdownInline`.
 * @module mcp-server/tools/definitions/_shared/markdown
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * `value` as an inline code span whose delimiter outgrows its longest backtick
 * run, so a value the tool did not author reads back byte-identical under a
 * CommonMark parse and cannot close the span early. A line break inside reads
 * back as a space.
 */
export function inlineCode(value: string): string {
  return markdown().inlineCode(value).build();
}

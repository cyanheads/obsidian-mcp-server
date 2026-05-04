/**
 * @fileoverview Reusable Zod shapes for Obsidian tool definitions.
 * Target/Section/PatchOptions/ContentType are referenced across multiple tools;
 * keeping them here prevents drift in the discriminator and field descriptions.
 * @module mcp-server/tools/definitions/_shared/schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Where a note lives — vault path, the active file, or a periodic note. */
export const TargetSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('path').describe('Address by vault-relative path.'),
      path: z
        .string()
        .min(1)
        .describe('Vault-relative path including extension, e.g. "Projects/foo.md".'),
    })
    .describe('Address a note by its vault-relative path.'),
  z
    .object({
      type: z.literal('active').describe('Address the file currently open in Obsidian.'),
    })
    .describe('Address whichever file is currently active in the Obsidian UI.'),
  z
    .object({
      type: z.literal('periodic').describe('Address a daily/weekly/monthly/etc. periodic note.'),
      period: z
        .enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly'])
        .describe('Periodic note granularity.'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('ISO date YYYY-MM-DD. Omit for the current period.'),
    })
    .describe('Address a periodic note (current or dated).'),
]);

/** Sub-document target inside a note. */
export const SectionSchema = z.object({
  type: z
    .enum(['heading', 'block', 'frontmatter'])
    .describe('Heading by name, block by reference, or frontmatter field by key.'),
  target: z
    .string()
    .min(1)
    .describe(
      'Heading name (use "::" for nested headings), block reference without leading caret (e.g. "2d9b4a", not "^2d9b4a"), or frontmatter field name.',
    ),
});

export const PatchOptionsSchema = z
  .object({
    createTargetIfMissing: z
      .boolean()
      .default(false)
      .describe('Create the target heading/block/frontmatter field if it does not exist.'),
    applyIfContentPreexists: z
      .boolean()
      .default(false)
      .describe(
        'Apply the patch even if matching content already exists in the target. Guards against double-applying.',
      ),
    trimTargetWhitespace: z
      .boolean()
      .default(false)
      .describe('Trim whitespace from the target section before applying the operation.'),
  })
  .optional();

export const ContentTypeSchema = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe(
    'Content body format. Use "json" for typed frontmatter values or block-targeted table rows. JSON values must be valid JSON literals — strings need quoting (`"\\"draft\\""`, not `"draft"`), and numbers/booleans/arrays/objects pass through as-is.',
  );

export type ToolTarget = z.infer<typeof TargetSchema>;
export type ToolSection = z.infer<typeof SectionSchema>;

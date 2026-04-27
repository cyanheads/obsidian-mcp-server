/**
 * @fileoverview obsidian_get_note — read a note's content, full NoteJson,
 * structural document map, or a single section.
 * @module mcp-server/tools/definitions/obsidian-get-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { extractSection } from '@/services/obsidian/section-extractor.js';
import { SectionSchema, TargetSchema } from './_shared/schemas.js';

const StatSchema = z.object({
  ctime: z.number().describe('Created time, ms since epoch.'),
  mtime: z.number().describe('Modified time, ms since epoch.'),
  size: z.number().describe('File size in bytes.'),
});

export const obsidianGetNote = tool('obsidian_get_note', {
  description:
    'Read a note from the vault. `format: "content"` returns just the raw markdown body. `format: "full"` returns a structured object with content, frontmatter, tags, and file metadata. `format: "document-map"` returns the catalog of headings, block references, and frontmatter fields. `format: "section"` returns a single heading/block/frontmatter section (requires `section`); heading sections include the full subtree under that heading, including nested headings. Works against any vault path, the active file, or a periodic note.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    format: z
      .enum(['content', 'full', 'document-map', 'section'])
      .describe('Which projection of the note to return.'),
    target: TargetSchema.describe('Where the note lives.'),
    section: SectionSchema.optional().describe(
      'Required when `format` is `"section"`. Identifies the heading/block/frontmatter to extract.',
    ),
  }),
  output: z.object({
    result: z
      .discriminatedUnion('format', [
        z
          .object({
            format: z.literal('content').describe('Echoed format discriminator.'),
            path: z.string().describe('Resolved vault-relative path of the note.'),
            content: z.string().describe('Raw markdown body.'),
          })
          .describe('Content-only projection.'),
        z
          .object({
            format: z.literal('full').describe('Echoed format discriminator.'),
            path: z.string().describe('Resolved vault-relative path of the note.'),
            content: z.string().describe('Raw markdown body.'),
            frontmatter: z
              .record(z.string(), z.unknown())
              .describe('Parsed YAML frontmatter as an object.'),
            tags: z.array(z.string()).describe('Tags from frontmatter and inline #tag syntax.'),
            stat: StatSchema.describe('File metadata.'),
          })
          .describe('Full projection — content plus parsed metadata.'),
        z
          .object({
            format: z.literal('document-map').describe('Echoed format discriminator.'),
            path: z.string().describe('Resolved vault-relative path of the note.'),
            headings: z.array(z.string()).describe('All headings in document order.'),
            blocks: z.array(z.string()).describe('All block reference IDs.'),
            frontmatterFields: z.array(z.string()).describe('All frontmatter field keys.'),
          })
          .describe('Document-map projection — catalog of patch targets.'),
        z
          .object({
            format: z.literal('section').describe('Echoed format discriminator.'),
            path: z.string().describe('Resolved vault-relative path of the note.'),
            section: SectionSchema.describe('Echoed section locator.'),
            valueText: z
              .string()
              .optional()
              .describe('Section value as raw markdown (heading/block sections).'),
            valueJson: z
              .unknown()
              .optional()
              .describe(
                'Section value as the JSON-typed frontmatter value (frontmatter sections only).',
              ),
          })
          .describe('Single-section projection.'),
      ])
      .describe('Mode-discriminated projection of the requested note.'),
  }),
  auth: ['tool:obsidian_get_note:read'],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const { target } = input;

    if (input.format === 'content') {
      if (target.type === 'path') {
        const content = await svc.getNoteContent(ctx, target);
        return { result: { format: 'content' as const, path: target.path, content } };
      }
      const note = await svc.getNoteJson(ctx, target);
      return { result: { format: 'content' as const, path: note.path, content: note.content } };
    }

    if (input.format === 'full') {
      const note = await svc.getNoteJson(ctx, target);
      return {
        result: {
          format: 'full' as const,
          path: note.path,
          content: note.content,
          frontmatter: note.frontmatter,
          tags: note.tags,
          stat: note.stat,
        },
      };
    }

    if (input.format === 'document-map') {
      const [map, path] = await Promise.all([
        svc.getDocumentMap(ctx, target),
        svc.resolvePath(ctx, target),
      ]);
      return {
        result: {
          format: 'document-map' as const,
          path,
          headings: map.headings,
          blocks: map.blocks,
          frontmatterFields: map.frontmatterFields,
        },
      };
    }

    if (!input.section) {
      throw invalidParams('`section` is required when `format` is "section".', {
        format: input.format,
      });
    }
    const note = await svc.getNoteJson(ctx, target);
    const value = extractSection(note, input.section);
    return {
      result: {
        format: 'section' as const,
        path: note.path,
        section: input.section,
        ...(input.section.type === 'frontmatter'
          ? { valueJson: value }
          : { valueText: typeof value === 'string' ? value : String(value) }),
      },
    };
  },

  format: ({ result }) => {
    if (result.format === 'content') {
      return [
        {
          type: 'text',
          text: `**${result.path}** (format: ${result.format})\n\n${result.content}`,
        },
      ];
    }
    if (result.format === 'full') {
      const lines = [
        `**${result.path}** (format: ${result.format})`,
        `*Tags:* ${result.tags.length > 0 ? result.tags.join(', ') : '(none)'}`,
        `*Stat:* created=${formatIsoTime(result.stat.ctime)} modified=${formatIsoTime(result.stat.mtime)} size=${result.stat.size}`,
      ];
      const fmKeys = Object.keys(result.frontmatter);
      if (fmKeys.length > 0) {
        lines.push('', '**Frontmatter**');
        for (const k of fmKeys) {
          lines.push(`- \`${k}\`: ${stringifyValue(result.frontmatter[k])}`);
        }
      }
      lines.push('', '**Content**', result.content);
      return [{ type: 'text', text: lines.join('\n') }];
    }
    if (result.format === 'document-map') {
      const lines = [
        `**${result.path}** (format: ${result.format})`,
        '',
        `**Headings (${result.headings.length})**`,
        ...result.headings.map((h) => `- ${h}`),
        '',
        `**Blocks (${result.blocks.length})**`,
        ...result.blocks.map((b) => `- ^${b}`),
        '',
        `**Frontmatter fields (${result.frontmatterFields.length})**`,
        ...result.frontmatterFields.map((f) => `- ${f}`),
      ];
      return [{ type: 'text', text: lines.join('\n') }];
    }
    const valueRender =
      result.valueText !== undefined
        ? result.valueText
        : result.valueJson !== undefined
          ? stringifyValue(result.valueJson)
          : '_(empty)_';
    return [
      {
        type: 'text',
        text: [
          `**${result.path}** (format: ${result.format})`,
          `*Section:* ${result.section.type} → ${result.section.target}`,
          '',
          valueRender,
        ].join('\n'),
      },
    ];
  },
});

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

function formatIsoTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '(unknown)';
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

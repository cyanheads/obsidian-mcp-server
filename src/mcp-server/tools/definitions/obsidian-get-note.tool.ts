/**
 * @fileoverview obsidian_get_note — read a note's content, full NoteJson,
 * structural document map, or a single section.
 * @module mcp-server/tools/definitions/obsidian-get-note.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { extractSection } from '@/services/obsidian/section-extractor.js';
import { SectionSchema, TargetSchema } from './_shared/schemas.js';
import { withCaseFallback } from './_shared/suggest-paths.js';

const StatSchema = z.object({
  ctime: z.number().describe('Created time, ms since epoch.'),
  mtime: z.number().describe('Modified time, ms since epoch.'),
  size: z.number().describe('File size in bytes.'),
});

export const obsidianGetNote = tool('obsidian_get_note', {
  description:
    'Read a note from the vault — by path, the active file, or a periodic note. Choose a `format` projection: raw body, full object, structural document map, or a single section.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    format: z
      .enum(['content', 'full', 'document-map', 'section'])
      .describe(
        'Which projection to return. `content` — raw markdown body. `full` — content plus parsed frontmatter, tags, and file metadata. `document-map` — catalog of headings, block IDs, and frontmatter field names (use to discover patch targets). `section` — a single heading, block, or frontmatter section (requires `section`); heading sections include the full subtree under that heading and use `Parent::Child` syntax for nesting.',
      ),
    target: TargetSchema.describe('Where the note lives.'),
    section: SectionSchema.optional().describe(
      'Required when `format` is `"section"`. Identifies the heading/block/frontmatter to extract.',
    ),
    includeLinks: z
      .boolean()
      .default(false)
      .describe(
        'When true with `format: "full"`, parses outgoing wiki and markdown link references from the note body. Skipped for other formats.',
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
              .describe(
                'Parsed YAML frontmatter. Values are strings, numbers, booleans, arrays, or nested objects.',
              ),
            tags: z.array(z.string()).describe('Tags from frontmatter and inline #tag syntax.'),
            stat: StatSchema.describe('File metadata.'),
            outgoingLinks: z
              .array(
                z
                  .object({
                    target: z
                      .string()
                      .describe(
                        'Link target as written — vault path, basename, or alias. No existence check.',
                      ),
                    type: z.enum(['wikilink', 'markdown']).describe('Source syntax.'),
                  })
                  .describe('A single outgoing link reference.'),
              )
              .optional()
              .describe(
                'Outgoing link references parsed from the note body. Present when `includeLinks` is true. Vault-internal references only — external URLs (http, mailto, etc.) are filtered out.',
              ),
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
  errors: [
    {
      reason: 'section_required',
      code: JsonRpcErrorCode.ValidationError,
      when: '`format` is "section" but no `section` locator was provided.',
      recovery:
        'Pass `section: { type, target }` (e.g. `{ type: "heading", target: "Intro" }`), or use `format: "full"` / `"document-map"` instead.',
    },
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: 'The target path is outside OBSIDIAN_READ_PATHS (and OBSIDIAN_WRITE_PATHS, since write paths imply read access).',
      recovery:
        'Use a path inside the configured read scope. The error data echoes the active scope.',
    },
    {
      reason: 'note_missing',
      code: JsonRpcErrorCode.NotFound,
      when: 'The vault path does not resolve to an existing note.',
      recovery:
        'Verify the path with obsidian_list_notes or use obsidian_search_notes to locate the note.',
    },
    {
      reason: 'no_active_file',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `active` but no file is currently open in Obsidian.',
      recovery:
        'Call obsidian_open_in_ui to focus a file, or pass an explicit path target instead.',
    },
    {
      reason: 'periodic_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Target was `periodic` but no matching periodic note exists.',
      recovery: 'Create the periodic note first or pass an explicit path target.',
    },
    {
      reason: 'periodic_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: "Target was `periodic` but the requested period is not enabled in Obsidian's Periodic Notes plugin settings.",
      recovery:
        "Pass an explicit path target — the requested period is disabled in the operator's Periodic Notes plugin.",
    },
  ],

  async handler(input, ctx) {
    const svc = getObsidianService();
    const { target } = input;

    if (input.format === 'content') {
      if (target.type === 'path') {
        const { result: content, resolvedPath } = await withCaseFallback(ctx, svc, target, (t) =>
          svc.getNoteContent(ctx, t),
        );
        return {
          result: { format: 'content' as const, path: resolvedPath ?? target.path, content },
        };
      }
      const note = await svc.getNoteJson(ctx, target);
      return { result: { format: 'content' as const, path: note.path, content: note.content } };
    }

    if (input.format === 'full') {
      const { result: note } = await withCaseFallback(ctx, svc, target, (t) =>
        svc.getNoteJson(ctx, t),
      );
      return {
        result: {
          format: 'full' as const,
          path: note.path,
          content: note.content,
          frontmatter: note.frontmatter,
          tags: note.tags,
          stat: note.stat,
          ...(input.includeLinks ? { outgoingLinks: parseOutgoingLinks(note.content) } : {}),
        },
      };
    }

    if (input.format === 'document-map') {
      if (target.type === 'path') {
        const { result: map, resolvedPath } = await withCaseFallback(ctx, svc, target, (t) =>
          svc.getDocumentMap(ctx, t),
        );
        return {
          result: {
            format: 'document-map' as const,
            path: resolvedPath ?? target.path,
            headings: map.headings,
            blocks: map.blocks,
            frontmatterFields: map.frontmatterFields,
          },
        };
      }
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
      throw ctx.fail('section_required', '`section` is required when `format` is "section".', {
        format: input.format,
        ...ctx.recoveryFor('section_required'),
      });
    }
    const { result: note } = await withCaseFallback(ctx, svc, target, (t) =>
      svc.getNoteJson(ctx, t),
    );
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
      if (result.outgoingLinks && result.outgoingLinks.length > 0) {
        lines.push('', `**Outgoing links (${result.outgoingLinks.length})**`);
        for (const l of result.outgoingLinks) {
          lines.push(`- [${l.type}] ${l.target}`);
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

/**
 * Extract outgoing link references from note content. Captures Obsidian
 * wikilinks (`[[target]]`, `![[target]]`, with optional `|alias` or
 * `#section`) and markdown links (`[text](target)`). External URIs
 * (any `scheme:` form) are filtered out — only vault-internal references
 * remain. No existence checks; this is the link graph as written.
 */
function parseOutgoingLinks(
  content: string,
): Array<{ target: string; type: 'wikilink' | 'markdown' }> {
  const links: Array<{ target: string; type: 'wikilink' | 'markdown' }> = [];

  for (const m of content.matchAll(/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const target = m[1]?.trim();
    if (target) links.push({ target, type: 'wikilink' });
  }

  /**
   * URL group accepts either `<bracketed text with spaces>` or a non-whitespace
   * run. The bracketed form is the markdown spec's escape hatch for paths
   * containing spaces.
   */
  for (const m of content.matchAll(/\[[^\]]*\]\((<[^<>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let target = m[1]?.trim();
    if (!target) continue;
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1).trim();
    }
    if (target && !/^[a-z][a-z0-9+\-.]*:/i.test(target)) {
      links.push({ target, type: 'markdown' });
    }
  }

  return links;
}

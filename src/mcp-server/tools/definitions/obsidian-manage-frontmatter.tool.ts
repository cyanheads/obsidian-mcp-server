/**
 * @fileoverview obsidian_manage_frontmatter — atomic get/set/delete on a single
 * frontmatter key. `set` PATCHes the field; `delete` reads-modifies-writes the
 * file because PATCH has no `delete` operation.
 * @module mcp-server/tools/definitions/obsidian-manage-frontmatter.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { deleteFrontmatterKey } from '@/services/obsidian/frontmatter-ops.js';
import { getObsidianService } from '@/services/obsidian/obsidian-service.js';
import { TargetSchema } from './_shared/schemas.js';

export const obsidianManageFrontmatter = tool('obsidian_manage_frontmatter', {
  description:
    'Get, set, or delete a single frontmatter key on a note, atomically. `set` requires a JSON-typed `value` (string, number, boolean, array, or object).',
  annotations: { destructiveHint: true },
  input: z.object({
    operation: z
      .enum(['get', 'set', 'delete'])
      .describe(
        'Operation to perform on `key`. `get` — read the current value. `set` — write `value`, creating the key if absent. `delete` — remove the key from frontmatter.',
      ),
    target: TargetSchema.describe('Where the note lives.'),
    key: z.string().min(1).describe('Frontmatter field name.'),
    value: z
      .unknown()
      .optional()
      .describe(
        'Required when `operation` is `"set"`. JSON-typed value to write — strings, numbers, booleans, arrays, and objects all accepted.',
      ),
  }),
  output: z.object({
    result: z
      .discriminatedUnion('operation', [
        z
          .object({
            operation: z.literal('get').describe('Echoed operation.'),
            path: z.string().describe('Resolved vault-relative path.'),
            key: z.string().describe('Echoed frontmatter key.'),
            exists: z.boolean().describe('True when the key was present in the frontmatter.'),
            value: z.unknown().describe('Current value, or `null` when the key is absent.'),
          })
          .describe('Result for `get`.'),
        z
          .object({
            operation: z.literal('set').describe('Echoed operation.'),
            path: z.string().describe('Resolved vault-relative path.'),
            key: z.string().describe('Echoed frontmatter key.'),
            frontmatter: z
              .record(z.string(), z.unknown())
              .describe('Full frontmatter after the change.'),
            previousSizeInBytes: z.number().describe('Byte size of the note before the set.'),
            currentSizeInBytes: z.number().describe('Byte size of the note after the set.'),
          })
          .describe('Result for `set`.'),
        z
          .object({
            operation: z.literal('delete').describe('Echoed operation.'),
            path: z.string().describe('Resolved vault-relative path.'),
            key: z.string().describe('Echoed frontmatter key.'),
            frontmatter: z
              .record(z.string(), z.unknown())
              .describe('Full frontmatter after the change.'),
            previousSizeInBytes: z.number().describe('Byte size of the note before the delete.'),
            currentSizeInBytes: z
              .number()
              .describe(
                'Byte size of the note after the delete. Equals `previousSizeInBytes` when the key was already absent and no write was issued.',
              ),
          })
          .describe('Result for `delete`.'),
      ])
      .describe('Operation-discriminated result payload.'),
  }),
  auth: ['tool:obsidian_manage_frontmatter:write'],
  errors: [
    {
      reason: 'path_forbidden',
      code: JsonRpcErrorCode.Forbidden,
      when: '`get` requires the path to be readable; `set`/`delete` require it to be inside OBSIDIAN_WRITE_PATHS, with OBSIDIAN_READ_ONLY=false.',
      recovery: 'Use a path inside the configured scope. The error data echoes the active scope.',
    },
    {
      reason: 'value_required',
      code: JsonRpcErrorCode.ValidationError,
      when: '`operation` is "set" but no `value` was supplied.',
      recovery:
        'Pass `value` as any JSON-typed value: string, number, boolean, array, or object (e.g. `"draft"`, `42`, `true`, `["a","b"]`).',
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

    if (input.operation === 'get') {
      const note = await svc.getNoteJson(ctx, target);
      const exists = input.key in note.frontmatter;
      return {
        result: {
          operation: 'get' as const,
          path: note.path,
          key: input.key,
          exists,
          value: exists ? note.frontmatter[input.key] : null,
        },
      };
    }

    if (input.operation === 'set') {
      if (input.value === undefined) {
        throw ctx.fail('value_required', '`value` is required when operation is "set".', {
          operation: input.operation,
          ...ctx.recoveryFor('value_required'),
        });
      }
      const path = await svc.resolvePath(ctx, target);
      const pathTarget = { type: 'path' as const, path };
      const previousSizeInBytes = await svc.getSize(ctx, pathTarget);
      await svc.patchNote(ctx, pathTarget, JSON.stringify(input.value), {
        operation: 'replace',
        targetType: 'frontmatter',
        target: input.key,
        contentType: 'json',
        createTargetIfMissing: true,
      });
      const note = await svc.getNoteJson(ctx, pathTarget);
      // Delivered bytes — not note.stat.size (see ObsidianService.tryGetSize).
      const currentSizeInBytes = Buffer.byteLength(note.content, 'utf8');
      return {
        result: {
          operation: 'set' as const,
          path,
          key: input.key,
          frontmatter: note.frontmatter,
          previousSizeInBytes,
          currentSizeInBytes,
        },
      };
    }

    const note = await svc.getNoteJson(ctx, target);
    // Delivered bytes — not note.stat.size (see ObsidianService.tryGetSize).
    const previousSizeInBytes = Buffer.byteLength(note.content, 'utf8');
    const newContent = deleteFrontmatterKey(note.content, input.key);
    let currentSizeInBytes = previousSizeInBytes;
    if (newContent !== note.content) {
      await svc.writeNote(ctx, target, newContent, 'markdown');
      currentSizeInBytes = await svc.getSize(ctx, { type: 'path', path: note.path });
    }
    const projected = { ...note.frontmatter };
    delete projected[input.key];
    return {
      result: {
        operation: 'delete' as const,
        path: note.path,
        key: input.key,
        frontmatter: projected,
        previousSizeInBytes,
        currentSizeInBytes,
      },
    };
  },

  format: ({ result }) => {
    if (result.operation === 'get') {
      const valueStr = result.exists ? formatValue(result.value) : '_(absent)_';
      return [
        {
          type: 'text',
          text: [
            `**Frontmatter ${result.operation} \`${result.key}\` in ${result.path}**`,
            `*Exists:* ${result.exists}`,
            '*Value:*',
            valueStr,
          ].join('\n'),
        },
      ];
    }
    const fmKeys = Object.keys(result.frontmatter);
    const lines = [
      `**Frontmatter ${result.operation} \`${result.key}\` in ${result.path}**`,
      `*Size:* ${result.previousSizeInBytes} → ${result.currentSizeInBytes} bytes`,
      '',
      `**Frontmatter (${fmKeys.length} keys after change)**`,
    ];
    if (fmKeys.length === 0) {
      lines.push('_(empty)_');
    } else {
      for (const k of fmKeys) {
        lines.push(`- \`${k}\`: ${formatValue(result.frontmatter[k])}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '`null`';
  if (typeof v === 'string') return v;
  return `\`${JSON.stringify(v)}\``;
}

/**
 * @fileoverview Defines the core logic, schemas, and types for the `obsidian_read_note` tool.
 * This tool handles reading a file from an Obsidian vault, with case-insensitive fallback.
 * @module src/mcp-server/tools/obsidianReadNoteTool/logic
 */

import path from "node:path/posix";
import { z } from "zod";
import {
  NoteJson,
  ObsidianRestApiService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  createFormattedStatWithTokenCount,
  logger,
  type RequestContext,
} from "../../../utils/index.js";

// ====================================================================================
// Zod Schema Definitions
// ====================================================================================

export const ObsidianReadNoteInputSchema = z.object({
  filePath: z
    .string()
    .min(1, "filePath cannot be empty.")
    .describe(
      'The vault-relative path to the target file (e.g., "developer/github/tips.md"). Tries case-sensitive first, then case-insensitive fallback.',
    ),
  format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe(
      "Format for the returned content ('markdown' or 'json'). Defaults to 'markdown'.",
    ),
  includeStat: z
    .boolean()
    .default(false)
    .describe(
      "If true and format is 'markdown', includes file stats in the response. Defaults to false. Ignored if format is 'json'.",
    ),
});

const FormattedStatSchema = z.object({
  createdTime: z
    .string()
    .describe(
      'Creation time formatted as a standard date-time string (e.g., "05:29:00 PM | 05-03-2025").',
    ),
  modifiedTime: z
    .string()
    .describe(
      'Last modified time formatted as a standard date-time string (e.g., "05:29:00 PM | 05-03-2025").',
    ),
  tokenCountEstimate: z
    .number()
    .int()
    .describe(
      "Estimated token count of the file content (using tiktoken 'gpt-4o').",
    ),
});

export const ObsidianReadNoteResponseSchema = z.object({
  content: z.union([z.string(), z.custom<NoteJson>()]),
  stats: FormattedStatSchema.optional(),
});

// ====================================================================================
// Type Definitions
// ====================================================================================

export type ObsidianReadNoteInput = z.infer<typeof ObsidianReadNoteInputSchema>;
export type ObsidianReadNoteResponse = z.infer<
  typeof ObsidianReadNoteResponseSchema
>;

// ====================================================================================
// Helper Functions
// ====================================================================================

async function findCaseInsensitiveMatch(
  obsidianService: ObsidianRestApiService,
  originalFilePath: string,
  context: RequestContext,
): Promise<string> {
  const dirname = path.dirname(originalFilePath);
  const filenameLower = path.basename(originalFilePath).toLowerCase();
  const dirToList = dirname === "." ? "/" : dirname;

  const filesInDir = await obsidianService.listFiles(dirToList, context);
  const matches = filesInDir.filter(
    (f) => !f.endsWith("/") && path.basename(f).toLowerCase() === filenameLower,
  );

  if (matches.length === 1) {
    return path.join(dirname, path.basename(matches[0]));
  }
  if (matches.length > 1) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      `Ambiguous case-insensitive matches for '${originalFilePath}'. Found: [${matches.join(", ")}]`,
      context,
    );
  }
  throw new McpError(
    BaseErrorCode.NOT_FOUND,
    `File not found: '${originalFilePath}' (case-insensitive fallback also failed).`,
    context,
  );
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const obsidianReadNoteLogic = async (
  params: ObsidianReadNoteInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<ObsidianReadNoteResponse> => {
  const { filePath, format, includeStat } = params;
  let effectiveFilePath = filePath;

  logger.debug(`Executing obsidian_read_note logic for: ${filePath}`, context);

  let noteJson: NoteJson;
  try {
    noteJson = (await obsidianService.getFileContent(
      filePath,
      "json",
      context,
    )) as NoteJson;
  } catch (error) {
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      effectiveFilePath = await findCaseInsensitiveMatch(
        obsidianService,
        filePath,
        context,
      );
      noteJson = (await obsidianService.getFileContent(
        effectiveFilePath,
        "json",
        context,
      )) as NoteJson;
    } else {
      throw error;
    }
  }

  const formattedStat = noteJson.stat
    ? await createFormattedStatWithTokenCount(
        noteJson.stat,
        noteJson.content ?? "",
        context,
      )
    : undefined;

  const response: ObsidianReadNoteResponse = {
    content: format === "json" ? noteJson : (noteJson.content ?? ""),
  };

  if (format === "json" || includeStat) {
    response.stats = formattedStat ?? undefined;
  }

  return response;
};

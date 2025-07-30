/**
 * @fileoverview Defines the core logic for the `obsidian_read_note` tool. This tool handles
 * reading a note from an Obsidian vault, with a case-insensitive fallback, providing content
 * in multiple formats and optional metadata.
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
      'The vault-relative path to the target note (e.g., "developer/github/tips.md"). Tries a case-sensitive match first, then a case-insensitive one.',
    ),
  format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe(
      "The desired format for the note's content: `markdown` for raw text or `json` for a structured object including frontmatter.",
    ),
  includeStat: z
    .boolean()
    .default(false)
    .describe(
      "If true, includes detailed file stats (creation/modification times, token count) in the response. Always included for the `json` format.",
    ),
});

const FormattedStatSchema = z.object({
  createdTime: z
    .string()
    .describe(
      'Creation time formatted as a human-readable string (e.g., "05:29:00 PM | 05-03-2025").',
    ),
  modifiedTime: z
    .string()
    .describe(
      'Last modified time formatted as a human-readable string (e.g., "05:29:00 PM | 05-03-2025").',
    ),
  tokenCountEstimate: z
    .number()
    .int()
    .describe(
      "An estimated token count of the note's content, based on the 'gpt-4o' model.",
    ),
});

export const ObsidianReadNoteResponseSchema = z.object({
  content: z
    .union([z.string(), z.custom<NoteJson>()])
    .describe(
      "The content of the note, either as a markdown string or a JSON object.",
    ),
  stats: FormattedStatSchema.optional().describe(
    "Optional file statistics, including timestamps and token count.",
  ),
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

  if ((format === "json" || includeStat) && formattedStat) {
    response.stats = formattedStat;
  }

  return response;
};

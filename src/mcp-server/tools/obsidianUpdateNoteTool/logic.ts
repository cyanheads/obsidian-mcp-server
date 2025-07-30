/**
 * @fileoverview Defines the core logic for the `obsidian_update_note` tool, which handles
 * whole-file operations like appending, prepending, and overwriting content in Obsidian notes.
 * @module src/mcp-server/tools/obsidianUpdateNoteTool/logic
 */

import { z } from "zod";
import {
  NoteJson,
  ObsidianRestApiService,
  VaultCacheService,
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

const BaseObsidianUpdateNoteInputSchema = z.object({
  targetType: z
    .enum(["filePath", "activeFile", "periodicNote"])
    .describe(
      "The type of note to target: a specific `filePath`, the `activeFile` in the editor, or a `periodicNote` (e.g., 'daily').",
    ),
  content: z.string().describe("The content to write, append, or prepend."),
  targetIdentifier: z
    .string()
    .optional()
    .describe(
      "Identifier for the target. Required for `filePath` (e.g., 'Notes/My Note.md') and `periodicNote` (e.g., 'daily', 'weekly').",
    ),
  modificationType: z
    .literal("wholeFile")
    .describe(
      "Defines the modification scope, fixed to `wholeFile` for this tool.",
    ),
  wholeFileMode: z
    .enum(["append", "prepend", "overwrite"])
    .describe(
      "The operation mode: `append` to add to the end, `prepend` to the beginning, or `overwrite` the entire note.",
    ),
  createIfNeeded: z
    .boolean()
    .default(true)
    .describe(
      "If true, a new note will be created if the target does not exist.",
    ),
  overwriteIfExists: z
    .boolean()
    .default(false)
    .describe(
      "A safety flag. If true, allows `overwrite` mode to proceed if the note already exists.",
    ),
  returnContent: z
    .boolean()
    .default(false)
    .describe(
      "If true, the final content of the note is included in the response.",
    ),
});

export const ObsidianUpdateNoteInputSchema =
  BaseObsidianUpdateNoteInputSchema.refine(
    (data) =>
      !(
        (data.targetType === "filePath" ||
          data.targetType === "periodicNote") &&
        !data.targetIdentifier
      ),
    {
      message: "targetIdentifier is required for 'filePath' or 'periodicNote'.",
      path: ["targetIdentifier"],
    },
  );

export const ObsidianUpdateNoteInputSchemaShape =
  BaseObsidianUpdateNoteInputSchema.shape;

const FormattedStatSchema = z.object({
  createdTime: z.string(),
  modifiedTime: z.string(),
  tokenCountEstimate: z.number().int(),
});

export const ObsidianUpdateNoteResponseSchema = z.object({
  success: z.boolean().describe("True if the operation was successful."),
  message: z.string().describe("A summary of the operation's result."),
  stats: FormattedStatSchema.optional().describe(
    "Optional file statistics, including timestamps and token count.",
  ),
  finalContent: z
    .string()
    .optional()
    .describe("The full content of the note after the update."),
});

// ====================================================================================
// Type Definitions
// ====================================================================================

export type ObsidianUpdateNoteInput = z.infer<
  typeof ObsidianUpdateNoteInputSchema
>;
export type ObsidianUpdateNoteResponse = z.infer<
  typeof ObsidianUpdateNoteResponseSchema
>;

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const obsidianUpdateNoteLogic = async (
  params: ObsidianUpdateNoteInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianUpdateNoteResponse> => {
  logger.debug("Executing obsidian_update_note logic.", context);

  const {
    targetType,
    targetIdentifier,
    content,
    wholeFileMode,
    createIfNeeded,
    overwriteIfExists,
  } = params;

  let effectiveFilePath: string | undefined;
  let existingContent = "";
  let fileExists = false;

  // Determine file path and check existence
  try {
    if (targetType === "filePath") {
      if (!targetIdentifier)
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "filePath is required.",
          context,
        );
      effectiveFilePath = targetIdentifier;
      existingContent = (await obsidianService.getFileContent(
        effectiveFilePath,
        "markdown",
        context,
      )) as string;
      fileExists = true;
    } else if (targetType === "activeFile") {
      const activeFile = await obsidianService.getActiveFile("json", context);
      if (typeof activeFile === "string")
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          "Could not retrieve active file details.",
          context,
        );
      effectiveFilePath = activeFile.path;
      existingContent = activeFile.content ?? "";
      fileExists = true;
    } else if (targetType === "periodicNote") {
      if (!targetIdentifier)
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "period is required for periodicNote.",
          context,
        );
      const note = await obsidianService.getPeriodicNote(
        targetIdentifier as any,
        "json",
        context,
      );
      if (typeof note === "string")
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          "Could not retrieve periodic note details.",
          context,
        );
      effectiveFilePath = note.path;
      existingContent = note.content ?? "";
      fileExists = true;
    }
  } catch (error) {
    if (
      !(error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND)
    ) {
      throw error;
    }
  }

  if (fileExists && wholeFileMode === "overwrite" && !overwriteIfExists) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      `Note at '${effectiveFilePath}' exists and 'overwriteIfExists' is false.`,
      context,
    );
  }

  if (!fileExists && !createIfNeeded) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `Note not found at '${effectiveFilePath}' and 'createIfNeeded' is false.`,
      context,
    );
  }

  let newContent = content;
  if (wholeFileMode === "append") {
    newContent = existingContent + content;
  } else if (wholeFileMode === "prepend") {
    newContent = content + existingContent;
  }

  // Determine the final file path for saving
  if (!effectiveFilePath) {
    if (targetType === "filePath" && targetIdentifier) {
      effectiveFilePath = targetIdentifier;
    } else {
      throw new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        "Could not determine a file path to save the note.",
        context,
      );
    }
  }

  await obsidianService.updateFileContent(
    effectiveFilePath,
    newContent,
    context,
  );
  if (vaultCacheService?.isReady()) {
    await vaultCacheService.updateCacheForFile(effectiveFilePath, context);
  }

  const finalNote = (await obsidianService.getFileContent(
    effectiveFilePath,
    "json",
    context,
  )) as NoteJson;

  const stats = finalNote.stat
    ? await createFormattedStatWithTokenCount(
        finalNote.stat,
        finalNote.content ?? "",
        context,
      )
    : undefined;

  return {
    success: true,
    message: `Successfully updated note via ${wholeFileMode} operation.`,
    stats: stats ?? undefined,
    finalContent: params.returnContent ? newContent : undefined,
  };
};

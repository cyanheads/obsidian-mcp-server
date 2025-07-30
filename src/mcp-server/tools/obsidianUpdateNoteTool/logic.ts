/**
 * @fileoverview Defines the core logic, schemas, and types for the `obsidian_update_note` tool.
 * This tool handles whole-file operations like append, prepend, and overwrite in Obsidian notes.
 * @module src/mcp-server/tools/obsidianUpdateNoteTool/logic
 */

import { z } from "zod";
import {
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
      "The type of target to modify: a specific file path, the currently active file, or a periodic note (e.g., daily).",
    ),
  content: z.string().describe("The content to add or use for overwriting."),
  targetIdentifier: z
    .string()
    .optional()
    .describe(
      "Identifier for the target. Required for 'filePath' (e.g., 'Notes/My Note.md') and 'periodicNote' (e.g., 'daily', 'weekly').",
    ),
  modificationType: z
    .literal("wholeFile")
    .describe("The type of modification, fixed to 'wholeFile' for this tool."),
  wholeFileMode: z
    .enum(["append", "prepend", "overwrite"])
    .describe(
      "The mode of operation: 'append' to add to the end, 'prepend' to add to the beginning, or 'overwrite' to replace the entire content.",
    ),
  createIfNeeded: z
    .boolean()
    .default(true)
    .describe(
      "If true, a new file will be created if the target does not exist. Defaults to true.",
    ),
  overwriteIfExists: z
    .boolean()
    .default(false)
    .describe(
      "If true, allows 'overwrite' mode to proceed even if the file already exists. A safeguard to prevent accidental data loss. Defaults to false.",
    ),
  returnContent: z
    .boolean()
    .default(false)
    .describe(
      "If true, the final content of the note will be returned in the response. Defaults to false.",
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
  success: z.boolean(),
  message: z.string(),
  stats: FormattedStatSchema.optional(),
  finalContent: z.string().optional(),
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

  let existingContent = "";
  let fileExists = false;

  try {
    if (targetType === "filePath" && targetIdentifier) {
      existingContent = (await obsidianService.getFileContent(
        targetIdentifier,
        "markdown",
        context,
      )) as string;
      fileExists = true;
    } else if (targetType === "activeFile") {
      existingContent = (await obsidianService.getActiveFile(
        "markdown",
        context,
      )) as string;
      fileExists = true;
    } else if (targetType === "periodicNote" && targetIdentifier) {
      existingContent = (await obsidianService.getPeriodicNote(
        targetIdentifier as any,
        "markdown",
        context,
      )) as string;
      fileExists = true;
    }
  } catch (error) {
    if (error instanceof McpError && error.code !== BaseErrorCode.NOT_FOUND) {
      throw error;
    }
  }

  if (fileExists && wholeFileMode === "overwrite" && !overwriteIfExists) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      "File exists and overwriteIfExists is false.",
      context,
    );
  }

  if (!fileExists && !createIfNeeded) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      "File does not exist and createIfNeeded is false.",
      context,
    );
  }

  let newContent = content;
  if (wholeFileMode === "append") {
    newContent = existingContent + content;
  } else if (wholeFileMode === "prepend") {
    newContent = content + existingContent;
  }

  if (targetType === "filePath" && targetIdentifier) {
    await obsidianService.updateFileContent(
      targetIdentifier,
      newContent,
      context,
    );
    if (vaultCacheService) {
      await vaultCacheService.updateCacheForFile(targetIdentifier, context);
    }
  } else if (targetType === "activeFile") {
    await obsidianService.updateActiveFile(newContent, context);
  } else if (targetType === "periodicNote" && targetIdentifier) {
    await obsidianService.updatePeriodicNote(
      targetIdentifier as any,
      newContent,
      context,
    );
  }

  const finalNote =
    targetType === "filePath" && targetIdentifier
      ? ((await obsidianService.getFileContent(
          targetIdentifier,
          "json",
          context,
        )) as any)
      : null;
  const stats = finalNote
    ? await createFormattedStatWithTokenCount(
        finalNote.stat,
        finalNote.content,
        context,
      )
    : undefined;

  return {
    success: true,
    message: `Successfully updated note.`,
    stats: stats ?? undefined,
    finalContent: params.returnContent ? newContent : undefined,
  };
};

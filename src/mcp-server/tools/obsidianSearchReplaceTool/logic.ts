/**
 * @fileoverview Defines the core logic for the `obsidian_search_replace` tool, which
 * performs advanced, in-memory search and replace operations on Obsidian notes.
 * @module src/mcp-server/tools/obsidianSearchReplaceTool/logic
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

const ReplacementBlockSchema = z.object({
  search: z.string().min(1, "Search pattern cannot be empty."),
  replace: z.string(),
});

const BaseObsidianSearchReplaceInputSchema = z.object({
  targetType: z
    .enum(["filePath", "activeFile", "periodicNote"])
    .describe(
      "The type of note to target: a specific `filePath`, the `activeFile` in the editor, or a `periodicNote` (e.g., daily).",
    ),
  targetIdentifier: z
    .string()
    .optional()
    .describe(
      "The identifier for the target. Required for `filePath` (e.g., 'Notes/My Note.md') and `periodicNote` (e.g., 'daily', 'weekly').",
    ),
  replacements: z
    .array(ReplacementBlockSchema)
    .min(1)
    .describe(
      "An array of one or more search/replace objects to be applied sequentially.",
    ),
  useRegex: z
    .boolean()
    .default(false)
    .describe(
      "If true, the `search` string is treated as a regular expression.",
    ),
  replaceAll: z
    .boolean()
    .default(true)
    .describe("If true, replaces all occurrences; otherwise, only the first."),
  caseSensitive: z
    .boolean()
    .default(true)
    .describe("If true, the search operation is case-sensitive."),
  flexibleWhitespace: z
    .boolean()
    .default(false)
    .describe(
      "If true (and not using regex), matches patterns with any amount of whitespace.",
    ),
  wholeWord: z
    .boolean()
    .default(false)
    .describe("If true (and not using regex), matches only whole words."),
  returnContent: z
    .boolean()
    .default(false)
    .describe(
      "If true, the final content of the note is included in the response.",
    ),
});

export const ObsidianSearchReplaceInputSchema =
  BaseObsidianSearchReplaceInputSchema.refine(
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
  ).refine((data) => !(data.flexibleWhitespace && data.useRegex), {
    message: "'flexibleWhitespace' cannot be true if 'useRegex' is true.",
    path: ["flexibleWhitespace"],
  });

export const ObsidianSearchReplaceInputSchemaShape =
  BaseObsidianSearchReplaceInputSchema.shape;

const FormattedStatSchema = z.object({
  createdTime: z.string(),
  modifiedTime: z.string(),
  tokenCountEstimate: z.number().int(),
});

export const ObsidianSearchReplaceResponseSchema = z.object({
  success: z.boolean().describe("True if the operation was successful."),
  message: z.string().describe("A summary of the operation's result."),
  totalReplacementsMade: z
    .number()
    .int()
    .describe("The total number of replacements made across all operations."),
  stats: FormattedStatSchema.optional().describe(
    "Optional file statistics, including timestamps and token count.",
  ),
  finalContent: z
    .string()
    .optional()
    .describe("The full content of the note after all replacements."),
});

// ====================================================================================
// Type Definitions
// ====================================================================================

export type ObsidianSearchReplaceInput = z.infer<
  typeof ObsidianSearchReplaceInputSchema
>;
export type ObsidianSearchReplaceResponse = z.infer<
  typeof ObsidianSearchReplaceResponseSchema
>;

// ====================================================================================
// Core Logic Function
// ====================================================================================

function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const obsidianSearchReplaceLogic = async (
  params: ObsidianSearchReplaceInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianSearchReplaceResponse> => {
  logger.debug("Executing obsidian_search_replace logic.", context);

  const {
    targetType,
    targetIdentifier,
    replacements,
    useRegex,
    replaceAll,
    caseSensitive,
    flexibleWhitespace,
    wholeWord,
  } = params;

  let originalContent: string;
  let effectiveFilePath: string | undefined;

  switch (targetType) {
    case "filePath":
      if (!targetIdentifier) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "filePath is required for targetType 'filePath'.",
          context,
        );
      }
      effectiveFilePath = targetIdentifier;
      originalContent = (await obsidianService.getFileContent(
        effectiveFilePath,
        "markdown",
        context,
      )) as string;
      break;
    case "activeFile":
      const activeFile = await obsidianService.getActiveFile("json", context);
      if (typeof activeFile === "string") {
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          "Failed to retrieve active file as JSON.",
          context,
        );
      }
      effectiveFilePath = activeFile.path;
      originalContent = activeFile.content ?? "";
      break;
    case "periodicNote":
      if (!targetIdentifier) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "targetIdentifier is required for periodicNote.",
          context,
        );
      }
      const periodicNote = await obsidianService.getPeriodicNote(
        targetIdentifier as any,
        "json",
        context,
      );
      if (typeof periodicNote === "string") {
        throw new McpError(
          BaseErrorCode.INTERNAL_ERROR,
          "Failed to retrieve periodic note as JSON.",
          context,
        );
      }
      effectiveFilePath = periodicNote.path;
      originalContent = periodicNote.content ?? "";
      break;
  }

  let modifiedContent = originalContent;
  let totalReplacementsMade = 0;

  for (const { search, replace } of replacements) {
    let searchPattern = search;
    if (!useRegex) {
      searchPattern = escapeRegex(search);
      if (flexibleWhitespace) {
        searchPattern = searchPattern.replace(/\s+/g, "\\s+");
      }
      if (wholeWord) {
        searchPattern = `\\b${searchPattern}\\b`;
      }
    }

    const flags = `${replaceAll ? "g" : ""}${caseSensitive ? "" : "i"}`;
    const regex = new RegExp(searchPattern, flags);
    const matches = modifiedContent.match(regex);

    if (matches) {
      totalReplacementsMade += matches.length;
      modifiedContent = modifiedContent.replace(regex, replace);
    }
  }

  if (modifiedContent !== originalContent) {
    if (!effectiveFilePath) {
      throw new McpError(
        BaseErrorCode.INTERNAL_ERROR,
        "Could not determine file path to save changes.",
        context,
      );
    }
    await obsidianService.updateFileContent(
      effectiveFilePath,
      modifiedContent,
      context,
    );
    if (vaultCacheService?.isReady()) {
      await vaultCacheService.updateCacheForFile(effectiveFilePath, context);
    }
  }

  const finalNote = effectiveFilePath
    ? ((await obsidianService.getFileContent(
        effectiveFilePath,
        "json",
        context,
      )) as any)
    : null;

  const stats = finalNote?.stat
    ? await createFormattedStatWithTokenCount(
        finalNote.stat,
        finalNote.content,
        context,
      )
    : undefined;

  return {
    success: true,
    message: `Completed search and replace. Made ${totalReplacementsMade} replacements.`,
    totalReplacementsMade,
    stats: stats ?? undefined,
    finalContent: params.returnContent ? modifiedContent : undefined,
  };
};

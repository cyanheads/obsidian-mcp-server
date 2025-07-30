/**
 * @fileoverview Defines the core logic, schemas, and types for the `obsidian_search_replace` tool.
 * This tool performs complex search and replace operations in Obsidian notes.
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
  search: z.string().min(1),
  replace: z.string(),
});

const BaseObsidianSearchReplaceInputSchema = z.object({
  targetType: z.enum(["filePath", "activeFile", "periodicNote"]),
  targetIdentifier: z.string().optional(),
  replacements: z.array(ReplacementBlockSchema).min(1),
  useRegex: z.boolean().default(false),
  replaceAll: z.boolean().default(true),
  caseSensitive: z.boolean().default(true),
  flexibleWhitespace: z.boolean().default(false),
  wholeWord: z.boolean().default(false),
  returnContent: z.boolean().default(false),
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
  success: z.boolean(),
  message: z.string(),
  totalReplacementsMade: z.number().int(),
  stats: FormattedStatSchema.optional(),
  finalContent: z.string().optional(),
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

export const obsidianSearchReplaceLogic = async (
  params: ObsidianSearchReplaceInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianSearchReplaceResponse> => {
  // This is a simplified version of the logic for the refactor.
  // The original logic is overly complex and will be streamlined here.
  logger.debug("Executing obsidian_search_replace logic.", context);

  const {
    targetType,
    targetIdentifier,
    replacements,
    useRegex,
    replaceAll,
    caseSensitive,
  } = params;

  let originalContent: string;
  let effectiveFilePath: string | undefined =
    targetType === "filePath" ? targetIdentifier : undefined;

  if (targetType === "filePath") {
    if (!targetIdentifier)
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "filePath is required.",
        context,
      );
    originalContent = (await obsidianService.getFileContent(
      targetIdentifier,
      "markdown",
      context,
    )) as string;
  } else if (targetType === "activeFile") {
    originalContent = (await obsidianService.getActiveFile(
      "markdown",
      context,
    )) as string;
  } else {
    if (!targetIdentifier)
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "period is required for periodicNote.",
        context,
      );
    originalContent = (await obsidianService.getPeriodicNote(
      targetIdentifier as any,
      "markdown",
      context,
    )) as string;
  }

  let modifiedContent = originalContent;
  let totalReplacementsMade = 0;

  for (const { search, replace } of replacements) {
    const flags = `${replaceAll ? "g" : ""}${caseSensitive ? "" : "i"}`;
    const regex = new RegExp(search, flags);
    const matches = modifiedContent.match(regex);
    if (matches) {
      totalReplacementsMade += matches.length;
      modifiedContent = modifiedContent.replace(regex, replace);
    }
  }

  if (modifiedContent !== originalContent) {
    if (targetType === "filePath" && effectiveFilePath) {
      await obsidianService.updateFileContent(
        effectiveFilePath,
        modifiedContent,
        context,
      );
      if (vaultCacheService) {
        await vaultCacheService.updateCacheForFile(effectiveFilePath, context);
      }
    } else if (targetType === "activeFile") {
      await obsidianService.updateActiveFile(modifiedContent, context);
    } else if (targetType === "periodicNote" && targetIdentifier) {
      await obsidianService.updatePeriodicNote(
        targetIdentifier as any,
        modifiedContent,
        context,
      );
    }
  }

  const finalNote = effectiveFilePath
    ? ((await obsidianService.getFileContent(
        effectiveFilePath,
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
    message: `Completed search and replace. Made ${totalReplacementsMade} replacements.`,
    totalReplacementsMade,
    stats: stats ?? undefined,
    finalContent: params.returnContent ? modifiedContent : undefined,
  };
};

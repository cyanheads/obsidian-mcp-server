/**
 * @fileoverview Defines the core logic, schemas, and types for the `obsidian_manage_tags` tool.
 * This tool handles adding, removing, and listing tags in both frontmatter and inline content.
 * @module src/mcp-server/tools/obsidianManageTagsTool/logic
 */

import { dump } from "js-yaml";
import { z } from "zod";
import {
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";
import { sanitization } from "../../../utils/security/sanitization.js";

// ====================================================================================
// Zod Schema Definitions
// ====================================================================================

export const ObsidianManageTagsInputSchema = z.object({
  filePath: z
    .string()
    .min(1, "filePath cannot be empty.")
    .describe(
      "The vault-relative path to the target note (e.g., 'Journal/2024-06-12.md').",
    ),
  operation: z
    .enum(["add", "remove", "list"])
    .describe(
      "The operation to perform: `add` new tags, `remove` existing tags, or `list` all current tags.",
    ),
  tags: z
    .array(z.string())
    .describe(
      "An array of tag names to process. Omit the '#' prefix (e.g., use 'project/active', not '#project/active').",
    ),
});

export const ObsidianManageTagsResponseSchema = z.object({
  success: z.boolean().describe("True if the operation was successful."),
  message: z.string().describe("A summary of the operation's result."),
  currentTags: z
    .array(z.string())
    .describe(
      "The final, complete list of tags on the note after the operation.",
    ),
  timestamp: z
    .string()
    .datetime()
    .describe("The ISO 8601 timestamp of when the operation completed."),
});

// ====================================================================================
// Type Definitions
// ====================================================================================

export type ObsidianManageTagsInput = z.infer<
  typeof ObsidianManageTagsInputSchema
>;
export type ObsidianManageTagsResponse = z.infer<
  typeof ObsidianManageTagsResponseSchema
>;

// ====================================================================================
// Logic Handler Functions
// ====================================================================================

async function addTags(
  params: ObsidianManageTagsInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianManageTagsResponse> {
  const { filePath, tags: inputTags } = params;
  const sanitizedTags = inputTags.map((t) => sanitization.sanitizeTagName(t));

  const note = await obsidianService.getFileContent(filePath, "json", context);
  if (typeof note === "string") {
    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      "Failed to parse note content as JSON.",
      context,
    );
  }

  const currentTags = new Set(note.tags);
  const tagsToAdd = sanitizedTags.filter((t) => !currentTags.has(t));

  if (tagsToAdd.length === 0) {
    return {
      success: true,
      message: "No new tags to add; all provided tags already exist.",
      currentTags: Array.from(currentTags),
      timestamp: new Date().toISOString(),
    };
  }

  const frontmatter = note.frontmatter ?? {};
  const frontmatterTags = new Set(
    Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
  );
  tagsToAdd.forEach((tag) => frontmatterTags.add(tag));
  frontmatter.tags = Array.from(frontmatterTags);

  const noteContent = (await obsidianService.getFileContent(
    filePath,
    "markdown",
    context,
  )) as string;
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const newFrontmatterString = dump(frontmatter);
  const newContent = noteContent.match(frontmatterRegex)
    ? noteContent.replace(frontmatterRegex, `---\n${newFrontmatterString}---\n`)
    : `---\n${newFrontmatterString}---\n\n${noteContent}`;

  await obsidianService.updateFileContent(filePath, newContent, context);
  if (vaultCacheService) {
    await vaultCacheService.updateCacheForFile(filePath, context);
  }

  return {
    success: true,
    message: `Successfully added tags: ${tagsToAdd.join(", ")}.`,
    currentTags: Array.from(new Set([...currentTags, ...tagsToAdd])),
    timestamp: new Date().toISOString(),
  };
}

async function removeTags(
  params: ObsidianManageTagsInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianManageTagsResponse> {
  const { filePath, tags: tagsToRemove } = params;
  const sanitizedTagsToRemove = new Set(
    tagsToRemove.map((t) => sanitization.sanitizeTagName(t)),
  );

  const note = await obsidianService.getFileContent(filePath, "json", context);
  if (typeof note === "string") {
    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      "Failed to parse note content as JSON.",
      context,
    );
  }

  const originalTags = new Set(note.tags);
  const tagsActuallyRemoved = Array.from(sanitizedTagsToRemove).filter((t) =>
    originalTags.has(t),
  );

  if (tagsActuallyRemoved.length === 0) {
    return {
      success: true,
      message:
        "No tags removed; the specified tags were not found in the note.",
      currentTags: Array.from(originalTags),
      timestamp: new Date().toISOString(),
    };
  }

  // Remove from frontmatter
  const frontmatter = note.frontmatter ?? {};
  if (Array.isArray(frontmatter.tags)) {
    frontmatter.tags = frontmatter.tags.filter(
      (t: string) => !sanitizedTagsToRemove.has(t),
    );
    if (frontmatter.tags.length === 0) {
      delete frontmatter.tags;
    }
  }

  // Remove from inline content
  let noteContent = (await obsidianService.getFileContent(
    filePath,
    "markdown",
    context,
  )) as string;

  const inlineTagRegex = /(?<=^|\s)#([^\s#]+)/g;
  noteContent = noteContent.replace(inlineTagRegex, (match, tagName) => {
    return sanitizedTagsToRemove.has(tagName) ? "" : match;
  });

  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const newFrontmatterString =
    Object.keys(frontmatter).length > 0 ? dump(frontmatter) : "";

  const newContent = noteContent.match(frontmatterRegex)
    ? noteContent.replace(frontmatterRegex, `---\n${newFrontmatterString}---\n`)
    : `---\n${newFrontmatterString}---\n\n${noteContent}`;

  await obsidianService.updateFileContent(filePath, newContent.trim(), context);

  if (vaultCacheService) {
    await vaultCacheService.updateCacheForFile(filePath, context);
  }

  const finalTags = Array.from(originalTags).filter(
    (t) => !sanitizedTagsToRemove.has(t),
  );

  return {
    success: true,
    message: `Successfully removed tags: ${tagsActuallyRemoved.join(", ")}.`,
    currentTags: finalTags,
    timestamp: new Date().toISOString(),
  };
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const obsidianManageTagsLogic = async (
  params: ObsidianManageTagsInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianManageTagsResponse> => {
  logger.debug(
    `Executing obsidian_manage_tags logic for op: ${params.operation}`,
    context,
  );

  const note = await obsidianService.getFileContent(
    params.filePath,
    "json",
    context,
  );
  if (typeof note === "string") {
    throw new McpError(
      BaseErrorCode.INTERNAL_ERROR,
      "Failed to parse note content as JSON.",
      context,
    );
  }

  switch (params.operation) {
    case "list":
      return {
        success: true,
        message: "Successfully listed all tags.",
        currentTags: note.tags,
        timestamp: new Date().toISOString(),
      };
    case "add":
      return addTags(params, context, obsidianService, vaultCacheService);
    case "remove":
      return removeTags(params, context, obsidianService, vaultCacheService);
    default:
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Invalid operation: ${params.operation}`,
        context,
      );
  }
};

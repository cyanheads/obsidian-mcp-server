/**
 * @fileoverview Defines the core logic, schemas, and types for the `obsidian_manage_frontmatter` tool.
 * This tool provides atomic operations to get, set, and delete keys in a note's YAML frontmatter.
 * @module src/mcp-server/tools/obsidianManageFrontmatterTool/logic
 */

import { dump } from "js-yaml";
import { z } from "zod";
import {
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// ====================================================================================
// Zod Schema Definitions
// ====================================================================================

const BaseObsidianManageFrontmatterInputSchema = z.object({
  filePath: z
    .string()
    .min(1, "filePath cannot be empty.")
    .describe(
      "The vault-relative path to the target note (e.g., 'Projects/Active/My Note.md').",
    ),
  operation: z
    .enum(["get", "set", "delete"])
    .describe(
      "The operation to perform on the frontmatter: 'get' to read a key, 'set' to create or update a key, or 'delete' to remove a key.",
    ),
  key: z
    .string()
    .min(1, "key cannot be empty.")
    .describe(
      "The name of the frontmatter key to target, such as 'status', 'tags', or 'aliases'.",
    ),
  value: z
    .any()
    .optional()
    .describe(
      'The value to assign when using the "set" operation. Can be a string, number, boolean, array, or a JSON object.',
    ),
});

export const ObsidianManageFrontmatterInputSchema =
  BaseObsidianManageFrontmatterInputSchema.refine(
    (data) => !(data.operation === "set" && data.value === undefined),
    {
      message: "A 'value' is required when the 'operation' is 'set'.",
      path: ["value"],
    },
  );

export const ObsidianManageFrontmatterInputSchemaShape =
  BaseObsidianManageFrontmatterInputSchema.shape;

export const ObsidianManageFrontmatterResponseSchema = z.object({
  success: z.boolean().describe("Indicates if the operation was successful."),
  message: z.string().describe("A summary of the operation outcome."),
  value: z.any().optional().describe("The value that was retrieved or set."),
  timestamp: z
    .string()
    .datetime()
    .describe("ISO 8601 timestamp of when the operation was completed."),
});

// ====================================================================================
// Type Definitions
// ====================================================================================

export type ObsidianManageFrontmatterInput = z.infer<
  typeof ObsidianManageFrontmatterInputSchema
>;
export type ObsidianManageFrontmatterResponse = z.infer<
  typeof ObsidianManageFrontmatterResponseSchema
>;

// ====================================================================================
// Logic Handler Functions
// ====================================================================================

async function getFrontmatterValue(
  params: ObsidianManageFrontmatterInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<ObsidianManageFrontmatterResponse> {
  const note = await obsidianService.getFileContent(
    params.filePath,
    "json",
    context,
  );
  if (typeof note === "string" || !note.frontmatter) {
    return {
      success: true,
      message: `Key '${params.key}' not found (no frontmatter).`,
      timestamp: new Date().toISOString(),
    };
  }
  const value = note.frontmatter[params.key];
  return {
    success: true,
    message: `Successfully retrieved key '${params.key}'.`,
    value,
    timestamp: new Date().toISOString(),
  };
}

async function setFrontmatterValue(
  params: ObsidianManageFrontmatterInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianManageFrontmatterResponse> {
  await obsidianService.patchFile(
    params.filePath,
    typeof params.value === "object"
      ? JSON.stringify(params.value)
      : String(params.value),
    {
      operation: "replace",
      targetType: "frontmatter",
      target: params.key,
      createTargetIfMissing: true,
      contentType:
        typeof params.value === "object" ? "application/json" : "text/markdown",
    },
    context,
  );

  if (vaultCacheService) {
    await vaultCacheService.updateCacheForFile(params.filePath, context);
  }

  return {
    success: true,
    message: `Successfully set key '${params.key}'.`,
    value: { [params.key]: params.value },
    timestamp: new Date().toISOString(),
  };
}

async function deleteFrontmatterValue(
  params: ObsidianManageFrontmatterInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianManageFrontmatterResponse> {
  const noteJson = await obsidianService.getFileContent(
    params.filePath,
    "json",
    context,
  );

  if (typeof noteJson === "string" || !noteJson.frontmatter) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `Key '${params.key}' not found in frontmatter.`,
      context,
    );
  }

  const { frontmatter } = noteJson;
  if (!(params.key in frontmatter)) {
    return {
      success: true,
      message: `Key '${params.key}' not found, no action taken.`,
      timestamp: new Date().toISOString(),
    };
  }

  delete frontmatter[params.key];

  const noteContent = (await obsidianService.getFileContent(
    params.filePath,
    "markdown",
    context,
  )) as string;
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const newFrontmatterString =
    Object.keys(frontmatter).length > 0 ? dump(frontmatter) : "";
  const newContent = noteContent.replace(
    frontmatterRegex,
    newFrontmatterString ? `---\n${newFrontmatterString}---\n` : "",
  );

  await obsidianService.updateFileContent(params.filePath, newContent, context);

  if (vaultCacheService) {
    await vaultCacheService.updateCacheForFile(params.filePath, context);
  }

  return {
    success: true,
    message: `Successfully deleted key '${params.key}'.`,
    timestamp: new Date().toISOString(),
  };
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const obsidianManageFrontmatterLogic = async (
  params: ObsidianManageFrontmatterInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianManageFrontmatterResponse> => {
  logger.debug(
    `Executing obsidian_manage_frontmatter logic for op: ${params.operation}`,
    context,
  );

  switch (params.operation) {
    case "get":
      return getFrontmatterValue(params, context, obsidianService);
    case "set":
      return setFrontmatterValue(
        params,
        context,
        obsidianService,
        vaultCacheService,
      );
    case "delete":
      return deleteFrontmatterValue(
        params,
        context,
        obsidianService,
        vaultCacheService,
      );
    default:
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        `Invalid operation: ${params.operation}`,
        context,
      );
  }
};

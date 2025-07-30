/**
 * @fileoverview Defines the core logic, schemas, and types for the `obsidian_delete_note` tool.
 * This tool handles the permanent deletion of a file within an Obsidian vault, including a
 * case-insensitive fallback mechanism.
 * @module src/mcp-server/tools/obsidianDeleteNoteTool/logic
 */

import path from "node:path";
import { z } from "zod";
import {
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

/**
 * Zod schema for validating the input arguments for the `obsidian_delete_note` tool.
 */
export const ObsidianDeleteNoteInputSchema = z
  .object({
    filePath: z
      .string()
      .min(1, "filePath cannot be empty.")
      .describe(
        'The vault-relative path to the file to be deleted (e.g., "archive/old-file.md"). Tries case-sensitive first, then case-insensitive fallback.',
      ),
  })
  .describe(
    "Permanently deletes a specified file from the Obsidian vault. Tries the exact path first, then attempts a case-insensitive fallback.",
  );

/**
 * TypeScript type inferred from `ObsidianDeleteNoteInputSchema`.
 */
export type ObsidianDeleteNoteInput = z.infer<
  typeof ObsidianDeleteNoteInputSchema
>;

/**
 * Zod schema for the successful response of the `obsidian_delete_note` tool.
 */
export const ObsidianDeleteNoteResponseSchema = z.object({
  success: z
    .boolean()
    .describe("Indicates whether the deletion was successful."),
  message: z.string().describe("A confirmation message detailing the outcome."),
  deletedPath: z
    .string()
    .describe("The exact vault-relative path of the file that was deleted."),
  timestamp: z
    .string()
    .datetime()
    .describe("ISO 8601 timestamp of when the operation was completed."),
});

/**
 * TypeScript type inferred from `ObsidianDeleteNoteResponseSchema`.
 */
export type ObsidianDeleteNoteResponse = z.infer<
  typeof ObsidianDeleteNoteResponseSchema
>;

/**
 * Finds a unique, case-insensitive file match in a directory.
 * @param obsidianService - The Obsidian REST API service instance.
 * @param originalFilePath - The user-provided file path.
 * @param context - The request context.
 * @returns The corrected, case-sensitive file path if a unique match is found.
 * @throws {McpError} If no match is found or the match is ambiguous.
 */
async function findCaseInsensitiveMatch(
  obsidianService: ObsidianRestApiService,
  originalFilePath: string,
  context: RequestContext,
): Promise<string> {
  const dirname = path.posix.dirname(originalFilePath);
  const filenameLower = path.posix.basename(originalFilePath).toLowerCase();
  const dirToList = dirname === "." ? "/" : dirname;

  logger.debug(
    `Listing directory for fallback deletion: ${dirToList}`,
    context,
  );
  const filesInDir = await obsidianService.listFiles(dirToList, context);

  const matches = filesInDir.filter(
    (f: string) =>
      !f.endsWith("/") &&
      path.posix.basename(f).toLowerCase() === filenameLower,
  );

  if (matches.length === 1) {
    const correctFilename = path.posix.basename(matches[0]);
    return path.posix.join(dirname, correctFilename);
  }

  if (matches.length > 1) {
    throw new McpError(
      BaseErrorCode.CONFLICT,
      `Deletion failed: Ambiguous case-insensitive matches for '${originalFilePath}'. Found: [${matches.join(", ")}].`,
      context,
    );
  }

  throw new McpError(
    BaseErrorCode.NOT_FOUND,
    `Deletion failed: File not found for '${originalFilePath}' (case-insensitive fallback also failed).`,
    context,
  );
}

/**
 * Processes the core logic for deleting a file from the Obsidian vault.
 * It attempts a case-sensitive deletion first. If that fails with a 'NOT_FOUND' error,
 * it performs a case-insensitive fallback search to find and delete the file.
 *
 * @param params - The validated input parameters for the tool.
 * @param context - The request context for logging and tracing.
 * @param obsidianService - An instance of the Obsidian REST API service.
 * @param vaultCacheService - An instance of the vault cache service.
 * @returns A promise that resolves to the structured success response.
 * @throws {McpError} If the file cannot be found, the match is ambiguous, or the API call fails.
 */
export async function obsidianDeleteNoteLogic(
  params: ObsidianDeleteNoteInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianDeleteNoteResponse> {
  const { filePath } = params;
  let effectiveFilePath = filePath;

  logger.debug(
    `Executing obsidian_delete_note logic for: ${filePath}`,
    context,
  );

  try {
    // Attempt 1: Case-sensitive deletion
    logger.debug(`Attempting to delete (case-sensitive): ${filePath}`, context);
    await obsidianService.deleteFile(filePath, context);
    logger.info(`Successfully deleted file: ${filePath}`, context);
  } catch (error) {
    // Attempt 2: Case-insensitive fallback on NOT_FOUND error
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      logger.info(
        `File not found at '${filePath}'. Attempting case-insensitive fallback.`,
        context,
      );
      effectiveFilePath = await findCaseInsensitiveMatch(
        obsidianService,
        filePath,
        context,
      );
      logger.debug(
        `Found case-insensitive match: ${effectiveFilePath}. Retrying delete.`,
        context,
      );
      await obsidianService.deleteFile(effectiveFilePath, context);
      logger.info(
        `Successfully deleted file via fallback: ${effectiveFilePath}`,
        context,
      );
    } else {
      // Re-throw any other errors
      throw error;
    }
  }

  // Update cache if available
  if (vaultCacheService) {
    await vaultCacheService.updateCacheForFile(effectiveFilePath, context);
  }

  return {
    success: true,
    message: `File '${effectiveFilePath}' was successfully deleted.`,
    deletedPath: effectiveFilePath,
    timestamp: new Date().toISOString(),
  };
}

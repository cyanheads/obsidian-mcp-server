/**
 * @fileoverview Defines the core logic for the `obsidian_delete_note` tool. This tool handles
 * the permanent and case-sensitive deletion of a note within an Obsidian vault, requiring
 * explicit user acknowledgement.
 * @module src/mcp-server/tools/obsidianDeleteNoteTool/logic
 */

import { z } from "zod";
import {
  ObsidianRestApiService,
  VaultCacheService,
} from "../../../services/obsidianRestAPI/index.js";
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
        'The exact, case-sensitive vault-relative path to the note for deletion (e.g., "archive/Project-Alpha.md").',
      ),
    acknowledgement: z
      .literal("yes", {
        errorMap: () => ({
          message:
            "Acknowledgement must be exactly 'yes' to confirm deletion. Only use this value if you have permission to delete this note.",
        }),
      })
      .describe(
        "Mandatory confirmation for this destructive operation. Must be 'yes'.",
      ),
  })
  .describe(
    "Permanently deletes a specified note from the Obsidian vault. Requires explicit acknowledgement.",
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
  success: z.boolean().describe("True if the note was successfully deleted."),
  message: z.string().describe("A confirmation message describing the result."),
  deletedPath: z
    .string()
    .describe("The exact vault-relative path of the deleted note."),
  timestamp: z
    .string()
    .datetime()
    .describe("The ISO 8601 timestamp of when the deletion occurred."),
});

/**
 * TypeScript type inferred from `ObsidianDeleteNoteResponseSchema`.
 */
export type ObsidianDeleteNoteResponse = z.infer<
  typeof ObsidianDeleteNoteResponseSchema
>;

/**
 * Processes the core logic for deleting a note from the Obsidian vault.
 * The operation is strictly case-sensitive and does not perform any fallbacks.
 *
 * @param params - The validated input parameters for the tool.
 * @param context - The request context for logging and tracing.
 * @param obsidianService - An instance of the Obsidian REST API service.
 * @param vaultCacheService - An instance of the vault cache service.
 * @returns A promise that resolves to the structured success response.
 * @throws {McpError} If the API call fails (e.g., note not found).
 */
export async function obsidianDeleteNoteLogic(
  params: ObsidianDeleteNoteInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
  vaultCacheService?: VaultCacheService,
): Promise<ObsidianDeleteNoteResponse> {
  const { filePath } = params;

  logger.debug(
    `Executing obsidian_delete_note logic for: ${filePath}`,
    context,
  );

  // Perform a case-sensitive deletion. The handler will catch any errors.
  logger.debug(`Attempting to delete (case-sensitive): ${filePath}`, context);
  await obsidianService.deleteFile(filePath, context);
  logger.info(`Successfully deleted note: ${filePath}`, context);

  // Update cache if available and enabled
  if (vaultCacheService?.isReady()) {
    await vaultCacheService.updateCacheForFile(filePath, context);
  }

  return {
    success: true,
    message: `Note '${filePath}' was successfully deleted.`,
    deletedPath: filePath,
    timestamp: new Date().toISOString(),
  };
}

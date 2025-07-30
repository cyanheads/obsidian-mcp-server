/**
 * @module PatchMethods
 * @description
 * Methods for performing granular PATCH operations within notes via the Obsidian REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import { PatchOptions, Period, RequestFunction } from "../types.js";
import { encodeVaultPath } from "../utils/obsidianApiUtils.js";
import { handleRequest } from "../utils/requestHandler.js";

/**
 * Helper to construct headers for PATCH requests.
 */
function buildPatchHeaders(options: PatchOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Operation: options.operation,
    "Target-Type": options.targetType,
    // Spec requires URL encoding for non-ASCII characters in Target header
    Target: encodeURIComponent(options.target),
  };
  if (options.targetDelimiter) {
    headers["Target-Delimiter"] = options.targetDelimiter;
  }
  if (options.trimTargetWhitespace !== undefined) {
    headers["Trim-Target-Whitespace"] = String(options.trimTargetWhitespace);
  }
  // Add Create-Target-If-Missing header if provided in options
  if (options.createTargetIfMissing !== undefined) {
    headers["Create-Target-If-Missing"] = String(options.createTargetIfMissing);
  }
  if (options.contentType) {
    headers["Content-Type"] = options.contentType;
  } else {
    // Default to markdown if not specified, especially for non-JSON content
    headers["Content-Type"] = "text/markdown";
  }
  return headers;
}

/**
 * Patches a specific file in the vault.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param content - The content to insert/replace (string or JSON for tables/frontmatter).
 * @param options - Patch operation details (operation, targetType, target, etc.).
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (200 OK).
 */
export async function patchFile(
  _request: RequestFunction,
  filePath: string,
  content: string | object, // Allow object for JSON content type
  options: PatchOptions,
  context: RequestContext,
): Promise<void> {
  const headers = buildPatchHeaders(options);
  const requestData =
    typeof content === "object" ? JSON.stringify(content) : content;
  const encodedPath = encodeVaultPath(filePath);

  // PATCH returns 200 OK according to spec
  await handleRequest(
    _request<void>(
      {
        method: "PATCH",
        url: `/vault${encodedPath}`, // Use the encoded path
        headers: headers,
        data: requestData,
      },
      context,
      "patchFile",
    ),
  );
}

/**
 * Patches the currently active file in Obsidian.
 * @param _request - The internal request function from the service instance.
 * @param content - The content to insert/replace.
 * @param options - Patch operation details.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (200 OK).
 */
export async function patchActiveFile(
  _request: RequestFunction,
  content: string | object,
  options: PatchOptions,
  context: RequestContext,
): Promise<void> {
  const headers = buildPatchHeaders(options);
  const requestData =
    typeof content === "object" ? JSON.stringify(content) : content;

  await handleRequest(
    _request<void>(
      {
        method: "PATCH",
        url: `/active/`,
        headers: headers,
        data: requestData,
      },
      context,
      "patchActiveFile",
    ),
  );
}

/**
 * Patches a periodic note.
 * @param _request - The internal request function from the service instance.
 * @param period - The period type ('daily', 'weekly', etc.).
 * @param content - The content to insert/replace.
 * @param options - Patch operation details.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (200 OK).
 */
export async function patchPeriodicNote(
  _request: RequestFunction,
  period: Period,
  content: string | object,
  options: PatchOptions,
  context: RequestContext,
): Promise<void> {
  const headers = buildPatchHeaders(options);
  const requestData =
    typeof content === "object" ? JSON.stringify(content) : content;

  await handleRequest(
    _request<void>(
      {
        method: "PATCH",
        url: `/periodic/${period}/`,
        headers: headers,
        data: requestData,
      },
      context,
      "patchPeriodicNote",
    ),
  );
}

/**
 * @module OpenMethods
 * @description
 * Methods for opening files in Obsidian via the REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import { RequestFunction } from "../types.js";
import { handleRequest } from "../utils/requestHandler.js";

/**
 * Opens a specific file in Obsidian. Creates the file if it doesn't exist.
 * @param _request - The internal request function from the service instance.
 * @param filePath - Vault-relative path to the file.
 * @param newLeaf - Whether to open the file in a new editor tab (leaf).
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (200 OK, but no body expected).
 */
export async function openFile(
  _request: RequestFunction,
  filePath: string,
  newLeaf: boolean = false,
  context: RequestContext,
): Promise<void> {
  // This endpoint returns 200 OK, not 204
  await handleRequest(
    _request<void>(
      {
        method: "POST",
        url: `/open/${encodeURIComponent(filePath)}`,
        params: { newLeaf },
      },
      context,
      "openFile",
    ),
  );
}

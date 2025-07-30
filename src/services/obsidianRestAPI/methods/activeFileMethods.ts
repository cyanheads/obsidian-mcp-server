/**
 * @module ActiveFileMethods
 * @description
 * Methods for interacting with the currently active file in Obsidian via the REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import { NoteJson, RequestFunction } from "../types.js";
import { handleRequest } from "../utils/requestHandler.js";

/**
 * Gets the content of the currently active file in Obsidian.
 * @param _request - The internal request function from the service instance.
 * @param format - 'markdown' or 'json' (for NoteJson).
 * @param context - Request context.
 * @returns The file content (string) or NoteJson object.
 */
export async function getActiveFile(
  _request: RequestFunction,
  format: "markdown" | "json" = "markdown",
  context: RequestContext,
): Promise<string | NoteJson> {
  const acceptHeader =
    format === "json" ? "application/vnd.olrapi.note+json" : "text/markdown";
  return handleRequest(
    _request<string | NoteJson>(
      {
        method: "GET",
        url: `/active/`,
        headers: { Accept: acceptHeader },
      },
      context,
      "getActiveFile",
    ),
  );
}

/**
 * Updates (overwrites) the content of the currently active file.
 * @param _request - The internal request function from the service instance.
 * @param content - The new content.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function updateActiveFile(
  _request: RequestFunction,
  content: string,
  context: RequestContext,
): Promise<void> {
  await handleRequest(
    _request<void>(
      {
        method: "PUT",
        url: `/active/`,
        headers: { "Content-Type": "text/markdown" },
        data: content,
      },
      context,
      "updateActiveFile",
    ),
  );
}

/**
 * Appends content to the end of the currently active file.
 * @param _request - The internal request function from the service instance.
 * @param content - The content to append.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function appendActiveFile(
  _request: RequestFunction,
  content: string,
  context: RequestContext,
): Promise<void> {
  await handleRequest(
    _request<void>(
      {
        method: "POST",
        url: `/active/`,
        headers: { "Content-Type": "text/markdown" },
        data: content,
      },
      context,
      "appendActiveFile",
    ),
  );
}

/**
 * Deletes the currently active file.
 * @param _request - The internal request function from the service instance.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function deleteActiveFile(
  _request: RequestFunction,
  context: RequestContext,
): Promise<void> {
  await handleRequest(
    _request<void>(
      {
        method: "DELETE",
        url: `/active/`,
      },
      context,
      "deleteActiveFile",
    ),
  );
}

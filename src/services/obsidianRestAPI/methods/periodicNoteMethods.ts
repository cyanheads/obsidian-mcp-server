/**
 * @module PeriodicNoteMethods
 * @description
 * Methods for interacting with periodic notes (daily, weekly, etc.) via the Obsidian REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import { NoteJson, Period, RequestFunction } from "../types.js";
import { handleRequest } from "../utils/requestHandler.js";

/**
 * Gets the content of a periodic note (daily, weekly, etc.).
 * @param _request - The internal request function from the service instance.
 * @param period - The period type ('daily', 'weekly', 'monthly', 'quarterly', 'yearly').
 * @param format - 'markdown' or 'json'.
 * @param context - Request context.
 * @returns The note content or NoteJson.
 */
export async function getPeriodicNote(
  _request: RequestFunction,
  period: Period,
  format: "markdown" | "json" = "markdown",
  context: RequestContext,
): Promise<string | NoteJson> {
  const acceptHeader =
    format === "json" ? "application/vnd.olrapi.note+json" : "text/markdown";
  return handleRequest(
    _request<string | NoteJson>(
      {
        method: "GET",
        url: `/periodic/${period}/`,
        headers: { Accept: acceptHeader },
      },
      context,
      "getPeriodicNote",
    ),
  );
}

/**
 * Updates (overwrites) the content of a periodic note. Creates if needed.
 * @param _request - The internal request function from the service instance.
 * @param period - The period type.
 * @param content - The new content.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function updatePeriodicNote(
  _request: RequestFunction,
  period: Period,
  content: string,
  context: RequestContext,
): Promise<void> {
  await handleRequest(
    _request<void>(
      {
        method: "PUT",
        url: `/periodic/${period}/`,
        headers: { "Content-Type": "text/markdown" },
        data: content,
      },
      context,
      "updatePeriodicNote",
    ),
  );
}

/**
 * Appends content to a periodic note. Creates if needed.
 * @param _request - The internal request function from the service instance.
 * @param period - The period type.
 * @param content - The content to append.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function appendPeriodicNote(
  _request: RequestFunction,
  period: Period,
  content: string,
  context: RequestContext,
): Promise<void> {
  await handleRequest(
    _request<void>(
      {
        method: "POST",
        url: `/periodic/${period}/`,
        headers: { "Content-Type": "text/markdown" },
        data: content,
      },
      context,
      "appendPeriodicNote",
    ),
  );
}

/**
 * Deletes a periodic note.
 * @param _request - The internal request function from the service instance.
 * @param period - The period type.
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function deletePeriodicNote(
  _request: RequestFunction,
  period: Period,
  context: RequestContext,
): Promise<void> {
  await handleRequest(
    _request<void>(
      {
        method: "DELETE",
        url: `/periodic/${period}/`,
      },
      context,
      "deletePeriodicNote",
    ),
  );
}

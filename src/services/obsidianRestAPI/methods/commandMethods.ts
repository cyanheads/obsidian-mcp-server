/**
 * @module CommandMethods
 * @description
 * Methods for interacting with Obsidian commands via the REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import {
  CommandListResponse,
  ObsidianCommand,
  RequestFunction,
} from "../types.js";
import { handleRequest } from "../utils/requestHandler.js";

/**
 * Executes a registered Obsidian command by its ID.
 * @param _request - The internal request function from the service instance.
 * @param commandId - The ID of the command (e.g., "app:go-back").
 * @param context - Request context.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function executeCommand(
  _request: RequestFunction,
  commandId: string,
  context: RequestContext,
): Promise<void> {
  await handleRequest(
    _request<void>(
      {
        method: "POST",
        url: `/commands/${encodeURIComponent(commandId)}/`,
      },
      context,
      "executeCommand",
    ),
  );
}

/**
 * Lists all available Obsidian commands.
 * @param _request - The internal request function from the service instance.
 * @param context - Request context.
 * @returns A list of available commands.
 */
export async function listCommands(
  _request: RequestFunction,
  context: RequestContext,
): Promise<ObsidianCommand[]> {
  const response = await handleRequest(
    _request<CommandListResponse>(
      {
        method: "GET",
        url: "/commands/",
      },
      context,
      "listCommands",
    ),
  );
  return response.commands;
}

/**
 * @module ObsidianRestApiTypes
 * @description
 * Type definitions for interacting with the Obsidian Local REST API,
 * based on its OpenAPI specification.
 */

import { AxiosRequestConfig } from "axios";
import { RequestContext } from "../../utils/index.js";

/**
 * Defines the signature for the internal request function passed to method implementations.
 * This function is bound to the `ObsidianRestApiService` instance and handles the core
 * logic of making an HTTP request, including authentication, error handling, and logging.
 *
 * @template T The expected return type of the API call.
 * @param config The Axios request configuration.
 * @param context The request context for logging and correlation.
 * @param operationName A descriptive name for the operation being performed, used for logging.
 * @returns A promise that resolves with the data of type `T`.
 */
import { McpError } from "../../types-global/errors.js";

export type RequestFunction = <T = any>(
  config: AxiosRequestConfig,
  context: RequestContext,
  operationName: string,
  throwOnError?: boolean,
) => Promise<T | McpError>;

/**
 * Filesystem metadata for a note.
 */
export interface NoteStat {
  ctime: number; // Creation time (Unix timestamp)
  mtime: number; // Modification time (Unix timestamp)
  size: number; // File size in bytes
}

/**
 * JSON representation of an Obsidian note.
 * Returned when requesting with Accept: application/vnd.olrapi.note+json
 */
export interface NoteJson {
  content: string;
  frontmatter: Record<string, any>; // Parsed YAML frontmatter
  path: string; // Vault-relative path
  stat: NoteStat;
  tags: string[]; // Tags found in the note (including frontmatter)
}

/**
 * Response structure for listing files in a directory.
 */
export interface FileListResponse {
  files: string[]; // List of file/directory names (directories end with '/')
}

/**
 * Match details within a simple search result.
 */
export interface SimpleSearchMatchDetail {
  start: number; // Start index of the match
  end: number; // End index of the match
}

/**
 * Contextual match information for simple search.
 */
export interface SimpleSearchMatch {
  context: string; // Text surrounding the match
  match: SimpleSearchMatchDetail;
}

/**
 * Result item for a simple text search.
 */
export interface SimpleSearchResult {
  filename: string; // Original path from API
  filePath: string; // Normalized path for internal use
  matches: SimpleSearchMatch[];
  score: number; // Relevance score
}

/**
 * Result item for a complex (Dataview/JsonLogic) search.
 */
export interface ComplexSearchResult {
  filename: string; // Original path from API
  filePath: string; // Normalized path for internal use
  result: any; // The result returned by the query logic for this file
}

/**
 * Structure for an available Obsidian command.
 */
export interface ObsidianCommand {
  id: string;
  name: string;
}

/**
 * Response structure for listing available commands.
 */
export interface CommandListResponse {
  commands: ObsidianCommand[];
}

/**
 * Basic status response from the API root.
 */
export interface ApiStatusResponse {
  authenticated: boolean;
  ok: string; // Should be "OK"
  service: string; // Should be "Obsidian Local REST API"
  versions: {
    obsidian: string; // Obsidian API version
    self: string; // Plugin version
  };
}

/**
 * Standard error response structure from the API.
 */
export interface ApiError {
  errorCode: number; // e.g., 40149
  message: string; // e.g., "A brief description of the error."
}

/**
 * Options for PATCH operations.
 */
export interface PatchOptions {
  operation: "append" | "prepend" | "replace";
  targetType: "heading" | "block" | "frontmatter";
  target: string; // The specific heading, block ID, or frontmatter key
  targetDelimiter?: string; // Default '::' for nested headings
  trimTargetWhitespace?: boolean; // Default false
  /**
   * If true, creates the target if it's missing.
   * This is implemented via the `Create-Target-If-Missing` HTTP header.
   * Particularly useful for adding new frontmatter keys.
   */
  createTargetIfMissing?: boolean;
  contentType?: "text/markdown" | "application/json"; // For request body type inference
}

/**
 * Type alias for periodic note periods.
 */
export type Period = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

/**
 * Defines the set of permissions for file access.
 */
export type Permission = "read" | "write" | "create" | "delete";

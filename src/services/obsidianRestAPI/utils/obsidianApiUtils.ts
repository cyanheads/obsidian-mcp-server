/**
 * @fileoverview Utilities for encoding vault-relative file paths for Obsidian REST API requests.
 * @module src/services/obsidianRestAPI/utils/obsidianApiUtils
 */

/**
 * Encodes a vault-relative file path correctly for API URLs.
 * Ensures path separators '/' are not encoded, but individual components are.
 * Handles leading slashes correctly.
 *
 * @param filePath - The raw vault-relative file path (e.g., "/Notes/My File.md" or "Notes/My File.md").
 * @returns The URL-encoded path suitable for appending to `/vault`.
 */
export function encodeVaultPath(filePath: string): string {
  // 1. Trim whitespace and remove any leading/trailing slashes for consistent processing.
  const trimmedPath = filePath.trim().replace(/^\/+|\/+$/g, "");

  // 2. If the original path was just '/' or empty, return an empty string (represents root for files).
  if (trimmedPath === "") {
    // For file operations, the API expects /vault/filename.md at the root,
    // so an empty encoded path segment is correct here.
    // For listFiles, we handle the root case separately.
    return "";
  }

  // 3. Split into components, encode each component, then rejoin with literal '/'.
  const encodedComponents = trimmedPath.split("/").map(encodeURIComponent);
  const encodedPath = encodedComponents.join("/");

  // 4. Prepend the leading slash.
  return `/${encodedPath}`;
}

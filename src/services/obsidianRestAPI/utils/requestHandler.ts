/**
 * @module RequestHandler
 * @description A utility for handling MCP requests and ensuring proper error propagation.
 */

import { McpError } from "../../../types-global/errors.js";

/**
 * A higher-order function that wraps a request function call, checks for McpError,
 * and throws it, ensuring that the rest of the application logic doesn't need to
 * handle the dual return type.
 * @param requestPromise The promise returned by the _request function.
 * @returns The result of the request if it's not an error.
 * @throws {McpError} If the request result is an McpError.
 */
export async function handleRequest<T>(
  requestPromise: Promise<T | McpError>,
): Promise<T> {
  const result = await requestPromise;
  if (result instanceof McpError) {
    throw result;
  }
  return result;
}

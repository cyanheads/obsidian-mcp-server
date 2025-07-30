/**
 * @fileoverview Provides a utility function to make fetch requests with a specified timeout.
 * @module src/utils/network/fetchWithTimeout
 */

import { logger } from "../internal/logger.js"; // Adjusted import path
import type { RequestContext } from "../internal/requestContext.js"; // Adjusted import path
import { McpError, BaseErrorCode } from "../../types-global/errors.js";

/**
 * Options for the fetchWithTimeout utility.
 * Extends standard RequestInit but omits 'signal' as it's handled internally.
 */
export type FetchWithTimeoutOptions = Omit<RequestInit, "signal">;

/**
 * Fetches a resource with a specified timeout.
 *
 * @param url - The URL to fetch.
 * @param timeoutMs - The timeout duration in milliseconds.
 * @param context - The request context for logging.
 * @param options - Optional fetch options (RequestInit), excluding 'signal'.
 * @returns A promise that resolves to the Response object.
 * @throws {McpError} If the request times out or another fetch-related error occurs.
 */
export async function fetchWithTimeout(
  url: string | URL,
  timeoutMs: number,
  context: RequestContext,
  options?: FetchWithTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const urlString = url.toString();
  const operationDescription = `fetch ${options?.method || "GET"} ${urlString}`;

  logger.debug(
    `Attempting ${operationDescription} with ${timeoutMs}ms timeout.`,
    context,
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    logger.debug(
      `Successfully fetched ${urlString}. Status: ${response.status}`,
      context,
    );
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      logger.error(`${operationDescription} timed out after ${timeoutMs}ms.`, {
        ...context,
        errorSource: "FetchTimeout",
      });
      throw new McpError(
        BaseErrorCode.TIMEOUT,
        `${operationDescription} timed out.`,
        { ...context, errorSource: "FetchTimeout" },
      );
    }

    // Log and re-throw other errors as McpError
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Network error during ${operationDescription}: ${errorMessage}`,
      {
        ...context,
        originalErrorName: error instanceof Error ? error.name : "UnknownError",
        errorSource: "FetchNetworkError",
      },
    );

    if (error instanceof McpError) {
      // If it's already an McpError, re-throw it
      throw error;
    }

    throw new McpError(
      BaseErrorCode.SERVICE_UNAVAILABLE, // Generic error for network/service issues
      `Network error during ${operationDescription}: ${errorMessage}`,
      {
        ...context,
        originalErrorName: error instanceof Error ? error.name : "UnknownError",
        errorSource: "FetchNetworkErrorWrapper",
      },
    );
  }
}

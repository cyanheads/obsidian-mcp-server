/**
 * @fileoverview Utilities for formatting Obsidian stat objects,
 * including timestamps and calculating estimated token counts.
 * @module src/services/obsidianRestAPI/utils/obsidianStatUtils
 */

import { format } from "date-fns";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, RequestContext } from "../../../utils/internal/index.js";
import { countTokens } from "../../../utils/metrics/index.js";

/**
 * Default format string for timestamps, providing a human-readable date and time.
 * Example output: "08:40:00 PM | 05-02-2025"
 */
const DEFAULT_TIMESTAMP_FORMAT = "hh:mm:ss a | MM-dd-yyyy";

/**
 * Formats a Unix timestamp (in milliseconds since the epoch) into a human-readable string.
 *
 * @param {number | undefined | null} timestampMs - The Unix timestamp in milliseconds.
 * @param {RequestContext} context - The request context for logging and error reporting.
 * @param {string} [formatString=DEFAULT_TIMESTAMP_FORMAT] - Optional format string adhering to `date-fns` tokens.
 *   Defaults to 'hh:mm:ss a | MM-dd-yyyy'.
 * @returns {string} The formatted timestamp string.
 * @throws {McpError} If the provided `timestampMs` is invalid (e.g., undefined, null, not a finite number, or results in an invalid Date object).
 */
export function formatTimestamp(
  timestampMs: number | undefined | null,
  context: RequestContext,
  formatString: string = DEFAULT_TIMESTAMP_FORMAT,
): string {
  const operation = "formatTimestamp";
  if (
    timestampMs === undefined ||
    timestampMs === null ||
    !Number.isFinite(timestampMs)
  ) {
    const errorMessage = `Invalid timestamp provided for formatting: ${timestampMs}`;
    logger.warning(errorMessage, { ...context, operation });
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, errorMessage, {
      ...context,
      operation,
    });
  }

  try {
    const date = new Date(timestampMs);
    if (isNaN(date.getTime())) {
      const errorMessage = `Timestamp resulted in an invalid date: ${timestampMs}`;
      logger.warning(errorMessage, { ...context, operation });
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, errorMessage, {
        ...context,
        operation,
      });
    }
    return format(date, formatString);
  } catch (error) {
    const errorMessage = `Failed to format timestamp ${timestampMs}: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(errorMessage, error instanceof Error ? error : undefined, {
      ...context,
      operation,
    });
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, errorMessage, {
      ...context,
      operation,
      originalError: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Represents the structure of an Obsidian API Stat object.
 */
export interface ObsidianStat {
  /** Creation time as a Unix timestamp (milliseconds). */
  ctime: number;
  /** Modification time as a Unix timestamp (milliseconds). */
  mtime: number;
  /** File size in bytes. */
  size: number;
}

/**
 * Represents formatted timestamp information derived from an Obsidian Stat object.
 */
export interface FormattedTimestamps {
  /** Human-readable creation time string. */
  createdTime: string;
  /** Human-readable modification time string. */
  modifiedTime: string;
}

/**
 * Formats the `ctime` (creation time) and `mtime` (modification time) from an
 * Obsidian API Stat object into human-readable strings.
 *
 * @param {ObsidianStat | undefined | null} stat - The Stat object from the Obsidian API.
 *   If undefined or null, placeholder strings ('N/A') are returned.
 * @param {RequestContext} context - The request context for logging and error reporting.
 * @returns {FormattedTimestamps} An object containing `createdTime` and `modifiedTime` strings.
 */
export function formatStatTimestamps(
  stat: ObsidianStat | undefined | null,
  context: RequestContext,
): FormattedTimestamps {
  const operation = "formatStatTimestamps";
  if (!stat) {
    logger.debug(
      "Stat object is undefined or null, returning N/A for timestamps.",
      { ...context, operation },
    );
    return {
      createdTime: "N/A",
      modifiedTime: "N/A",
    };
  }
  try {
    return {
      createdTime: formatTimestamp(stat.ctime, context),
      modifiedTime: formatTimestamp(stat.mtime, context),
    };
  } catch (error) {
    // Log the error from formatTimestamp if it occurs during this higher-level operation
    logger.error(
      `Error formatting timestamps within formatStatTimestamps for ctime: ${stat.ctime}, mtime: ${stat.mtime}`,
      error instanceof Error ? error : undefined,
      { ...context, operation },
    );
    // Return N/A as a fallback if formatting fails at this stage
    return {
      createdTime: "N/A",
      modifiedTime: "N/A",
    };
  }
}

/**
 * Represents a fully formatted stat object, including human-readable timestamps
 * and an estimated token count for the file content.
 */
export interface FormattedStatWithTokenCount extends FormattedTimestamps {
  /** Estimated number of tokens in the file content. -1 if counting failed or content was empty. */
  tokenCountEstimate: number;
}

/**
 * Creates a formatted stat object that includes human-readable timestamps
 * (creation and modification times) and an estimated token count for the provided file content.
 *
 * @param {ObsidianStat | null | undefined} stat - The original Stat object from the Obsidian API.
 *   If null or undefined, the function will return the input value (null or undefined).
 * @param {string} content - The file content string from which to calculate the token count.
 * @param {RequestContext} context - The request context for logging and error reporting.
 * @returns {Promise<FormattedStatWithTokenCount | null | undefined>} A promise resolving to an object
 *   containing `createdTime`, `modifiedTime`, and `tokenCountEstimate`. Returns `null` or `undefined`
 *   if the input `stat` object was `null` or `undefined`, respectively.
 */
export async function createFormattedStatWithTokenCount(
  stat: ObsidianStat | null | undefined,
  content: string,
  context: RequestContext,
): Promise<FormattedStatWithTokenCount | null | undefined> {
  const operation = "createFormattedStatWithTokenCount";
  if (stat === null || stat === undefined) {
    logger.debug("Input stat is null or undefined, returning as is.", {
      ...context,
      operation,
    });
    return stat; // Return original null/undefined
  }

  const formattedTimestamps = formatStatTimestamps(stat, context);
  let tokenCountEstimate = -1; // Default: indicates error or empty content

  if (content && content.trim().length > 0) {
    try {
      tokenCountEstimate = await countTokens(content, context);
    } catch (tokenError) {
      logger.warning(
        `Failed to count tokens for stat object. Error: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
        {
          ...context,
          operation,
          originalError:
            tokenError instanceof Error
              ? tokenError.message
              : String(tokenError),
        },
      );
      // tokenCountEstimate remains -1
    }
  } else {
    logger.debug(
      "Content is empty or whitespace-only, setting tokenCountEstimate to 0.",
      { ...context, operation },
    );
    tokenCountEstimate = 0;
  }

  return {
    createdTime: formattedTimestamps.createdTime,
    modifiedTime: formattedTimestamps.modifiedTime,
    tokenCountEstimate: tokenCountEstimate,
  };
}

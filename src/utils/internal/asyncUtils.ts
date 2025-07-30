/**
 * @fileoverview Provides utilities for handling asynchronous operations,
 * such as retrying operations with delays.
 * @module src/utils/internal/asyncUtils
 */
import { McpError, BaseErrorCode } from "../../types-global/errors.js";
import { logger } from "./logger.js";
import { RequestContext } from "../index.js";

/**
 * Configuration for the {@link retryWithDelay} function, defining how retries are handled.
 */
export interface RetryConfig<T> {
  /**
   * A descriptive name for the operation being retried. Used in logging.
   * Example: "FetchUserData", "ProcessPayment".
   */
  operationName: string;
  /**
   * The request context associated with the operation, for logging and tracing.
   */
  context: RequestContext;
  /**
   * The maximum number of retry attempts before failing.
   */
  maxRetries: number;
  /**
   * The delay in milliseconds between retry attempts.
   */
  delayMs: number;
  /**
   * An optional function to determine if a retry should be attempted based on the error.
   * If not provided, retries will be attempted for any error.
   * @param error - The error that occurred during the operation.
   * @returns `true` if a retry should be attempted, `false` otherwise.
   */
  shouldRetry?: (error: unknown) => boolean;
  /**
   * An optional function to execute before each retry attempt.
   * Useful for custom logging or cleanup actions.
   * @param attempt - The current retry attempt number.
   * @param error - The error that triggered the retry.
   */
  onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * Executes an asynchronous operation with a configurable retry mechanism.
 * This function will attempt the operation up to `maxRetries` times, with a specified
 * `delayMs` between attempts. It allows for custom logic to decide if an error
 * warrants a retry and for actions to be taken before each retry.
 *
 * @template T The expected return type of the asynchronous operation.
 * @param {() => Promise<T>} operation - The asynchronous function to execute.
 *   This function should return a Promise resolving to type `T`.
 * @param {RetryConfig<T>} config - Configuration options for the retry behavior,
 *   including operation name, context, retry limits, delay, and custom handlers.
 * @returns {Promise<T>} A promise that resolves with the result of the operation if successful.
 * @throws {McpError} Throws an `McpError` if the operation fails after all retry attempts,
 *   or if an unexpected error occurs during the retry logic. The error will contain details
 *   about the operation name, context, and the last encountered error.
 */
export async function retryWithDelay<T>(
  operation: () => Promise<T>,
  config: RetryConfig<T>,
): Promise<T> {
  const {
    operationName,
    context,
    maxRetries,
    delayMs,
    shouldRetry = () => true, // Default: retry on any error
    onRetry,
  } = config;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // Ensure the context for logging includes attempt details
      const retryAttemptContext: RequestContext = {
        ...context, // Spread existing context
        operation: operationName, // Ensure operationName is part of the context for logger
        attempt,
        maxRetries,
        lastError: error instanceof Error ? error.message : String(error),
      };

      if (attempt < maxRetries && shouldRetry(error)) {
        if (onRetry) {
          onRetry(attempt, error); // Custom onRetry logic
        } else {
          // Default logging for retry attempt
          logger.warning(
            `Operation '${operationName}' failed on attempt ${attempt} of ${maxRetries}. Retrying in ${delayMs}ms...`,
            retryAttemptContext, // Pass the enriched context
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        // Max retries reached or shouldRetry returned false
        const finalErrorMsg = `Operation '${operationName}' failed definitively after ${attempt} attempt(s).`;
        // Log the final failure with the enriched context
        logger.error(
          finalErrorMsg,
          error instanceof Error ? error : undefined,
          retryAttemptContext,
        );

        if (error instanceof McpError) {
          // If the last error was already an McpError, create a new one with updated details to respect immutability.
          const newDetails = {
            ...(error.details ?? {}),
            ...retryAttemptContext,
            finalAttempt: true,
          };
          throw new McpError(error.code, error.message, newDetails);
        }
        // For other errors, wrap in a new McpError
        throw new McpError(
          BaseErrorCode.SERVICE_UNAVAILABLE, // Default to SERVICE_UNAVAILABLE, consider making this configurable or smarter
          `${finalErrorMsg} Last error: ${error instanceof Error ? error.message : String(error)}`,
          {
            ...retryAttemptContext, // Include all retry context
            originalErrorName:
              error instanceof Error ? error.name : typeof error,
            originalErrorStack:
              error instanceof Error ? error.stack : undefined,
            finalAttempt: true,
          },
        );
      }
    }
  }

  // Fallback: This part should ideally not be reached if the loop logic is correct.
  // If it is, it implies an issue with the loop or maxRetries logic.
  const fallbackErrorContext: RequestContext = {
    ...context,
    operation: operationName,
    maxRetries,
    reason: "Fallback_Error_Path_Reached_In_Retry_Logic",
  };
  logger.crit(
    // Log as critical because this path indicates a logic flaw
    `Operation '${operationName}' failed unexpectedly after all retries (fallback path). This may indicate a logic error in retryWithDelay.`,
    lastError instanceof Error ? lastError : undefined,
    fallbackErrorContext,
  );
  throw new McpError(
    BaseErrorCode.INTERNAL_ERROR, // Indicates an issue with the retry utility itself
    `Operation '${operationName}' failed unexpectedly after all retries (fallback path). Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    {
      ...fallbackErrorContext,
      originalError:
        lastError instanceof Error
          ? {
              message: lastError.message,
              name: lastError.name,
              stack: lastError.stack,
            }
          : String(lastError),
    },
  );
}

/**
 * @fileoverview This module provides utilities for robust error handling.
 * It defines structures for error context, options for handling errors,
 * and mappings for classifying errors. The main `ErrorHandler` class
 * offers static methods for consistent error processing, logging, and transformation.
 * @module src/utils/internal/errorHandler
 */
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { generateUUID, sanitizeInputForLogging } from "../index.js";
import { logger } from "./logger.js";
import { RequestContext } from "./requestContext.js";

/**
 * Defines a generic structure for providing context with errors.
 * This context can include identifiers like `requestId` or any other relevant
 * key-value pairs that aid in debugging or understanding the error's circumstances.
 */
export interface ErrorContext {
  /**
   * A unique identifier for the request or operation during which the error occurred.
   * Useful for tracing errors through logs and distributed systems.
   */
  requestId?: string;

  /**
   * Allows for arbitrary additional context information.
   * Keys are strings, and values can be of any type.
   */
  [key: string]: unknown;
}

/**
 * Configuration options for the `ErrorHandler.handleError` method.
 * These options control how an error is processed, logged, and whether it's rethrown.
 */
export interface ErrorHandlerOptions {
  /**
   * The context of the operation that caused the error.
   * This can include `requestId` and other relevant debugging information.
   */
  context?: ErrorContext;

  /**
   * A descriptive name of the operation being performed when the error occurred.
   * This helps in identifying the source or nature of the error in logs.
   * Example: "UserLogin", "ProcessPayment", "FetchUserProfile".
   */
  operation: string;

  /**
   * The input data or parameters that were being processed when the error occurred.
   * This input will be sanitized before logging to prevent sensitive data exposure.
   */
  input?: unknown;

  /**
   * If true, the (potentially transformed) error will be rethrown after handling.
   * Defaults to `false`.
   */
  rethrow?: boolean;

  /**
   * A specific `BaseErrorCode` to assign to the error, overriding any
   * automatically determined error code.
   */
  errorCode?: BaseErrorCode;

  /**
   * A custom function to map or transform the original error into a new `Error` instance.
   * If provided, this function is used instead of the default `McpError` creation.
   * @param error - The original error that occurred.
   * @returns The transformed error.
   */
  errorMapper?: (error: unknown) => Error;

  /**
   * If true, stack traces will be included in the logs.
   * Defaults to `true`.
   */
  includeStack?: boolean;

  /**
   * If true, indicates that the error is critical and might require immediate attention
   * or could lead to system instability. This is primarily for logging and alerting.
   * Defaults to `false`.
   */
  critical?: boolean;
}

/**
 * Defines a basic rule for mapping errors based on patterns.
 * Used internally by `COMMON_ERROR_PATTERNS` and as a base for `ErrorMapping`.
 */
export interface BaseErrorMapping {
  /**
   * A string or regular expression to match against the error message.
   * If a string is provided, it's typically used for substring matching (case-insensitive).
   */
  pattern: string | RegExp;

  /**
   * The `BaseErrorCode` to assign if the pattern matches.
   */
  errorCode: BaseErrorCode;

  /**
   * An optional custom message template for the mapped error.
   * (Note: This property is defined but not directly used by `ErrorHandler.determineErrorCode`
   * which focuses on `errorCode`. It's more relevant for custom mapping logic.)
   */
  messageTemplate?: string;
}

/**
 * Extends `BaseErrorMapping` to include a factory function for creating
 * specific error instances and additional context for the mapping.
 * Used by `ErrorHandler.mapError`.
 * @template T The type of `Error` this mapping will produce, defaults to `Error`.
 */
export interface ErrorMapping<T extends Error = Error>
  extends BaseErrorMapping {
  /**
   * A factory function that creates and returns an instance of the mapped error type `T`.
   * @param error - The original error that occurred.
   * @param context - Optional additional context provided in the mapping rule.
   * @returns The newly created error instance.
   */
  factory: (error: unknown, context?: Record<string, unknown>) => T;

  /**
   * Additional static context to be merged or passed to the `factory` function
   * when this mapping rule is applied.
   */
  additionalContext?: Record<string, unknown>;
}

/**
 * Maps standard JavaScript error constructor names to `BaseErrorCode` values.
 * @private
 */
const ERROR_TYPE_MAPPINGS: Readonly<Record<string, BaseErrorCode>> = {
  SyntaxError: BaseErrorCode.VALIDATION_ERROR,
  TypeError: BaseErrorCode.VALIDATION_ERROR,
  ReferenceError: BaseErrorCode.INTERNAL_ERROR,
  RangeError: BaseErrorCode.VALIDATION_ERROR,
  URIError: BaseErrorCode.VALIDATION_ERROR,
  EvalError: BaseErrorCode.INTERNAL_ERROR,
};

/**
 * Array of `BaseErrorMapping` rules to classify errors by message/name patterns.
 * Order matters: more specific patterns should precede generic ones.
 * @private
 */
const COMMON_ERROR_PATTERNS: ReadonlyArray<Readonly<BaseErrorMapping>> = [
  {
    pattern:
      /auth|unauthorized|unauthenticated|not.*logged.*in|invalid.*token|expired.*token/i,
    errorCode: BaseErrorCode.UNAUTHORIZED,
  },
  {
    pattern: /permission|forbidden|access.*denied|not.*allowed/i,
    errorCode: BaseErrorCode.FORBIDDEN,
  },
  {
    pattern: /not found|missing|no such|doesn't exist|couldn't find/i,
    errorCode: BaseErrorCode.NOT_FOUND,
  },
  {
    pattern:
      /invalid|validation|malformed|bad request|wrong format|missing required/i,
    errorCode: BaseErrorCode.VALIDATION_ERROR,
  },
  {
    pattern: /conflict|already exists|duplicate|unique constraint/i,
    errorCode: BaseErrorCode.CONFLICT,
  },
  {
    pattern: /rate limit|too many requests|throttled/i,
    errorCode: BaseErrorCode.RATE_LIMITED,
  },
  {
    pattern: /timeout|timed out|deadline exceeded/i,
    errorCode: BaseErrorCode.TIMEOUT,
  },
  {
    pattern: /service unavailable|bad gateway|gateway timeout|upstream error/i,
    errorCode: BaseErrorCode.SERVICE_UNAVAILABLE,
  },
];

/**
 * Creates a "safe" RegExp for testing error messages.
 * Ensures case-insensitivity and removes the global flag.
 * @param pattern - The string or RegExp pattern.
 * @returns A new RegExp instance.
 * @private
 */
function createSafeRegex(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) {
    let flags = pattern.flags.replace("g", "");
    if (!flags.includes("i")) {
      flags += "i";
    }
    return new RegExp(pattern.source, flags);
  }
  return new RegExp(pattern, "i");
}

/**
 * Retrieves a descriptive name for an error object or value.
 * @param error - The error object or value.
 * @returns A string representing the error's name or type.
 * @private
 */
function getErrorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  if (error === null) {
    return "NullValueEncountered";
  }
  if (error === undefined) {
    return "UndefinedValueEncountered";
  }
  if (
    typeof error === "object" &&
    error !== null &&
    error.constructor &&
    typeof error.constructor.name === "string" &&
    error.constructor.name !== "Object"
  ) {
    return `${error.constructor.name}Encountered`;
  }
  return `${typeof error}Encountered`;
}

/**
 * Extracts a message string from an error object or value.
 * @param error - The error object or value.
 * @returns The error message string.
 * @private
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error === null) {
    return "Null value encountered as error";
  }
  if (error === undefined) {
    return "Undefined value encountered as error";
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    const str = String(error);
    if (str === "[object Object]" && error !== null) {
      try {
        return `Non-Error object encountered: ${JSON.stringify(error)}`;
      } catch {
        return `Unstringifyable non-Error object encountered (constructor: ${error.constructor?.name || "Unknown"})`;
      }
    }
    return str;
  } catch (e) {
    return `Error converting error to string: ${e instanceof Error ? e.message : "Unknown conversion error"}`;
  }
}

/**
 * A utility class providing static methods for comprehensive error handling.
 */
export class ErrorHandler {
  /**
   * Determines an appropriate `BaseErrorCode` for a given error.
   * Checks `McpError` instances, `ERROR_TYPE_MAPPINGS`, and `COMMON_ERROR_PATTERNS`.
   * Defaults to `BaseErrorCode.INTERNAL_ERROR`.
   * @param error - The error instance or value to classify.
   * @returns The determined error code.
   */
  public static determineErrorCode(error: unknown): BaseErrorCode {
    if (error instanceof McpError) {
      return error.code;
    }

    const errorName = getErrorName(error);
    const errorMessage = getErrorMessage(error);

    if (errorName in ERROR_TYPE_MAPPINGS) {
      return ERROR_TYPE_MAPPINGS[errorName as keyof typeof ERROR_TYPE_MAPPINGS];
    }

    for (const mapping of COMMON_ERROR_PATTERNS) {
      const regex = createSafeRegex(mapping.pattern);
      if (regex.test(errorMessage) || regex.test(errorName)) {
        return mapping.errorCode;
      }
    }
    return BaseErrorCode.INTERNAL_ERROR;
  }

  /**
   * Handles an error with consistent logging and optional transformation.
   * Sanitizes input, determines error code, logs details, and can rethrow.
   * @param error - The error instance or value that occurred.
   * @param options - Configuration for handling the error.
   * @returns The handled (and potentially transformed) error instance.
   */
  public static handleError(
    error: unknown,
    options: ErrorHandlerOptions,
  ): Error {
    const {
      context = {},
      operation,
      input,
      rethrow = false,
      errorCode: explicitErrorCode,
      includeStack = true,
      critical = false,
      errorMapper,
    } = options;

    const sanitizedInput =
      input !== undefined ? sanitizeInputForLogging(input) : undefined;
    const originalErrorName = getErrorName(error);
    const originalErrorMessage = getErrorMessage(error);
    const originalStack = error instanceof Error ? error.stack : undefined;

    let finalError: Error;
    let loggedErrorCode: BaseErrorCode;

    const errorDetailsSeed =
      error instanceof McpError &&
      typeof error.details === "object" &&
      error.details !== null
        ? { ...error.details }
        : {};

    const consolidatedDetails: Record<string, unknown> = {
      ...errorDetailsSeed,
      ...context,
      originalErrorName,
      originalMessage: originalErrorMessage,
    };
    if (
      originalStack &&
      !(error instanceof McpError && error.details?.originalStack)
    ) {
      consolidatedDetails.originalStack = originalStack;
    }

    if (error instanceof McpError) {
      loggedErrorCode = error.code;
      finalError = errorMapper
        ? errorMapper(error)
        : new McpError(error.code, error.message, consolidatedDetails);
    } else {
      loggedErrorCode =
        explicitErrorCode || ErrorHandler.determineErrorCode(error);
      const message = `Error in ${operation}: ${originalErrorMessage}`;
      finalError = errorMapper
        ? errorMapper(error)
        : new McpError(loggedErrorCode, message, consolidatedDetails);
    }

    if (
      finalError !== error &&
      error instanceof Error &&
      finalError instanceof Error &&
      !finalError.stack &&
      error.stack
    ) {
      finalError.stack = error.stack;
    }

    const logRequestId =
      typeof context.requestId === "string" && context.requestId
        ? context.requestId
        : generateUUID();

    const logTimestamp =
      typeof context.timestamp === "string" && context.timestamp
        ? context.timestamp
        : new Date().toISOString();

    const logPayload: Record<string, unknown> = {
      requestId: logRequestId,
      timestamp: logTimestamp,
      operation,
      input: sanitizedInput,
      critical,
      errorCode: loggedErrorCode,
      originalErrorType: originalErrorName,
      finalErrorType: getErrorName(finalError),
      ...Object.fromEntries(
        Object.entries(context).filter(
          ([key]) => key !== "requestId" && key !== "timestamp",
        ),
      ),
    };

    if (finalError instanceof McpError && finalError.details) {
      logPayload.errorDetails = finalError.details;
    } else {
      logPayload.errorDetails = consolidatedDetails;
    }

    if (includeStack) {
      const stack =
        finalError instanceof Error ? finalError.stack : originalStack;
      if (stack) {
        logPayload.stack = stack;
      }
    }

    logger.error(
      `Error in ${operation}: ${finalError.message || originalErrorMessage}`,
      logPayload as unknown as RequestContext, // Cast to RequestContext for logger compatibility
    );

    if (rethrow) {
      throw finalError;
    }
    return finalError;
  }

  /**
   * Maps an error to a specific error type `T` based on `ErrorMapping` rules.
   * Returns original/default error if no mapping matches.
   * @template T The target error type, extending `Error`.
   * @param error - The error instance or value to map.
   * @param mappings - An array of mapping rules to apply.
   * @param defaultFactory - Optional factory for a default error if no mapping matches.
   * @returns The mapped error of type `T`, or the original/defaulted error.
   */
  public static mapError<T extends Error>(
    error: unknown,
    mappings: ReadonlyArray<ErrorMapping<T>>,
    defaultFactory?: (error: unknown, context?: Record<string, unknown>) => T,
  ): T | Error {
    const errorMessage = getErrorMessage(error);
    const errorName = getErrorName(error);

    for (const mapping of mappings) {
      const regex = createSafeRegex(mapping.pattern);
      if (regex.test(errorMessage) || regex.test(errorName)) {
        return mapping.factory(error, mapping.additionalContext);
      }
    }

    if (defaultFactory) {
      return defaultFactory(error);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Formats an error into a consistent object structure for API responses or structured logging.
   * @param error - The error instance or value to format.
   * @returns A structured representation of the error.
   */
  public static formatError(error: unknown): Record<string, unknown> {
    if (error instanceof McpError) {
      return {
        code: error.code,
        message: error.message,
        details:
          typeof error.details === "object" && error.details !== null
            ? error.details
            : {},
      };
    }

    if (error instanceof Error) {
      return {
        code: ErrorHandler.determineErrorCode(error),
        message: error.message,
        details: { errorType: error.name || "Error" },
      };
    }

    return {
      code: BaseErrorCode.UNKNOWN_ERROR,
      message: getErrorMessage(error),
      details: { errorType: getErrorName(error) },
    };
  }

  /**
   * Safely executes a function (sync or async) and handles errors using `ErrorHandler.handleError`.
   * The error is always rethrown.
   * @template T The expected return type of the function `fn`.
   * @param fn - The function to execute.
   * @param options - Error handling options (excluding `rethrow`).
   * @returns A promise resolving with the result of `fn` if successful.
   * @throws {McpError | Error} The error processed by `ErrorHandler.handleError`.
   * @example
   * ```typescript
   * async function fetchData(userId: string, context: RequestContext) {
   *   return ErrorHandler.tryCatch(
   *     async () => {
   *       const response = await fetch(`/api/users/${userId}`);
   *       if (!response.ok) throw new Error(`Failed to fetch user: ${response.status}`);
   *       return response.json();
   *     },
   *     { operation: 'fetchUserData', context, input: { userId } }
   *   );
   * }
   * ```
   */
  public static async tryCatch<T>(
    fn: () => Promise<T> | T,
    options: Omit<ErrorHandlerOptions, "rethrow">,
  ): Promise<T> {
    try {
      return await Promise.resolve(fn());
    } catch (error) {
      // ErrorHandler.handleError will return the error to be thrown.
      throw ErrorHandler.handleError(error, { ...options, rethrow: true });
    }
  }
}

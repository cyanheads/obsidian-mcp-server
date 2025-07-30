/**
 * @fileoverview Defines standardized error codes, a custom error class, and related schemas
 * for handling errors within the Model Context Protocol (MCP) server and its components.
 * This module provides a structured way to represent and communicate errors, ensuring
 * consistency and clarity for both server-side operations and client-side error handling.
 * @module src/types-global/errors
 */

import { z } from "zod";

/**
 * Defines a comprehensive set of standardized error codes for common issues encountered
 * within MCP servers, tools, or related operations. These codes are designed to help
 * clients and developers programmatically understand the nature of an error, facilitating
 * more precise error handling and debugging.
 */
export enum BaseErrorCode {
  /** Access denied due to invalid credentials or lack of authentication. */
  UNAUTHORIZED = "UNAUTHORIZED",
  /** Access denied despite valid authentication, due to insufficient permissions. */
  FORBIDDEN = "FORBIDDEN",
  /** The requested resource or entity could not be found. */
  NOT_FOUND = "NOT_FOUND",
  /** The request could not be completed due to a conflict with the current state of the resource. */
  CONFLICT = "CONFLICT",
  /** The request failed due to invalid input parameters or data. */
  VALIDATION_ERROR = "VALIDATION_ERROR",
  /** The provided input is invalid for the operation. */
  INVALID_INPUT = "INVALID_INPUT",
  /** An error occurred while parsing input data (e.g., date string, JSON). */
  PARSING_ERROR = "PARSING_ERROR",
  /** The request was rejected because the client has exceeded rate limits. */
  RATE_LIMITED = "RATE_LIMITED",
  /** The request timed out before a response could be generated. */
  TIMEOUT = "TIMEOUT",
  /** The service is temporarily unavailable, possibly due to maintenance or overload. */
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
  /** An unexpected error occurred on the server side. */
  INTERNAL_ERROR = "INTERNAL_ERROR",
  /** An error occurred, but the specific cause is unknown or cannot be categorized. */
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
  /** An error occurred during the loading or validation of configuration data. */
  CONFIGURATION_ERROR = "CONFIGURATION_ERROR",
  /** An error occurred during the initialization phase of a service or module. */
  INITIALIZATION_FAILED = "INITIALIZATION_FAILED",
  /** A service was used before it was properly initialized. */
  SERVICE_NOT_INITIALIZED = "SERVICE_NOT_INITIALIZED",
  /** A generic error occurred during a database operation. */
  DATABASE_ERROR = "DATABASE_ERROR",
  /** An error occurred while loading or interacting with an extension. */
  EXTENSION_ERROR = "EXTENSION_ERROR",
  /** An error occurred during the shutdown phase of a service or module. */
  SHUTDOWN_ERROR = "SHUTDOWN_ERROR",
  /** A generic error occurred during the execution of an agent's task. */
  AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
}

/**
 * Custom error class for MCP-specific errors, extending the built-in `Error` class.
 * It standardizes error reporting by encapsulating a `BaseErrorCode`, a descriptive
 * human-readable message, and optional structured details for more context.
 *
 * This class is central to error handling within the MCP framework, allowing for
 * consistent error creation and propagation.
 */
export class McpError extends Error {
  /**
   * The standardized error code from {@link BaseErrorCode}.
   */
  public readonly code: BaseErrorCode;

  /**
   * Optional additional details or context about the error.
   * This can be any structured data that helps in understanding or debugging the error.
   */
  public readonly details?: Record<string, unknown>;

  /**
   * Creates an instance of McpError.
   *
   * @param code - The standardized error code that categorizes the error.
   * @param message - A human-readable description of the error.
   * @param details - Optional. A record containing additional structured details about the error.
   */
  constructor(
    code: BaseErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);

    this.code = code;
    this.details = details;
    this.name = "McpError";

    // Maintain a proper prototype chain.
    Object.setPrototypeOf(this, McpError.prototype);

    // Capture the stack trace, excluding the constructor call from it, if available.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, McpError);
    }
  }
}

/**
 * Zod schema for validating error objects. This schema can be used for:
 * - Validating error structures when parsing error responses from external services.
 * - Ensuring consistency when creating or handling error objects internally.
 * - Generating TypeScript types for error objects.
 *
 * The schema enforces the presence of a `code` (from {@link BaseErrorCode}) and a `message`,
 * and allows for optional `details`.
 */
export const ErrorSchema = z
  .object({
    /**
     * The error code, corresponding to one of the {@link BaseErrorCode} enum values.
     * This field is required and helps in programmatically identifying the error type.
     */
    code: z
      .nativeEnum(BaseErrorCode)
      .describe("Standardized error code from BaseErrorCode enum"),
    /**
     * A human-readable, descriptive message explaining the error.
     * This field is required and provides context to developers or users.
     */
    message: z
      .string()
      .min(1, "Error message cannot be empty.")
      .describe("Detailed human-readable error message"),
    /**
     * Optional. A record containing additional structured details or context about the error.
     * This can include things like invalid field names, specific values that caused issues, or other relevant data.
     */
    details: z
      .record(z.unknown())
      .optional()
      .describe(
        "Optional structured details providing more context about the error",
      ),
  })
  .describe(
    "Schema for validating structured error objects, ensuring consistency in error reporting.",
  );

/**
 * TypeScript type inferred from the {@link ErrorSchema}.
 * This type represents the structure of a validated error object, commonly used
 * for error responses or when passing error information within the application.
 */
export type ErrorResponse = z.infer<typeof ErrorSchema>;

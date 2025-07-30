/**
 * @fileoverview Provides a comprehensive `Sanitization` class for various input cleaning and validation tasks.
 * This module includes utilities for sanitizing HTML, strings, URLs, file paths, JSON, numbers,
 * and for redacting sensitive information from data intended for logging.
 * @module src/utils/security/sanitization
 */
import path from "path";
import sanitizeHtml from "sanitize-html";
import validator from "validator";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { logger, requestContextService } from "../index.js";

/**
 * Defines options for path sanitization to control how file paths are processed and validated.
 */
export interface PathSanitizeOptions {
  /** If provided, restricts sanitized paths to be relative to this directory. */
  rootDir?: string;
  /** If true, normalizes Windows backslashes to POSIX forward slashes. */
  toPosix?: boolean;
  /** If true, absolute paths are permitted (subject to `rootDir`). Default: false. */
  allowAbsolute?: boolean;
}

/**
 * Contains information about a path sanitization operation.
 */
export interface SanitizedPathInfo {
  /** The final sanitized and normalized path string. */
  sanitizedPath: string;
  /** The original path string before any processing. */
  originalInput: string;
  /** True if the input path was absolute after initial normalization. */
  wasAbsolute: boolean;
  /** True if an absolute path was converted to relative due to `allowAbsolute: false`. */
  convertedToRelative: boolean;
  /** The effective options used for sanitization, including defaults. */
  optionsUsed: PathSanitizeOptions;
}

/**
 * Defines options for context-specific string sanitization.
 */
export interface SanitizeStringOptions {
  /** The context in which the string will be used. 'javascript' is disallowed. */
  context?: "text" | "html" | "attribute" | "url" | "javascript";
  /** Custom allowed HTML tags if `context` is 'html'. */
  allowedTags?: string[];
  /** Custom allowed HTML attributes if `context` is 'html'. */
  allowedAttributes?: Record<string, string[]>;
}

/**
 * Configuration options for HTML sanitization, mirroring `sanitize-html` library options.
 */
export interface HtmlSanitizeConfig {
  /** An array of allowed HTML tag names. */
  allowedTags?: string[];
  /** Specifies allowed attributes, either globally or per tag. */
  allowedAttributes?: sanitizeHtml.IOptions["allowedAttributes"];
  /** If true, HTML comments are preserved. */
  preserveComments?: boolean;
  /** Custom functions to transform tags during sanitization. */
  transformTags?: sanitizeHtml.IOptions["transformTags"];
}

/**
 * A singleton class providing various methods for input sanitization.
 * Aims to protect against common vulnerabilities like XSS and path traversal.
 */
export class Sanitization {
  /** @private */
  private static instance: Sanitization;

  /**
   * Default list of field names considered sensitive for log redaction.
   * Case-insensitive matching is applied.
   * @private
   */
  private sensitiveFields: string[] = [
    "password",
    "token",
    "secret",
    "key",
    "apiKey",
    "auth",
    "credential",
    "jwt",
    "ssn",
    "credit",
    "card",
    "cvv",
    "authorization",
  ];

  /**
   * Default configuration for HTML sanitization.
   * @private
   */
  private defaultHtmlSanitizeConfig: HtmlSanitizeConfig = {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "a",
      "ul",
      "ol",
      "li",
      "b",
      "i",
      "strong",
      "em",
      "strike",
      "code",
      "hr",
      "br",
      "div",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "pre",
    ],
    allowedAttributes: {
      a: ["href", "name", "target"],
      img: ["src", "alt", "title", "width", "height"],
      "*": ["class", "id", "style"],
    },
    preserveComments: false,
  };

  /** @private */
  private constructor() {}

  /**
   * Retrieves the singleton instance of the `Sanitization` class.
   * @returns The singleton `Sanitization` instance.
   */
  public static getInstance(): Sanitization {
    if (!Sanitization.instance) {
      Sanitization.instance = new Sanitization();
    }
    return Sanitization.instance;
  }

  /**
   * Sets or extends the list of sensitive field names for log sanitization.
   * @param fields - An array of field names to add to the sensitive list.
   */
  public setSensitiveFields(fields: string[]): void {
    this.sensitiveFields = [
      ...new Set([
        ...this.sensitiveFields,
        ...fields.map((f) => f.toLowerCase()),
      ]),
    ];
    const logContext = requestContextService.createRequestContext({
      operation: "Sanitization.setSensitiveFields",
      newSensitiveFieldCount: this.sensitiveFields.length,
    });
    logger.debug(
      "Updated sensitive fields list for log sanitization",
      logContext,
    );
  }

  /**
   * Gets a copy of the current list of sensitive field names.
   * @returns An array of sensitive field names.
   */
  public getSensitiveFields(): string[] {
    return [...this.sensitiveFields];
  }

  /**
   * Sanitizes an HTML string by removing potentially malicious tags and attributes.
   * @param input - The HTML string to sanitize.
   * @param config - Optional custom configuration for `sanitize-html`.
   * @returns The sanitized HTML string. Returns an empty string if input is falsy.
   */
  public sanitizeHtml(input: string, config?: HtmlSanitizeConfig): string {
    if (!input) return "";
    const effectiveConfig = {
      allowedTags:
        config?.allowedTags ?? this.defaultHtmlSanitizeConfig.allowedTags,
      allowedAttributes:
        config?.allowedAttributes ??
        this.defaultHtmlSanitizeConfig.allowedAttributes,
      transformTags: config?.transformTags, // Can be undefined
      preserveComments:
        config?.preserveComments ??
        this.defaultHtmlSanitizeConfig.preserveComments,
    };

    const options: sanitizeHtml.IOptions = {
      allowedTags: effectiveConfig.allowedTags,
      allowedAttributes: effectiveConfig.allowedAttributes,
      transformTags: effectiveConfig.transformTags,
    };

    if (effectiveConfig.preserveComments) {
      // Ensure allowedTags is an array before spreading
      const baseTags = Array.isArray(options.allowedTags)
        ? options.allowedTags
        : [];
      options.allowedTags = [...baseTags, "!--"];
    }
    return sanitizeHtml(input, options);
  }

  /**
   * Sanitizes a string based on its intended context (e.g., HTML, URL, text).
   * **Important:** `context: 'javascript'` is disallowed due to security risks.
   *
   * @param input - The string to sanitize.
   * @param options - Options specifying the sanitization context.
   * @returns The sanitized string. Returns an empty string if input is falsy.
   * @throws {McpError} If `options.context` is 'javascript', or URL validation fails.
   */
  public sanitizeString(
    input: string,
    options: SanitizeStringOptions = {},
  ): string {
    if (!input) return "";

    const context = options.context ?? "text";

    switch (context) {
      case "html": {
        const config: HtmlSanitizeConfig = {};
        if (options.allowedTags) {
          config.allowedTags = options.allowedTags;
        }
        if (options.allowedAttributes) {
          config.allowedAttributes = this.convertAttributesFormat(
            options.allowedAttributes,
          );
        }
        return this.sanitizeHtml(input, config);
      }
      case "attribute":
        return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} });
      case "url":
        if (
          !validator.isURL(input, {
            protocols: ["http", "https"],
            require_protocol: true,
            require_host: true,
          })
        ) {
          logger.warning(
            "Potentially invalid URL detected during string sanitization (context: url)",
            requestContextService.createRequestContext({
              operation: "Sanitization.sanitizeString.urlWarning",
              invalidUrlAttempt: input,
            }),
          );
          return "";
        }
        return validator.trim(input);
      case "javascript":
        logger.error(
          "Attempted JavaScript sanitization via sanitizeString, which is disallowed.",
          requestContextService.createRequestContext({
            operation: "Sanitization.sanitizeString.jsAttempt",
            inputSnippet: input.substring(0, 50),
          }),
        );
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "JavaScript sanitization is not supported through sanitizeString due to security risks.",
        );
      case "text":
      default:
        return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} });
    }
  }

  /**
   * Converts attribute format for `sanitizeHtml`.
   * @param attrs - Attributes in `{ tagName: ['attr1'] }` format.
   * @returns Attributes in `sanitize-html` expected format.
   * @private
   */
  private convertAttributesFormat(
    attrs: Record<string, string[]>,
  ): sanitizeHtml.IOptions["allowedAttributes"] {
    return attrs;
  }

  /**
   * Sanitizes a URL string by validating its format and protocol.
   * @param input - The URL string to sanitize.
   * @param allowedProtocols - Array of allowed URL protocols. Default: `['http', 'https']`.
   * @returns The sanitized and trimmed URL string.
   * @throws {McpError} If the URL is invalid or uses a disallowed protocol.
   */
  public sanitizeUrl(
    input: string,
    allowedProtocols: string[] = ["http", "https"],
  ): string {
    try {
      const trimmedInput = input.trim();
      if (
        !validator.isURL(trimmedInput, {
          protocols: allowedProtocols,
          require_protocol: true,
          require_host: true,
        })
      ) {
        throw new Error("Invalid URL format or protocol not in allowed list.");
      }
      const lowercasedInput = trimmedInput.toLowerCase();
      if (
        lowercasedInput.startsWith("javascript:") ||
        lowercasedInput.startsWith("data:") ||
        lowercasedInput.startsWith("vbscript:")
      ) {
        throw new Error(
          "Disallowed pseudo-protocol (javascript:, data:, or vbscript:) in URL.",
        );
      }
      return trimmedInput;
    } catch (error) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        error instanceof Error
          ? error.message
          : "Invalid or unsafe URL provided.",
        { input },
      );
    }
  }

  /**
   * Sanitizes a file path to prevent path traversal and normalize format.
   * @param input - The file path string to sanitize.
   * @param options - Options to control sanitization behavior.
   * @returns An object with the sanitized path and sanitization metadata.
   * @throws {McpError} If the path is invalid or unsafe.
   */
  public sanitizePath(
    input: string,
    options: PathSanitizeOptions = {},
  ): SanitizedPathInfo {
    const originalInput = input;
    const effectiveOptions: PathSanitizeOptions = {
      toPosix: options.toPosix ?? false,
      allowAbsolute: options.allowAbsolute ?? false,
      rootDir: options.rootDir ? path.resolve(options.rootDir) : undefined,
    };

    let wasAbsoluteInitially = false;

    try {
      if (!input || typeof input !== "string")
        throw new Error("Invalid path input: must be a non-empty string.");
      if (input.includes("\0"))
        throw new Error("Path contains null byte, which is disallowed.");

      let normalized = path.normalize(input);
      wasAbsoluteInitially = path.isAbsolute(normalized);

      if (effectiveOptions.toPosix) {
        normalized = normalized.replace(/\\/g, "/");
      }

      let finalSanitizedPath: string;

      if (effectiveOptions.rootDir) {
        const fullPath = path.resolve(effectiveOptions.rootDir, normalized);
        if (
          !fullPath.startsWith(effectiveOptions.rootDir + path.sep) &&
          fullPath !== effectiveOptions.rootDir
        ) {
          throw new Error(
            "Path traversal detected: attempts to escape the defined root directory.",
          );
        }
        finalSanitizedPath = path.relative(effectiveOptions.rootDir, fullPath);
        finalSanitizedPath =
          finalSanitizedPath === "" ? "." : finalSanitizedPath;
        if (
          path.isAbsolute(finalSanitizedPath) &&
          !effectiveOptions.allowAbsolute
        ) {
          throw new Error(
            "Path resolved to absolute outside root when absolute paths are disallowed.",
          );
        }
      } else {
        if (path.isAbsolute(normalized)) {
          if (!effectiveOptions.allowAbsolute) {
            throw new Error(
              "Absolute paths are disallowed by current options.",
            );
          } else {
            finalSanitizedPath = normalized;
          }
        } else {
          const resolvedAgainstCwd = path.resolve(normalized);
          const currentWorkingDir = path.resolve(".");
          if (
            !resolvedAgainstCwd.startsWith(currentWorkingDir + path.sep) &&
            resolvedAgainstCwd !== currentWorkingDir
          ) {
            throw new Error(
              "Relative path traversal detected (escapes current working directory context).",
            );
          }
          finalSanitizedPath = normalized;
        }
      }

      return {
        sanitizedPath: finalSanitizedPath,
        originalInput,
        wasAbsolute: wasAbsoluteInitially,
        convertedToRelative:
          wasAbsoluteInitially &&
          !path.isAbsolute(finalSanitizedPath) &&
          !effectiveOptions.allowAbsolute,
        optionsUsed: effectiveOptions,
      };
    } catch (error) {
      logger.warning(
        "Path sanitization error",
        requestContextService.createRequestContext({
          operation: "Sanitization.sanitizePath.error",
          originalPathInput: originalInput,
          pathOptionsUsed: effectiveOptions,
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        error instanceof Error
          ? error.message
          : "Invalid or unsafe path provided.",
        { input: originalInput },
      );
    }
  }

  /**
   * Sanitizes a JSON string by parsing it to validate its format.
   * Optionally checks if the JSON string exceeds a maximum allowed size.
   * @template T The expected type of the parsed JSON object. Defaults to `unknown`.
   * @param input - The JSON string to sanitize/validate.
   * @param maxSize - Optional maximum allowed size of the JSON string in bytes.
   * @returns The parsed JavaScript object.
   * @throws {McpError} If input is not a string, too large, or invalid JSON.
   */
  public sanitizeJson<T = unknown>(input: string, maxSize?: number): T {
    try {
      if (typeof input !== "string")
        throw new Error("Invalid input: expected a JSON string.");
      if (maxSize !== undefined && Buffer.byteLength(input, "utf8") > maxSize) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          `JSON string exceeds maximum allowed size of ${maxSize} bytes.`,
          { actualSize: Buffer.byteLength(input, "utf8"), maxSize },
        );
      }
      return JSON.parse(input) as T;
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        error instanceof Error ? error.message : "Invalid JSON format.",
        {
          inputPreview:
            input.length > 100 ? `${input.substring(0, 100)}...` : input,
        },
      );
    }
  }

  /**
   * Validates and sanitizes a numeric input, converting strings to numbers.
   * Clamps the number to `min`/`max` if provided.
   * @param input - The number or string to validate and sanitize.
   * @param min - Minimum allowed value (inclusive).
   * @param max - Maximum allowed value (inclusive).
   * @returns The sanitized (and potentially clamped) number.
   * @throws {McpError} If input is not a valid number, NaN, or Infinity.
   */
  public sanitizeNumber(
    input: number | string,
    min?: number,
    max?: number,
  ): number {
    let value: number;
    if (typeof input === "string") {
      const trimmedInput = input.trim();
      if (trimmedInput === "" || !validator.isNumeric(trimmedInput)) {
        throw new McpError(
          BaseErrorCode.VALIDATION_ERROR,
          "Invalid number format: input is empty or not numeric.",
          { input },
        );
      }
      value = parseFloat(trimmedInput);
    } else if (typeof input === "number") {
      value = input;
    } else {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Invalid input type: expected number or string.",
        { input: String(input) },
      );
    }

    if (isNaN(value) || !isFinite(value)) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "Invalid number value (NaN or Infinity).",
        { input },
      );
    }

    let clamped = false;
    const originalValueForLog = value;
    if (min !== undefined && value < min) {
      value = min;
      clamped = true;
    }
    if (max !== undefined && value > max) {
      value = max;
      clamped = true;
    }
    if (clamped) {
      logger.debug(
        "Number clamped to range.",
        requestContextService.createRequestContext({
          operation: "Sanitization.sanitizeNumber.clamped",
          originalInput: String(input),
          parsedValue: originalValueForLog,
          minValue: min,
          maxValue: max,
          clampedValue: value,
        }),
      );
    }
    return value;
  }

  /**
   * Sanitizes a string to be a valid Obsidian tag.
   * - Removes leading/trailing whitespace.
   * - Replaces spaces and invalid characters with underscores.
   * - Removes leading '#' if present.
   * @param input - The string to sanitize.
   * @returns The sanitized tag string.
   */
  public sanitizeTagName(input: string): string {
    if (!input) return "";
    return input
      .trim()
      .replace(/^#+/, "") // Remove leading hashes
      .replace(/\s+/g, "_") // Replace spaces with underscores
      .replace(/[^\w/-]/g, ""); // Remove invalid characters except word chars, '/', and '-'
  }

  /**
   * Sanitizes input for logging by redacting sensitive fields.
   * Creates a deep clone and replaces values of fields matching `this.sensitiveFields`
   * (case-insensitive substring match) with "[REDACTED]".
   *
   * It uses `structuredClone` if available for a high-fidelity deep clone.
   * If `structuredClone` is not available (e.g., in older Node.js environments),
   * it falls back to `JSON.parse(JSON.stringify(input))`. This fallback has limitations:
   * - `Date` objects are converted to ISO date strings.
   * - `undefined` values within objects are removed.
   * - `Map`, `Set`, `RegExp` objects are converted to empty objects (`{}`).
   * - Functions are removed.
   * - `BigInt` values will throw an error during `JSON.stringify` unless a `toJSON` method is provided.
   * - Circular references will cause `JSON.stringify` to throw an error.
   *
   * @param input - The input data to sanitize for logging.
   * @returns A sanitized (deep cloned) version of the input, safe for logging.
   *   Returns original input if not object/array, or "[Log Sanitization Failed]" on error.
   */
  public sanitizeForLogging(input: unknown): unknown {
    try {
      if (!input || typeof input !== "object") return input;

      const clonedInput =
        typeof globalThis.structuredClone === "function"
          ? globalThis.structuredClone(input)
          : JSON.parse(JSON.stringify(input));
      this.redactSensitiveFields(clonedInput);
      return clonedInput;
    } catch (error) {
      logger.error(
        "Error during log sanitization, returning placeholder.",
        requestContextService.createRequestContext({
          operation: "Sanitization.sanitizeForLogging.error",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      );
      return "[Log Sanitization Failed]";
    }
  }

  /**
   * Recursively redacts sensitive fields in an object or array in place.
   * @param obj - The object or array to redact.
   * @private
   */
  private redactSensitiveFields(obj: unknown): void {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      obj.forEach((item) => this.redactSensitiveFields(item));
      return;
    }

    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = (obj as Record<string, unknown>)[key];

        // Split camelCase and snake_case/kebab-case keys into words
        const keyWords = key
          .replace(/([A-Z])/g, " $1") // Add space before uppercase letters
          .toLowerCase()
          .split(/[\s_-]+/); // Split by space, underscore, or hyphen

        const isSensitive = keyWords.some((word) =>
          this.sensitiveFields.includes(word),
        );

        if (isSensitive) {
          (obj as Record<string, unknown>)[key] = "[REDACTED]";
        } else if (value && typeof value === "object") {
          this.redactSensitiveFields(value);
        }
      }
    }
  }
}

/**
 * Singleton instance of the `Sanitization` class.
 * Use this for all input sanitization tasks.
 */
export const sanitization = Sanitization.getInstance();

/**
 * Convenience function calling `sanitization.sanitizeForLogging`.
 * @param input - The input data to sanitize.
 * @returns A sanitized version of the input, safe for logging.
 */
export const sanitizeInputForLogging = (input: unknown): unknown =>
  sanitization.sanitizeForLogging(input);

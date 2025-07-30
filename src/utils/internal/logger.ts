/**
 * @fileoverview Provides a singleton Logger class that wraps Winston for file logging
 * and supports sending MCP (Model Context Protocol) `notifications/message`.
 * It handles different log levels compliant with RFC 5424 and MCP specifications.
 * @module src/utils/internal/logger
 */
import path from "path";
import winston from "winston";
import TransportStream from "winston-transport";
import { config } from "../../config/index.js";
import { RequestContext } from "./requestContext.js";

/**
 * Defines the supported logging levels based on RFC 5424 Syslog severity levels,
 * as used by the Model Context Protocol (MCP).
 * Levels are: 'debug'(7), 'info'(6), 'notice'(5), 'warning'(4), 'error'(3), 'crit'(2), 'alert'(1), 'emerg'(0).
 * Lower numeric values indicate higher severity.
 */
export type McpLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "crit"
  | "alert"
  | "emerg";

/**
 * Numeric severity mapping for MCP log levels (lower is more severe).
 * @private
 */
const mcpLevelSeverity: Record<McpLogLevel, number> = {
  emerg: 0,
  alert: 1,
  crit: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
};

/**
 * Maps MCP log levels to Winston's core levels for file logging.
 * @private
 */
const mcpToWinstonLevel: Record<
  McpLogLevel,
  "debug" | "info" | "warn" | "error"
> = {
  debug: "debug",
  info: "info",
  notice: "info",
  warning: "warn",
  error: "error",
  crit: "error",
  alert: "error",
  emerg: "error",
};

/**
 * Interface for a more structured error object, primarily for formatting console logs.
 * @private
 */
interface ErrorWithMessageAndStack {
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

/**
 * Interface for the payload of an MCP log notification.
 * This structure is used when sending log data via MCP `notifications/message`.
 */
export interface McpLogPayload {
  message: string;
  context?: RequestContext;
  error?: {
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

/**
 * Type for the `data` parameter of the `McpNotificationSender` function.
 */
export type McpNotificationData = McpLogPayload | Record<string, unknown>;

/**
 * Defines the signature for a function that can send MCP log notifications.
 * This function is typically provided by the MCP server instance.
 * @param level - The severity level of the log message.
 * @param data - The payload of the log notification.
 * @param loggerName - An optional name or identifier for the logger/server.
 */
export type McpNotificationSender = (
  level: McpLogLevel,
  data: McpNotificationData,
  loggerName?: string,
) => void;

// The logsPath from config is resolved and validated by src/config/index.ts.
// It can be null if the directory is invalid or inaccessible, in which case file logging will be disabled.

/**
 * Creates the Winston console log format.
 * @returns The Winston log format for console output.
 * @private
 */
function createWinstonConsoleFormat(): winston.Logform.Format {
  return winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let metaString = "";
      const metaCopy = { ...meta };
      if (metaCopy.error && typeof metaCopy.error === "object") {
        const errorObj = metaCopy.error as ErrorWithMessageAndStack;
        if (errorObj.message) metaString += `\n  Error: ${errorObj.message}`;
        if (errorObj.stack)
          metaString += `\n  Stack: ${String(errorObj.stack)
            .split("\n")
            .map((l: string) => `    ${l}`)
            .join("\n")}`;
        delete metaCopy.error;
      }
      if (Object.keys(metaCopy).length > 0) {
        try {
          const replacer = (_key: string, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value;
          const remainingMetaJson = JSON.stringify(metaCopy, replacer, 2);
          if (remainingMetaJson !== "{}")
            metaString += `\n  Meta: ${remainingMetaJson}`;
        } catch (stringifyError: unknown) {
          const errorMessage =
            stringifyError instanceof Error
              ? stringifyError.message
              : String(stringifyError);
          metaString += `\n  Meta: [Error stringifying metadata: ${errorMessage}]`;
        }
      }
      return `${timestamp} ${level}: ${message}${metaString}`;
    }),
  );
}

/**
 * Singleton Logger class that wraps Winston for robust logging.
 * Supports file logging, conditional console logging, and MCP notifications.
 */
export class Logger {
  private static instance: Logger;
  private winstonLogger?: winston.Logger;
  private interactionLogger?: winston.Logger;
  private initialized = false;
  private mcpNotificationSender?: McpNotificationSender;
  private currentMcpLevel: McpLogLevel = "info";
  private currentWinstonLevel: "debug" | "info" | "warn" | "error" = "info";

  private readonly MCP_NOTIFICATION_STACK_TRACE_MAX_LENGTH = 1024;
  private readonly LOG_FILE_MAX_SIZE = 5 * 1024 * 1024; // 5MB
  private readonly LOG_MAX_FILES = 5;

  /** @private */
  private constructor() {}

  /**
   * Initializes the Winston logger instance.
   * Should be called once at application startup.
   * @param level - The initial minimum MCP log level.
   */
  public async initialize(level: McpLogLevel = "info"): Promise<void> {
    if (this.initialized) {
      this.warning("Logger already initialized.", {
        loggerSetup: true,
        requestId: "logger-init",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Set initialized to true at the beginning of the initialization process.
    this.initialized = true;

    this.currentMcpLevel = level;
    this.currentWinstonLevel = mcpToWinstonLevel[level];

    const resolvedLogsDir = config.logsPath;

    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    );

    const transports: TransportStream[] = [];
    const fileTransportOptions = {
      format: fileFormat,
      maxsize: this.LOG_FILE_MAX_SIZE,
      maxFiles: this.LOG_MAX_FILES,
      tailable: true,
    };

    if (resolvedLogsDir) {
      transports.push(
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "error.log"),
          level: "error",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "warn.log"),
          level: "warn",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "info.log"),
          level: "info",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "debug.log"),
          level: "debug",
          ...fileTransportOptions,
        }),
        new winston.transports.File({
          filename: path.join(resolvedLogsDir, "combined.log"),
          ...fileTransportOptions,
        }),
      );
    } else {
      if (process.stdout.isTTY) {
        console.warn(
          "File logging disabled as logsPath is not configured or invalid.",
        );
      }
    }

    this.winstonLogger = winston.createLogger({
      level: this.currentWinstonLevel,
      transports,
      exitOnError: false,
    });

    // Initialize a separate logger for structured interactions
    if (resolvedLogsDir) {
      this.interactionLogger = winston.createLogger({
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json({ space: 2 }),
        ),
        transports: [
          new winston.transports.File({
            filename: path.join(resolvedLogsDir, "interactions.log"),
            ...fileTransportOptions,
          }),
        ],
      });
    }

    // Configure console transport after Winston logger is created
    const consoleStatus = this._configureConsoleTransport();

    const initialContext: RequestContext = {
      loggerSetup: true,
      requestId: "logger-init-deferred",
      timestamp: new Date().toISOString(),
    };
    // Removed logging of logsDirCreatedMessage as it's no longer set
    if (consoleStatus.message) {
      this.info(consoleStatus.message, initialContext);
    }

    this.initialized = true; // Ensure this is set after successful setup
    this.info(
      `Logger initialized. File logging level: ${this.currentWinstonLevel}. MCP logging level: ${this.currentMcpLevel}. Console logging: ${consoleStatus.enabled ? "enabled" : "disabled"}`,
      {
        loggerSetup: true,
        requestId: "logger-post-init",
        timestamp: new Date().toISOString(),
        logsPathUsed: resolvedLogsDir ?? "none",
      },
    );
  }

  /**
   * Sets the function used to send MCP 'notifications/message'.
   * @param sender - The function to call for sending notifications, or undefined to disable.
   */
  public setMcpNotificationSender(
    sender: McpNotificationSender | undefined,
  ): void {
    this.mcpNotificationSender = sender;
    const status = sender ? "enabled" : "disabled";
    this.info(`MCP notification sending ${status}.`, {
      loggerSetup: true,
      requestId: "logger-set-sender",
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Dynamically sets the minimum logging level.
   * @param newLevel - The new minimum MCP log level to set.
   */
  public setLevel(newLevel: McpLogLevel): void {
    const setLevelContext: RequestContext = {
      loggerSetup: true,
      requestId: "logger-set-level",
      timestamp: new Date().toISOString(),
    };
    if (!this.ensureInitialized()) {
      if (process.stdout.isTTY) {
        console.error("Cannot set level: Logger not initialized.");
      }
      return;
    }
    if (!(newLevel in mcpLevelSeverity)) {
      this.warning(
        `Invalid MCP log level provided: ${newLevel}. Level not changed.`,
        setLevelContext,
      );
      return;
    }

    const oldLevel = this.currentMcpLevel;
    this.currentMcpLevel = newLevel;
    this.currentWinstonLevel = mcpToWinstonLevel[newLevel];
    if (this.winstonLogger) {
      // Ensure winstonLogger is defined
      this.winstonLogger.level = this.currentWinstonLevel;
    }

    const consoleStatus = this._configureConsoleTransport();

    if (oldLevel !== newLevel) {
      this.info(
        `Log level changed. File logging level: ${this.currentWinstonLevel}. MCP logging level: ${this.currentMcpLevel}. Console logging: ${consoleStatus.enabled ? "enabled" : "disabled"}`,
        setLevelContext,
      );
      if (
        consoleStatus.message &&
        consoleStatus.message !== "Console logging status unchanged."
      ) {
        this.info(consoleStatus.message, setLevelContext);
      }
    }
  }

  /**
   * Configures the console transport based on the current log level and TTY status.
   * Adds or removes the console transport as needed.
   * @returns {{ enabled: boolean, message: string | null }} Status of console logging.
   * @private
   */
  private _configureConsoleTransport(): {
    enabled: boolean;
    message: string | null;
  } {
    if (!this.winstonLogger) {
      return {
        enabled: false,
        message: "Cannot configure console: Winston logger not initialized.",
      };
    }

    const consoleTransport = this.winstonLogger.transports.find(
      (t) => t instanceof winston.transports.Console,
    );
    const shouldHaveConsole =
      this.currentMcpLevel === "debug" && process.stdout.isTTY;
    let message: string | null = null;

    if (shouldHaveConsole && !consoleTransport) {
      const consoleFormat = createWinstonConsoleFormat();
      this.winstonLogger.add(
        new winston.transports.Console({
          level: "debug", // Console always logs debug if enabled
          format: consoleFormat,
        }),
      );
      message = "Console logging enabled (level: debug, stdout is TTY).";
    } else if (!shouldHaveConsole && consoleTransport) {
      this.winstonLogger.remove(consoleTransport);
      message = "Console logging disabled (level not debug or stdout not TTY).";
    } else {
      message = "Console logging status unchanged.";
    }
    return { enabled: shouldHaveConsole, message };
  }

  /**
   * Gets the singleton instance of the Logger.
   * @returns The singleton Logger instance.
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Resets the singleton instance.
   * This is intended for use in testing environments only.
   */
  public static resetForTesting(): void {
    // This is a clear indication that this method is for testing purposes.
    if (process.env.NODE_ENV !== "test") {
      console.warn(
        "Warning: `resetForTesting` should only be called in a test environment.",
      );
      return;
    }
    // De-reference the instance to allow garbage collection
    // and force re-creation on next getInstance() call.
    (Logger.instance as unknown) = undefined;
  }

  /**
   * Ensures the logger has been initialized.
   * @returns True if initialized, false otherwise.
   * @private
   */
  private ensureInitialized(): boolean {
    if (!this.initialized || !this.winstonLogger) {
      if (process.stdout.isTTY) {
        console.warn("Logger not initialized; message dropped.");
      }
      return false;
    }
    return true;
  }

  /**
   * Centralized log processing method.
   * @param level - The MCP severity level of the message.
   * @param msg - The main log message.
   * @param context - Optional request context for the log.
   * @param error - Optional error object associated with the log.
   * @private
   */
  private log(
    level: McpLogLevel,
    msg: string,
    context?: RequestContext,
    error?: Error,
  ): void {
    if (!this.ensureInitialized()) return;
    if (mcpLevelSeverity[level] > mcpLevelSeverity[this.currentMcpLevel]) {
      return; // Do not log if message level is less severe than currentMcpLevel
    }

    const logData: Record<string, unknown> = { ...context };
    const winstonLevel = mcpToWinstonLevel[level];

    if (error) {
      this.winstonLogger!.log(winstonLevel, msg, { ...logData, error });
    } else {
      this.winstonLogger!.log(winstonLevel, msg, logData);
    }

    if (this.mcpNotificationSender) {
      const mcpDataPayload: McpLogPayload = { message: msg };
      if (context && Object.keys(context).length > 0)
        mcpDataPayload.context = context;
      if (error) {
        mcpDataPayload.error = { message: error.message };
        // Include stack trace in debug mode for MCP notifications, truncated for brevity
        if (this.currentMcpLevel === "debug" && error.stack) {
          mcpDataPayload.error.stack = error.stack.substring(
            0,
            this.MCP_NOTIFICATION_STACK_TRACE_MAX_LENGTH,
          );
        }
      }
      try {
        const serverName =
          config?.mcpServerName ?? "MCP_SERVER_NAME_NOT_CONFIGURED";
        this.mcpNotificationSender(level, mcpDataPayload, serverName);
      } catch (sendError: unknown) {
        const errorMessage =
          sendError instanceof Error ? sendError.message : String(sendError);
        const internalErrorContext: RequestContext = {
          requestId: context?.requestId || "logger-internal-error",
          timestamp: new Date().toISOString(),
          originalLevel: level,
          originalMessage: msg,
          sendError: errorMessage,
          mcpPayload: JSON.stringify(mcpDataPayload).substring(0, 500), // Log a preview
        };
        this.winstonLogger!.error(
          "Failed to send MCP log notification",
          internalErrorContext,
        );
      }
    }
  }

  /** Logs a message at the 'debug' level. */
  public debug(msg: string, context?: RequestContext): void {
    this.log("debug", msg, context);
  }

  /** Logs a message at the 'info' level. */
  public info(msg: string, context?: RequestContext): void {
    this.log("info", msg, context);
  }

  /** Logs a message at the 'notice' level. */
  public notice(msg: string, context?: RequestContext): void {
    this.log("notice", msg, context);
  }

  /** Logs a message at the 'warning' level. */
  public warning(msg: string, context?: RequestContext): void {
    this.log("warning", msg, context);
  }

  /**
   * Logs a message at the 'error' level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public error(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = err instanceof Error ? err : undefined;
    const actualContext = err instanceof Error ? context : err;
    this.log("error", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'crit' (critical) level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public crit(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = err instanceof Error ? err : undefined;
    const actualContext = err instanceof Error ? context : err;
    this.log("crit", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'alert' level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public alert(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = err instanceof Error ? err : undefined;
    const actualContext = err instanceof Error ? context : err;
    this.log("alert", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'emerg' (emergency) level.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public emerg(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = err instanceof Error ? err : undefined;
    const actualContext = err instanceof Error ? context : err;
    this.log("emerg", msg, actualContext, errorObj);
  }

  /**
   * Logs a message at the 'emerg' (emergency) level, typically for fatal errors.
   * @param msg - The main log message.
   * @param err - Optional. Error object or RequestContext.
   * @param context - Optional. RequestContext if `err` is an Error.
   */
  public fatal(
    msg: string,
    err?: Error | RequestContext,
    context?: RequestContext,
  ): void {
    const errorObj = err instanceof Error ? err : undefined;
    const actualContext = err instanceof Error ? context : err;
    this.log("emerg", msg, actualContext, errorObj);
  }

  /**
   * Logs a structured interaction object to a dedicated file.
   * @param interactionName - A name for the interaction type (e.g., 'OpenRouterIO').
   * @param data - The structured data to log.
   */
  public logInteraction(
    interactionName: string,
    data: Record<string, unknown>,
  ): void {
    if (!this.interactionLogger) {
      this.warning(
        "Interaction logger not available. File logging may be disabled.",
        data.context as RequestContext,
      );
      return;
    }
    this.interactionLogger.info({ interactionName, ...data });
  }
}

/**
 * The singleton instance of the Logger.
 * Use this instance for all logging operations.
 */
export const logger = Logger.getInstance();

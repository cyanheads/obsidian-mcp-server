/**
 * @module ObsidianRestApiService
 * @description
 * This module provides the core implementation for the Obsidian REST API service.
 * It encapsulates the logic for making authenticated requests to the API endpoints.
 */

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import https from "node:https"; // Import the https module for Agent configuration
import { config } from "../../config/index.js";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../utils/index.js"; // Added requestContextService
import { PermissionsService } from "../permissions/service.js";
import * as activeFileMethods from "./methods/activeFileMethods.js";
import * as commandMethods from "./methods/commandMethods.js";
import * as openMethods from "./methods/openMethods.js";
import * as patchMethods from "./methods/patchMethods.js";
import * as periodicNoteMethods from "./methods/periodicNoteMethods.js";
import * as searchMethods from "./methods/searchMethods.js";
import * as vaultMethods from "./methods/vaultMethods.js";
import {
  ApiStatusResponse, // Import PatchOptions type
  ComplexSearchResult,
  NoteJson,
  NoteStat,
  ObsidianCommand,
  PatchOptions,
  Period,
  Permission,
  SimpleSearchResult,
} from "./types.js"; // Import types from the new file

export class ObsidianRestApiService {
  private axiosInstance: AxiosInstance;
  private apiKey: string;
  private permissionsService: PermissionsService;

  constructor(
    // Injected for testability and adherence to Dependency Inversion Principle
    permissionsService: PermissionsService,
  ) {
    this.apiKey = config.obsidianApiKey; // Get from central config
    this.permissionsService = permissionsService;

    if (!this.apiKey) {
      // Config validation should prevent this, but double-check
      throw new McpError(
        BaseErrorCode.CONFIGURATION_ERROR,
        "Obsidian API Key is missing in configuration.",
        {},
      );
    }

    const httpsAgent = new https.Agent({
      rejectUnauthorized: config.obsidianVerifySsl,
    });

    this.axiosInstance = axios.create({
      baseURL: config.obsidianBaseUrl.replace(/\/$/, ""), // Remove trailing slash
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json", // Default accept type
      },
      timeout: 60000, // Increased timeout to 60 seconds (was 15000)
      httpsAgent,
    });

    logger.info(
      `ObsidianRestApiService initialized with base URL: ${this.axiosInstance.defaults.baseURL}, Verify SSL: ${config.obsidianVerifySsl}`,
      requestContextService.createRequestContext({
        operation: "ObsidianServiceInit",
      }),
    );
  }

  /**
   * Private helper to make requests and handle common errors.
   * @param config - Axios request configuration.
   * @param context - Request context for logging.
   * @param operationName - Name of the operation for logging context.
   * @param throwOnError - If false, returns an McpError instead of throwing.
   * @returns The response data or an McpError if throwOnError is false.
   */
  private async _request<T = any>(
    requestConfig: AxiosRequestConfig,
    context: RequestContext,
    operationName: string,
    throwOnError = true,
  ): Promise<T | McpError> {
    const operationContext = {
      ...context,
      operation: `ObsidianAPI_${operationName}`,
    };
    logger.debug(
      `Making Obsidian API request: ${requestConfig.method} ${requestConfig.url}`,
      operationContext,
    );

    return await ErrorHandler.tryCatch(
      async () => {
        try {
          const response = await this.axiosInstance.request<T>(requestConfig);
          logger.debug(
            `Obsidian API request successful: ${requestConfig.method} ${requestConfig.url}`,
            { ...operationContext, status: response.status },
          );
          if (requestConfig.method === "HEAD") {
            return response as T;
          }
          return response.data;
        } catch (error) {
          const axiosError = error as AxiosError;
          let errorCode = BaseErrorCode.INTERNAL_ERROR;
          let errorMessage = `Obsidian API request failed: ${axiosError.message}`;
          const errorDetails: Record<string, any> = {
            requestUrl: requestConfig.url,
            requestMethod: requestConfig.method,
            responseStatus: axiosError.response?.status,
            responseData: axiosError.response?.data,
          };

          if (axiosError.response) {
            switch (axiosError.response.status) {
              case 400:
                errorCode = BaseErrorCode.VALIDATION_ERROR;
                errorMessage = `Obsidian API Bad Request: ${JSON.stringify(axiosError.response.data)}`;
                break;
              case 401:
                errorCode = BaseErrorCode.UNAUTHORIZED;
                errorMessage = "Obsidian API Unauthorized: Invalid API Key.";
                break;
              case 403:
                errorCode = BaseErrorCode.FORBIDDEN;
                errorMessage = "Obsidian API Forbidden: Check permissions.";
                break;
              case 404:
                errorCode = BaseErrorCode.NOT_FOUND;
                errorMessage = `Obsidian API Not Found: ${requestConfig.url}`;
                break;
              case 405:
                errorCode = BaseErrorCode.VALIDATION_ERROR;
                errorMessage = `Obsidian API Method Not Allowed: ${requestConfig.method} on ${requestConfig.url}`;
                break;
              case 503:
                errorCode = BaseErrorCode.SERVICE_UNAVAILABLE;
                errorMessage = "Obsidian API Service Unavailable.";
                break;
            }
          } else if (axiosError.request) {
            errorCode = BaseErrorCode.SERVICE_UNAVAILABLE;
            errorMessage = `Obsidian API Network Error: No response received from ${requestConfig.url}. This may be due to Obsidian not running, the Local REST API plugin being disabled, or a network issue.`;
          }

          const mcpError = new McpError(
            errorCode,
            errorMessage,
            operationContext,
          );

          if (throwOnError) {
            logger.error(errorMessage, {
              ...operationContext,
              ...errorDetails,
            });
            throw mcpError;
          } else {
            logger.debug(
              `Obsidian API request failed but not throwing: ${errorMessage}`,
              {
                ...operationContext,
                ...errorDetails,
              },
            );
            return mcpError;
          }
        }
      },
      {
        operation: `ObsidianAPI_${operationName}_Wrapper`,
        context: context,
        input: requestConfig,
        errorCode: BaseErrorCode.INTERNAL_ERROR,
      },
    );
  }

  // --- API Methods ---

  async checkStatus(context: RequestContext): Promise<ApiStatusResponse> {
    return this._request<ApiStatusResponse>(
      {
        method: "GET",
        url: "/",
      },
      context,
      "checkStatus",
    ) as Promise<ApiStatusResponse>;
  }

  // --- Vault Methods ---

  async getFileContent(
    filePath: string,
    format: "markdown" | "json" = "markdown",
    context: RequestContext,
  ): Promise<string | NoteJson> {
    if (!this.permissionsService.isAllowed(filePath, "read", context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Read access denied for path: ${filePath}`,
        context,
      );
    }
    return vaultMethods.getFileContent(
      this._request.bind(this),
      filePath,
      format,
      context,
    );
  }

  async updateFileContent(
    filePath: string,
    content: string,
    context: RequestContext,
  ): Promise<void> {
    const fileExists = (await this.getFileMetadata(filePath, context)) !== null;
    const requiredPermission = fileExists ? "write" : "create";

    if (!this.permissionsService.isAllowed(filePath, requiredPermission, context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `${requiredPermission.charAt(0).toUpperCase() + requiredPermission.slice(1)} access denied for path: ${filePath}`,
        context,
      );
    }

    return vaultMethods.updateFileContent(
      this._request.bind(this),
      filePath,
      content,
      context,
    );
  }

  async appendFileContent(
    filePath: string,
    content: string,
    context: RequestContext,
  ): Promise<void> {
    const fileExists = (await this.getFileMetadata(filePath, context)) !== null;
    const requiredPermission = fileExists ? "write" : "create";

    if (!this.permissionsService.isAllowed(filePath, requiredPermission, context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `${requiredPermission.charAt(0).toUpperCase() + requiredPermission.slice(1)} access denied for path: ${filePath}`,
        context,
      );
    }

    return vaultMethods.appendFileContent(
      this._request.bind(this),
      filePath,
      content,
      context,
    );
  }

  async deleteFile(filePath: string, context: RequestContext): Promise<void> {
    if (!this.permissionsService.isAllowed(filePath, "delete", context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Delete access denied for path: ${filePath}`,
        context,
      );
    }
    return vaultMethods.deleteFile(this._request.bind(this), filePath, context);
  }

  async listFiles(dirPath: string, context: RequestContext): Promise<string[]> {
    if (!this.permissionsService.isAllowed(dirPath, "read", context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Read access denied for path: ${dirPath}`,
        context,
      );
    }
    return vaultMethods.listFiles(this._request.bind(this), dirPath, context);
  }

  async getFileMetadata(
    filePath: string,
    context: RequestContext,
  ): Promise<NoteStat | null> {
    if (!this.permissionsService.isAllowed(filePath, "read", context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Read access denied for path: ${filePath}`,
        context,
      );
    }

    const requestFn = <T = any>(
      config: AxiosRequestConfig,
      ctx: RequestContext,
      opName: string,
      throwErr = true,
    ) => this._request<T>(config, ctx, opName, throwErr);

    const result = await vaultMethods.getFileMetadata(
      requestFn,
      filePath,
      context,
    );

    if (result instanceof McpError) {
      if (result.code === BaseErrorCode.NOT_FOUND) {
        return null; // Explicitly return null only for 404 errors
      }
      throw result; // Re-throw other errors
    }
    return result;
  }

  // --- Search Methods ---

  async searchSimple(
    query: string,
    contextLength: number = 100,
    context: RequestContext,
  ): Promise<SimpleSearchResult[]> {
    const results = await searchMethods.searchSimple(
      this._request.bind(this),
      query,
      contextLength,
      context,
    );
    return results.filter((result) =>
      this.permissionsService.isAllowed(result.filePath, "read", context),
    );
  }

  async searchComplex(
    query: string | object,
    contentType:
      | "application/vnd.olrapi.dataview.dql+txt"
      | "application/vnd.olrapi.jsonlogic+json",
    context: RequestContext,
  ): Promise<ComplexSearchResult[]> {
    const results = await searchMethods.searchComplex(
      this._request.bind(this),
      query,
      contentType,
      context,
    );
    return results.filter((result) =>
      this.permissionsService.isAllowed(result.filePath, "read", context),
    );
  }

  // --- Command Methods ---

  async executeCommand(
    commandId: string,
    context: RequestContext,
  ): Promise<void> {
    return commandMethods.executeCommand(
      this._request.bind(this),
      commandId,
      context,
    );
  }

  async listCommands(context: RequestContext): Promise<ObsidianCommand[]> {
    return commandMethods.listCommands(this._request.bind(this), context);
  }

  // --- Open Methods ---

  async openFile(
    filePath: string,
    newLeaf: boolean = false,
    context: RequestContext,
  ): Promise<void> {
    if (
      !this.permissionsService.isAllowed(filePath, "read", context) &&
      !this.permissionsService.isAllowed(filePath, "create", context)
    ) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Open access denied for path: ${filePath}`,
        context,
      );
    }
    return openMethods.openFile(
      this._request.bind(this),
      filePath,
      newLeaf,
      context,
    );
  }

  // --- Active File Methods ---

  async getActiveFile(
    format: "markdown" | "json" = "markdown",
    context: RequestContext,
  ): Promise<string | NoteJson> {
    const note = await this._getVerifiedActiveNote("read", context);
    return format === "markdown" ? note.content : note;
  }

  async updateActiveFile(
    content: string,
    context: RequestContext,
  ): Promise<void> {
    const note = await this._getVerifiedActiveNote("write", context);
    if (!this.permissionsService.isAllowed(note.path, "create", context)) {
      if (!this.permissionsService.isAllowed(note.path, "write", context)) {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          `Write access denied for active file: ${note.path}`,
          context,
        );
      }
    }
    return activeFileMethods.updateActiveFile(
      this._request.bind(this),
      content,
      context,
    );
  }

  async appendActiveFile(
    content: string,
    context: RequestContext,
  ): Promise<void> {
    const note = await this._getVerifiedActiveNote("write", context);
    if (!this.permissionsService.isAllowed(note.path, "create", context)) {
      if (!this.permissionsService.isAllowed(note.path, "write", context)) {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          `Write access denied for active file: ${note.path}`,
          context,
        );
      }
    }
    return activeFileMethods.appendActiveFile(
      this._request.bind(this),
      content,
      context,
    );
  }

  async deleteActiveFile(context: RequestContext): Promise<void> {
    const note = await this._getVerifiedActiveNote("delete", context);
    return activeFileMethods.deleteActiveFile(
      this._request.bind(this),
      context,
    );
  }

  // --- Periodic Notes Methods ---

  async getPeriodicNote(
    period: Period,
    format: "markdown" | "json" = "markdown",
    context: RequestContext,
  ): Promise<string | NoteJson> {
    const note = await this._getVerifiedPeriodicNote(period, "read", context);
    return format === "markdown" ? note.content : note;
  }

  async updatePeriodicNote(
    period: Period,
    content: string,
    context: RequestContext,
  ): Promise<void> {
    const note = await this._getVerifiedPeriodicNote(period, "write", context);
    if (!this.permissionsService.isAllowed(note.path, "create", context)) {
      if (!this.permissionsService.isAllowed(note.path, "write", context)) {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          `Write access denied for periodic note: ${note.path}`,
          context,
        );
      }
    }
    return periodicNoteMethods.updatePeriodicNote(
      this._request.bind(this),
      period,
      content,
      context,
    );
  }

  async appendPeriodicNote(
    period: Period,
    content: string,
    context: RequestContext,
  ): Promise<void> {
    const note = await this._getVerifiedPeriodicNote(period, "write", context);
    if (!this.permissionsService.isAllowed(note.path, "create", context)) {
      if (!this.permissionsService.isAllowed(note.path, "write", context)) {
        throw new McpError(
          BaseErrorCode.FORBIDDEN,
          `Write access denied for periodic note: ${note.path}`,
          context,
        );
      }
    }
    return periodicNoteMethods.appendPeriodicNote(
      this._request.bind(this),
      period,
      content,
      context,
    );
  }

  async deletePeriodicNote(
    period: Period,
    context: RequestContext,
  ): Promise<void> {
    const note = await this._getVerifiedPeriodicNote(period, "delete", context);
    return periodicNoteMethods.deletePeriodicNote(
      this._request.bind(this),
      period,
      context,
    );
  }

  // --- Patch Methods ---

  async patchFile(
    filePath: string,
    content: string | object,
    options: PatchOptions,
    context: RequestContext,
  ): Promise<void> {
    if (!this.permissionsService.isAllowed(filePath, "write", context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Write access denied for path: ${filePath}`,
        context,
      );
    }
    return patchMethods.patchFile(
      this._request.bind(this),
      filePath,
      content,
      options,
      context,
    );
  }

  async patchActiveFile(
    content: string | object,
    options: PatchOptions,
    context: RequestContext,
  ): Promise<void> {
    const note = await this._getVerifiedActiveNote("write", context);
    return patchMethods.patchActiveFile(
      this._request.bind(this),
      content,
      options,
      context,
    );
  }

  async patchPeriodicNote(
    period: Period,
    content: string | object,
    options: PatchOptions,
    context: RequestContext,
  ): Promise<void> {
    const note = await this._getVerifiedPeriodicNote(period, "write", context);
    return patchMethods.patchPeriodicNote(
      this._request.bind(this),
      period,
      content,
      options,
      context,
    );
  }

  // --- Private Helper Methods for Permission Checking ---

  private async _getVerifiedActiveNote(
    permission: Permission,
    context: RequestContext,
  ): Promise<NoteJson> {
    const note = (await activeFileMethods.getActiveFile(
      this._request.bind(this),
      "json",
      context,
    )) as NoteJson;

    if (!this.permissionsService.isAllowed(note.path, permission, context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Access denied for active file: ${note.path}`,
        context,
      );
    }
    return note;
  }

  private async _getVerifiedPeriodicNote(
    period: Period,
    permission: Permission,
    context: RequestContext,
  ): Promise<NoteJson> {
    const note = (await periodicNoteMethods.getPeriodicNote(
      this._request.bind(this),
      period,
      "json",
      context,
    )) as NoteJson;

    if (!this.permissionsService.isAllowed(note.path, permission, context)) {
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        `Access denied for periodic note: ${note.path}`,
        context,
      );
    }
    return note;
  }
}

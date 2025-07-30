/**
 * @module PermissionsService
 * @description Service for managing and checking file path permissions.
 */

import { config, Permission, PermissionsConfig } from "../../config/index.js";
import { logger, RequestContext } from "../../utils/index.js";

/**
 * Service to manage and check file path-based permissions.
 * It uses a set of rules defined in a configuration file to determine
 * whether an action (read, write, create, delete) is allowed on a given path.
 */
export class PermissionsService {
  private permissionsConfig: PermissionsConfig | null;

  constructor() {
    this.permissionsConfig = config.obsidianPermissions;
    if (this.permissionsConfig) {
      // Sort rules by path length descending to ensure most specific rule is checked first.
      this.permissionsConfig.rules.sort(
        (a, b) => b.path.length - a.path.length,
      );
      logger.info("PermissionsService initialized with configured rules.");
    } else {
      logger.info(
        "PermissionsService initialized without a configuration. All actions will be allowed.",
      );
    }
  }

  /**
   * Checks if a specific permission is granted for a given file path.
   *
   * @param {string} filePath - The vault-relative path to check.
   * @param {Permission} requiredPermission - The permission required for the action.
   * @param {RequestContext} context - The request context for logging.
   * @returns {boolean} True if the action is permitted, false otherwise.
   */
  public isAllowed(
    filePath: string,
    requiredPermission: Permission,
    context: RequestContext,
  ): boolean {
    // If no permissions file is loaded, all actions are allowed by default.
    if (!this.permissionsConfig) {
      return true;
    }

    const opContext = {
      ...context,
      operation: "isAllowed",
      filePath,
      requiredPermission,
    };

    // Find the most specific rule that matches the start of the file path.
    const matchingRule = this.permissionsConfig.rules.find((rule) =>
      filePath.startsWith(rule.path),
    );

    let finalPermissions: Permission[];
    if (matchingRule) {
      finalPermissions = matchingRule.permissions;
      logger.debug(
        `Found matching permission rule for path. Path: "${matchingRule.path}", Permissions: [${finalPermissions.join(", ")}]`,
        opContext,
      );
    } else {
      finalPermissions = this.permissionsConfig.defaultPermissions;
      logger.debug(
        `No specific rule found. Applying default permissions: [${finalPermissions.join(", ")}]`,
        opContext,
      );
    }

    const isGranted = finalPermissions.includes(requiredPermission);
    if (!isGranted) {
      logger.warning(
        `Permission '${requiredPermission}' denied for path '${filePath}'.`,
        opContext,
      );
    }

    return isGranted;
  }
}

import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

dotenv.config();

// --- Determine Project Root ---
const findProjectRoot = (startDir: string): string => {
  let currentDir = startDir;
  while (true) {
    const packageJsonPath = join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `Could not find project root (package.json) starting from ${startDir}`,
      );
    }
    currentDir = parentDir;
  }
};

let projectRoot: string;
try {
  const currentModuleDir = dirname(fileURLToPath(import.meta.url));
  projectRoot = findProjectRoot(currentModuleDir);
} catch (error: any) {
  console.error(`FATAL: Error determining project root: ${error.message}`);
  projectRoot = process.cwd();
  console.warn(
    `Warning: Using process.cwd() (${projectRoot}) as fallback project root.`,
  );
}
// --- End Determine Project Root ---

const pkgPath = join(projectRoot, "package.json");
let pkg = { name: "obsidian-mcp-server", version: "0.0.0" };

try {
  pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
} catch (error) {
  if (process.stderr.isTTY) {
    console.error(
      "Warning: Could not read package.json for default config values. Using hardcoded defaults.",
      error,
    );
  }
}

const EnvSchema = z.object({
  MCP_SERVER_NAME: z.string().optional(),
  MCP_SERVER_VERSION: z.string().optional(),
  MCP_LOG_LEVEL: z.string().default("info"),
  LOGS_DIR: z.string().default(path.join(projectRoot, "logs")),
  NODE_ENV: z.string().default("development"),
  MCP_TRANSPORT_TYPE: z.enum(["stdio", "http"]).default("stdio"),
  MCP_SESSION_MODE: z.enum(["stateless", "stateful", "auto"]).default("auto"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(3010),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_HTTP_ENDPOINT_PATH: z.string().default("/mcp"),
  MCP_HTTP_MAX_PORT_RETRIES: z.coerce.number().int().nonnegative().default(15),
  MCP_HTTP_PORT_RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(50),
  MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(1_800_000),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  MCP_AUTH_MODE: z.enum(["jwt", "oauth", "none"]).default("none"),
  MCP_AUTH_SECRET_KEY: z
    .string()
    .min(
      32,
      "MCP_AUTH_SECRET_KEY must be at least 32 characters long for security",
    )
    .optional(),
  OAUTH_ISSUER_URL: z.string().url().optional(),
  OAUTH_AUDIENCE: z.string().optional(),
  OAUTH_JWKS_URI: z.string().url().optional(),
  DEV_MCP_CLIENT_ID: z.string().optional(),
  DEV_MCP_SCOPES: z.string().optional(),
  OBSIDIAN_API_KEY: z.string().min(1, "OBSIDIAN_API_KEY cannot be empty"),
  OBSIDIAN_BASE_URL: z.string().url().default("http://127.0.0.1:27123"),
  OBSIDIAN_VERIFY_SSL: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("false"),
  OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  OBSIDIAN_ENABLE_CACHE: z
    .string()
    .transform((val) => val.toLowerCase() === "true")
    .default("true"),
  OBSIDIAN_API_SEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30000),
  OBSIDIAN_CACHE_INCLUDE_PATHS: z.string().default("/"),
  OBSIDIAN_CACHE_EXCLUDE_PATHS: z.string().default(""),
  OBSIDIAN_PERMISSIONS_FILE_PATH: z.string().optional(),
});

export const permissionSchema = z.enum(["read", "write", "create", "delete"]);
export type Permission = z.infer<typeof permissionSchema>;

const PermissionRuleSchema = z.object({
  path: z.string().min(1),
  permissions: z.array(permissionSchema),
});

const PermissionsConfigSchema = z.object({
  rules: z.array(PermissionRuleSchema),
  defaultPermissions: z.array(permissionSchema).default(["read"]),
});

export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;

const parsedEnv = EnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const errorDetails = parsedEnv.error.flatten().fieldErrors;
  if (process.stderr.isTTY) {
    console.error("❌ Invalid environment variables:", errorDetails);
  }
  throw new Error(
    `Invalid environment configuration. Please check your .env file or environment variables. Details: ${JSON.stringify(errorDetails)}`,
  );
}

const env = parsedEnv.data;

const ensureDirectory = (
  dirPath: string,
  rootDir: string,
  dirName: string,
): string | null => {
  const resolvedDirPath = path.isAbsolute(dirPath)
    ? dirPath
    : path.resolve(rootDir, dirPath);

  if (
    !resolvedDirPath.startsWith(rootDir + path.sep) &&
    resolvedDirPath !== rootDir
  ) {
    if (process.stderr.isTTY) {
      console.error(
        `Error: ${dirName} path "${dirPath}" resolves to "${resolvedDirPath}", which is outside the project boundary "${rootDir}".`,
      );
    }
    return null;
  }

  if (!existsSync(resolvedDirPath)) {
    try {
      mkdirSync(resolvedDirPath, { recursive: true });
    } catch (err: unknown) {
      if (process.stderr.isTTY) {
        console.error(
          `Error creating ${dirName} directory at ${resolvedDirPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  } else {
    try {
      if (!statSync(resolvedDirPath).isDirectory()) {
        if (process.stderr.isTTY) {
          console.error(
            `Error: ${dirName} path ${resolvedDirPath} exists but is not a directory.`,
          );
        }
        return null;
      }
    } catch (statError: any) {
      if (process.stderr.isTTY) {
        console.error(
          `Error accessing ${dirName} path ${resolvedDirPath}: ${statError.message}`,
        );
      }
      return null;
    }
  }
  return resolvedDirPath;
};

const validatedLogsPath = ensureDirectory(env.LOGS_DIR, projectRoot, "logs");

if (!validatedLogsPath) {
  if (process.stderr.isTTY) {
    console.error(
      "FATAL: Logs directory configuration is invalid or could not be created. Please check permissions and path. Exiting.",
    );
  }
  process.exit(1);
}

const loadPermissionsConfig = (
  filePath: string | undefined,
): PermissionsConfig | null => {
  if (!filePath) {
    return null;
  }

  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectRoot, filePath);

  if (!existsSync(resolvedPath)) {
    if (process.stderr.isTTY) {
      console.warn(
        `Warning: Permissions file not found at ${resolvedPath}. Permissions will not be enforced.`,
      );
    }
    return null;
  }

  try {
    const fileContent = readFileSync(resolvedPath, "utf-8");
    const jsonData = JSON.parse(fileContent);
    const parsedConfig = PermissionsConfigSchema.safeParse(jsonData);

    if (!parsedConfig.success) {
      if (process.stderr.isTTY) {
        console.error(
          `❌ Invalid permissions file at ${resolvedPath}:`,
          parsedConfig.error.flatten().fieldErrors,
        );
      }
      throw new Error("Invalid permissions file format.");
    }

    if (process.stdout.isTTY) {
      console.log(`✅ Successfully loaded permissions from ${resolvedPath}.`);
    }
    return parsedConfig.data;
  } catch (error: any) {
    if (process.stderr.isTTY) {
      console.error(
        `Error loading permissions file from ${resolvedPath}: ${error.message}`,
      );
    }
    return null;
  }
};

const permissionsConfig = loadPermissionsConfig(
  env.OBSIDIAN_PERMISSIONS_FILE_PATH,
);

export const config = {
  pkg,
  mcpServerName: env.MCP_SERVER_NAME || pkg.name,
  mcpServerVersion: env.MCP_SERVER_VERSION || pkg.version,
  logLevel: env.MCP_LOG_LEVEL,
  logsPath: validatedLogsPath,
  environment: env.NODE_ENV,
  mcpTransportType: env.MCP_TRANSPORT_TYPE,
  mcpSessionMode: env.MCP_SESSION_MODE,
  mcpHttpPort: env.MCP_HTTP_PORT,
  mcpHttpHost: env.MCP_HTTP_HOST,
  mcpHttpEndpointPath: env.MCP_HTTP_ENDPOINT_PATH,
  mcpHttpMaxPortRetries: env.MCP_HTTP_MAX_PORT_RETRIES,
  mcpHttpPortRetryDelayMs: env.MCP_HTTP_PORT_RETRY_DELAY_MS,
  mcpStatefulSessionStaleTimeoutMs: env.MCP_STATEFUL_SESSION_STALE_TIMEOUT_MS,
  mcpAllowedOrigins: env.MCP_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  mcpAuthMode: env.MCP_AUTH_MODE,
  mcpAuthSecretKey: env.MCP_AUTH_SECRET_KEY,
  oauthIssuerUrl: env.OAUTH_ISSUER_URL,
  oauthAudience: env.OAUTH_AUDIENCE,
  oauthJwksUri: env.OAUTH_JWKS_URI,
  devMcpClientId: env.DEV_MCP_CLIENT_ID,
  devMcpScopes: env.DEV_MCP_SCOPES?.split(",").map((s) => s.trim()),
  obsidianApiKey: env.OBSIDIAN_API_KEY,
  obsidianBaseUrl: env.OBSIDIAN_BASE_URL,
  obsidianVerifySsl: env.OBSIDIAN_VERIFY_SSL,
  obsidianCacheRefreshIntervalMin: env.OBSIDIAN_CACHE_REFRESH_INTERVAL_MIN,
  obsidianEnableCache: env.OBSIDIAN_ENABLE_CACHE,
  obsidianApiSearchTimeoutMs: env.OBSIDIAN_API_SEARCH_TIMEOUT_MS,
  obsidianCacheIncludePaths: env.OBSIDIAN_CACHE_INCLUDE_PATHS.split(",")
    .map((p) => p.trim())
    .filter(Boolean),
  obsidianCacheExcludePaths: env.OBSIDIAN_CACHE_EXCLUDE_PATHS.split(",")
    .map((p) => p.trim())
    .filter(Boolean),
  obsidianPermissions: permissionsConfig,
};

export const logLevel = config.logLevel;
export const environment = config.environment;

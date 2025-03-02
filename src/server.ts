import { config } from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  Tool,
  TextContent,
  ImageContent,
  EmbeddedResource,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { ObsidianClient } from "./obsidian.js";
import { ObsidianError, DEFAULT_RATE_LIMIT_CONFIG, RateLimitConfig } from "./types.js";
import type { ToolHandler } from "./types.js";
import { TagResource } from "./resources.js";
import {
  ListFilesInVaultToolHandler,
  ListFilesInDirToolHandler,
  GetFileContentsToolHandler,
  FindInFileToolHandler,
  AppendContentToolHandler,
  PatchContentToolHandler,
  ComplexSearchToolHandler,
  GetTagsToolHandler,
  GetActiveFileToolHandler
} from "./tools.js";
import {
  GetPropertiesToolHandler,
  UpdatePropertiesToolHandler
} from "./propertyTools.js";

// Load environment variables
config();

const API_KEY = process.env.OBSIDIAN_API_KEY;
if (!API_KEY) {
  throw new Error("OBSIDIAN_API_KEY environment variable is required");
}

// Get rate limit config from environment or use defaults
const rateLimitConfig: RateLimitConfig = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? String(DEFAULT_RATE_LIMIT_CONFIG.windowMs)),
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? String(DEFAULT_RATE_LIMIT_CONFIG.maxRequests))
};

// Request tracking for rate limiting
const requestCounts = new Map<string, { count: number; resetTime: number }>();

function checkRateLimit(toolName: string): boolean {
  const now = Date.now();
  const requestInfo = requestCounts.get(toolName);

  if (!requestInfo || now > requestInfo.resetTime) {
    // Reset counter for new window
    requestCounts.set(toolName, {
      count: 1,
      resetTime: now + rateLimitConfig.windowMs
    });
    return true;
  }

  if (requestInfo.count >= rateLimitConfig.maxRequests) {
    return false;
  }

  requestInfo.count++;
  return true;
}

// Clean up expired rate limit entries periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [tool, info] of requestCounts.entries()) {
    if (now > info.resetTime) {
      requestCounts.delete(tool);
    }
  }
}, 60000); // Clean up every minute

// Initialize Obsidian client with environment configuration
const client = new ObsidianClient({
  apiKey: API_KEY,
  verifySSL: process.env.VERIFY_SSL === 'true',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxContentLength: parseInt(process.env.MAX_CONTENT_LENGTH || String(50 * 1024 * 1024)),
  maxBodyLength: parseInt(process.env.MAX_BODY_LENGTH || String(50 * 1024 * 1024))
});

// Initialize tool handlers
type AnyToolHandler = ToolHandler<any>;
const toolHandlers = new Map<string, AnyToolHandler>();
const handlers: AnyToolHandler[] = [
  new ListFilesInVaultToolHandler(client),
  new ListFilesInDirToolHandler(client),
  new GetFileContentsToolHandler(client),
  new FindInFileToolHandler(client),
  new AppendContentToolHandler(client),
  new PatchContentToolHandler(client),
  new ComplexSearchToolHandler(client),
  new GetPropertiesToolHandler(client),
  new UpdatePropertiesToolHandler(client),
  new GetTagsToolHandler(client),
  new GetActiveFileToolHandler(client)
];

handlers.forEach(handler => toolHandlers.set(handler.name, handler));

// Initialize resources
const tagResource = new TagResource(client);

// Create MCP server
const server = new Server(
  {
    name: "obsidian-mcp-server",
    version: process.env.npm_package_version ?? "1.1.0" // Use version from package.json
  },
  {
    capabilities: {
      tools: {},
      resources: {
        [tagResource.getResourceDescription().uri]: tagResource
      }
    }
  }
);

// Set up resource handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [tagResource.getResourceDescription()]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === tagResource.getResourceDescription().uri) {
    return {
      contents: await tagResource.getContent()
    };
  }
  throw new ObsidianError(`Resource not found: ${request.params.uri}`, 40400); // 40400 = Not found
});

// Set up tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [];
  for (const handler of toolHandlers.values()) {
    tools.push(handler.getToolDescription());
  }
  return { tools };
});

// Add validation helper
function validateToolArguments(args: unknown, schema: any): { valid: boolean; errors: string[] } {
  if (typeof args !== 'object' || args === null) {
    return { valid: false, errors: ['Arguments must be an object'] };
  }

  const errors: string[] = [];
  const required = schema.required || [];
  
  // Check required fields
  for (const field of required) {
    if (!(field in args)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check field types
  const properties = schema.properties || {};
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) {
      errors.push(`Unknown field: ${key}`);
      continue;
    }

    // Skip validation for undefined optional fields
    if (value === undefined && !required.includes(key)) {
      continue;
    }

    // Type validation
    if (propSchema.type === 'string' && typeof value !== 'string') {
      errors.push(`Field ${key} must be a string`);
    } else if (propSchema.type === 'number' && typeof value !== 'number') {
      errors.push(`Field ${key} must be a number`);
    } else if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`Field ${key} must be a boolean`);
    } else if (propSchema.type === 'array' && !Array.isArray(value)) {
      errors.push(`Field ${key} must be an array`);
    }

    // Enum validation
    if (propSchema.enum && value !== undefined && !propSchema.enum.includes(value)) {
      errors.push(`Field ${key} must be one of: ${propSchema.enum.join(', ')}`);
    }

    // Format validation for paths
    if (propSchema.format === 'path' && typeof value === 'string') {
      // Prevent path traversal
      if (value.includes('../') || value.includes('..\\')) {
        errors.push(`Field ${key} contains invalid path traversal`);
      }
      // Prevent absolute paths
      if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
        errors.push(`Field ${key} must be a relative path`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const handler = toolHandlers.get(name);
  if (!handler) {
    throw new ObsidianError(`Unknown tool: ${name}`, 40400); // 40400 = Not found
  }

  // Check rate limit
  if (!checkRateLimit(name)) {
    throw new ObsidianError(
      `Rate limit exceeded for tool: ${name}. Please try again later.`,
      42900 // 42900 = Rate limit exceeded
    );
  }

  // Add timeout handling
  const timeoutMs = parseInt(process.env.TOOL_TIMEOUT_MS ?? '60000'); // 60 second default timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new ObsidianError(`Tool execution timed out after ${timeoutMs}ms`, 40800)); // 40800 = Request timeout
    }, timeoutMs);
  });

  try {
    // Validate arguments against tool's schema
    const toolDescription = handler.getToolDescription();
    const validationResult = validateToolArguments(args, toolDescription.inputSchema);
    if (!validationResult.valid) {
      throw new ObsidianError(
        `Invalid tool arguments: ${validationResult.errors.join(', ')}`,
        40000 // 40000 = Bad request
      );
    }

    // Race between tool execution and timeout
    const content = await Promise.race([
      handler.runTool(args),
      timeoutPromise
    ]);
    return { content };
  } catch (error) {
    if (error instanceof ObsidianError) {
      // Check if the operation actually succeeded despite the error
      if (error.errorCode === 20400) { // 20400 = Success with no content
        return {
          content: [{
            type: "text",
            text: "Operation completed successfully"
          }]
        };
      }
      throw error;
    }
    
    // Enhanced error logging
    console.error("Tool execution error:", {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      toolName: name,
      args
    });

    if (error instanceof Error) {
      throw new ObsidianError(
        `Tool '${name}' execution failed: ${error.message}`,
        50000, // 50000 = Internal server error
        { originalError: error.stack }
      );
    }
    
    throw new ObsidianError(
      "Tool execution failed with unknown error",
      50000, // 50000 = Internal server error
      { error }
    );
  }
});

// Error handler
server.onerror = (error) => {
  console.error("[MCP Error]", error);
};

// Handle shutdown gracefully across platforms
const cleanup = async () => {
  console.error('Shutting down server...');
  clearInterval(cleanupInterval); // Clean up rate limit interval
  await server.close();
  process.exit(0);
};

// Handle various termination signals
process.on('SIGINT', cleanup);  // Ctrl+C on all platforms
process.on('SIGTERM', cleanup); // Termination request
if (process.platform === 'win32') {
  // Windows-specific handling
  process.on('SIGHUP', cleanup);  // Terminal closed
} else {
  // Unix-specific signals
  process.on('SIGUSR1', cleanup);
  process.on('SIGUSR2', cleanup);
}

// Handle uncaught errors
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  await cleanup();
});

process.on('unhandledRejection', async (error) => {
  console.error('Unhandled rejection:', error);
  await cleanup();
});

// Export the run function
export async function run(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Obsidian MCP server running on stdio");
}

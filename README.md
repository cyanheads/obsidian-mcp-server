# Obsidian MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-1.4.0-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.2.3-blue.svg)]()
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-blue.svg)]()
[![GitHub](https://img.shields.io/github/stars/cyanheads/obsidian-mcp-server?style=social)](https://github.com/cyanheads/obsidian-mcp-server)

A Model Context Protocol server designed for LLMs to interact with Obsidian vaults. Built with TypeScript and featuring secure API communication, efficient file operations, and comprehensive search capabilities, it enables AI assistants to seamlessly manage knowledge bases through a clean, flexible tool interface.

The Model Context Protocol (MCP) enables AI models to interact with external tools and resources through a standardized interface.

Requires the Local REST API plugin in Obsidian.

<a href="https://glama.ai/mcp/servers/syuh40cxyk"><img width="380" height="200" src="https://glama.ai/mcp/servers/syuh40cxyk/badge" alt="Obsidian Server MCP server" /></a>

## Features

### File Operations
- Atomic file/directory operations with validation
- Resource monitoring and cleanup

### Search System
- Full-text search with configurable context
- Advanced JsonLogic queries for files, tags, and metadata
- Support for glob patterns and frontmatter fields

### Property Management
- YAML frontmatter parsing and intelligent merging
- Automatic timestamps (created by Obsidian, modified by server)
- Custom field support

### Security & Performance
- API key auth with rate limiting and SSL options
- Resource monitoring and health checks

## Installation

1. Install Node.js (LTS recommended)
2. Enable Local REST API plugin in Obsidian
3. Clone and build:
```bash
git clone git@github.com:cyanheads/obsidian-mcp-server.git
cd obsidian-mcp-server
npm install
npm run build
```

Or install from npm:
```bash
npm install obsidian-mcp-server
```

## Configuration

Add to your MCP client settings (e.g., `claude_desktop_config.json` or `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "obsidian-mcp-server": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp-server/build/index.js"],
      "env": {
        "OBSIDIAN_API_KEY": "your_api_key_here",
        "VERIFY_SSL": "false",
        "OBSIDIAN_PROTOCOL": "https",
        "OBSIDIAN_HOST": "127.0.0.1",
        "OBSIDIAN_PORT": "27124",
        "REQUEST_TIMEOUT": "5000",
        "MAX_CONTENT_LENGTH": "52428800",
        "MAX_BODY_LENGTH": "52428800",
        "RATE_LIMIT_WINDOW_MS": "900000",
        "RATE_LIMIT_MAX_REQUESTS": "200",
        "TOOL_TIMEOUT_MS": "60000"
      }
    }
  }
}
```

Environment Variables:

Required:
- `OBSIDIAN_API_KEY`: Your API key from Obsidian's Local REST API plugin settings

Connection Settings:
- `VERIFY_SSL`: Enable SSL certificate verification (default: false in development)
- `OBSIDIAN_PROTOCOL`: Protocol to use (default: "https")
- `OBSIDIAN_HOST`: Host address (default: "127.0.0.1")
- `OBSIDIAN_PORT`: Port number (default: 27124)

Request Limits:
- `REQUEST_TIMEOUT`: Request timeout in milliseconds (default: 5000)
- `MAX_CONTENT_LENGTH`: Maximum response content length in bytes (default: 52428800 [50MB])
- `MAX_BODY_LENGTH`: Maximum request body length in bytes (default: 52428800 [50MB])

Rate Limiting:
- `RATE_LIMIT_WINDOW_MS`: Rate limit window in milliseconds (default: 900000 [15 minutes])
- `RATE_LIMIT_MAX_REQUESTS`: Maximum requests per window (default: 200)

Tool Execution:
- `TOOL_TIMEOUT_MS`: Tool execution timeout in milliseconds (default: 60000 [1 minute])

SSL Certificate Setup:

For Windows Users:
1. Development Setup (Not Recommended for Production):
   - Set `VERIFY_SSL` to "false"
   - Set `OBSIDIAN_PROTOCOL` to "http"
   - Enable "Non-encrypted (HTTP) Server" in Obsidian's Local REST API settings

2. Production Setup (Recommended):
   - Set `VERIFY_SSL` to "true"
   - Get the certificate from Obsidian Settings > Local REST API > 'How to Access'
   - Open Windows Certificate Manager (certmgr.msc)
   - Navigate to "Trusted Root Certification Authorities" > "Certificates"
   - Right-click > "All Tasks" > "Import" and select the certificate file

For Other Systems:
- macOS: Add certificate to Keychain Access
- Linux: Add to ca-certificates

Additional configuration options:
```typescript
interface ObsidianConfig {
  apiKey: string;           // Required: API key for authentication
  verifySSL?: boolean;      // Optional: Enable SSL verification
  timeout?: number;         // Optional: Request timeout in ms
  maxContentLength?: number;// Optional: Max response content length
  maxBodyLength?: number;   // Optional: Max request body length
}

interface RateLimitConfig {
  windowMs: number;         // Time window for rate limiting
  maxRequests: number;      // Max requests per window
}
```

Error Handling:
- All errors include a 5-digit error code
- HTTP status codes are automatically converted (e.g., 404 -> 40400)
- Default server error code: 50000
- Detailed error messages include original error stack traces in development

## Tools

### File Management
```typescript
// List vault contents
obsidian_list_files_in_vault: {}

// List directory contents
obsidian_list_files_in_dir: {
  dirpath: string  // Path relative to vault root
}

// Get file contents
obsidian_get_file_contents: {
  filepath: string  // Path relative to vault root
}
```

### Search Operations
```typescript
// Text search with context
obsidian_find_in_file: {
  query: string,
  contextLength?: number  // Default: 10
}

// Advanced search with JsonLogic
obsidian_complex_search: {
  query: JsonLogicQuery
  // Examples:
  // Find by tag:
  // {"in": ["#mytag", {"var": "frontmatter.tags"}]}
  //
  // Find markdown files in a directory:
  // {"glob": ["docs/*.md", {"var": "path"}]}
  //
  // Combine conditions:
  // {"and": [
  //   {"glob": ["*.md", {"var": "path"}]},
  //   {"in": ["#mytag", {"var": "frontmatter.tags"}]}
  // ]}
}
```

### Content Modification
```typescript
// Append to file
obsidian_append_content: {
  filepath: string,  // Path relative to vault root
  content: string    // Content to append
}

// Update file content
obsidian_patch_content: {
  filepath: string,  // Path relative to vault root
  content: string    // New content (replaces existing)
}
```

### Command Management
```typescript
// List available commands
obsidian_list_commands: {}

// Execute a command
obsidian_execute_command: {
  commandId: string  // Command ID to execute
}
```

### File Navigation
```typescript
// Open a file in Obsidian
obsidian_open_file: {
  filepath: string,   // Path relative to vault root
  newLeaf?: boolean  // Open in new leaf (default: false)
}

// Get active file content
obsidian_get_active_file: {}

// Get periodic note content
obsidian_get_periodic_note: {
  period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly"
}
```

### Property Management
```typescript
// Get all tags in vault or directory
obsidian_get_tags: {
  path?: string  // Optional: limit to specific directory
}

// Get note properties
obsidian_get_properties: {
  filepath: string  // Path relative to vault root
}

// Update note properties
obsidian_update_properties: {
  filepath: string,  // Path relative to vault root
  properties: {
    title?: string,
    author?: string,
    // Note: created/modified timestamps are managed automatically
    type?: Array<"concept" | "architecture" | "specification" | 
      "protocol" | "api" | "research" | "implementation" | 
      "guide" | "reference">,
    tags?: string[],  // Must start with #
    status?: Array<"draft" | "in-progress" | "review" | "complete">,
    version?: string,
    platform?: string,
    repository?: string,  // URL
    dependencies?: string[],
    sources?: string[],
    urls?: string[],      // URLs
    papers?: string[],
    custom?: Record<string, unknown>
  }
}
```

## Best Practices

### File Operations
- Use atomic operations with validation
- Handle errors and monitor performance

### Search Implementation
- Use appropriate search tool for the task:
  - obsidian_find_in_file for text search
  - obsidian_complex_search for metadata/tag filtering
- Keep context size reasonable (default: 10 chars)

### Property Management
- Use appropriate types and validate updates
- Handle arrays and custom fields properly
- Never set timestamps (managed automatically)

### Error Prevention
- Validate inputs and handle errors gracefully
- Monitor patterns and respect rate limits

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a Pull Request

For bugs and features, create an issue at [https://github.com/cyanheads/obsidian-mcp-server/issues](https://github.com/cyanheads/obsidian-mcp-server/issues).

## Publishing

The package is automatically published to npm when version tags are pushed:

```bash
# Update version in package.json
npm version patch  # or minor, or major
git push --follow-tags
```

This will trigger the GitHub Action to build and publish the package.

## License

Apache License 2.0

---

<div align="center">
Built with the Model Context Protocol
</div>

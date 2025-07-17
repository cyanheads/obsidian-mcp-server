[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/cyanheads-obsidian-mcp-server-badge.png)](https://mseep.ai/app/cyanheads-obsidian-mcp-server)

# Obsidian MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-1.10.2-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.5.8-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-green.svg)]()
[![GitHub](https://img.shields.io/github/stars/cyanheads/obsidian-mcp-server?style=social)](https://github.com/cyanheads/obsidian-mcp-server)

A Model Context Protocol server designed for LLMs to interact with Obsidian vaults. Built with TypeScript and featuring secure API communication, efficient file operations, and comprehensive search capabilities, it enables AI assistants to seamlessly manage knowledge bases through a clean, flexible tool interface.

The Model Context Protocol (MCP) enables AI models to interact with external tools and resources through a standardized interface.

Requires the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) in Obsidian.

## 📋 Table of Contents

[Features](#-features) | [Installation](#-installation) | [Configuration](#-configuration) |
[Tools](#-tools) | [Resources](#-resources) | [Project Structure](#-project-structure) |
[Contributing](#-contributing) | [Publishing](#-publishing) | [License](#-license)

## ✨ Features

- **File Operations**: Atomic file/directory operations with validation, resource monitoring, and error handling.
- **Search System**: Full-text search with configurable context, advanced JsonLogic queries, glob patterns, and frontmatter field support.
- **Property Management**: YAML frontmatter parsing, intelligent merging, automatic timestamps, and custom field support.
- **Security & Performance**: API key authentication, rate limiting, SSL options, resource monitoring, and graceful shutdown.

## 🚀 Installation

Note: Requires Node.js and the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) enabled in Obsidian.

### Option 1: Clone and Build (for development or direct use)

1.  Enable the Local REST API plugin in Obsidian.
2.  Clone the repository, install dependencies, and build the project:
    ```bash
    git clone git@github.com:cyanheads/obsidian-mcp-server.git
    cd obsidian-mcp-server
    npm install
    npm run build
    ```
3.  Configure the server using environment variables (see Configuration section below).

4.  Configure your MCP client settings (e.g., `claude_desktop_config.json` or `cline_mcp_settings.json`) to include the server. See the Configuration section for details.

### Option 2: Install via npm (as a dependency or globally)

1.  Enable the Local REST API plugin in Obsidian.
2.  Install the package using npm:

    ```bash
    # Install locally (e.g., within another project)
    npm install obsidian-mcp-server

    # Or install globally
    npm install -g obsidian-mcp-server
    ```

3.  Configure your MCP client settings (e.g., `claude_desktop_config.json` or `cline_mcp_settings.json`) to include the server. See the Configuration section for details.

## ⚙️ Configuration

Add to your MCP client settings (e.g., `claude_desktop_config.json` or `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "obsidian-mcp-server": {
      "command": "node",
      "args": ["/path/to/obsidian-mcp-server/dist/index.js"],
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

**Environment Variables:**

- `OBSIDIAN_API_KEY` (Required): Your API key from Obsidian's Local REST API plugin settings.
- `VERIFY_SSL` (Default: `false`): Enable SSL verification. Set to `false` for self-signed certificates or local use.
- `OBSIDIAN_PROTOCOL` (Default: `"https"`): Protocol (`http` or `https`).
- `OBSIDIAN_HOST` (Default: `"127.0.0.1"`): Host address.
- `OBSIDIAN_PORT` (Default: `27124`): Port number.
- `REQUEST_TIMEOUT` (Default: `5000`): Request timeout (ms).
- `MAX_CONTENT_LENGTH` (Default: `52428800` [50MB]): Max response content length (bytes).
- `MAX_BODY_LENGTH` (Default: `52428800` [50MB]): Max request body length (bytes).
- `RATE_LIMIT_WINDOW_MS` (Default: `900000` [15 min]): Rate limit window (ms).
- `RATE_LIMIT_MAX_REQUESTS` (Default: `200`): Max requests per window.
- `TOOL_TIMEOUT_MS` (Default: `60000` [1 min]): Tool execution timeout (ms).

## 🛠️ Tools

| Tool                             | Description                                                                                                                                                                                                                                                                                                                                   | Parameters                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **obsidian_list_files_in_vault** | Lists all files and directories within the root of your Obsidian vault. Returns a hierarchical structure detailing files, folders, and their types.                                                                                                                                                                                           | None                                                                                                                                                                                                                                                                                         |
| **obsidian_list_files_in_dir**   | Lists files and directories within a specific folder in your Obsidian vault. Returns a hierarchical structure. Note: Empty directories may not be included in the results. Useful for exploring vault organization.                                                                                                                           | `dirpath*`: Path to list files from (relative to vault root). Note that empty directories will not be returned.                                                                                                                                                                              |
| **obsidian_get_file_contents**   | Retrieves the full content of a specified file within your Obsidian vault. Supports various readable file formats.                                                                                                                                                                                                                            | `filepath*`: Path to the relevant file (relative to your vault root).                                                                                                                                                                                                                        |
| **obsidian_append_content**      | Appends the provided content to the end of a specified file in the vault. If the file does not exist, it will be created.                                                                                                                                                                                                                     | `filepath*`: Path to the file (relative to vault root)<br>`content*`: Content to append to the file                                                                                                                                                                                          |
| **obsidian_update_content**      | Overwrites the entire content of a specified file in the vault with the provided content. If the file does not exist, it will be created.                                                                                                                                                                                                     | `filepath*`: Path to the file (relative to vault root)<br>`content*`: The new, complete content for the file (overwrites existing content).                                                                                                                                                  |
| **obsidian_find_in_file**        | Performs a full-text search across all files in your Obsidian vault. Returns matching files with context around each match. If more than 5 files match, only filenames and match counts are returned to avoid excessive output. Ideal for locating specific text, tags, or patterns.                                                          | `query*`: Text pattern to search for. Can include tags, keywords, or phrases.<br>`contextLength`: Number of characters surrounding each match to provide context (default: 10).                                                                                                              |
| **obsidian_complex_search**      | Finds files based on path patterns using JsonLogic queries. Primarily supports `glob` for pattern matching (e.g., '\*.md') and `var` for accessing the 'path' variable. Note: For content-based searches (full-text, tags within content, dates), use `obsidian_find_in_file`.                                                                | `query*`: A JsonLogic query object targeting file paths. Example: `{"glob": ["*.md", {"var": "path"}]}` matches all markdown files.                                                                                                                                                          |
| **obsidian_get_tags**            | Retrieves all tags defined in the YAML frontmatter of markdown files within your Obsidian vault, along with their usage counts and associated file paths. Optionally, limit the search to a specific folder.                                                                                                                                  | `path`: Optional folder path (relative to vault root) to restrict the tag search.                                                                                                                                                                                                            |
| **obsidian_get_properties**      | Retrieves properties (like title, tags, status) from the YAML frontmatter of a specified Obsidian note. Returns all defined properties, including any custom fields.                                                                                                                                                                          | `filepath*`: Path to the note file (relative to vault root)                                                                                                                                                                                                                                  |
| **obsidian_update_properties**   | Updates properties within the YAML frontmatter of a specified Obsidian note. By default, array properties (like tags, type, status) are merged; use the 'replace' option to overwrite them instead. Handles custom fields and manages timestamps automatically. See schema for supported standard fields (title, author, tags, status, etc.). | `filepath*`: Path to the note file (relative to vault root)<br>`properties*`: Properties to update<br>`replace`: If true, array properties (like tags, status) will be completely replaced with the provided values instead of being merged with existing values. Defaults to false (merge). |

## 🔗 Resources

| Resource            | Description                                                             | Returns          |
| ------------------- | ----------------------------------------------------------------------- | ---------------- |
| **obsidian://tags** | List of all tags used across the Obsidian vault with their usage counts | application/json |

## 📁 Project Structure

The project follows a modular architecture with clear separation of concerns:

```
src/
  ├── index.ts          # Main entry point
  ├── mcp/              # MCP server implementation
  ├── obsidian/         # Obsidian API client and types
  ├── resources/        # MCP resource implementations
  ├── tools/            # MCP tool implementations
  │   ├── files/        # File operations tools
  │   ├── search/       # Search tools
  │   └── properties/   # Property management tools
  └── utils/            # Shared utilities
```

## 👥 Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a Pull Request

For bugs and features, create an issue at [https://github.com/cyanheads/obsidian-mcp-server/issues](https://github.com/cyanheads/obsidian-mcp-server/issues).

## 📄 License

[![Apache 2.0 License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Apache License 2.0

---

<div align="center">
Built with the Model Context Protocol
</div>

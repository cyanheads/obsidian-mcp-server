# Permissions Service

The Obsidian MCP Server includes a `PermissionsService` to provide granular, path-based access control within your Obsidian vault. This feature allows you to define specific permissions (`read`, `write`, `create`, `delete`) for different directories, ensuring that AI agents and other tools can only perform actions that you have explicitly allowed.

## How It Works

The service operates on a simple but powerful set of rules defined in a JSON configuration file. When a tool attempts to perform an action on a file, the `PermissionsService` checks its path against the configured rules to determine if the action is permitted.

1.  **Rule Specificity**: The service always uses the **most specific rule** that matches a file path. For example, a rule for `Daily Notes/2025/` is more specific than a rule for `Daily Notes/`.
2.  **Default Permissions**: If no specific rule matches a file path, the `defaultPermissions` are applied. This allows you to set a baseline level of access for your entire vault.
3.  **Implicit Denial**: If a permission is not explicitly granted by either a specific rule or the default rules, it is denied.

## Configuration

To enable the `PermissionsService`, you must create a permissions JSON file and point to it using the `OBSIDIAN_PERMISSIONS_FILE_PATH` environment variable in your MCP client configuration.

**1. Create a Permissions JSON File**

Create a file (e.g., `obsidian-permissions.json`) to define your access rules. The file has two main parts: `rules` and `defaultPermissions`.

-   `rules`: An array of objects, where each object defines:
    -   `path`: The vault-relative path to a directory. **Must end with a `/`**.
    -   `permissions`: An array of strings specifying the allowed actions. Valid permissions are:
        -   `"read"`: Allows reading the content of notes.
        -   `"write"`: Allows modifying existing notes.
        -   `"create"`: Allows creating new notes.
        -   `"delete"`: Allows deleting notes.
-   `defaultPermissions`: An array of permissions that apply to any path not covered by a specific rule.

**Example `obsidian-permissions.json`:**

```json
{
  "rules": [
    {
      "path": "Daily Notes/",
      "permissions": ["read", "write", "create", "delete"]
    },
    {
      "path": "Templates/",
      "permissions": ["read"]
    },
    {
      "path": "Attachments/Images/",
      "permissions": ["read", "create", "delete"]
    },
    {
      "path": "Secrets/",
      "permissions": []
    }
  ],
  "defaultPermissions": ["read"]
}
```

In this example:
-   Full access is granted to the `Daily Notes/` directory.
-   Files in `Templates/` are read-only.
-   In `Attachments/Images/`, files can be read, created, and deleted, but not modified.
-   All access is denied to the `Secrets/` directory.
-   For any other path in the vault, only `read` access is granted.

**2. Update Your MCP Client Configuration**

In your MCP client's settings (e.g., `cline_mcp_settings.json`), add the optional `OBSIDIAN_PERMISSIONS_FILE_PATH` environment variable to the `env` block for the `obsidian-mcp-server`. The path should be an absolute path or relative to the `obsidian-mcp-server` project root.

```json
{
  "mcpServers": {
    "obsidian-mcp-server": {
      "command": "npx",
      "args": ["obsidian-mcp-server"],
      "env": {
        "OBSIDIAN_API_KEY": "YOUR_API_KEY_FROM_OBSIDIAN_PLUGIN",
        "OBSIDIAN_BASE_URL": "http://127.0.0.1:27123",
        "OBSIDIAN_PERMISSIONS_FILE_PATH": "/path/to/your/obsidian-permissions.json"
      }
    }
  }
}
```

If this variable is not set, the `PermissionsService` will be disabled, and all actions will be allowed by default.

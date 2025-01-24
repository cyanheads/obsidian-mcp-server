import { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { ObsidianClient } from "./obsidian.js";
import { encoding_for_model } from "tiktoken";
import {
  ToolHandler,
  PatchContentArgs,
  AppendContentArgs,
  SearchArgs,
  ComplexSearchArgs,
  FileContentsArgs,
  ListFilesArgs,
  ObsidianError
} from "./types.js";

const TOOL_NAMES = {
  LIST_FILES_IN_VAULT: "obsidian_list_files_in_vault",
  LIST_FILES_IN_DIR: "obsidian_list_files_in_dir",
  GET_FILE_CONTENTS: "obsidian_get_file_contents",
  FIND_IN_FILE: "obsidian_find_in_file",
  APPEND_CONTENT: "obsidian_append_content",
  PATCH_CONTENT: "obsidian_patch_content",
  COMPLEX_SEARCH: "obsidian_complex_search"
} as const;

// Load token limits from environment or use defaults
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS ?? '20000');
const TRUNCATION_MESSAGE = "\n\n[Response truncated due to length]";

export abstract class BaseToolHandler<T = Record<string, unknown>> implements ToolHandler<T> {
  private tokenizer = encoding_for_model("gpt-4"); // This is strictly for token counting, not for LLM inference
  private isShuttingDown = false;

  constructor(
    public readonly name: string,
    protected client: ObsidianClient
  ) {
    // Clean up tokenizer when process exits
    const cleanup = () => {
      if (!this.isShuttingDown) {
        this.isShuttingDown = true;
        if (this.tokenizer) {
          this.tokenizer.free();
        }
      }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', cleanup);
  }

  protected countTokens(text: string): number {
    return this.tokenizer.encode(text).length;
  }

  protected truncateToTokenLimit(text: string): string {
    const tokens = this.tokenizer.encode(text);
    if (tokens.length <= MAX_TOKENS) {
      return text;
    }

    // Reserve tokens for truncation message
    const messageTokens = this.tokenizer.encode(TRUNCATION_MESSAGE);
    const availableTokens = MAX_TOKENS - messageTokens.length;
    
    // Decode truncated tokens back to text
    const truncatedText = this.tokenizer.decode(tokens.slice(0, availableTokens));
    return truncatedText + TRUNCATION_MESSAGE;
  }

  abstract getToolDescription(): Tool;
  abstract runTool(args: T): Promise<Array<TextContent>>;

  protected createResponse(content: unknown): TextContent[] {
    let text: string;

    // Handle different content types
    if (typeof content === 'string') {
      text = content;
    } else if (content instanceof Buffer) {
      text = content.toString('utf-8');
    } else if (Array.isArray(content) && content.every(item => typeof item === 'string')) {
      text = content.join('\n');
    } else if (content instanceof Error) {
      text = `Error: ${content.message}\n${content.stack || ''}`;
    } else {
      try {
        text = JSON.stringify(content, null, 2);
      } catch (error) {
        text = String(content);
      }
    }

    // Count tokens and truncate if necessary
    const originalTokenCount = this.countTokens(text);
    const truncatedText = this.truncateToTokenLimit(text);
    const finalTokenCount = this.countTokens(truncatedText);
    
    if (originalTokenCount > MAX_TOKENS) {
      console.debug(
        `[${this.name}] Response truncated:`,
        `original tokens=${originalTokenCount}`,
        `truncated tokens=${finalTokenCount}`
      );
    }
    
    return [{
      type: "text",
      text: truncatedText
    }];
  }

  protected handleError(error: unknown): never {
    if (error instanceof ObsidianError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new ObsidianError(
        `Tool '${this.name}' execution failed: ${error.message}`,
        500,
        { originalError: error.stack }
      );
    }
    throw new ObsidianError(
      `Tool '${this.name}' execution failed with unknown error`,
      500,
      { error }
    );
  }
}

export class ListFilesInVaultToolHandler extends BaseToolHandler<Record<string, never>> {
  constructor(client: ObsidianClient) {
    super(TOOL_NAMES.LIST_FILES_IN_VAULT, client);
  }

  getToolDescription(): Tool {
    return {
      name: this.name,
      description: "Lists all files and directories in the root directory of your Obsidian vault. Returns a hierarchical structure of files and folders, including metadata like file type.",
      examples: [
        {
          description: "List all files in vault",
          args: {}
        },
        {
          description: "Example response",
          args: {},
          response: [
            {
              "path": "Daily Notes",
              "type": "folder",
              "children": [
                { "path": "Daily Notes/2025-01-24.md", "type": "file" }
              ]
            },
            {
              "path": "Projects",
              "type": "folder",
              "children": [
                { "path": "Projects/MCP.md", "type": "file" }
              ]
            }
          ]
        }
      ],
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    };
  }

  async runTool(): Promise<Array<TextContent>> {
    try {
      const files = await this.client.listFilesInVault();
      return this.createResponse(files);
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export class ListFilesInDirToolHandler extends BaseToolHandler<ListFilesArgs> {
  constructor(client: ObsidianClient) {
    super(TOOL_NAMES.LIST_FILES_IN_DIR, client);
  }

  getToolDescription(): Tool {
    return {
      name: this.name,
      description: "Lists all files and directories that exist in a specific Obsidian directory. Returns a hierarchical structure showing files, folders, and their relationships. Useful for exploring vault organization and finding specific files.",
      examples: [
        {
          description: "List files in Documents folder",
          args: {
            dirpath: "Documents"
          }
        },
        {
          description: "Example response structure",
          args: {
            dirpath: "Projects"
          },
          response: [
            {
              "path": "Projects/Active",
              "type": "folder",
              "children": [
                { "path": "Projects/Active/ProjectA.md", "type": "file" },
                { "path": "Projects/Active/ProjectB.md", "type": "file" }
              ]
            },
            {
              "path": "Projects/Archive",
              "type": "folder",
              "children": [
                { "path": "Projects/Archive/OldProject.md", "type": "file" }
              ]
            }
          ]
        }
      ],
      inputSchema: {
        type: "object",
        properties: {
          dirpath: {
            type: "string",
            description: "Path to list files from (relative to your vault root). Note that empty directories will not be returned.",
            format: "path"
          }
        },
        required: ["dirpath"]
      }
    };
  }

  async runTool(args: ListFilesArgs): Promise<Array<TextContent>> {
    try {
      const files = await this.client.listFilesInDir(args.dirpath);
      return this.createResponse(files);
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export class GetFileContentsToolHandler extends BaseToolHandler<FileContentsArgs> {
  constructor(client: ObsidianClient) {
    super(TOOL_NAMES.GET_FILE_CONTENTS, client);
  }

  getToolDescription(): Tool {
    return {
      name: this.name,
      description: "Return the content of a single file in your vault. Supports markdown files, text files, and other readable formats. Returns the raw content including any YAML frontmatter.",
      examples: [
        {
          description: "Get content of a markdown note",
          args: {
            filepath: "Projects/research.md"
          }
        },
        {
          description: "Get content of a configuration file",
          args: {
            filepath: "configs/settings.yml"
          }
        }
      ],
      inputSchema: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the relevant file (relative to your vault root).",
            format: "path"
          }
        },
        required: ["filepath"]
      }
    };
  }

  async runTool(args: FileContentsArgs): Promise<Array<TextContent>> {
    try {
      const content = await this.client.getFileContents(args.filepath);
      return this.createResponse(content);
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export class FindInFileToolHandler extends BaseToolHandler<SearchArgs> {
  constructor(client: ObsidianClient) {
    super(TOOL_NAMES.FIND_IN_FILE, client);
  }

  getToolDescription(): Tool {
    return {
      name: this.name,
      description: "Full-text search across all files in the vault. Returns matching files with surrounding context for each match. Useful for finding specific content, references, or patterns across notes.",
      examples: [
        {
          description: "Search for a specific term",
          args: {
            query: "neural networks",
            contextLength: 20
          }
        },
        {
          description: "Search with default context",
          args: {
            query: "#todo"
          },
          response: [
            {
              "filename": "Projects/AI.md",
              "matches": [
                {
                  "context": "Research needed:\n#todo Implement transformer architecture\nDeadline: Next week",
                  "match": { "start": 15, "end": 45 }
                }
              ]
            }
          ]
        }
      ],
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text pattern to search for. Can include tags, keywords, or phrases."
          },
          contextLength: {
            type: "integer",
            description: "Number of characters to include before and after each match for context (default: 10)",
            default: 10
          }
        },
        required: ["query"]
      }
    };
  }

  async runTool(args: SearchArgs): Promise<Array<TextContent>> {
    try {
      const results = await this.client.search(args.query, args.contextLength);
      // Extract only unique filenames from search results
      const filenames = [...new Set(results.map(result => result.filename))].sort();
      return this.createResponse(filenames);
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export class AppendContentToolHandler extends BaseToolHandler<AppendContentArgs> {
  constructor(client: ObsidianClient) {
    super(TOOL_NAMES.APPEND_CONTENT, client);
  }

  getToolDescription(): Tool {
    return {
      name: this.name,
      description: "Append content to a new or existing file in the vault.",
      examples: [
        {
          description: "Append a new task",
          args: {
            filepath: "tasks.md",
            content: "- [ ] New task to complete"
          }
        },
        {
          description: "Append meeting notes",
          args: {
            filepath: "meetings/2025-01-23.md",
            content: "## Meeting Notes\n\n- Discussed project timeline\n- Assigned tasks"
          }
        }
      ],
      inputSchema: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file (relative to vault root)",
            format: "path"
          },
          content: {
            type: "string",
            description: "Content to append to the file"
          }
        },
        required: ["filepath", "content"]
      }
    };
  }

  async runTool(args: AppendContentArgs): Promise<Array<TextContent>> {
    try {
      await this.client.appendContent(args.filepath, args.content);
      return this.createResponse({ message: `Successfully appended content to ${args.filepath}` });
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export class PatchContentToolHandler extends BaseToolHandler<PatchContentArgs> {
  constructor(client: ObsidianClient) {
    super(TOOL_NAMES.PATCH_CONTENT, client);
  }

  getToolDescription(): Tool {
    return {
      name: this.name,
      description: "Update the entire content of an existing note or create a new one.",
      examples: [
        {
          description: "Update a note's content",
          args: {
            filepath: "project.md",
            content: "# Project Notes\n\nThis will replace the entire content of the note."
          }
        }
      ],
      inputSchema: {
        type: "object",
        properties: {
          filepath: {
            type: "string",
            description: "Path to the file (relative to vault root)",
            format: "path"
          },
          content: {
            type: "string",
            description: "New content for the note (replaces existing content)"
          }
        },
        required: ["filepath", "content"]
      }
    };
  }

  async runTool(args: PatchContentArgs): Promise<Array<TextContent>> {
    try {
      await this.client.updateContent(args.filepath, args.content);
      return this.createResponse({ message: `Successfully updated content in ${args.filepath}` });
    } catch (error) {
      return this.handleError(error);
    }
  }
}

export class ComplexSearchToolHandler extends BaseToolHandler<ComplexSearchArgs> {
  constructor(client: ObsidianClient) {
    super(TOOL_NAMES.COMPLEX_SEARCH, client);
  }

  getToolDescription(): Tool {
    return {
      name: this.name,
      description: "Advanced search functionality using JsonLogic queries. Enables complex file filtering based on paths, metadata, modification times, and content patterns. Supports logical operations, date comparisons, and pattern matching.",
      examples: [
        {
          description: "Find markdown files in a specific folder",
          args: {
            query: {
              "and": [
                {"glob": ["Projects/*.md", {"var": "path"}]},
                {"contains": [{"var": "content"}, "#active"]}
              ]
            }
          }
        },
        {
          description: "Find recently modified documentation",
          args: {
            query: {
              "and": [
                {"glob": ["docs/*.md", {"var": "path"}]},
                {">=": [
                  {"var": "mtime"},
                  {"date": "-7 days"}
                ]},
                {"!=": [{"var": "size"}, 0]}
              ]
            }
          }
        },
        {
          description: "Find files by multiple criteria",
          args: {
            query: {
              "and": [
                {"or": [
                  {"glob": ["*.md", {"var": "path"}]},
                  {"glob": ["*.txt", {"var": "path"}]}
                ]},
                {"contains": [{"var": "content"}, "TODO"]},
                {"<": [{"var": "size"}, 10000]}
              ]
            }
          }
        }
      ],
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "object",
            description: "JsonLogic query object. Example: {\"glob\": [\"*.md\", {\"var\": \"path\"}]} matches all markdown files"
          }
        },
        required: ["query"]
      }
    };
  }

  async runTool(args: ComplexSearchArgs): Promise<Array<TextContent>> {
    try {
      const results = await this.client.searchJson(args.query);
      return this.createResponse(results);
    } catch (error) {
      return this.handleError(error);
    }
  }
}

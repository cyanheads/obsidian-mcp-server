/**
 * @fileoverview Core logic for the 'obsidian_list_notes' tool.
 * This module defines the input schema, response types, and processing logic for
 * recursively listing files and directories in an Obsidian vault with filtering.
 * @module src/mcp-server/tools/obsidianListNotesTool/logic
 */

import path from "node:path/posix";
import { z } from "zod";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import { logger, type RequestContext } from "../../../utils/index.js";

// ====================================================================================
// Zod Schema Definitions
// ====================================================================================

export const ObsidianListNotesInputSchema = z
  .object({
    dirPath: z
      .string()
      .describe(
        'The vault-relative path to the directory to list (e.g., "Meetings/2024/Q3" or "/" for the vault root).',
      ),
    fileExtensionFilter: z
      .array(z.string().startsWith(".", "Extension must start with a dot '.'"))
      .optional()
      .describe(
        "An array of file extensions to include (e.g., `['.md', '.canvas']`). Directories are always included.",
      ),
    nameRegexFilter: z
      .string()
      .nullable()
      .optional()
      .describe(
        "A JavaScript regex pattern to filter entries by name. (e.g., `^Project-` to find all notes starting with 'Project-').",
      ),
    recursionDepth: z
      .number()
      .int()
      .default(-1)
      .describe(
        "The maximum depth for recursive listing. Use 0 for no recursion or -1 for infinite depth (default).",
      ),
  })
  .describe(
    "Lists notes and directories within a specified Obsidian vault path, offering advanced filtering and recursion.",
  );

export const ObsidianListNotesResponseSchema = z.object({
  directoryPath: z
    .string()
    .describe("The absolute vault path of the directory that was listed."),
  tree: z
    .string()
    .describe("A formatted string visualizing the directory structure."),
  totalEntries: z
    .number()
    .int()
    .describe("The total count of all notes and directories found."),
});

// ====================================================================================
// Type Definitions
// ====================================================================================

export type ObsidianListNotesInput = z.infer<
  typeof ObsidianListNotesInputSchema
>;
export type ObsidianListNotesResponse = z.infer<
  typeof ObsidianListNotesResponseSchema
>;

interface FileTreeNode {
  name: string;
  type: "file" | "directory";
  children: FileTreeNode[];
}

// ====================================================================================
// Helper Functions
// ====================================================================================

function formatTree(
  nodes: FileTreeNode[],
  indent = "",
): { tree: string; count: number } {
  let treeString = "";
  let count = nodes.length;

  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const prefix = isLast ? "└── " : "├── ";
    const childIndent = isLast ? "    " : "│   ";

    treeString += `${indent}${prefix}${node.name}\n`;

    if (node.children.length > 0) {
      const result = formatTree(node.children, indent + childIndent);
      treeString += result.tree;
      count += result.count;
    }
  });

  return { tree: treeString, count };
}

async function buildFileTree(
  dirPath: string,
  currentDepth: number,
  params: ObsidianListNotesInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<FileTreeNode[]> {
  const { recursionDepth, fileExtensionFilter, nameRegexFilter } = params;

  if (recursionDepth !== -1 && currentDepth > recursionDepth) {
    return [];
  }

  let fileNames;
  try {
    fileNames = await obsidianService.listFiles(dirPath, context);
  } catch (error) {
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      logger.warning(
        `Directory not found during recursive list: ${dirPath}. Skipping.`,
        context,
      );
      return [];
    }
    throw error;
  }

  const regex =
    nameRegexFilter && nameRegexFilter.trim() !== ""
      ? new RegExp(nameRegexFilter)
      : null;

  const treeNodes: FileTreeNode[] = [];

  for (const name of fileNames) {
    const fullPath = path.join(dirPath, name);
    const isDirectory = name.endsWith("/");
    const cleanName = isDirectory ? name.slice(0, -1) : name;

    if (regex && !regex.test(cleanName)) continue;
    if (
      !isDirectory &&
      fileExtensionFilter?.length &&
      !fileExtensionFilter.includes(path.extname(name))
    ) {
      continue;
    }

    const node: FileTreeNode = {
      name: isDirectory ? `${cleanName}/` : cleanName,
      type: isDirectory ? "directory" : "file",
      children: isDirectory
        ? await buildFileTree(
            fullPath,
            currentDepth + 1,
            params,
            context,
            obsidianService,
          )
        : [],
    };
    treeNodes.push(node);
  }

  treeNodes.sort((a, b) => {
    if (a.type === "directory" && b.type === "file") return -1;
    if (a.type === "file" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  return treeNodes;
}

// ====================================================================================
// Core Logic Function
// ====================================================================================

export const obsidianListNotesLogic = async (
  params: ObsidianListNotesInput,
  context: RequestContext,
  obsidianService: ObsidianRestApiService,
): Promise<ObsidianListNotesResponse> => {
  const { dirPath } = params;
  const dirPathForLog = dirPath === "" || dirPath === "/" ? "/" : dirPath;

  logger.debug(
    `Executing obsidian_list_notes logic for path: ${dirPathForLog}`,
    context,
  );

  try {
    const fileTree = await buildFileTree(
      dirPathForLog,
      0,
      params,
      context,
      obsidianService,
    );

    if (fileTree.length === 0) {
      return {
        directoryPath: dirPathForLog,
        tree: "(empty or all items filtered)",
        totalEntries: 0,
      };
    }

    const { tree, count } = formatTree(fileTree);

    return {
      directoryPath: dirPathForLog,
      tree: tree.trimEnd(),
      totalEntries: count,
    };
  } catch (error) {
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      const notFoundMsg = `Directory not found: ${dirPathForLog}`;
      throw new McpError(error.code, notFoundMsg, context);
    }
    throw error;
  }
};

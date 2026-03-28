import type { ToolDef } from "../../providers/types.js";

/**
 * Tool schema definitions using the provider-agnostic ToolDef type.
 * Each schema describes a tool that can be passed to any LLM provider
 * via the appropriate adapter.
 */

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Execute a shell command in the project directory. Use for running builds, tests, linters, git commands, dev servers, curl, etc. The command runs with the project root as cwd.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
      timeout: {
        type: "number",
        description:
          "Timeout in milliseconds. Defaults to 120000 (2 minutes). Use longer timeouts for builds and test suites.",
      },
    },
    required: ["command"],
  },
};

export const readFileTool: ToolDef = {
  name: "read_file",
  description:
    "Read a file's contents. Returns the file content with line numbers. Use offset and limit to read specific sections of large files.",
  input_schema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description:
          "Path to the file, relative to the project root or absolute.",
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based). Optional.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. Optional.",
      },
    },
    required: ["file_path"],
  },
};

export const writeFileTool: ToolDef = {
  name: "write_file",
  description:
    "Create a new file or overwrite an existing file. Parent directories are created automatically. Use edit_file for targeted modifications to existing files.",
  input_schema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description:
          "Path to the file, relative to the project root or absolute.",
      },
      content: {
        type: "string",
        description: "The full content to write to the file.",
      },
    },
    required: ["file_path", "content"],
  },
};

export const editFileTool: ToolDef = {
  name: "edit_file",
  description:
    "Apply a targeted find-and-replace edit to an existing file. The old_text must match exactly (including whitespace and indentation). Replaces only the first occurrence.",
  input_schema: {
    type: "object" as const,
    properties: {
      file_path: {
        type: "string",
        description:
          "Path to the file, relative to the project root or absolute.",
      },
      old_text: {
        type: "string",
        description:
          "The exact text to find in the file. Must match exactly including whitespace.",
      },
      new_text: {
        type: "string",
        description: "The replacement text.",
      },
    },
    required: ["file_path", "old_text", "new_text"],
  },
};

export const globTool: ToolDef = {
  name: "glob",
  description:
    'Find files matching a glob pattern. Returns a list of matching file paths relative to the search directory. Example patterns: "**/*.ts", "src/components/**/*.tsx", "*.json".',
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against.",
      },
      path: {
        type: "string",
        description:
          "Directory to search in, relative to project root. Defaults to project root.",
      },
    },
    required: ["pattern"],
  },
};

export const grepTool: ToolDef = {
  name: "grep",
  description:
    "Search file contents using a regular expression pattern. Returns matching lines with file paths and line numbers.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for.",
      },
      path: {
        type: "string",
        description:
          "File or directory to search in, relative to project root. Defaults to project root.",
      },
      glob: {
        type: "string",
        description:
          'Glob pattern to filter which files to search (e.g. "*.ts", "*.tsx").',
      },
      context: {
        type: "number",
        description:
          "Number of context lines to show before and after each match.",
      },
    },
    required: ["pattern"],
  },
};

/** All available tool schemas, keyed by tool name. */
export const TOOL_SCHEMAS: Record<string, ToolDef> = {
  bash: bashTool,
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  glob: globTool,
  grep: grepTool,
};

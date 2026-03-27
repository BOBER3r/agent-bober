import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { execa } from "execa";

// ── Constants ──────────────────────────────────────────────────────

/** Max characters per tool result to prevent context blow-up. */
const MAX_OUTPUT_CHARS = 100_000;

/** Default bash command timeout in ms. */
const DEFAULT_BASH_TIMEOUT = 120_000;

/** Max files returned by glob. */
const MAX_GLOB_RESULTS = 500;

/** Max lines returned by grep. */
const MAX_GREP_LINES = 300;

// ── Types ──────────────────────────────────────────────────────────

export type ToolHandler = (
  input: Record<string, unknown>,
) => Promise<{ output: string; isError: boolean }>;

// ── Path sandboxing ────────────────────────────────────────────────

/**
 * Resolve and validate a file path, ensuring it stays within projectRoot.
 * Returns the absolute path or throws if the path escapes the sandbox.
 */
function sandboxPath(projectRoot: string, inputPath: string): string {
  const abs = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(projectRoot, inputPath);

  // Ensure the resolved path is within the project root
  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path "${inputPath}" resolves outside the project root. Access denied.`,
    );
  }

  return abs;
}

/**
 * Truncate output to MAX_OUTPUT_CHARS with a notice.
 */
function truncate(text: string, limit: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n[Output truncated at ${limit.toLocaleString()} characters. Use more specific commands or read_file with offset/limit.]`
  );
}

// ── Tool handlers ──────────────────────────────────────────────────

function createBashHandler(projectRoot: string): ToolHandler {
  return async (input) => {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? DEFAULT_BASH_TIMEOUT;

    if (!command) {
      return { output: "Error: 'command' parameter is required.", isError: true };
    }

    try {
      const result = await execa("sh", ["-c", command], {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
        env: { ...process.env },
      });

      const output = result.all ?? result.stdout ?? "";
      const exitCode = result.exitCode ?? -1;

      const parts: string[] = [];
      if (exitCode !== 0) {
        parts.push(`Exit code: ${exitCode}`);
      }
      parts.push(output);
      if (result.stderr && !result.all?.includes(result.stderr)) {
        parts.push(`stderr:\n${result.stderr}`);
      }

      return {
        output: truncate(parts.join("\n")),
        isError: exitCode !== 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ETIMEDOUT") || message.includes("timed out")) {
        return {
          output: `Command timed out after ${timeout}ms. Use a longer timeout or a more specific command.`,
          isError: true,
        };
      }
      return { output: `Error executing command: ${message}`, isError: true };
    }
  };
}

function createReadFileHandler(projectRoot: string): ToolHandler {
  return async (input) => {
    const filePath = input.file_path as string;
    if (!filePath) {
      return { output: "Error: 'file_path' parameter is required.", isError: true };
    }

    try {
      const abs = sandboxPath(projectRoot, filePath);
      const content = await readFile(abs, "utf-8");
      const lines = content.split("\n");

      const offset = Math.max(1, (input.offset as number) ?? 1);
      const limit = (input.limit as number) ?? lines.length;

      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice
        .map((line, i) => `${String(offset + i).padStart(6)}\t${line}`)
        .join("\n");

      return { output: truncate(numbered), isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        return { output: `File not found: ${filePath}`, isError: true };
      }
      return { output: `Error reading file: ${message}`, isError: true };
    }
  };
}

function createWriteFileHandler(projectRoot: string): ToolHandler {
  return async (input) => {
    const filePath = input.file_path as string;
    const content = input.content as string;
    if (!filePath) {
      return { output: "Error: 'file_path' parameter is required.", isError: true };
    }
    if (content === undefined || content === null) {
      return { output: "Error: 'content' parameter is required.", isError: true };
    }

    try {
      const abs = sandboxPath(projectRoot, filePath);

      // Create parent directories
      const dir = abs.substring(0, abs.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });

      await writeFile(abs, content, "utf-8");
      const bytes = content.length;
      return {
        output: `Wrote ${bytes} bytes to ${filePath}`,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error writing file: ${message}`, isError: true };
    }
  };
}

function createEditFileHandler(projectRoot: string): ToolHandler {
  return async (input) => {
    const filePath = input.file_path as string;
    const oldText = input.old_text as string;
    const newText = input.new_text as string;

    if (!filePath) {
      return { output: "Error: 'file_path' parameter is required.", isError: true };
    }
    if (!oldText) {
      return { output: "Error: 'old_text' parameter is required.", isError: true };
    }
    if (newText === undefined || newText === null) {
      return { output: "Error: 'new_text' parameter is required.", isError: true };
    }

    try {
      const abs = sandboxPath(projectRoot, filePath);
      const content = await readFile(abs, "utf-8");

      const idx = content.indexOf(oldText);
      if (idx === -1) {
        // Show a snippet of the file to help the agent find the right text
        const preview = content.slice(0, 500);
        return {
          output:
            `Error: old_text not found in ${filePath}. ` +
            `The text must match exactly including whitespace and indentation.\n\n` +
            `File starts with:\n${preview}`,
          isError: true,
        };
      }

      const updated =
        content.slice(0, idx) + newText + content.slice(idx + oldText.length);
      await writeFile(abs, updated, "utf-8");

      return {
        output: `Applied edit to ${filePath}: replaced ${oldText.length} chars with ${newText.length} chars.`,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        return { output: `File not found: ${filePath}`, isError: true };
      }
      return { output: `Error editing file: ${message}`, isError: true };
    }
  };
}

function createGlobHandler(projectRoot: string): ToolHandler {
  return async (input) => {
    const pattern = input.pattern as string;
    if (!pattern) {
      return { output: "Error: 'pattern' parameter is required.", isError: true };
    }

    const searchDir = input.path
      ? sandboxPath(projectRoot, input.path as string)
      : projectRoot;

    try {
      // Use the glob package (already a dependency)
      const { glob } = await import("glob");
      const matches = await glob(pattern, {
        cwd: searchDir,
        nodir: true,
        ignore: ["node_modules/**", ".git/**", "dist/**"],
      });

      if (matches.length === 0) {
        return { output: `No files found matching "${pattern}"`, isError: false };
      }

      const limited = matches.slice(0, MAX_GLOB_RESULTS);
      let output = limited.join("\n");
      if (matches.length > MAX_GLOB_RESULTS) {
        output += `\n\n[${matches.length - MAX_GLOB_RESULTS} more files not shown. Use a more specific pattern.]`;
      }

      return { output, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error during glob: ${message}`, isError: true };
    }
  };
}

function createGrepHandler(projectRoot: string): ToolHandler {
  return async (input) => {
    const pattern = input.pattern as string;
    if (!pattern) {
      return { output: "Error: 'pattern' parameter is required.", isError: true };
    }

    const searchPath = input.path
      ? sandboxPath(projectRoot, input.path as string)
      : projectRoot;

    try {
      const args = ["-rn", "--color=never"];

      // Add context lines
      const context = input.context as number | undefined;
      if (context && context > 0) {
        args.push(`-C`, String(context));
      }

      // Add glob filter
      const globPattern = input.glob as string | undefined;
      if (globPattern) {
        args.push(`--include=${globPattern}`);
      }

      // Always exclude common dirs
      args.push(
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
      );

      args.push(pattern, searchPath);

      const result = await execa("grep", args, {
        cwd: projectRoot,
        reject: false,
        all: true,
        timeout: 30_000,
      });

      const output = result.all ?? result.stdout ?? "";

      if (result.exitCode === 1 && !output.trim()) {
        return { output: `No matches found for pattern "${pattern}"`, isError: false };
      }

      // Limit output lines
      const lines = output.split("\n");
      if (lines.length > MAX_GREP_LINES) {
        const truncated = lines.slice(0, MAX_GREP_LINES).join("\n");
        return {
          output:
            truncated +
            `\n\n[${lines.length - MAX_GREP_LINES} more lines. Use a more specific pattern or glob filter.]`,
          isError: false,
        };
      }

      return { output: truncate(output), isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error during grep: ${message}`, isError: true };
    }
  };
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Create all tool handlers scoped to a project root.
 */
export function createToolHandlers(
  projectRoot: string,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set("bash", createBashHandler(projectRoot));
  handlers.set("read_file", createReadFileHandler(projectRoot));
  handlers.set("write_file", createWriteFileHandler(projectRoot));
  handlers.set("edit_file", createEditFileHandler(projectRoot));
  handlers.set("glob", createGlobHandler(projectRoot));
  handlers.set("grep", createGrepHandler(projectRoot));

  return handlers;
}

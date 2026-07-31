import { execa } from "execa";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ── Git Helpers ────────────────────────────────────────────────────

/**
 * Get the name of the currently checked-out branch.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
  });
  return stdout.trim();
}

/**
 * Create a new branch and check it out.
 */
export async function createBranch(cwd: string, name: string): Promise<void> {
  await execa("git", ["checkout", "-b", name], { cwd });
}

/**
 * Stage all changes and create a commit.
 *
 * @returns The short hash of the new commit.
 */
export async function commitAll(
  cwd: string,
  message: string,
): Promise<string> {
  await execa("git", ["add", "-A"], { cwd });
  await execa("git", ["commit", "-m", message], { cwd });

  const { stdout } = await execa("git", ["rev-parse", "--short", "HEAD"], {
    cwd,
  });
  return stdout.trim();
}

/**
 * Get a list of files changed since a given ref (defaults to HEAD).
 *
 * Returns relative paths as reported by git.
 */
export async function getChangedFiles(
  cwd: string,
  since?: string,
): Promise<string[]> {
  const ref = since ?? "HEAD";
  const { stdout } = await execa(
    "git",
    ["diff", "--name-only", ref],
    { cwd, reject: false },
  );
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Get the unified diff since a given ref (defaults to HEAD).
 */
export async function getDiff(
  cwd: string,
  since?: string,
): Promise<string> {
  const ref = since ?? "HEAD";
  const { stdout } = await execa("git", ["diff", ref], {
    cwd,
    reject: false,
  });
  return stdout;
}

/**
 * Check whether the working tree has uncommitted changes (staged or unstaged).
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execa("git", ["status", "--porcelain"], {
    cwd,
    reject: false,
  });
  return stdout.trim().length > 0;
}

/**
 * Add a new git worktree at the given path on a new branch.
 *
 * Shells out to: git worktree add <path> -b <branch> [<baseBranch>]
 * Throws on non-zero exit (a failed worktree-add must surface as an error).
 */
export async function addWorktree(
  projectRoot: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
): Promise<void> {
  const args = ["worktree", "add", worktreePath, "-b", branch];
  if (baseBranch) args.push(baseBranch);
  await execa("git", args, { cwd: projectRoot });
}

/**
 * Remove a git worktree by path.
 *
 * Shells out to: git worktree remove [-f] <path>
 * Uses reject: false so that removing a worktree that no longer exists
 * does not crash cleanup paths.
 */
export async function removeWorktree(
  projectRoot: string,
  worktreePath: string,
  force?: boolean,
): Promise<void> {
  const args = ["worktree", "remove"];
  if (force) args.push("-f");
  args.push(worktreePath);
  await execa("git", args, { cwd: projectRoot, reject: false });
}

/**
 * Check whether the working tree is clean (no staged or unstaged changes).
 *
 * Returns { clean: true, dirtyFiles: [] } when the tree is clean.
 * Returns { clean: false, dirtyFiles: [...] } listing each dirty path
 * (parsed from `git status --porcelain` — columns 0-1 are the XY status
 * codes, column 2 is a space, then the path starts at column 3).
 */
export async function isClean(
  cwd: string,
): Promise<{ clean: boolean; dirtyFiles: string[] }> {
  const { stdout } = await execa("git", ["status", "--porcelain"], {
    cwd,
    reject: false,
  });
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { clean: true, dirtyFiles: [] };
  }
  // Porcelain format: "XY path" — strip the leading "XY " (3 chars)
  const dirtyFiles = lines.map((l) => l.slice(3).trim());
  return { clean: false, dirtyFiles };
}

/**
 * Deterministically ensure `.gitignore` covers a directory entry.
 *
 * Idempotent: a line is only appended when no existing (trimmed) line
 * already matches `entry`, `entry/`, `/entry`, or `/entry/`. Unrelated
 * lines are never rewritten or reordered. Creates `.gitignore` when it
 * does not exist. This is deterministic TS, never an LLM instruction —
 * gitignore correctness is a safety property, not a documentation task
 * (sc-1-3, nonGoals[3]).
 *
 * @returns Whether a new line was appended.
 */
export async function ensureGitignoreEntry(
  projectRoot: string,
  entry: string,
): Promise<boolean> {
  const gitignorePath = join(projectRoot, ".gitignore");
  const normalized = entry.replace(/^\/+/, "").replace(/\/+$/, "");
  const coveringForms = new Set([
    normalized,
    `${normalized}/`,
    `/${normalized}`,
    `/${normalized}/`,
  ]);

  let content: string;
  try {
    content = await readFile(gitignorePath, "utf-8");
  } catch {
    content = "";
  }

  const alreadyCovered = content
    .split("\n")
    .some((line) => coveringForms.has(line.trim()));

  if (alreadyCovered) {
    return false;
  }

  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  const appended = `${content}${separator}${normalized}/\n`;
  await writeFile(gitignorePath, appended, "utf-8");
  return true;
}


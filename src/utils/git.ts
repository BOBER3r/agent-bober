import { execa } from "execa";

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
 * Stash any current changes, run the provided function, then restore.
 *
 * If the stash is empty (nothing to save) the restore step is skipped.
 */
export async function stashAndRestore<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dirty = await hasUncommittedChanges(cwd);

  if (dirty) {
    await execa("git", ["stash", "push", "-m", "bober-auto-stash"], { cwd });
  }

  try {
    return await fn();
  } finally {
    if (dirty) {
      await execa("git", ["stash", "pop"], { cwd, reject: false });
    }
  }
}

/**
 * Scanner: Git Conventions
 *
 * Analyzes git history and branches to detect:
 * - Commit message format (conventional commits, custom prefixes)
 * - Branch naming patterns
 * - Merge strategy
 */

import { join } from "node:path";
import { execa } from "execa";
import { fileExists } from "../../utils/fs.js";
import type { GitConventionsReport } from "../types.js";

// ── Commit message analysis ───────────────────────────────────────

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?:/i;

const MERGE_COMMIT_RE = /^Merge (branch|pull request|remote)/i;

/**
 * Extracts the prefix/type from a commit message.
 * Returns e.g. "feat:", "bober(sprint-1):", "JIRA-123:".
 */
function extractPrefix(message: string): string | null {
  // Conventional commits: feat(scope): or feat:
  const conventional = /^[a-zA-Z]+(\([^)]+\))?:/.exec(message);
  if (conventional) return conventional[0];

  // Ticket prefix: JIRA-123, ABC-456
  const ticket = /^[A-Z]+-\d+/.exec(message);
  if (ticket) return ticket[0];

  return null;
}

function detectMostCommonPrefix(messages: string[]): string | null {
  const prefixCounts = new Map<string, number>();

  for (const msg of messages) {
    const prefix = extractPrefix(msg);
    if (prefix) {
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }

  if (prefixCounts.size === 0) return null;

  let topPrefix = "";
  let topCount = 0;
  for (const [prefix, count] of prefixCounts) {
    if (count > topCount) {
      topPrefix = prefix;
      topCount = count;
    }
  }

  return topPrefix || null;
}

// ── Branch pattern analysis ───────────────────────────────────────

/**
 * Groups branch names into patterns like "feature/*", "bober/*", etc.
 */
function detectBranchPatterns(branches: string[]): string[] {
  const prefixCounts = new Map<string, number>();

  for (const branch of branches) {
    // Strip remote prefix (remotes/origin/)
    const clean = branch.replace(/^remotes\/[^/]+\//, "").trim();
    if (!clean || clean === "HEAD") continue;

    const slashIdx = clean.indexOf("/");
    if (slashIdx > 0) {
      const prefix = clean.substring(0, slashIdx);
      prefixCounts.set(prefix + "/*", (prefixCounts.get(prefix + "/*") ?? 0) + 1);
    }
  }

  // Return patterns with at least 1 occurrence, sorted by frequency
  return Array.from(prefixCounts.entries())
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern]) => pattern);
}

// ── Main scanner ──────────────────────────────────────────────────

export async function scanGitConventions(
  projectRoot: string,
): Promise<GitConventionsReport | null> {
  // Check for .git directory
  const gitDir = join(projectRoot, ".git");
  if (!(await fileExists(gitDir))) {
    return null;
  }

  // Fetch git log
  let recentMessages: string[];
  try {
    const { stdout } = await execa(
      "git",
      ["log", "--oneline", "-50"],
      { cwd: projectRoot },
    );
    recentMessages = stdout
      .split("\n")
      .map((line) => {
        // Remove the short hash prefix (first 7-8 chars)
        const spaceIdx = line.indexOf(" ");
        return spaceIdx > 0 ? line.substring(spaceIdx + 1).trim() : line.trim();
      })
      .filter((msg) => msg.length > 0);
  } catch {
    // Git command failed (no commits, etc.)
    return null;
  }

  // Fetch branches
  let branches: string[] = [];
  try {
    const { stdout } = await execa("git", ["branch", "-a"], { cwd: projectRoot });
    branches = stdout
      .split("\n")
      .map((b) => b.replace(/^\*?\s+/, "").trim())
      .filter((b) => b.length > 0);
  } catch {
    // Non-fatal
  }

  // Analyze commit messages
  const mergeCommits = recentMessages.filter((m) => MERGE_COMMIT_RE.test(m));
  const nonMergeMessages = recentMessages.filter((m) => !MERGE_COMMIT_RE.test(m));

  const conventionalCount = nonMergeMessages.filter((m) =>
    CONVENTIONAL_COMMIT_RE.test(m),
  ).length;

  const usesConventionalCommits =
    nonMergeMessages.length > 0 &&
    conventionalCount / nonMergeMessages.length >= 0.5;

  const mergeCommitRatio =
    recentMessages.length > 0
      ? mergeCommits.length / recentMessages.length
      : 0;

  return {
    usesConventionalCommits,
    mostCommonPrefix: detectMostCommonPrefix(nonMergeMessages),
    recentMessages,
    branchPatterns: detectBranchPatterns(branches),
    branches,
    hasLinearHistory: mergeCommitRatio < 0.05,
    mergeCommitRatio,
  };
}

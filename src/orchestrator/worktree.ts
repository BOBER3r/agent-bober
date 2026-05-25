// ── worktree.ts ───────────────────────────────────────────────────────
//
// runInWorktree(task, projectRoot, config, opts) creates a git worktree
// under <projectRoot>/<pipeline.worktreeRoot>/<runId>, kicks off the
// pipeline INSIDE that worktree (passing worktreePath as the new projectRoot),
// then cleans up per policy on success or retains on failure.
//
// Sprint 4 (cockpit-integration)

import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";

import type { BoberConfig } from "../config/schema.js";
import { runPipeline, type PipelineResult } from "./pipeline.js";
import { runManager } from "../mcp/run-manager.js";
import { addWorktree, removeWorktree, isClean, getCurrentBranch } from "../utils/git.js";
import { logger } from "../utils/logger.js";

// ── Slug derivation ────────────────────────────────────────────────────
//
// Matches the generator.branchPattern '{feature-name}' substitution.
// Takes first 60 chars of the task, lowercases, replaces non-alphanumeric
// runs with '-', strips leading/trailing dashes.
// If the resulting slug is empty (e.g. all-emoji task), falls back to a
// short prefix so branch names are always valid.

export function deriveWorktreeSlug(task: string): string {
  const slug = task
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "run";
}

// ── Types ─────────────────────────────────────────────────────────────

export interface RunInWorktreeOpts {
  /** When true, skip the dirty-tree check and allow worktree creation anyway. Default false. */
  allowDirty?: boolean;
  /** When true, retain the worktree on success (overrides pipeline.cleanupWorktreeOnSuccess). Default false. */
  keepOnSuccess?: boolean;
  /** Injected pipelineFn for testing. Defaults to the real runPipeline. */
  pipelineFn?: (
    task: string,
    projectRoot: string,
    config: BoberConfig,
  ) => Promise<PipelineResult>;
}

export interface RunInWorktreeResult {
  runId: string;
  branch: string;
  worktreePath: string;
}

// ── .gitignore check ──────────────────────────────────────────────────

async function isBoberGitignored(projectRoot: string): Promise<boolean> {
  try {
    const gitignore = await readFile(join(projectRoot, ".gitignore"), "utf-8");
    // Check if any line matches .bober or .bober/
    return gitignore.split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed === ".bober" || trimmed === ".bober/" || trimmed === "/.bober" || trimmed === "/.bober/";
    });
  } catch {
    return false;
  }
}

// ── Main entry point ───────────────────────────────────────────────────

export async function runInWorktree(
  task: string,
  projectRoot: string,
  config: BoberConfig,
  opts: RunInWorktreeOpts = {},
): Promise<RunInWorktreeResult> {
  // 1. Dirty-tree guard
  if (!opts.allowDirty) {
    const { clean, dirtyFiles } = await isClean(projectRoot);
    if (!clean) {
      throw new Error(
        `Working tree has uncommitted changes:\n  ${dirtyFiles.join("\n  ")}\n` +
          `Pass --allow-dirty (CLI) or allowDirty=true (MCP) to override.`,
      );
    }
  }

  // 2. Determine baseline branch (current HEAD or 'main' fallback)
  let baseBranch: string;
  let isDetached = false;
  try {
    const cur = await getCurrentBranch(projectRoot);
    if (cur === "HEAD") {
      // Detached HEAD
      isDetached = true;
      baseBranch = "main";
    } else {
      baseBranch = cur;
    }
  } catch {
    isDetached = true;
    baseBranch = "main";
  }

  if (isDetached) {
    process.stderr.write(
      `[runInWorktree] Detached HEAD detected — falling back to baseline 'main'.\n`,
    );
  }

  // Warn if .bober/ is not gitignored (soft check, not a hard error)
  const gitignored = await isBoberGitignored(projectRoot);
  if (!gitignored) {
    process.stderr.write(
      `[runInWorktree] Warning: .bober/ is not in .gitignore — ` +
        `the worktree directory will appear as a tracked path. ` +
        `Consider adding '.bober/' to .gitignore.\n`,
    );
  }

  // 3. Derive runId, branch name, worktree path
  const runId = randomUUID();
  const slug = deriveWorktreeSlug(task);
  const branchPattern = config.generator.branchPattern ?? "bober/{feature-name}";
  const branch = branchPattern.replace("{feature-name}", slug);
  const worktreeRootRel = config.pipeline.worktreeRoot ?? ".bober/worktrees";
  const worktreeRootAbs = isAbsolute(worktreeRootRel)
    ? worktreeRootRel
    : join(projectRoot, worktreeRootRel);
  const worktreePath = join(worktreeRootAbs, runId);

  // 4. Create worktree via git CLI
  await addWorktree(projectRoot, worktreePath, branch, baseBranch);

  // 5. Kick off pipeline INSIDE the worktree (worktreePath becomes the new projectRoot)
  const cleanupOnSuccess =
    !opts.keepOnSuccess && config.pipeline.cleanupWorktreeOnSuccess !== false;

  const pipelineFn = opts.pipelineFn ?? runPipeline;

  // Wrap pipelineFn so we can intercept resolution and run cleanup.
  // CRITICAL: pipelineFn is called with worktreePath as projectRoot, NOT the original.
  const wrapped = async (t: string, _root: string, c: BoberConfig) => {
    try {
      const result = await pipelineFn(t, worktreePath, c);
      if (result.success && cleanupOnSuccess) {
        try {
          await removeWorktree(projectRoot, worktreePath);
        } catch (e) {
          logger.warn(
            `[runInWorktree] worktree cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } else if (!result.success) {
        process.stderr.write(
          `[runInWorktree] Pipeline failed — worktree retained for debugging: ${worktreePath}\n`,
        );
      }
      return result;
    } catch (err) {
      // On throw, ALWAYS retain
      process.stderr.write(
        `[runInWorktree] Pipeline crashed — worktree retained for debugging: ${worktreePath}\n`,
      );
      throw err;
    }
  };

  await runManager.startRun(task, projectRoot, config, wrapped, {
    runId,
    worktreePath,
    branch,
  });

  return { runId, branch, worktreePath };
}

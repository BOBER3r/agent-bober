/**
 * Renderer for `generator-diff` artifacts.
 *
 * Shows: git diff --stat of the sprint's commits, list of files changed
 * (created/modified/deleted), commit count, and per-file diff (truncated
 * at 50 lines per file). Skips binary files (lists but does not render inline).
 *
 * This is the ONLY renderer allowed to shell out (to git).
 * All git calls go through the GitClient interface for testability.
 *
 * Exports two functions:
 *   - `renderGeneratorDiff(artifact)` — SYNC, no git I/O, uses filesChanged list only.
 *     Used by the registry dispatch (sync constraint).
 *   - `renderGeneratorDiffAsync(artifact, git?)` — ASYNC, full git diff.
 *     May be called directly by mechanisms that can await.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import { execa } from "execa";
import { applyLineCap } from "./_util.js";

const MAX_LINES_PER_FILE = 50;

/** Mockable seam for git operations — mirrors GhClient pattern in pr.ts. */
export interface GitClient {
  diffStat(base: string, head: string, cwd: string): Promise<string>;
  diffNumstat(
    base: string,
    head: string,
    cwd: string,
  ): Promise<Array<{ added: string; deleted: string; path: string }>>;
  diffFile(
    filePath: string,
    base: string,
    head: string,
    cwd: string,
  ): Promise<string>;
  revListCount(base: string, head: string, cwd: string): Promise<number>;
}

/** Default GitClient implementation — wraps execa. */
export function createGitClient(): GitClient {
  return {
    async diffStat(base, head, cwd) {
      const r = await execa(
        "git",
        ["diff", "--stat", `${base}..${head}`],
        { cwd, reject: false },
      );
      return r.stdout ?? "";
    },
    async diffNumstat(base, head, cwd) {
      const r = await execa(
        "git",
        ["diff", "--numstat", `${base}..${head}`],
        { cwd, reject: false },
      );
      const lines = (r.stdout ?? "").split("\n").filter(Boolean);
      return lines.map((line) => {
        const parts = line.split("\t");
        return {
          added: parts[0] ?? "-",
          deleted: parts[1] ?? "-",
          path: parts[2] ?? "",
        };
      });
    },
    async diffFile(filePath, base, head, cwd) {
      const r = await execa(
        "git",
        ["diff", "--unified=3", `${base}..${head}`, "--", filePath],
        { cwd, reject: false },
      );
      return r.stdout ?? "";
    },
    async revListCount(base, head, cwd) {
      const r = await execa(
        "git",
        ["rev-list", "--count", `${base}..${head}`],
        { cwd, reject: false },
      );
      const n = parseInt((r.stdout ?? "").trim(), 10);
      return isNaN(n) ? 0 : n;
    },
  };
}

interface GeneratorDiffArtifact {
  type?: string;
  commit?: string;
  baseRef?: string;
  headRef?: string;
  filesChanged?: Array<{ path: string; action: string }>;
  cwd?: string;
}

/**
 * Render a `generator-diff` artifact as markdown (SYNC version).
 *
 * Only uses the `filesChanged` list from the artifact — no git I/O.
 * This is what the registry dispatch calls (sync constraint).
 */
export function renderGeneratorDiff(artifact: unknown): string {
  const a = (artifact ?? {}) as GeneratorDiffArtifact;
  const filesChanged = a.filesChanged ?? [];
  const commit = a.commit ?? a.headRef ?? "unknown";

  const lines: string[] = [
    `## Generator Diff`,
    ``,
    `- **Commit:** \`${commit}\``,
    ``,
  ];

  if (filesChanged.length > 0) {
    lines.push(`### Files changed (${filesChanged.length})`);
    for (const f of filesChanged) {
      lines.push(`- \`${f.path}\` (${f.action})`);
    }
    lines.push(``);
  } else {
    lines.push(`_No files listed in artifact._`);
    lines.push(``);
  }

  return lines.join("\n");
}

/**
 * Render a `generator-diff` artifact as markdown (ASYNC version with git I/O).
 *
 * When baseRef/headRef are available, shells out to git for stat and per-file diffs.
 * Falls back to showing just the filesChanged list when refs are unavailable.
 *
 * @param artifact - The generator-diff artifact.
 * @param git      - Injectable GitClient (default: createGitClient()).
 */
export async function renderGeneratorDiffAsync(
  artifact: unknown,
  git: GitClient = createGitClient(),
): Promise<string> {
  const a = (artifact ?? {}) as GeneratorDiffArtifact;
  const filesChanged = a.filesChanged ?? [];
  const cwd = a.cwd ?? process.cwd();

  const lines: string[] = [`## Generator Diff`, ``];

  // If we have refs, shell out for stat and per-file diffs.
  const baseRef = a.baseRef;
  const headRef = a.headRef ?? a.commit ?? "HEAD";

  if (baseRef) {
    try {
      const commitCount = await git.revListCount(baseRef, headRef, cwd);
      lines.push(`- **Commits:** ${commitCount}`);
      lines.push(``);

      const stat = await git.diffStat(baseRef, headRef, cwd);
      if (stat.trim()) {
        lines.push(`### Diff stat`);
        lines.push("```");
        lines.push(stat.trim());
        lines.push("```");
        lines.push(``);
      }

      // Get numstat to identify binary files
      const numstat = await git.diffNumstat(baseRef, headRef, cwd);
      const binaryPaths = new Set(
        numstat.filter((e) => e.added === "-" && e.deleted === "-").map((e) => e.path),
      );
      const textPaths = numstat
        .filter((e) => e.added !== "-" || e.deleted !== "-")
        .map((e) => e.path);

      if (binaryPaths.size > 0) {
        lines.push(`### Binary files (not rendered inline)`);
        for (const p of binaryPaths) {
          lines.push(`- \`${p}\``);
        }
        lines.push(``);
      }

      // Per-file diffs (text files only, truncated at 50 lines)
      if (textPaths.length > 0) {
        lines.push(`### Per-file diffs`);
        lines.push(``);
        for (const filePath of textPaths.slice(0, 10)) {
          const fileDiff = await git.diffFile(filePath, baseRef, headRef, cwd);
          const diffLines = fileDiff.split("\n");
          const truncated = applyLineCap(
            diffLines.join("\n"),
            MAX_LINES_PER_FILE,
            `${filePath}:1`,
          );
          lines.push(`#### \`${filePath}\``);
          lines.push("```diff");
          lines.push(truncated);
          lines.push("```");
          lines.push(``);
        }
      }
    } catch {
      // If git fails, fall through to file list
    }
  }

  // Always show the filesChanged list from the artifact
  if (filesChanged.length > 0) {
    lines.push(`### Files changed (${filesChanged.length})`);
    for (const f of filesChanged) {
      lines.push(`- \`${f.path}\` (${f.action})`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

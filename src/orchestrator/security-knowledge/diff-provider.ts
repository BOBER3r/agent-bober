import { execa } from "execa";
import { Buffer } from "node:buffer";

import type { BoberConfig } from "../../config/schema.js";
import { logger } from "../../utils/logger.js";
import { getGraphState, getGraphDeps } from "../tools/index.js";

/**
 * Orchestrator-owned real-diff provider (spec-20260714 sprint 6, ADR-5).
 *
 * Shells `git` in orchestrator Node — NEVER as an auditor tool — to compute
 * the actual changed files/hunks for a sprint, replacing the sprint-5 seam
 * that ranked signatures against `contract.estimatedFiles` only. Mirrors
 * `security-scanners.ts`'s injectable never-throw runner shape exactly
 * (Pattern A): any git failure (ENOENT, not-a-repo, abort, malformed
 * output) degrades to an empty `AuditDiff` rather than throwing, so a
 * broken git environment never crashes the audit — it just falls back to
 * `estimated-files` behavior.
 *
 * `AuditDiff` is the shared input type future sprints (7: supply-chain,
 * 8: verifier) will also consume — kept clean and exported.
 */

// ── AuditDiff data model ──────────────────────────────────────────────

export interface DiffHunk {
  startLine: number;
  lineCount: number;
  content: string;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
}

export interface AuditDiff {
  changedFiles: ChangedFile[];
  neighborhoodFiles: string[];
  truncated: boolean;
}

export const EMPTY_DIFF: AuditDiff = { changedFiles: [], neighborhoodFiles: [], truncated: false };

// ── Injectable git runner (keeps tests off real git — mirrors ScannerRunner) ──

export interface GitRunResult {
  exitCode: number | undefined;
  stdout: string;
  failed: boolean;
}

export type GitRunner = (
  args: string[],
  opts: { cwd: string; signal: AbortSignal },
) => Promise<GitRunResult>;

// bober: caps mirror security-scanners.ts's MAX_SCANNER_BUFFER rationale —
// an unbounded diff (huge rewrite, vendored-file commit) cannot blow the
// auditor prompt or exhaust memory; it degrades to truncated:true instead.
const MAX_CHANGED_FILES = 60;
const MAX_HUNK_BYTES = 256 * 1024; // total across all hunks
const DIFF_CONTEXT_LINES = 3;
const MAX_GIT_BUFFER = 1024 * 1024 * 10;

/**
 * Default runner: wraps execa with the EXACT options used by
 * `security-scanners.ts`'s `defaultRunner` (cancelSignal ties the child's
 * lifetime to the shared audit AbortSignal, SIGKILL on cancel/abort,
 * `reject: false` so a missing `git` binary or nonzero exit resolves
 * normally instead of throwing).
 */
const defaultGitRunner: GitRunner = async (args, opts) => {
  const result = await execa("git", args, {
    cwd: opts.cwd,
    cancelSignal: opts.signal,
    killSignal: "SIGKILL",
    reject: false,
    all: true,
    maxBuffer: MAX_GIT_BUFFER,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  return {
    exitCode: result.exitCode,
    stdout: result.all ?? result.stdout ?? "",
    failed: result.failed,
  };
};

// ── baseRef resolution (merge-base w/ default branch, HEAD~1 fallback) ──

async function resolveDefaultBranchRef(
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const symbolic = await runner(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
    signal,
  });
  if (!symbolic.failed && symbolic.exitCode === 0) {
    const ref = symbolic.stdout.trim();
    if (ref) return ref;
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const check = await runner(["rev-parse", "--verify", "-q", candidate], { cwd, signal });
    if (!check.failed && check.exitCode === 0) return candidate;
  }

  return undefined;
}

/**
 * Resolves the base ref to diff against: the explicit `baseRef` when given,
 * else the merge-base with the detected default branch, else `HEAD~1`.
 * Never throws — every git call goes through the never-throw `runner`.
 */
async function resolveBaseRef(
  runner: GitRunner,
  cwd: string,
  signal: AbortSignal,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;

  const defaultBranch = await resolveDefaultBranchRef(runner, cwd, signal);
  if (defaultBranch) {
    const mergeBase = await runner(["merge-base", defaultBranch, "HEAD"], { cwd, signal });
    if (!mergeBase.failed && mergeBase.exitCode === 0 && mergeBase.stdout.trim()) {
      return mergeBase.stdout.trim();
    }
  }

  return "HEAD~1";
}

// ── Pure parsing helpers (never throw; feed ranking, not correctness) ──

function parseNameStatus(raw: string): Map<string, ChangedFile["status"]> {
  const map = new Map<string, ChangedFile["status"]>();
  if (typeof raw !== "string" || !raw) return map;

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("\t").filter(Boolean);
    if (parts.length < 2) continue;

    const code = parts[0];
    let status: ChangedFile["status"];
    let path: string | undefined;

    if (code.startsWith("R") || code.startsWith("C")) {
      // rename/copy: "R100\told\tnew" — key by the new path.
      status = "renamed";
      path = parts[2] ?? parts[1];
    } else if (code.startsWith("A")) {
      status = "added";
      path = parts[1];
    } else if (code.startsWith("D")) {
      status = "deleted";
      path = parts[1];
    } else {
      status = "modified";
      path = parts[1];
    }

    if (path) map.set(path, status);
  }

  return map;
}

function parseHunkHeader(line: string): { startLine: number; lineCount: number } {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return {
    startLine: match ? Number(match[1]) : 0,
    lineCount: match && match[2] ? Number(match[2]) : 1,
  };
}

function parseHunks(raw: string): Map<string, DiffHunk[]> {
  const map = new Map<string, DiffHunk[]>();
  if (typeof raw !== "string" || !raw) return map;

  let currentPath: string | undefined;
  let pendingOldPath: string | undefined;
  let currentHunk: DiffHunk | undefined;
  let currentLines: string[] = [];

  const flushHunk = () => {
    if (currentPath && currentHunk) {
      currentHunk.content = currentLines.join("\n");
      const arr = map.get(currentPath) ?? [];
      arr.push(currentHunk);
      map.set(currentPath, arr);
    }
    currentHunk = undefined;
    currentLines = [];
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushHunk();
      currentPath = undefined;
      pendingOldPath = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      const m = /^--- a\/(.+)$/.exec(line);
      pendingOldPath = m ? m[1] : undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      // A deleted file's "+++" side is "/dev/null" — fall back to the "---" path.
      currentPath = m ? m[1] : pendingOldPath;
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      const { startLine, lineCount } = parseHunkHeader(line);
      currentHunk = { startLine, lineCount, content: "" };
      currentLines = [line];
      continue;
    }
    if (currentHunk) {
      currentLines.push(line);
    }
  }
  flushHunk();

  return map;
}

/**
 * Parse `git diff --name-status` + `git diff -U<n>` output into
 * `ChangedFile[]`, bounded by `MAX_CHANGED_FILES` (file count) and
 * `MAX_HUNK_BYTES` (total hunk content bytes). Pure and total — any
 * structural surprise (non-string input, malformed lines) is skipped
 * rather than thrown (Pattern B, mirrors `parseSlitherOutput`).
 */
export function parseUnifiedDiff(
  nameStatus: string,
  unified: string,
): { files: ChangedFile[]; truncated: boolean } {
  const statusMap = parseNameStatus(nameStatus);
  const hunksByPath = parseHunks(unified);

  let truncated = false;

  let paths = Array.from(statusMap.keys());
  if (paths.length > MAX_CHANGED_FILES) {
    paths = paths.slice(0, MAX_CHANGED_FILES);
    truncated = true;
  }

  const files: ChangedFile[] = [];
  let totalBytes = 0;

  for (const path of paths) {
    const status = statusMap.get(path) ?? "modified";
    const hunks = hunksByPath.get(path) ?? [];

    const boundedHunks: DiffHunk[] = [];
    for (const hunk of hunks) {
      const hunkBytes = Buffer.byteLength(hunk.content, "utf8");
      if (totalBytes + hunkBytes > MAX_HUNK_BYTES) {
        truncated = true;
        break;
      }
      boundedHunks.push(hunk);
      totalBytes += hunkBytes;
    }
    if (boundedHunks.length < hunks.length) truncated = true;

    files.push({ path, status, hunks: boundedHunks });
  }

  return { files, truncated };
}

// bober: substring list, not a grammar — cheap and total, good enough to
// hint the selector's keyword-overlap ranking (selector.ts:20-23); it need
// not be perfect (assumptions[2]).
const NOTABLE_SUBSTRINGS = [
  ".raw(",
  "FOR UPDATE",
  "postinstall",
  "ecrecover",
  "dangerouslySetInnerHTML",
  "eval(",
  "exec(",
  "child_process",
  "SELECT ",
  "DROP TABLE",
  "innerHTML",
  "__proto__",
];

/**
 * Tokenizes changed-hunk text into keywords for the selector's
 * keyword-overlap ranking (selector.ts). Pure and total: guards every
 * field access, never throws on malformed hunk content.
 */
export function extractDiffKeywords(files: ChangedFile[]): string[] {
  if (!Array.isArray(files)) return [];

  const keywords = new Set<string>();

  for (const file of files) {
    const hunks = Array.isArray(file?.hunks) ? file.hunks : [];
    for (const hunk of hunks) {
      const content = typeof hunk?.content === "string" ? hunk.content : "";
      if (!content) continue;

      for (const needle of NOTABLE_SUBSTRINGS) {
        if (content.includes(needle)) keywords.add(needle);
      }

      for (const line of content.split("\n")) {
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (!line.startsWith("+") && !line.startsWith("-")) continue;
        const tokens = line.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
        for (const token of tokens) keywords.add(token);
      }
    }
  }

  return Array.from(keywords);
}

// ── Graph neighborhood expansion (sc-6-2, opt-in-within-opt-in) ────────

/**
 * Expands `changedFiles` into a call-graph neighborhood via
 * `GraphClient.impact` when the graph engine is ready. A per-file impact
 * miss (`{ok:false}` or a thrown call) never drops the others — each file
 * is isolated, mirroring the scanner pre-filter's per-scanner isolation.
 */
async function collectGraphNeighborhood(paths: string[], signal: AbortSignal): Promise<string[]> {
  const deps = getGraphDeps();
  if (!deps) return [];

  const neighborhood = new Set<string>();

  await Promise.all(
    paths.map(async (path) => {
      if (signal.aborted) return;
      try {
        const result = await deps.client.impact(path);
        if (result.ok) {
          for (const node of result.data.affected) {
            neighborhood.add(node.file);
          }
        }
      } catch {
        // one path's graph miss never drops the others (or the git-derived changedFiles).
      }
    }),
  );

  return Array.from(neighborhood);
}

// ── SecurityDiffProvider ────────────────────────────────────────────────

export interface SecurityDiffComputeInput {
  projectRoot: string;
  baseRef?: string;
  expandWithGraph: boolean;
  signal: AbortSignal;
  /** Needed for the `getGraphState(config).engineHealth === 'ready'` gate (sc-6-2). */
  config?: BoberConfig;
  /** Injected in tests — default wraps execa. */
  runner?: GitRunner;
}

export interface SecurityDiffProvider {
  compute(input: SecurityDiffComputeInput): Promise<AuditDiff>;
}

/**
 * Computes a real, bounded `AuditDiff` by shelling git in orchestrator
 * Node. NEVER throws: any failure (missing git, not-a-repo, abort,
 * malformed diff output) degrades to `EMPTY_DIFF`, which callers treat as
 * "fall back to estimated-files" rather than an audit-crashing error.
 */
export const securityDiffProvider: SecurityDiffProvider = {
  async compute(input) {
    const {
      projectRoot,
      baseRef: explicitBaseRef,
      expandWithGraph,
      signal,
      config,
      runner = defaultGitRunner,
    } = input;

    try {
      if (signal.aborted) return EMPTY_DIFF;

      const baseRef = await resolveBaseRef(runner, projectRoot, signal, explicitBaseRef);

      const nameStatusResult = await runner(["diff", "--name-status", baseRef], {
        cwd: projectRoot,
        signal,
      });
      if (nameStatusResult.failed) {
        logger.debug(
          `[security-diff-provider] git diff --name-status against "${baseRef}" failed — degrading to empty diff`,
        );
        return EMPTY_DIFF;
      }

      const unifiedResult = await runner(["diff", `-U${DIFF_CONTEXT_LINES}`, baseRef], {
        cwd: projectRoot,
        signal,
      });
      if (unifiedResult.failed) {
        logger.debug(
          `[security-diff-provider] git diff -U${DIFF_CONTEXT_LINES} against "${baseRef}" failed — degrading to empty diff`,
        );
        return EMPTY_DIFF;
      }

      const { files, truncated } = parseUnifiedDiff(nameStatusResult.stdout, unifiedResult.stdout);

      let neighborhoodFiles: string[] = [];
      if (expandWithGraph && getGraphState(config).engineHealth === "ready") {
        neighborhoodFiles = await collectGraphNeighborhood(
          files.map((f) => f.path),
          signal,
        );
      }

      return { changedFiles: files, neighborhoodFiles, truncated };
    } catch (err) {
      logger.debug(
        `[security-diff-provider] compute threw: ${err instanceof Error ? err.message : String(err)} — degrading to empty diff`,
      );
      return EMPTY_DIFF;
    }
  },
};

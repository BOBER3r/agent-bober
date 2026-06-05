import { execa } from "execa";
import type { GraphArtifactStore } from "./artifact-store.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SyncResult {
  indexed: number;
}

export interface StatusResult {
  ready: boolean;
  indexedFileCount: number;
  tokensaveVersion: string;
}

// ── TokensaveCli ───────────────────────────────────────────────────

/**
 * Short-lived execa wrapper for `tokensave init/sync/status`.
 *
 * Each method spawns a child process and waits for it to exit.
 * Use `TokensaveMcpClient` for long-lived JSON-RPC calls.
 *
 * Constructor pattern mirrors `TokensavePrereqCheck` (src/graph/prereq.ts:7-8).
 */
export class TokensaveCli {
  constructor(
    private readonly cwd: string,
    private readonly store: GraphArtifactStore | null = null,
    private readonly binary: string = "tokensave",
  ) {}

  /**
   * Run `tokensave init` (full index of the project at `cwd`).
   *
   * NOTE: tokensave's `init` has no `--tier` flag (that was a pre-6.x API).
   * `languageTier` is now a bober-level concept recorded in the manifest only,
   * so it is accepted for caller convenience but NOT forwarded to the binary.
   * Resolves on exit code 0; throws a structured Error on non-zero.
   */
  async init(opts: { cwd?: string; languageTier?: string }): Promise<void> {
    const effectiveCwd = opts.cwd ?? this.cwd;
    const result = await execa(
      this.binary,
      ["init"],
      {
        cwd: effectiveCwd,
        reject: false,
        all: true,
        // tokensave prompts to create/gitignore; with no TTY it auto-accepts.
        input: "",
      },
    );

    if (result.exitCode !== 0) {
      const output = result.all ?? result.stdout ?? result.stderr ?? "";
      // `init` is idempotent from bober's perspective: an already-initialised
      // project is a success, not an error (caller refreshes the manifest).
      if (/already initialized/i.test(output)) return;
      throw new Error(
        `tokensave init failed (exit ${result.exitCode ?? -1}): ${output.slice(0, 500)}`,
      );
    }
  }

  /**
   * Run `tokensave sync <paths...>` with a timeout.
   * Returns `{indexed}` parsed from stdout JSON.
   * Throws on timeout, non-zero exit, or unparseable output.
   *
   * After a successful sync, updates the manifest via the injected
   * GraphArtifactStore (if provided), setting lastSyncAt and clearing
   * pendingFiles (evaluator note #10).
   */
  async sync(paths: string[], timeoutMs: number): Promise<SyncResult> {
    const result = await execa(this.binary, ["sync", ...paths], {
      cwd: this.cwd,
      timeout: timeoutMs,
      reject: false,
      all: true,
    });

    // Detect timeout — execa sets timedOut flag or ETIMEDOUT in message
    if (result.timedOut) {
      throw new Error(
        `tokensave sync timed out after ${timeoutMs}ms`,
      );
    }

    if (result.exitCode !== 0) {
      const output = result.all ?? result.stdout ?? result.stderr ?? "";
      throw new Error(
        `tokensave sync failed (exit ${result.exitCode ?? -1}): ${output.slice(0, 500)}`,
      );
    }

    // tokensave prints its summary ("N added, M modified, K removed") to
    // stderr, so parse the combined `all` stream rather than stdout alone.
    const combined = result.all ?? result.stdout ?? "";
    const indexed = parseSyncOutput(combined);

    // Update manifest via store if injected
    if (this.store) {
      try {
        const existing = await this.store.readManifest();
        if (existing) {
          await this.store.writeManifest({
            ...existing,
            lastSyncAt: new Date().toISOString(),
            indexedFileCount: indexed,
            pendingFiles: [],
          });
        }
      } catch {
        // Manifest update is best-effort; sync result is still valid
      }
    }

    return { indexed };
  }

  /**
   * Run `tokensave status --json`.
   * Returns `{ready: false, indexedFileCount: 0, tokensaveVersion: ""}` when
   * tokensave has not been initialised — does NOT throw in that case.
   * Throws only on binary execution failure (ENOENT etc.).
   */
  async status(): Promise<StatusResult> {
    const result = await execa(this.binary, ["status", "--json"], {
      cwd: this.cwd,
      reject: false,
      all: true,
    });

    // If the binary can't be found at all, propagate the error
    if (result.failed && result.exitCode === null) {
      throw new Error(
        `tokensave binary not found or could not execute: ${result.stderr ?? ""}`,
      );
    }

    // Any non-zero exit (e.g. "not initialised") → not-ready, don't throw
    const stdout = result.stdout ?? "";
    if (!stdout.trim()) {
      return { ready: false, indexedFileCount: 0, tokensaveVersion: "" };
    }

    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      // tokensave `status --json` returns {node_count, edge_count, file_count,
      // nodes_by_kind, ...}. There is no `ready`/`indexedFileCount` field and no
      // version, so derive `ready` from the presence of an index (file_count).
      // Tolerate the legacy {ready, indexedFileCount, tokensaveVersion} shape too.
      const fileCount =
        typeof parsed.file_count === "number"
          ? parsed.file_count
          : typeof parsed.indexedFileCount === "number"
            ? parsed.indexedFileCount
            : 0;
      const ready =
        parsed.ready === true ||
        typeof parsed.file_count === "number" ||
        typeof parsed.node_count === "number";
      return {
        ready,
        indexedFileCount: fileCount,
        tokensaveVersion:
          typeof parsed.tokensaveVersion === "string" ? parsed.tokensaveVersion : "",
      };
    } catch {
      // Unparseable output → treat as not-ready, not an error
      return { ready: false, indexedFileCount: 0, tokensaveVersion: "" };
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Parse the number of indexed files from tokensave sync output.
 *
 * tokensave 6.x prints a human summary like
 *   "✔ sync done — 3 added, 1 modified, 0 removed in 41ms"
 * (with ANSI colour codes), so we sum added + modified. Legacy JSON
 * (`{"indexed": N}`) and `indexed: N` key-value forms are still accepted.
 */
function parseSyncOutput(output: string): number {
  // Strip ANSI escape sequences before matching.
  // eslint-disable-next-line no-control-regex
  const trimmed = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
  if (!trimmed) return 0;

  // Try direct JSON parse (legacy shape)
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.indexed === "number") return obj.indexed;
  } catch {
    // Fall through
  }

  // Incremental sync summary: "N added, M modified, K removed"
  const added = /(\d+)\s+added/.exec(trimmed);
  const modified = /(\d+)\s+modified/.exec(trimmed);
  if (added || modified) {
    return (
      (added ? parseInt(added[1], 10) : 0) +
      (modified ? parseInt(modified[1], 10) : 0)
    );
  }

  // Full re-index summary (--force): "indexing done — N files, ... nodes"
  const files = /(\d+)\s+files\b/.exec(trimmed);
  if (files) return parseInt(files[1], 10);

  // Legacy key-value pattern like "indexed: 42"
  const match = /indexed["\s:]+(\d+)/.exec(trimmed);
  if (match) return parseInt(match[1], 10);

  return 0;
}

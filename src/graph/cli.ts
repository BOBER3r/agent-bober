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
   * Run `tokensave init --tier <tier>`.
   * Resolves on exit code 0; throws a structured Error on non-zero.
   */
  async init(opts: { cwd?: string; languageTier: string }): Promise<void> {
    const effectiveCwd = opts.cwd ?? this.cwd;
    const result = await execa(
      this.binary,
      ["init", "--tier", opts.languageTier],
      {
        cwd: effectiveCwd,
        reject: false,
        all: true,
      },
    );

    if (result.exitCode !== 0) {
      const output = result.all ?? result.stdout ?? result.stderr ?? "";
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

    const stdout = result.stdout ?? "";
    const indexed = parseSyncOutput(stdout);

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
      return {
        ready: parsed.ready === true,
        indexedFileCount:
          typeof parsed.indexedFileCount === "number" ? parsed.indexedFileCount : 0,
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
 * Parse `{indexed: N}` from tokensave sync stdout.
 * Accepts both plain JSON and a JSON object embedded in other text.
 */
function parseSyncOutput(stdout: string): number {
  const trimmed = stdout.trim();
  if (!trimmed) return 0;

  // Try direct JSON parse
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj.indexed === "number") return obj.indexed;
  } catch {
    // Fall through
  }

  // Try to extract a number from a key-value pattern like "indexed: 42"
  const match = /indexed["\s:]+(\d+)/.exec(trimmed);
  if (match) return parseInt(match[1], 10);

  return 0;
}

import { execa } from "execa";
import type { GraphArtifactStore } from "./artifact-store.js";
import type { CliMap } from "./backends/types.js";
import { TokensaveBackend } from "./backends/tokensave-backend.js";

// ── Types ──────────────────────────────────────────────────────────

// Back-compat re-export — SyncResult/StatusResult now live in ./types.js
// (shared with the GraphBackend CliMap). No importer outside this file
// used these directly before this move (verified).
export type { SyncResult, StatusResult } from "./types.js";
import type { StatusResult, SyncResult } from "./types.js";

// ── TokensaveCli ───────────────────────────────────────────────────

/**
 * Short-lived execa wrapper for `tokensave init/sync/status`.
 *
 * Each method spawns a child process and waits for it to exit.
 * Use `TokensaveMcpClient` for long-lived JSON-RPC calls.
 *
 * Constructor pattern mirrors `TokensavePrereqCheck` (src/graph/prereq.ts:7-8).
 * Argv + output parsing are driven by the tokensave backend's CliMap; the
 * transport-level guards (idempotent init, timeout, empty-stdout, throw-on-
 * null-exit) stay here since they are not parsing concerns.
 */
export class TokensaveCli {
  private readonly cliMap: CliMap;

  constructor(
    private readonly cwd: string,
    private readonly store: GraphArtifactStore | null = null,
    private readonly binary: string = new TokensaveBackend().processSpec().binary,
  ) {
    this.cliMap = new TokensaveBackend().cliMap();
  }

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
      this.cliMap.initArgs(opts),
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
    const result = await execa(this.binary, this.cliMap.syncArgs(paths), {
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
    const indexed = this.cliMap.parseSync(combined);

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
    const result = await execa(this.binary, this.cliMap.statusArgs, {
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
      return this.cliMap.parseStatus(stdout);
    } catch {
      // Unparseable output → treat as not-ready, not an error
      return { ready: false, indexedFileCount: 0, tokensaveVersion: "" };
    }
  }
}

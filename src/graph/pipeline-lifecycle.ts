/**
 * GraphPipelineLifecycle — singleton that owns the tokensave serve subprocess
 * for the duration of a single `agent-bober run` pipeline invocation.
 *
 * Module-level export guarantees one instance per Node process (ESM singleton).
 * Importers receive the same object regardless of how many times they import.
 *
 * Responsibilities:
 *   - Read bober.config.json graph section.
 *   - Run prereq check before spawning.
 *   - Orphan cleanup via PID file (`.bober/graph/.serve.pid`).
 *   - SIGTERM/SIGINT handlers for graceful shutdown.
 *   - Idempotent start() and stop().
 */

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { BoberConfig } from "../config/schema.js";
import { fileExists, readJson, writeJson } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { TokensavePrereqCheck } from "./prereq.js";
import { GraphArtifactStore } from "./artifact-store.js";
import { TokensaveMcpClient, type EngineHealth } from "./mcp-client.js";
import { IncidentLog } from "./incidents.js";
import { GraphClient } from "./client.js";
import { GraphFallback } from "./fallback.js";

// ── PID file shape ─────────────────────────────────────────────────

interface PidFileData {
  pid: number;
  startedAt: string;
  projectRoot: string;
}

// ── Implementation ─────────────────────────────────────────────────

class GraphPipelineLifecycleImpl {
  private started = false;
  private stopping = false;
  private healthOverride: "disabled" | null = null;
  private mcpClient: TokensaveMcpClient | null = null;
  private store: GraphArtifactStore | null = null;
  private incidents: IncidentLog | null = null;
  private projectRoot: string | null = null;
  private pidPath: string | null = null;
  private sigHandler: (() => void) | null = null;

  // ── start ────────────────────────────────────────────────────────

  /**
   * Start the lifecycle.
   *
   * - When graph.enabled is false (or graph section is absent): no-op; health = 'disabled'.
   * - Otherwise: prereq check → orphan cleanup → spawn serve → write PID file → register signals.
   * - Idempotent: calling start() twice is safe (second call is a no-op).
   */
  async start(projectRoot: string, config: BoberConfig): Promise<void> {
    if (this.started) return;
    this.started = true;

    const cfg = config.graph;

    if (!cfg || cfg.enabled === false) {
      this.healthOverride = "disabled";
      return;
    }

    this.projectRoot = projectRoot;
    this.pidPath = resolve(projectRoot, ".bober/graph/.serve.pid");
    this.incidents = new IncidentLog(projectRoot);

    // Prereq check — fail fast on missing/incompatible binary
    const prereq = await new TokensavePrereqCheck(
      cfg.tokensavePath ?? "tokensave",
    ).check();

    if (!prereq.ok) {
      throw new Error(
        `Graph prereq failed: ${prereq.reason} — ${prereq.hint}`,
      );
    }

    // Create .bober/graph/ directory
    this.store = new GraphArtifactStore(projectRoot);
    await this.store.ensureLayout();

    // Orphan cleanup
    await this.handleOrphan();

    // Spawn
    this.mcpClient = new TokensaveMcpClient(
      projectRoot,
      cfg,
      this.incidents,
      cfg.tokensavePath ?? "tokensave",
    );

    await this.mcpClient.start();

    // Write PID file
    await this.writePidFile();

    // Register SIGTERM / SIGINT handlers
    this.registerSignalHandlers();

    const pid = this.mcpClient.childPid;
    if (pid !== null) {
      try {
        await this.incidents.append({
          ts: new Date().toISOString(),
          event: "start",
          pid,
        });
      } catch {
        // Incident write failure must not break startup
      }
    }

    logger.info(`[graph] Pipeline lifecycle started (pid=${String(pid)})`);
  }

  // ── stop ─────────────────────────────────────────────────────────

  /**
   * Gracefully stop the lifecycle.
   * SIGTERM → wait 2000ms (inside mcpClient.stop()) → SIGKILL fallback.
   * Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.mcpClient) {
      const pid = this.mcpClient.childPid;
      try {
        await this.mcpClient.stop();
        if (pid !== null && this.incidents) {
          await this.incidents.append({
            ts: new Date().toISOString(),
            event: "stop",
            pid,
            reason: "normal",
          });
        }
      } catch {
        // stop() errors must not propagate from signal handlers
      }
    }

    await this.removePidFile();
    this.unregisterSignalHandlers();

    logger.info("[graph] Pipeline lifecycle stopped");
  }

  // ── engineHealth ──────────────────────────────────────────────────

  engineHealth(): string {
    if (this.healthOverride === "disabled") return "disabled";
    if (!this.mcpClient) return "starting";
    return this.mcpClient.health();
  }

  // ── getGraphClient ────────────────────────────────────────────────

  /**
   * Lazy accessor for the GraphClient instance.
   * Returns null if the engine is not 'ready'.
   * Caches the constructed client on first call.
   */
  private _graphClient: GraphClient | null = null;

  getGraphClient(): GraphClient | null {
    if (this.engineHealth() !== "ready") return null;
    if (!this.mcpClient || !this.store || !this.incidents || !this.projectRoot) {
      return null;
    }
    if (!this._graphClient) {
      const fallback = new GraphFallback("dual");
      this._graphClient = new GraphClient(
        this.projectRoot,
        this.mcpClient,
        this.store,
        fallback,
        this.incidents,
        // GraphClient constructor takes config as GraphSection — use minimal stub
        // that satisfies the type (lifecycle already validated config at start())
        {
          enabled: true,
          autoSync: true,
          languageTier: "core",
          manifestPath: ".bober/graph/manifest.json",
          syncTimeoutMs: 2000,
          queryTimeoutMs: 5000,
          debounceMs: 750,
          hookQueueMax: 50,
          maxEngineRssMb: 512,
          exposeOnExternalMcp: true,
          preflightBudgets: {
            architect: 4000,
            curator: 2000,
            generator: 1000,
            evaluator: 1500,
            researcherPhase2: 3000,
          },
        },
      );
    }
    return this._graphClient;
  }

  /**
   * Returns {client, fallback} when engine is 'ready', null otherwise.
   * Used by resolveRoleTools to construct gated tool sets.
   */
  getGraphDeps(): { client: GraphClient; fallback: GraphFallback } | null {
    const client = this.getGraphClient();
    if (!client) return null;
    // Construct a matching fallback (dual mode — same as used in getGraphClient)
    const fallback = new GraphFallback("dual");
    return { client, fallback };
  }

  // ── For testing only ──────────────────────────────────────────────

  /**
   * Reset internal state so tests can call start() again on the same instance.
   * NOT intended for production use.
   */
  _reset(): void {
    this.started = false;
    this.stopping = false;
    this.healthOverride = null;
    this.mcpClient = null;
    this.store = null;
    this.incidents = null;
    this.projectRoot = null;
    this.pidPath = null;
    this._graphClient = null;
    this.unregisterSignalHandlers();
    this.sigHandler = null;
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async handleOrphan(): Promise<void> {
    if (!this.pidPath) return;

    if (!(await fileExists(this.pidPath))) return;

    let existing: PidFileData;
    try {
      existing = await readJson<PidFileData>(this.pidPath);
    } catch {
      // Malformed PID file — remove and continue
      await rm(this.pidPath, { force: true });
      return;
    }

    if (!existing || typeof existing.pid !== "number") {
      await rm(this.pidPath, { force: true });
      return;
    }

    const orphanPid = existing.pid;

    try {
      // probe: throws ESRCH if dead, throws EPERM if dead-but-not-owned
      process.kill(orphanPid, 0);

      // Still alive → kill it
      logger.warn(`[graph] Killing orphan tokensave serve (pid=${orphanPid})`);
      try {
        process.kill(orphanPid, "SIGTERM");
      } catch {
        // Already gone
      }
      await delay(500);
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        // Already gone
      }

      if (this.incidents) {
        try {
          await this.incidents.append({
            ts: new Date().toISOString(),
            event: "orphan-killed",
            pid: orphanPid,
          });
        } catch {
          // Best-effort
        }
      }
    } catch {
      // Dead or not accessible — safe to overwrite
    }

    await rm(this.pidPath, { force: true });
  }

  private async writePidFile(): Promise<void> {
    if (!this.pidPath || !this.mcpClient) return;
    const pid = this.mcpClient.childPid;
    if (pid === null) return;

    const data: PidFileData = {
      pid,
      startedAt: new Date().toISOString(),
      projectRoot: this.projectRoot ?? "",
    };
    await writeJson(this.pidPath, data);
  }

  private async removePidFile(): Promise<void> {
    if (!this.pidPath) return;
    try {
      await rm(this.pidPath, { force: true });
    } catch {
      // Best-effort
    }
  }

  private registerSignalHandlers(): void {
    this.sigHandler = () => {
      this.stop().catch(() => {
        // Signal handlers must not throw
      });
    };
    process.on("SIGTERM", this.sigHandler);
    process.on("SIGINT", this.sigHandler);
  }

  private unregisterSignalHandlers(): void {
    if (this.sigHandler) {
      process.removeListener("SIGTERM", this.sigHandler);
      process.removeListener("SIGINT", this.sigHandler);
    }
  }
}

// ── Module-level singleton ─────────────────────────────────────────

/**
 * The one and only GraphPipelineLifecycle instance per Node process.
 *
 * ESM module caching guarantees this is the same object for all importers
 * in the same realm — even if imported from multiple modules simultaneously.
 *
 * Usage:
 *   import { graphPipelineLifecycle } from './pipeline-lifecycle.js';
 *   await graphPipelineLifecycle.start(projectRoot, config);
 *   // ... pipeline runs ...
 *   await graphPipelineLifecycle.stop();
 */
export const graphPipelineLifecycle = new GraphPipelineLifecycleImpl();

// Re-export the class for testing purposes (tests can call _reset())
export { GraphPipelineLifecycleImpl };
export type { EngineHealth };

// ── Utilities ──────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

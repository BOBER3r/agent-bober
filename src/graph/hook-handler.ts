import { resolve } from "node:path";
import { readFile, truncate } from "node:fs/promises";
import { fileExists } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import type { TokensaveCli } from "./cli.js";
import type { GraphArtifactStore } from "./artifact-store.js";
import type { IncidentLog } from "./incidents.js";
import type { GraphSection } from "../config/schema.js";

// ── Types ──────────────────────────────────────────────────────────

interface HookQueueLine {
  ts: string;
  tool: "Edit" | "Write" | "MultiEdit" | string;
  paths: string[];
}

// ── GraphHookHandler ───────────────────────────────────────────────

/**
 * Debounces PostToolUse Edit|Write events and forwards path batches to
 * TokensaveCli.sync. Owns:
 *   - In-memory Set<string> of pending paths (cap = config.hookQueueMax).
 *   - A single debounce Timer (window = config.debounceMs).
 *   - A 100ms poll loop reading .bober/graph/.hook-queue.jsonl.
 *
 * onPostToolUse is synchronous (fire-and-forget). flush() drains the queue
 * with a 5000ms total budget — called from GraphPipelineLifecycle.stop()
 * before the engine is killed.
 */
export class GraphHookHandler {
  private readonly queue = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private overflowBatch = 0;
  private syncing = false;
  private stopped = false;
  private readonly queueFilePath: string;
  private static readonly FLUSH_BUDGET_MS = 5000;
  private static readonly POLL_INTERVAL_MS = 100;
  private static readonly OVERFLOW_EVICT = 10;
  private static readonly OVERFLOW_WARN_EVERY = 10;

  constructor(
    private readonly cli: TokensaveCli,
    private readonly store: GraphArtifactStore,
    private readonly incidents: IncidentLog,
    private readonly config: GraphSection,
    projectRoot: string,
  ) {
    this.queueFilePath = resolve(projectRoot, ".bober/graph/.hook-queue.jsonl");
  }

  /** Begin polling the IPC queue file. Called once at lifecycle start(). */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.drainIpcFile().catch(() => {});
    }, GraphHookHandler.POLL_INTERVAL_MS);
    // Unref so the interval does not prevent the process from exiting naturally.
    this.pollTimer.unref?.();
  }

  /**
   * Synchronous fire-and-forget entry point.
   * Adds paths to queue; resets debounce timer; on cap-overflow drops oldest.
   * Returns immediately — NO awaits.
   */
  onPostToolUse(payload: { paths: string[] }): void {
    if (this.stopped) return;
    if (this.config.autoSync === false) return;
    if (!payload.paths?.length) return;

    for (const p of payload.paths) this.queue.add(p);

    // Overflow: queue.size > hookQueueMax → drop the oldest entries.
    if (this.queue.size > this.config.hookQueueMax) {
      const overflow = this.queue.size - this.config.hookQueueMax;
      const dropCount = Math.max(overflow, GraphHookHandler.OVERFLOW_EVICT);
      this.evictOldest(dropCount);
      this.overflowBatch++;
      // Fire-and-forget incident write — do NOT await
      this.incidents
        .append({
          ts: new Date().toISOString(),
          event: "debounce-overflow",
          droppedCount: dropCount,
          queueSize: this.queue.size,
          currentPaths: Array.from(this.queue).slice(-10),
        })
        .catch(() => {});
      if (this.overflowBatch % GraphHookHandler.OVERFLOW_WARN_EVERY === 0) {
        logger.warn(
          `[graph] Hook queue overflow: dropped ${dropCount} oldest paths (batch ${this.overflowBatch})`,
        );
      }
    }

    // Reset / arm debounce timer.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runSync().catch(() => {});
    }, this.config.debounceMs);
    // Unref so the timer does not prevent the process from exiting naturally.
    this.debounceTimer.unref?.();
  }

  /** Drain queue with FLUSH_BUDGET_MS total budget. Called from lifecycle.stop(). */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopped = true;

    // Drain IPC file one last time before draining queue.
    await this.drainIpcFile().catch(() => {});

    if (this.queue.size === 0) return;

    const start = Date.now();
    try {
      await Promise.race([this.runSync(), delay(GraphHookHandler.FLUSH_BUDGET_MS)]);
    } finally {
      // Anything still in the queue → write to manifest.pendingFiles
      if (this.queue.size > 0) {
        await this.markPending(Array.from(this.queue));
      }
      logger.info(`[graph] HookHandler.flush completed in ${Date.now() - start}ms`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  private evictOldest(n: number): void {
    let count = 0;
    for (const p of this.queue) {
      if (count >= n) break;
      this.queue.delete(p);
      count++;
    }
  }

  private async runSync(): Promise<void> {
    if (this.syncing) return;
    if (this.queue.size === 0) return;
    this.syncing = true;
    const paths = Array.from(this.queue);
    this.queue.clear();
    try {
      await this.cli.sync(paths, this.config.syncTimeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(msg)) {
        await this.incidents
          .append({
            ts: new Date().toISOString(),
            event: "hook-timeout",
            paths,
            timeoutMs: this.config.syncTimeoutMs,
          })
          .catch(() => {});
        await this.markPending(paths);
      } else {
        logger.warn(`[graph] Hook sync failed (non-timeout): ${msg}`);
      }
    } finally {
      this.syncing = false;
    }
  }

  private async markPending(paths: string[]): Promise<void> {
    try {
      const existing = await this.store.readManifest();
      if (!existing) return;
      const merged = Array.from(new Set([...(existing.pendingFiles ?? []), ...paths]));
      await this.store.writeManifest({ ...existing, pendingFiles: merged });
    } catch {
      // Manifest update is best-effort
    }
  }

  private async drainIpcFile(): Promise<void> {
    if (!(await fileExists(this.queueFilePath))) return;
    let raw: string;
    try {
      raw = await readFile(this.queueFilePath, "utf-8");
    } catch {
      return;
    }
    if (!raw) return;

    // Truncate first so a concurrent hook-script append is not permanently lost.
    // We accept one line of loss on truly simultaneous writes — this is fine
    // because the hook script and this reader are on different processes.
    try {
      await truncate(this.queueFilePath, 0);
    } catch {
      // ignore
    }

    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec: HookQueueLine;
      try {
        rec = JSON.parse(t) as HookQueueLine;
      } catch {
        continue;
      }
      if (!Array.isArray(rec.paths) || rec.paths.length === 0) continue;
      this.onPostToolUse({ paths: rec.paths });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── EventStreamManager ──────────────────────────────────────────────
//
// Tails .bober/history.jsonl + .bober/telemetry/<date>.jsonl for matching
// runIds and forwards events as server-initiated MCP notifications.
//
// stdout-safety: all diagnostic output MUST go to process.stderr.
// The MCP stdio transport owns stdout; writing to stdout here would
// corrupt the JSON-RPC stream.

import { open as fsOpen, read as fsRead, close as fsClose, watch, type FSWatcher } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { Buffer } from "node:buffer";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// ── Constants ────────────────────────────────────────────────────────

const NOTIF_EVENT = "bober/events";
const NOTIF_DROPPED = "bober/events.dropped";

// ── Interfaces ───────────────────────────────────────────────────────

interface Subscription {
  subscriptionId: string;
  runId: string;
  startedAt: string;
  queue: unknown[];
  queueBound: number;
  droppedSinceLastDelivery: number;
  flushing: boolean;
}

interface FileWatch {
  path: string;
  watcher: FSWatcher;
  offset: number;
  refCount: number;
  partialLine: string;
  /** Serializes concurrent onFileEvent calls for this file path. */
  chain: Promise<void>;
}

// ── Helper: extract runId from a parsed JSONL record ────────────────

function extractRunId(rec: unknown): string | undefined {
  if (typeof rec !== "object" || rec === null) return undefined;
  const r = rec as Record<string, unknown>;
  // Top-level runId field (telemetry events carry it here)
  if (typeof r.runId === "string") return r.runId;
  // Nested under details (future history.jsonl writers may use this)
  if (typeof r.details === "object" && r.details !== null) {
    const d = r.details as Record<string, unknown>;
    if (typeof d.runId === "string") return d.runId;
  }
  return undefined;
}

// ── Helper: get today's telemetry file path ──────────────────────────

function todayTelemetryPath(projectRoot: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(projectRoot, ".bober", "telemetry", `${date}.jsonl`);
}

// ── EventStreamManager ───────────────────────────────────────────────

export class EventStreamManager {
  private subscriptions = new Map<string, Subscription>();
  /** FileWatch entries keyed by absolute path. */
  private fileWatches = new Map<string, FileWatch>();
  /**
   * Map from subscriptionId → set of watched file paths.
   * Used to release watches on unsubscribe.
   */
  private subFiles = new Map<string, Set<string>>();
  /** Telemetry date-poll interval (detects date roll-overs). */
  private telemetryPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Current date string (YYYY-MM-DD) used to detect roll-over. */
  private currentTelemetryDate = new Date().toISOString().slice(0, 10);

  constructor(
    private readonly server: Server,
    private readonly projectRoot: string,
    private readonly defaultQueueBound = 1000,
  ) {}

  // ── Public API ───────────────────────────────────────────────────

  async subscribe(
    runId: string,
    opts: { since?: string; queueBound?: number } = {},
  ): Promise<{ subscriptionId: string; status: "subscribed"; startedAt: string }> {
    const subscriptionId = randomUUID();
    const startedAt = new Date().toISOString();
    const queueBound = opts.queueBound ?? this.defaultQueueBound;

    const sub: Subscription = {
      subscriptionId,
      runId,
      startedAt,
      queue: [],
      queueBound,
      droppedSinceLastDelivery: 0,
      flushing: false,
    };
    this.subscriptions.set(subscriptionId, sub);
    this.subFiles.set(subscriptionId, new Set());

    // Watch history.jsonl
    const historyPath = join(this.projectRoot, ".bober", "history.jsonl");
    await this.openWatch(historyPath, subscriptionId);

    // Watch telemetry/<today>.jsonl (may not exist yet — openWatch handles this)
    const telemetryPath = todayTelemetryPath(this.projectRoot);
    await this.openWatch(telemetryPath, subscriptionId);

    // Start telemetry poll timer if not already running
    this.ensureTelemetryPoller();

    // Backfill: if `since` is provided, deliver pre-existing events
    if (opts.since !== undefined) {
      await this.backfill(sub, historyPath, opts.since);
      await this.backfill(sub, telemetryPath, opts.since);
    }

    return { subscriptionId, status: "subscribed", startedAt };
  }

  unsubscribe(subscriptionId: string): { ok: boolean } {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return { ok: false };

    this.subscriptions.delete(subscriptionId);
    const files = this.subFiles.get(subscriptionId) ?? new Set();
    this.subFiles.delete(subscriptionId);

    for (const filePath of files) {
      this.releaseWatch(filePath);
    }

    return { ok: true };
  }

  shutdown(): void {
    // Cancel telemetry poller
    if (this.telemetryPollTimer !== null) {
      clearInterval(this.telemetryPollTimer);
      this.telemetryPollTimer = null;
    }
    // Close all watchers
    for (const fw of this.fileWatches.values()) {
      try { fw.watcher.close(); } catch { /* ignore */ }
    }
    this.fileWatches.clear();
    this.subscriptions.clear();
    this.subFiles.clear();
  }

  // ── Watcher management ──────────────────────────────────────────

  private async openWatch(filePath: string, subscriptionId: string): Promise<void> {
    const subFileSet = this.subFiles.get(subscriptionId);
    if (!subFileSet) return; // subscription was already removed

    subFileSet.add(filePath);

    if (this.fileWatches.has(filePath)) {
      // Already watching — just increment refCount
      this.fileWatches.get(filePath)!.refCount++;
      return;
    }

    // Determine the initial offset (end of file, so we only see NEW appends)
    let initialOffset = 0;
    try {
      const s = await stat(filePath);
      initialOffset = s.size;
    } catch {
      // File doesn't exist yet; start at 0 so we catch it when it's created
    }

    // Ensure parent directory exists so fs.watch doesn't throw
    const parentDir = dirname(filePath);
    try {
      await mkdir(parentDir, { recursive: true });
    } catch {
      // ignore
    }

    // Attempt to watch. If the file doesn't exist, watch the parent directory
    // for creation, then switch to watching the file once it appears.
    const fw: FileWatch = {
      path: filePath,
      watcher: null as unknown as FSWatcher, // assigned below
      offset: initialOffset,
      refCount: 1,
      partialLine: "",
      chain: Promise.resolve(),
    };
    this.fileWatches.set(filePath, fw);

    try {
      // Try watching the file directly first (works if file exists)
      const fileExists = await this.fileExists(filePath);
      if (fileExists) {
        fw.watcher = this.createWatcher(filePath, fw);
      } else {
        // Watch parent directory for file creation
        fw.watcher = this.createParentWatcher(filePath, parentDir, fw);
      }
    } catch (err) {
      process.stderr.write(
        `[event-stream] Failed to watch ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      // Remove the broken watch entry
      this.fileWatches.delete(filePath);
      subFileSet.delete(filePath);
    }
  }

  private createWatcher(filePath: string, fw: FileWatch): FSWatcher {
    const watcher = watch(filePath, { persistent: false }, (_eventType) => {
      fw.chain = fw.chain.then(() => this.onFileEvent(filePath)).catch(() => {});
    });
    watcher.unref?.();
    return watcher;
  }

  private createParentWatcher(filePath: string, parentDir: string, fw: FileWatch): FSWatcher {
    const filename = filePath.slice(parentDir.length + 1);
    const watcher = watch(parentDir, { persistent: false }, (_eventType, changedFile) => {
      if (changedFile === filename) {
        // File appeared — switch to file watcher
        fw.chain = fw.chain.then(async () => {
          const exists = await this.fileExists(filePath);
          if (exists && this.fileWatches.has(filePath)) {
            try {
              fw.watcher.close();
            } catch { /* ignore */ }
            fw.watcher = this.createWatcher(filePath, fw);
            // Also read any content that appeared
            await this.onFileEvent(filePath);
          }
        }).catch(() => {});
      }
    });
    watcher.unref?.();
    return watcher;
  }

  private releaseWatch(filePath: string): void {
    const fw = this.fileWatches.get(filePath);
    if (!fw) return;
    fw.refCount--;
    if (fw.refCount <= 0) {
      try { fw.watcher.close(); } catch { /* ignore */ }
      this.fileWatches.delete(filePath);
    }
  }

  // ── File reading ────────────────────────────────────────────────

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async onFileEvent(filePath: string): Promise<void> {
    const fw = this.fileWatches.get(filePath);
    if (!fw) return;

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return; // file gone or not yet created
    }

    const fileSize = fileStat.size;
    if (fileSize <= fw.offset) return; // no new data (or truncated — ignore)

    // Read only the new bytes
    let newBytes: Buffer;
    try {
      newBytes = await this.readFromOffset(filePath, fw.offset, fileSize - fw.offset);
    } catch {
      return;
    }
    fw.offset = fileSize;

    const rawText = fw.partialLine + newBytes.toString("utf-8");
    const lines = rawText.split("\n");

    // The last element may be incomplete (mid-append) — hold it back
    fw.partialLine = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue; // skip malformed lines
      }

      const runId = extractRunId(rec);
      if (!runId) continue; // sc-3-6: skip lines without runId

      // Fan-out to matching subscriptions
      for (const sub of this.subscriptions.values()) {
        if (sub.runId === runId) {
          this.deliver(sub, rec);
        }
      }
    }
  }

  private readFromOffset(filePath: string, offset: number, length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      fsOpen(filePath, "r", (openErr, fd) => {
        if (openErr) { reject(openErr); return; }
        const buf = Buffer.alloc(length);
        fsRead(fd, buf, 0, length, offset, (readErr, bytesRead) => {
          fsClose(fd, (closeErr) => {
            if (readErr) { reject(readErr); return; }
            if (closeErr) {
              // Non-fatal; just log and resolve
              process.stderr.write(`[event-stream] close fd error: ${closeErr.message}\n`);
            }
            resolve(buf.subarray(0, bytesRead));
          });
        });
      });
    });
  }

  // ── Backfill ────────────────────────────────────────────────────

  private async backfill(sub: Subscription, filePath: string, since: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      return; // file may not exist yet
    }

    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const runId = extractRunId(rec);
      if (!runId || runId !== sub.runId) continue;

      // Check timestamp > since
      if (typeof rec === "object" && rec !== null) {
        const r = rec as Record<string, unknown>;
        if (typeof r.timestamp === "string" && r.timestamp > since) {
          this.deliver(sub, rec);
        }
      }
    }
  }

  // ── Delivery / backpressure ─────────────────────────────────────

  private deliver(sub: Subscription, event: unknown): void {
    sub.queue.push(event);
    if (sub.queue.length > sub.queueBound) {
      const overflow = sub.queue.length - sub.queueBound;
      sub.queue.splice(0, overflow); // drop oldest
      sub.droppedSinceLastDelivery += overflow;
    }
    // Defer flush via a resolved Promise microtask so that flush() does not start
    // consuming events until the current synchronous batch of deliver() calls has
    // fully completed. This ensures all overflow tracking is accurate before any
    // notifications are sent (sc-3-3: exactly 1 dropped notification per overflow window).
    void Promise.resolve().then(() => this.flush(sub));
  }

  private async flush(sub: Subscription): Promise<void> {
    if (sub.flushing) return;
    sub.flushing = true;
    try {
      while (sub.queue.length > 0) {
        const event = sub.queue.shift()!;
        if (!this.subscriptions.has(sub.subscriptionId)) break; // unsubscribed
        await (this.server as unknown as {
          notification(n: { method: string; params: Record<string, unknown> }): Promise<void>;
        }).notification({
          method: NOTIF_EVENT,
          params: { subscriptionId: sub.subscriptionId, event },
        });
      }
      if (sub.droppedSinceLastDelivery > 0) {
        const count = sub.droppedSinceLastDelivery;
        sub.droppedSinceLastDelivery = 0;
        if (this.subscriptions.has(sub.subscriptionId)) {
          await (this.server as unknown as {
            notification(n: { method: string; params: Record<string, unknown> }): Promise<void>;
          }).notification({
            method: NOTIF_DROPPED,
            params: { subscriptionId: sub.subscriptionId, dropped: count },
          });
        }
      }
    } catch (err) {
      process.stderr.write(
        `[event-stream] notification error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      sub.flushing = false;
    }
  }

  // ── Telemetry date poller ───────────────────────────────────────

  private ensureTelemetryPoller(): void {
    if (this.telemetryPollTimer !== null) return;
    this.telemetryPollTimer = setInterval(() => {
      this.checkTelemetryDateRollover();
    }, 5_000);
    this.telemetryPollTimer.unref?.();
  }

  private checkTelemetryDateRollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this.currentTelemetryDate) return;

    // Date rolled over — update watcher for all subscriptions
    const oldPath = join(this.projectRoot, ".bober", "telemetry", `${this.currentTelemetryDate}.jsonl`);
    const newPath = join(this.projectRoot, ".bober", "telemetry", `${today}.jsonl`);
    this.currentTelemetryDate = today;

    // Release old telemetry watchers and open new ones
    for (const [subId, fileSet] of this.subFiles.entries()) {
      if (fileSet.has(oldPath)) {
        this.releaseWatch(oldPath);
        fileSet.delete(oldPath);
        // Open watch for the new date file
        this.openWatch(newPath, subId).catch(() => {});
      }
    }
  }
}

// ── Late-bound module singleton ──────────────────────────────────────

let _manager: EventStreamManager | null = null;

export function initEventStream(
  server: Server,
  projectRoot: string,
  queueBound?: number,
): EventStreamManager {
  _manager = new EventStreamManager(server, projectRoot, queueBound);
  return _manager;
}

export function getEventStream(): EventStreamManager {
  if (!_manager) {
    throw new Error(
      "EventStreamManager not initialized; call initEventStream(server, projectRoot) after server.connect().",
    );
  }
  return _manager;
}

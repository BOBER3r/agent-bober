// ── pid-sidecar.ts ─────────────────────────────────────────────────────
//
// Persists runId -> {pid, task, spawnedAt} for a chat session at
// .bober/chat/<sessionId>.pids.json. Survives across instances (sc-2-7).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "../utils/fs.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface PidEntry {
  pid?: number;
  task: string;
  spawnedAt: string;
}

// ── PidSidecar ────────────────────────────────────────────────────────

export class PidSidecar {
  constructor(
    private readonly projectRoot: string,
    private readonly sessionId: string,
  ) {}

  private path(): string {
    return join(
      this.projectRoot,
      ".bober",
      "chat",
      `${this.sessionId}.pids.json`,
    );
  }

  /**
   * Read all pid entries for this session from disk.
   * Returns an empty map if the file is missing or malformed — never throws.
   */
  async readAll(): Promise<Record<string, PidEntry>> {
    try {
      return JSON.parse(
        await readFile(this.path(), "utf-8"),
      ) as Record<string, PidEntry>;
    } catch {
      return {};
    }
  }

  /**
   * Record a runId->PidEntry mapping persistently.
   * Reads existing entries, merges, and atomically rewrites the sidecar file.
   */
  async record(runId: string, entry: PidEntry): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    const all = await this.readAll();
    all[runId] = entry;
    await writeFile(
      this.path(),
      JSON.stringify(all, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}

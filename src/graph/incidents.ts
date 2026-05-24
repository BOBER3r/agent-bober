import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDir } from "../utils/fs.js";

// ── Types ──────────────────────────────────────────────────────────

export type IncidentEvent =
  | { ts: string; event: "breaker-tripped"; restartCount: number; windowMs: number }
  | { ts: string; event: "restart"; pid: number | null; exitCode: number | null; signal: string | null }
  | { ts: string; event: "start"; pid: number }
  | { ts: string; event: "stop"; pid: number; reason: "sigterm" | "sigkill" | "normal" }
  | { ts: string; event: "orphan-killed"; pid: number }
  | { ts: string; event: "sandbox-drop"; file: string; source: string };

// ── IncidentLog ────────────────────────────────────────────────────

/**
 * Append-only writer for .bober/graph/incidents.jsonl.
 *
 * Each call writes a single newline-terminated JSON object.
 * The directory is created defensively on each write, in case
 * GraphArtifactStore.ensureLayout() has not been called yet.
 */
export class IncidentLog {
  private readonly path: string;

  constructor(projectRoot: string) {
    this.path = resolve(projectRoot, ".bober/graph/incidents.jsonl");
  }

  async append(e: IncidentEvent): Promise<void> {
    await ensureDir(resolve(this.path, ".."));
    await appendFile(this.path, JSON.stringify(e) + "\n", "utf-8");
  }
}

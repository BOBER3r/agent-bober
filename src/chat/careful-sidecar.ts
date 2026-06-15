// ── careful-sidecar.ts ─────────────────────────────────────────────────
//
// Persists the per-session "careful mode" toggle at
// .bober/chat/<sessionId>.careful.json. Default off → autopilot (Phase 1).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "../utils/fs.js";

// ── CarefulSidecar ────────────────────────────────────────────────────

export class CarefulSidecar {
  constructor(
    private readonly projectRoot: string,
    private readonly sessionId: string,
  ) {}

  private path(): string {
    return join(this.projectRoot, ".bober", "chat", `${this.sessionId}.careful.json`);
  }

  /**
   * Read the careful flag. Missing/malformed file => false (autopilot). Never throws.
   */
  async isCareful(): Promise<boolean> {
    try {
      const data = JSON.parse(await readFile(this.path(), "utf-8")) as { careful?: boolean };
      return data.careful === true;
    } catch {
      return false;
    }
  }

  /**
   * Persist the careful flag atomically.
   */
  async setCareful(on: boolean): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    await writeFile(
      this.path(),
      JSON.stringify({ careful: on }, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}

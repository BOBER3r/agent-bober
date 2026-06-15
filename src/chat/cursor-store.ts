// ── cursor-store.ts ──────────────────────────────────────────────────────
//
// Persists the byte cursor + seen-run-ids set for a CompletionTailer session
// at .bober/chat/<sessionId>.cursor.json. Survives REPL restarts.
// Modeled on pid-sidecar.ts (sc-3-6).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "../utils/fs.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface CursorFile {
  byteCursor: number;
  lastSize: number;
  /** Serialised as an array; hydrate into a Set on read. */
  seenRunIds: string[];
}

const EMPTY: CursorFile = { byteCursor: 0, lastSize: 0, seenRunIds: [] };

// ── CursorStore ────────────────────────────────────────────────────────

export class CursorStore {
  constructor(
    private readonly projectRoot: string,
    private readonly sessionId: string,
  ) {}

  private path(): string {
    return join(
      this.projectRoot,
      ".bober",
      "chat",
      `${this.sessionId}.cursor.json`,
    );
  }

  /**
   * Read the stored cursor. Returns the zero-state default on any error
   * (missing file, malformed JSON) — never throws.
   */
  async read(): Promise<CursorFile> {
    try {
      return JSON.parse(await readFile(this.path(), "utf-8")) as CursorFile;
    } catch {
      return { ...EMPTY };
    }
  }

  /**
   * Persist an updated cursor file to disk.
   * Creates .bober/chat/ if it does not exist.
   */
  async write(cursor: CursorFile): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    await writeFile(
      this.path(),
      JSON.stringify(cursor, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}

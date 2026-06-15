// ── conversation-store.ts ──────────────────────────────────────────────
//
// Append-only JSONL persistence for chat conversations.
// Layout: .bober/chat/<sessionId>.jsonl
// Each line is a JSON-encoded TurnRecord.

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "../utils/fs.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TurnRecord {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

// ── Path helpers ──────────────────────────────────────────────────────

function chatDir(projectRoot: string): string {
  return join(projectRoot, ".bober", "chat");
}

function sessionPath(projectRoot: string, sessionId: string): string {
  return join(chatDir(projectRoot), `${sessionId}.jsonl`);
}

// ── ConversationStore ─────────────────────────────────────────────────

export class ConversationStore {
  private readonly projectRoot: string;
  private readonly sessionId: string;

  constructor(projectRoot: string, sessionId: string) {
    this.projectRoot = projectRoot;
    this.sessionId = sessionId;
  }

  /**
   * Append a turn record to the session JSONL file.
   * Creates the .bober/chat/ directory if it does not yet exist.
   */
  async append(record: TurnRecord): Promise<void> {
    const dir = chatDir(this.projectRoot);
    await ensureDir(dir);
    const path = sessionPath(this.projectRoot, this.sessionId);
    await appendFile(path, JSON.stringify(record) + "\n", "utf-8");
  }

  /**
   * Load the most recent `limit` turns from the session JSONL.
   * Returns records newest-last (chronological order).
   * Skips any malformed (non-parseable) lines silently.
   */
  async loadRecent(limit: number): Promise<TurnRecord[]> {
    const path = sessionPath(this.projectRoot, this.sessionId);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      // File does not exist yet — no prior conversation
      return [];
    }

    const records: TurnRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as TurnRecord;
        records.push(parsed);
      } catch {
        // Skip malformed lines
      }
    }

    // Return up to `limit` newest-last (chronological order = array tail)
    return records.slice(-limit);
  }
}

import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDir } from "../utils/fs.js";

// ── Types ──────────────────────────────────────────────────────────

export interface TokenUsageRecord {
  agent: "generator" | "researcher-phase2" | "curator" | "architect";
  runId: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  graphEnabled: boolean;
}

// ── TokenUsageLog ──────────────────────────────────────────────────

/**
 * Append-only writer for .bober/graph/token-usage.jsonl.
 *
 * Each call writes ONE line (one JSON object) per agent run.
 * A metrics-write failure must not break the agent — callers should
 * wrap calls in try/catch and swallow errors.
 */
export class TokenUsageLog {
  private readonly path: string;

  constructor(projectRoot: string) {
    this.path = resolve(projectRoot, ".bober/graph/token-usage.jsonl");
  }

  async append(r: TokenUsageRecord): Promise<void> {
    await ensureDir(resolve(this.path, ".."));
    await appendFile(this.path, JSON.stringify(r) + "\n", "utf-8");
  }
}

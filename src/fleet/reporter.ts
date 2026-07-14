// ── reporter.ts ───────────────────────────────────────────────────────
//
// PortfolioReporter: tally ChildOutcome[] into a PortfolioReport and
// atomically write it to <rootDir>/.bober/fleet-report.json.
//
// Write strategy mirrors writeRunState in src/state/run-state.ts:
// temp file + rename to prevent partial-write corruption.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import type { ChildOutcome } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface PortfolioReport {
  total: number;
  completed: number;
  failed: number;
  other: number;
  generatedAt: string;
  children: ChildOutcome[];
  rounds?: number;
}

// ── PortfolioReporter ─────────────────────────────────────────────────

export class PortfolioReporter {
  // ── build ───────────────────────────────────────────────────────────

  /**
   * Tally a list of ChildOutcome records into a PortfolioReport.
   *
   * - completed: status === "completed"
   * - failed:    status === "failed"
   * - other:     anything else (running / aborted / unknown)
   * - generatedAt: ISO-8601 timestamp at call time
   */
  build(outcomes: ChildOutcome[], opts?: { rounds?: number }): PortfolioReport {
    let completed = 0;
    let failed = 0;
    let other = 0;

    for (const o of outcomes) {
      if (o.status === "completed") {
        completed++;
      } else if (o.status === "failed") {
        failed++;
      } else {
        other++;
      }
    }

    return {
      total: outcomes.length,
      completed,
      failed,
      other,
      generatedAt: new Date().toISOString(),
      children: outcomes,
      ...(opts?.rounds !== undefined ? { rounds: opts.rounds } : {}),
    };
  }

  // ── write ────────────────────────────────────────────────────────────

  /**
   * Atomically write the PortfolioReport to <rootDir>/.bober/fleet-report.json.
   *
   * Uses temp file + rename to prevent partial-write corruption (mirrors
   * writeRunState in src/state/run-state.ts).
   *
   * This is the ONE place in the fleet subsystem allowed to throw on IO failure.
   *
   * @returns The absolute path of the written file.
   */
  async write(rootDir: string, report: PortfolioReport): Promise<string> {
    const dir = resolve(join(rootDir, ".bober"));
    await mkdir(dir, { recursive: true });

    const filePath = join(dir, "fleet-report.json");
    const rnd = randomBytes(4).toString("hex");
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;

    await writeFile(tmp, JSON.stringify(report, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tmp, filePath);

    return filePath;
  }
}

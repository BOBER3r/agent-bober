/**
 * Colocated smoke tests for IncidentLog and IncidentEvent union.
 *
 * Verifies that the union variants added in sprint 8 (debounce-overflow,
 * hook-timeout) type-check correctly. Full write tests exist in integration
 * test fixtures.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("IncidentLog — colocated smoke tests", () => {
  it("appends a debounce-overflow event to the JSONL file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "bober-incidents-"));
    try {
      const { IncidentLog } = await import("./incidents.js");
      const log = new IncidentLog(tmp);
      await log.append({
        ts: new Date().toISOString(),
        event: "debounce-overflow",
        droppedCount: 10,
        queueSize: 50,
        currentPaths: ["src/a.ts"],
      });

      const raw = await readFile(join(tmp, ".bober/graph/incidents.jsonl"), "utf-8");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.event).toBe("debounce-overflow");
      expect(parsed.droppedCount).toBe(10);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("appends a hook-timeout event to the JSONL file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "bober-incidents-"));
    try {
      const { IncidentLog } = await import("./incidents.js");
      const log = new IncidentLog(tmp);
      await log.append({
        ts: new Date().toISOString(),
        event: "hook-timeout",
        paths: ["src/b.ts", "src/c.ts"],
        timeoutMs: 2000,
      });

      const raw = await readFile(join(tmp, ".bober/graph/incidents.jsonl"), "utf-8");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.event).toBe("hook-timeout");
      expect(parsed.timeoutMs).toBe(2000);
      expect(parsed.paths).toEqual(["src/b.ts", "src/c.ts"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

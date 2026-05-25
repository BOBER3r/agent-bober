/**
 * Tier 2 careful-flow end-to-end integration test (s14-c6).
 *
 * Exercises the disk mechanism approval dance without mocking the disk mechanism.
 * Uses Strategy B (in-process) from the Sprint 14 briefing:
 *   - Re-registers a fresh DiskCheckpointMechanism pointing at tmpdir/.bober/approvals
 *   - Calls runWithAudit which invokes the real DiskCheckpointMechanism.request()
 *   - In parallel, polls for .pending.json files and writes .approved.json via saveApproved()
 *   - Asserts the audit log is written to .bober/audits/<runId>.jsonl
 *
 * We do NOT run the full runPipeline() (which would need 6 real LLM agents) — instead
 * we test the disk mechanism + audit infrastructure that the pipeline delegates to.
 * This is the canonical "approval dance" integration per the contract.
 *
 * Sprint 14 — tests/integration/ (cross-cutting integration tests per briefing pattern).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiskCheckpointMechanism } from "../../src/orchestrator/checkpoints/mechanisms/disk.js";
import { registerCheckpointMechanism } from "../../src/orchestrator/checkpoints/registry.js";
import { runWithAudit } from "../../src/orchestrator/checkpoints/audit.js";
import { saveApproved, listPending } from "../../src/state/approval-state.js";

let projectRoot: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-careful-flow-"));
  // Re-register the disk mechanism pointing at the tmpdir so the module-load-time
  // cached cwd doesn't matter (disk.ts:83 in registry.ts constructs with process.cwd()).
  const approvalsDir = join(projectRoot, ".bober", "approvals");
  registerCheckpointMechanism(
    "disk",
    new DiskCheckpointMechanism(approvalsDir, {
      pollMs: 50,          // Fast polling for test speed
      timeoutMs: 10_000,   // 10s test timeout
    }),
  );
});

afterEach(async () => {
  // Restore cwd if it was changed (safety measure — we use registerCheckpointMechanism instead)
  try { process.chdir(originalCwd); } catch { /* ignore */ }
  await rm(projectRoot, { recursive: true, force: true });
});

describe("careful-flow end-to-end (s14-c6)", () => {
  it("disk-mechanism approval dance: write .approved.json → runWithAudit completes → audit log written", async () => {
    const runId = `test-run-${Date.now()}`;
    const checkpointId = "post-research";

    // Step 1: Kick off the checkpoint in the background (it blocks until .approved.json appears).
    const checkpointPromise = runWithAudit({
      projectRoot,
      runId,
      checkpointId,
      mechanism: "disk",
      iteration: 1,
      fn: async () => {
        const diskMechanism = new DiskCheckpointMechanism(
          join(projectRoot, ".bober", "approvals"),
          { pollMs: 50, timeoutMs: 10_000 },
        );
        return diskMechanism.request(checkpointId, {
          type: "research-doc",
          summary: "integration test artifact",
        });
      },
    });

    // Step 2: Poll for the pending file and write .approved.json to unblock.
    // Using saveApproved() as the canonical helper (per briefing) — NOT hand-rolling the path.
    let approved = false;
    const POLL_INTERVAL = 100; // ms
    const MAX_POLLS = 80;      // 8 seconds total

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL));

      const pending = await listPending(projectRoot);
      const target = pending.find((p) => p.checkpointId === checkpointId);

      if (target) {
        // Write the approval marker using the canonical helper
        await saveApproved(projectRoot, checkpointId, {
          approvedAt: new Date().toISOString(),
          approverId: "integration-test",
        });
        approved = true;
        break;
      }
    }

    expect(approved, "Pending marker should have appeared within 8 seconds").toBe(true);

    // Step 3: Await the checkpoint — it should return approved=true
    const outcome = await checkpointPromise;
    expect(outcome.approved).toBe(true);

    // Step 4: Assert .bober/audits/<runId>.jsonl was written
    const auditPath = join(projectRoot, ".bober", "audits", `${runId}.jsonl`);
    let auditContent: string;
    try {
      await access(auditPath, constants.R_OK);
      auditContent = await readFile(auditPath, "utf-8");
    } catch {
      throw new Error(`Audit file not found at ${auditPath}. runWithAudit should have created it.`);
    }

    // Verify at least one JSONL line exists
    const auditLines = auditContent.trim().split("\n").filter(Boolean);
    expect(auditLines.length).toBeGreaterThanOrEqual(1);

    // Verify the audit line has the expected structure
    const auditRecord = JSON.parse(auditLines[0]!) as Record<string, unknown>;
    expect(auditRecord["runId"]).toBe(runId);
    expect(auditRecord["checkpointId"]).toBe(checkpointId);
    expect(auditRecord["mechanism"]).toBe("disk");
    expect(auditRecord["outcome"]).toBe("approved");

    // Step 5: Verify .pending.json was cleaned up by the disk mechanism after approval
    const approvalsDir = join(projectRoot, ".bober", "approvals");
    let approvalsFiles: string[] = [];
    try {
      approvalsFiles = await readdir(approvalsDir);
    } catch {
      // directory might not exist if cleanup was complete
    }
    const pendingFiles = approvalsFiles.filter((f) => f.endsWith(".pending.json"));
    expect(pendingFiles).toHaveLength(0);
  });

  it("disk-mechanism: multiple sequential checkpoints all complete with audit entries", async () => {
    const runId = `test-multi-run-${Date.now()}`;
    const checkpoints = ["post-research", "post-plan"] as const;

    for (const cpId of checkpoints) {
      // Start checkpoint in background
      const promise = runWithAudit({
        projectRoot,
        runId,
        checkpointId: cpId,
        mechanism: "disk",
        iteration: 1,
        fn: async () => {
          const diskMechanism = new DiskCheckpointMechanism(
            join(projectRoot, ".bober", "approvals"),
            { pollMs: 50, timeoutMs: 10_000 },
          );
          return diskMechanism.request(cpId, { type: "test-artifact" });
        },
      });

      // Poll and approve
      let approved = false;
      for (let i = 0; i < 80; i++) {
        await new Promise<void>((r) => setTimeout(r, 100));
        const pending = await listPending(projectRoot);
        if (pending.some((p) => p.checkpointId === cpId)) {
          await saveApproved(projectRoot, cpId, {
            approvedAt: new Date().toISOString(),
            approverId: "integration-test",
          });
          approved = true;
          break;
        }
      }
      expect(approved, `Checkpoint ${cpId} pending marker should have appeared`).toBe(true);

      const outcome = await promise;
      expect(outcome.approved).toBe(true);
    }

    // Both checkpoints should produce audit entries
    const auditPath = join(projectRoot, ".bober", "audits", `${runId}.jsonl`);
    const auditContent = await readFile(auditPath, "utf-8");
    const auditLines = auditContent.trim().split("\n").filter(Boolean);
    expect(auditLines.length).toBeGreaterThanOrEqual(2);

    // Verify both checkpoints are in the audit
    const checkpointIds = auditLines.map((line) => {
      const r = JSON.parse(line) as Record<string, unknown>;
      return r["checkpointId"] as string;
    });
    expect(checkpointIds).toContain("post-research");
    expect(checkpointIds).toContain("post-plan");
  });
});

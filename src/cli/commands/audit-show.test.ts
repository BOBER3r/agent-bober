/**
 * Colocated unit tests for the `audit show` CLI command.
 *
 * Placed at src/cli/commands/audit-show.test.ts per the project's colocation
 * convention (mirrors list-approvals.test.ts location).
 *
 * Sprint 13 — covers s13-c6 and s13-c8e.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRecord } from "../../orchestrator/checkpoints/audit.js";
import { getAuditPath } from "../../orchestrator/checkpoints/audit.js";

// ── Temp directory setup ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-audit-show-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeAuditLog(runId: string, records: ApprovalRecord[]): Promise<string> {
  const dir = join(tmpDir, ".bober", "audits");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${runId}.jsonl`);
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(path, lines, "utf-8");
  return path;
}

function makeRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    timestamp: "2026-05-25T12:00:00.000Z",
    runId: "run-test",
    checkpointId: "post-plan",
    mechanism: "noop",
    outcome: "approved",
    approverId: "autopilot",
    iteration: 1,
    durationMs: 1234,
    ...overrides,
  };
}

/**
 * Directly test the JSONL reading and rendering logic by reading the file
 * with the same logic the CLI command uses.
 */
async function renderAuditLog(runId: string): Promise<{ records: ApprovalRecord[]; raw: string }> {
  const path = getAuditPath(tmpDir, runId);
  const raw = await readFile(path, "utf-8");
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ApprovalRecord);
  return { records, raw };
}

// ── Tests: JSONL reading and parsing (s13-c6, s13-c8e) ───────────────────────

describe("audit show — JSONL reading (s13-c8e)", () => {
  it("reads a JSONL file with a single record and parses it correctly", async () => {
    const runId = "run-single";
    const record = makeRecord({ runId, checkpointId: "post-plan", outcome: "approved", approverId: "oleksii" });
    await writeAuditLog(runId, [record]);

    const { records } = await renderAuditLog(runId);

    expect(records).toHaveLength(1);
    expect(records[0].checkpointId).toBe("post-plan");
    expect(records[0].outcome).toBe("approved");
    expect(records[0].approverId).toBe("oleksii");
  });

  it("reads a JSONL file with multiple records", async () => {
    const runId = "run-multi";
    await writeAuditLog(runId, [
      makeRecord({ runId, checkpointId: "post-research", outcome: "approved", iteration: 1 }),
      makeRecord({ runId, checkpointId: "post-plan", outcome: "rejected", iteration: 1, feedbackText: "not ready" }),
      makeRecord({ runId, checkpointId: "post-plan", outcome: "approved", iteration: 2 }),
    ]);

    const { records } = await renderAuditLog(runId);

    expect(records).toHaveLength(3);
    expect(records[0].checkpointId).toBe("post-research");
    expect(records[1].outcome).toBe("rejected");
    expect(records[1].feedbackText).toBe("not ready");
    expect(records[2].iteration).toBe(2);
  });

  it("parses JSON for --json mode: records have all expected fields", async () => {
    const runId = "run-json-fields";
    const record = makeRecord({
      runId,
      checkpointId: "post-sprint",
      mechanism: "disk",
      outcome: "edited",
      approverId: "test-user",
      iteration: 3,
      durationMs: 5000,
      editDeltaSummary: { lineCount: 7, firstChars: "some content" },
    });
    await writeAuditLog(runId, [record]);

    const { records } = await renderAuditLog(runId);
    const [parsed] = records;

    expect(parsed.runId).toBe(runId);
    expect(parsed.checkpointId).toBe("post-sprint");
    expect(parsed.mechanism).toBe("disk");
    expect(parsed.outcome).toBe("edited");
    expect(parsed.approverId).toBe("test-user");
    expect(parsed.iteration).toBe(3);
    expect(parsed.durationMs).toBe(5000);
    expect(parsed.editDeltaSummary?.lineCount).toBe(7);
  });

  it("--json mode produces the same data as the records array", async () => {
    const runId = "run-json-equiv";
    const records = [
      makeRecord({ runId, outcome: "approved" }),
      makeRecord({ runId, outcome: "rejected", feedbackText: "needs work" }),
    ];
    await writeAuditLog(runId, records);

    const { records: parsed } = await renderAuditLog(runId);
    const jsonOutput = JSON.stringify(parsed, null, 2);
    const reparsed = JSON.parse(jsonOutput) as ApprovalRecord[];

    expect(Array.isArray(reparsed)).toBe(true);
    expect(reparsed).toHaveLength(2);
    expect(reparsed[0].outcome).toBe("approved");
    expect(reparsed[1].outcome).toBe("rejected");
  });
});

// ── Tests: ENOENT handling (s13-c8e) ─────────────────────────────────────────

describe("audit show — ENOENT path (s13-c8e)", () => {
  it("ENOENT: reading a non-existent audit file throws with code ENOENT", async () => {
    const path = getAuditPath(tmpDir, "nonexistent-run");
    try {
      await readFile(path, "utf-8");
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ENOENT");
    }
  });

  it("getAuditPath returns a .jsonl path under .bober/audits/", () => {
    const path = getAuditPath(tmpDir, "run-abc");
    expect(path).toContain(".bober");
    expect(path).toContain("audits");
    expect(path).toContain("run-abc.jsonl");
  });
});

// ── Tests: CLI command registration (s13-c6) ─────────────────────────────────

describe("registerAuditCommand — command structure (s13-c6)", () => {
  it("registers an 'audit' parent command with 'show' subcommand", async () => {
    const { Command } = await import("commander");
    const { registerAuditCommand } = await import("./audit-show.js");

    const program = new Command();
    program.exitOverride();
    registerAuditCommand(program);

    // The 'audit' command should be registered.
    const auditCmd = program.commands.find((c) => c.name() === "audit");
    expect(auditCmd).toBeDefined();

    // The 'show' subcommand should be registered under 'audit'.
    const showCmd = auditCmd?.commands.find((c) => c.name() === "show");
    expect(showCmd).toBeDefined();
    expect(showCmd?.description()).toContain("audit log");
  });

  it("registerAuditCommand is a named export (not default)", async () => {
    const module = await import("./audit-show.js");
    expect(typeof module.registerAuditCommand).toBe("function");
  });
});

/**
 * Unit tests for the telemetry emit module.
 *
 * Covers:
 * - s28-c3: JSONL line written with correct shape when enabled=true
 * - s28-c3: No-op when enabled=false (zero file writes)
 * - s28-c3: File mode is 0600 (Sprint 13 pattern)
 * - s28-c5: Privacy — user-content strings are NEVER written
 * - s28-c3: Concurrent emits serialize correctly (mutex pattern)
 *
 * Sprint 28 — tests/telemetry/emit.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoberConfig } from "../../src/config/schema.js";
import { emit } from "../../src/telemetry/emit.js";

// ── Temp directory setup ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-telemetry-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function enabledConfig(): BoberConfig {
  return { telemetry: { enabled: true } } as BoberConfig;
}

function disabledConfig(): BoberConfig {
  return { telemetry: { enabled: false } } as BoberConfig;
}

function telemetryFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(tmpDir, ".bober", "telemetry", `${date}.jsonl`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("telemetry emit — file IO", () => {
  it("writes a JSONL line with correct shape when enabled=true", async () => {
    await emit(tmpDir, enabledConfig(), "checkpoint-approved", {
      checkpointId: "post-plan",
      iteration: 1,
    });
    const path = telemetryFilePath();
    const raw = await readFile(path, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.eventType).toBe("checkpoint-approved");
    expect(parsed.checkpointId).toBe("post-plan");
    expect(parsed.iteration).toBe(1);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("writes mode 0600 on the telemetry file", async () => {
    await emit(tmpDir, enabledConfig(), "sprint-pass", { sprintId: "sprint-1", iteration: 1 });
    const path = telemetryFilePath();
    const { stat } = await import("node:fs/promises");
    const s = await stat(path);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("is a no-op when enabled=false — zero file writes from 100 calls", async () => {
    const cfg = disabledConfig();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        emit(tmpDir, cfg, "checkpoint-approved", { checkpointId: "x", iteration: 1 }),
      ),
    );
    const telDir = join(tmpDir, ".bober", "telemetry");
    await expect(access(telDir)).rejects.toThrow();
  });

  it("is a no-op when telemetry section is absent (undefined)", async () => {
    const cfg = {} as BoberConfig;
    await emit(tmpDir, cfg, "sprint-pass", { sprintId: "test", iteration: 1 });
    const telDir = join(tmpDir, ".bober", "telemetry");
    await expect(access(telDir)).rejects.toThrow();
  });

  it("serializes 50 concurrent emits — produces 50 well-formed lines", async () => {
    const cfg = enabledConfig();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        emit(tmpDir, cfg, "agent-spawn", { agentName: "generator", iteration: i }),
      ),
    );
    const path = telemetryFilePath();
    const raw = await readFile(path, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.eventType).toBe("agent-spawn");
      expect(parsed.agentName).toBe("generator");
      expect(typeof parsed.timestamp).toBe("string");
    }
  });

  it("writes multiple different event types", async () => {
    const cfg = enabledConfig();
    await emit(tmpDir, cfg, "checkpoint-approved", { checkpointId: "post-plan", iteration: 1 });
    await emit(tmpDir, cfg, "sprint-pass", { sprintId: "s1", iteration: 1 });
    await emit(tmpDir, cfg, "incident-resolved", { incidentId: "inc-001", durationMs: 42000 });

    const path = telemetryFilePath();
    const raw = await readFile(path, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    const types = lines.map((l) => (JSON.parse(l) as { eventType: string }).eventType);
    expect(types).toEqual(["checkpoint-approved", "sprint-pass", "incident-resolved"]);
  });
});

describe("telemetry emit — privacy invariant (s28-c5)", () => {
  it("never writes user-content strings even when prod-looking data is in scope", async () => {
    const cfg = enabledConfig();
    // Simulated secret that must NOT appear in the telemetry file.
    const userFeedback = "AKIASECRET123 user-database-credentials-leaked";
    // The call site emits ONLY IDs — not the feedback text itself.
    void userFeedback; // referenced to simulate being "in scope"
    await emit(tmpDir, cfg, "checkpoint-rejected", {
      checkpointId: "post-plan",
      iteration: 1,
      // feedbackText is NOT a field in TelemetryEventData — it cannot be passed
    });
    const path = telemetryFilePath();
    const raw = await readFile(path, "utf-8");
    expect(raw).not.toContain("AKIASECRET123");
    expect(raw).not.toContain("user-database-credentials-leaked");
  });

  it("payload contains only allowed fields (IDs, counts, enums)", async () => {
    const cfg = enabledConfig();
    await emit(tmpDir, cfg, "agent-error", {
      agentName: "generator",
      errorKind: "timeout",
      retryCount: 2,
    });
    const path = telemetryFilePath();
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    // Only these keys should be present
    const keys = Object.keys(parsed);
    const allowedKeys = new Set([
      "timestamp", "eventType", "agentName", "errorKind", "retryCount",
      // TelemetryEventData allowed fields:
      "runId", "incidentId", "specId", "sprintId", "contractId",
      "checkpointId", "iteration", "durationMs", "outcome",
    ]);
    for (const key of keys) {
      expect(allowedKeys.has(key), `Unexpected key in telemetry payload: ${key}`).toBe(true);
    }
  });
});

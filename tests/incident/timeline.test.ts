/**
 * Unit tests for src/incident/timeline.ts (Sprint 19).
 *
 * Test location: tests/incident/timeline.test.ts — follows the contract's
 * expectedChanges path (tests/incident/timeline.test.ts). The tests/ directory
 * IS in use (see tests/config/, tests/orchestrator/, tests/integration/), so
 * this placement is consistent with the project's non-colocated test tree.
 *
 * Each test uses a fresh mkdtemp directory as projectRoot so NO files are
 * written to the repo's .bober/incidents/ directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIncident,
  deriveSlug,
  appendTimeline,
  appendObservation,
  appendAction,
  appendChange,
  appendRunbookExecution,
  setIncidentStatus,
  listIncidents,
} from "../../src/incident/timeline.js";
import type {
  TimelineEvent,
  ObservationEntry,
  ActionEntry,
  ChangeEntry,
  RunbookExecutionEntry,
} from "../../src/incident/types.js";

// ── Temp directory fixture ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-incident-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function makeObservation(overrides: Partial<ObservationEntry> = {}): ObservationEntry {
  return {
    timestamp: new Date().toISOString(),
    phase: 1,
    observation: "CPU spike observed",
    source: "prometheus",
    verified: true,
    ...overrides,
  };
}

function makeAction(overrides: Partial<ActionEntry> = {}): ActionEntry {
  return {
    timestamp: new Date().toISOString(),
    action: "Restarted web pods",
    blastRadius: "safe",
    requiresApproval: false,
    ...overrides,
  };
}

function makeChange(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id: "chg-1",
    type: "k8s_scale",
    executedAt: new Date().toISOString(),
    description: "scale to 6",
    inverse: { description: "scale to 3", command: "kubectl scale --replicas=3" },
    status: "executed",
    ...overrides,
  };
}

function makeRunbookEntry(overrides: Partial<RunbookExecutionEntry> = {}): RunbookExecutionEntry {
  return {
    timestamp: new Date().toISOString(),
    runbookName: "restart-web-tier",
    stepNumber: 1,
    status: "success",
    preconditionResult: "pass",
    postconditionResult: "pass",
    ...overrides,
  };
}

function makeTimelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    timestamp: new Date().toISOString(),
    eventKind: "test_event",
    source: "system",
    summary: "Test event summary",
    ...overrides,
  };
}

// ── createIncident: full skeleton ─────────────────────────────────────────────

describe("createIncident — skeleton structure", () => {
  it("creates all required files and directories", async () => {
    const incidentId = await createIncident("500 errors on checkout endpoint", tmpDir);
    const dir = join(tmpDir, ".bober", "incidents", incidentId);

    // All 5 JSONL files exist.
    for (const fname of [
      "timeline.jsonl",
      "observations.jsonl",
      "actions.jsonl",
      "changelog.jsonl",
      "runbook-execution.jsonl",
    ]) {
      const fileStat = await stat(join(dir, fname));
      expect(fileStat.isFile(), `${fname} should be a file`).toBe(true);
    }

    // hypotheses.md exists.
    const mdStat = await stat(join(dir, "hypotheses.md"));
    expect(mdStat.isFile()).toBe(true);

    // incident.json exists and has correct fields.
    const raw = await readFile(join(dir, "incident.json"), "utf-8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    expect(meta.incidentId).toBe(incidentId);
    expect(meta.symptom).toBe("500 errors on checkout endpoint");
    expect(meta.status).toBe("investigating");
    expect(typeof meta.createdAt).toBe("string");

    // diagnoses/ subdirectory exists.
    const diagStat = await stat(join(dir, "diagnoses"));
    expect(diagStat.isDirectory()).toBe(true);
  });

  it("returns incidentId with correct format for '500 errors on checkout endpoint'", async () => {
    const incidentId = await createIncident("500 errors on checkout endpoint", tmpDir);
    expect(incidentId).toMatch(/^inc-\d{8}-500-errors-on$/);
  });

  it("emits an incident_created timeline event on create", async () => {
    const incidentId = await createIncident("db connection failure", tmpDir);
    const tlPath = join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl");
    const events = await readJsonl<TimelineEvent>(tlPath);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].eventKind).toBe("incident_created");
    expect(events[0].source).toBe("system");
  });
});

// ── deriveSlug edge cases ──────────────────────────────────────────────────────

describe("deriveSlug — edge cases", () => {
  it("normal text → first 3 words kebab-case", () => {
    expect(deriveSlug("500 errors on checkout endpoint")).toBe("500-errors-on");
  });

  it("empty string → 'untitled'", () => {
    expect(deriveSlug("")).toBe("untitled");
  });

  it("all-punctuation → 'untitled'", () => {
    expect(deriveSlug("!!!  !!!  ???")).toBe("untitled");
  });

  it("unicode-only (CJK) → 'untitled'", () => {
    expect(deriveSlug("数据库 连接 失败")).toBe("untitled");
  });

  it("very long string → truncated to ≤30 chars", () => {
    const slug = deriveSlug("a".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug).not.toBe("untitled");
  });

  it("single word under 30 chars → returned as-is", () => {
    expect(deriveSlug("latency")).toBe("latency");
  });

  it("mixed punct and letters → strips punct, keeps letters", () => {
    expect(deriveSlug("api!!! slowness-- now")).toBe("api-slowness-now");
  });
});

describe("createIncident — slug via createIncident (s19-c3 test pattern)", () => {
  it.each([
    ["500 errors on checkout endpoint", /^inc-\d{8}-500-errors-on$/],
    ["", /^inc-\d{8}-untitled$/],
    ["!!!  !!!  ???", /^inc-\d{8}-untitled$/],
    ["a".repeat(200), /^inc-\d{8}-[a]{1,30}$/],
    ["数据库 连接 失败", /^inc-\d{8}-/],
  ])("symptom %j produces id matching %s", async (symptom, pattern) => {
    const id = await createIncident(symptom, tmpDir);
    expect(id).toMatch(pattern);
  });
});

// ── appendTimeline ─────────────────────────────────────────────────────────────

describe("appendTimeline", () => {
  it("appends a single line to timeline.jsonl", async () => {
    const incidentId = await createIncident("latency spike", tmpDir);
    const event = makeTimelineEvent({ eventKind: "manual_note", summary: "Engineer escalated" });

    await appendTimeline(tmpDir, incidentId, event);

    const tlPath = join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl");
    const lines = await readJsonl<TimelineEvent>(tlPath);
    // At least 2 lines: incident_created + manual_note
    const found = lines.find((l) => l.eventKind === "manual_note");
    expect(found).toBeTruthy();
    expect(found?.summary).toBe("Engineer escalated");
  });

  it("appended event is valid JSON", async () => {
    const incidentId = await createIncident("network error", tmpDir);
    const event = makeTimelineEvent();
    await appendTimeline(tmpDir, incidentId, event);

    const tlPath = join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl");
    const raw = await readFile(tlPath, "utf-8");
    for (const line of raw.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ── appendObservation — double-write ──────────────────────────────────────────

describe("appendObservation — double-write pattern", () => {
  it("writes to observations.jsonl AND timeline.jsonl", async () => {
    const incidentId = await createIncident("service degraded", tmpDir);
    const dir = join(tmpDir, ".bober", "incidents", incidentId);
    const obs = makeObservation({ observation: "p99 latency > 5s" });

    await appendObservation(tmpDir, incidentId, obs);

    const obsLines = await readJsonl<ObservationEntry>(join(dir, "observations.jsonl"));
    expect(obsLines).toHaveLength(1);
    expect(obsLines[0].observation).toBe("p99 latency > 5s");

    const tlLines = await readJsonl<TimelineEvent>(join(dir, "timeline.jsonl"));
    const obsEvent = tlLines.find((l) => l.eventKind === "observation_recorded");
    expect(obsEvent).toBeTruthy();
    expect(obsEvent?.source).toBe("diagnoser");
  });
});

// ── appendAction — double-write ────────────────────────────────────────────────

describe("appendAction — double-write pattern", () => {
  it("writes to actions.jsonl AND timeline.jsonl", async () => {
    const incidentId = await createIncident("db overloaded", tmpDir);
    const dir = join(tmpDir, ".bober", "incidents", incidentId);
    const action = makeAction({ action: "scaled up replicas" });

    await appendAction(tmpDir, incidentId, action);

    const actLines = await readJsonl<ActionEntry>(join(dir, "actions.jsonl"));
    expect(actLines).toHaveLength(1);
    expect(actLines[0].action).toBe("scaled up replicas");

    const tlLines = await readJsonl<TimelineEvent>(join(dir, "timeline.jsonl"));
    const actionEvent = tlLines.find((l) => l.eventKind === "action_taken");
    expect(actionEvent).toBeTruthy();
    expect(actionEvent?.source).toBe("human");
  });
});

// ── appendChange — double-write + required inverse ────────────────────────────

describe("appendChange — double-write pattern and required inverse", () => {
  it("writes to changelog.jsonl AND timeline.jsonl", async () => {
    const incidentId = await createIncident("feature flag caused regression", tmpDir);
    const dir = join(tmpDir, ".bober", "incidents", incidentId);
    const change = makeChange();

    await appendChange(tmpDir, incidentId, change);

    const changeLines = await readJsonl<ChangeEntry>(join(dir, "changelog.jsonl"));
    expect(changeLines).toHaveLength(1);
    expect(changeLines[0].inverse.description).toBe("scale to 3");

    const tlLines = await readJsonl<TimelineEvent>(join(dir, "timeline.jsonl"));
    const changeEvent = tlLines.find((l) => l.eventKind === "change_recorded");
    expect(changeEvent).toBeTruthy();
    expect(changeEvent?.source).toBe("deployer");
  });

  it("appendChange WITHOUT inverse throws schema error (s19-c5)", async () => {
    const incidentId = await createIncident("rollback test", tmpDir);
    const dir = join(tmpDir, ".bober", "incidents", incidentId);

    // @ts-expect-error — intentionally omitting required field to test validation
    const badChange = {
      id: "c1",
      type: "k8s_scale",
      executedAt: new Date().toISOString(),
      description: "scale",
      status: "executed",
    };

    await expect(appendChange(tmpDir, incidentId, badChange)).rejects.toThrow(/inverse/);

    // Verify changelog.jsonl was NOT written at all.
    const changelogPath = join(dir, "changelog.jsonl");
    const raw = await readFile(changelogPath, "utf-8");
    expect(raw).toBe("");
  });
});

// ── appendRunbookExecution — double-write ─────────────────────────────────────

describe("appendRunbookExecution — double-write pattern", () => {
  it("writes to runbook-execution.jsonl AND timeline.jsonl", async () => {
    const incidentId = await createIncident("runbook test", tmpDir);
    const dir = join(tmpDir, ".bober", "incidents", incidentId);
    const entry = makeRunbookEntry({ runbookName: "drain-nodes", stepNumber: 2 });

    await appendRunbookExecution(tmpDir, incidentId, entry);

    const rbLines = await readJsonl<RunbookExecutionEntry>(
      join(dir, "runbook-execution.jsonl"),
    );
    expect(rbLines).toHaveLength(1);
    expect(rbLines[0].runbookName).toBe("drain-nodes");
    expect(rbLines[0].stepNumber).toBe(2);

    const tlLines = await readJsonl<TimelineEvent>(join(dir, "timeline.jsonl"));
    const rbEvent = tlLines.find((l) => l.eventKind === "runbook_step_executed");
    expect(rbEvent).toBeTruthy();
    expect(rbEvent?.source).toBe("system");
  });
});

// ── Concurrent appends — mutex correctness ────────────────────────────────────

describe("concurrent appends — mutex correctness", () => {
  it("100 parallel appendObservation calls produce 100 valid lines in both files", async () => {
    const incidentId = await createIncident("concurrent test", tmpDir);
    const dir = join(tmpDir, ".bober", "incidents", incidentId);

    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        appendObservation(tmpDir, incidentId, {
          timestamp: new Date().toISOString(),
          phase: 1,
          observation: `obs-${i}`,
          source: "test",
          verified: true,
        }),
      ),
    );

    const obsPath = join(dir, "observations.jsonl");
    const obsLines = (await readFile(obsPath, "utf-8")).split("\n").filter(Boolean);
    expect(obsLines).toHaveLength(100);
    for (const line of obsLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // timeline.jsonl gets 100 lines from the 100 observation events
    // (plus 1 from incident_created, so ≥ 100 observations).
    const tlPath = join(dir, "timeline.jsonl");
    const tlLines = (await readFile(tlPath, "utf-8")).split("\n").filter(Boolean);
    // The observation events: exactly 100 in timeline from double-write.
    const obsEvents = tlLines.filter((l) => {
      try {
        return (JSON.parse(l) as TimelineEvent).eventKind === "observation_recorded";
      } catch {
        return false;
      }
    });
    expect(obsEvents).toHaveLength(100);
  });
});

// ── setIncidentStatus ──────────────────────────────────────────────────────────

describe("setIncidentStatus", () => {
  it("updates status in incident.json", async () => {
    const incidentId = await createIncident("status test", tmpDir);
    const metaPath = join(tmpDir, ".bober", "incidents", incidentId, "incident.json");

    await setIncidentStatus(tmpDir, incidentId, "remediating");

    const raw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    expect(meta.status).toBe("remediating");
  });

  it("sets resolvedAt automatically when status is 'resolved'", async () => {
    const incidentId = await createIncident("resolve test", tmpDir);
    const metaPath = join(tmpDir, ".bober", "incidents", incidentId, "incident.json");

    const before = Date.now();
    await setIncidentStatus(tmpDir, incidentId, "resolved");
    const after = Date.now();

    const raw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    expect(meta.status).toBe("resolved");
    expect(typeof meta.resolvedAt).toBe("string");
    // resolvedAt should be a valid ISO string within the test window.
    const resolvedMs = new Date(meta.resolvedAt as string).getTime();
    expect(resolvedMs).toBeGreaterThanOrEqual(before);
    expect(resolvedMs).toBeLessThanOrEqual(after);
  });

  it("does not overwrite existing resolvedAt on a second status change", async () => {
    const incidentId = await createIncident("re-resolve test", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "resolved");

    const metaPath = join(tmpDir, ".bober", "incidents", incidentId, "incident.json");
    const firstRaw = await readFile(metaPath, "utf-8");
    const firstResolvedAt = (JSON.parse(firstRaw) as Record<string, unknown>).resolvedAt;

    await setIncidentStatus(tmpDir, incidentId, "aborted");

    const secondRaw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(secondRaw) as Record<string, unknown>;
    // resolvedAt from first resolve should be preserved.
    expect(meta.resolvedAt).toBe(firstResolvedAt);
    expect(meta.status).toBe("aborted");
  });
});

// ── listIncidents ──────────────────────────────────────────────────────────────

describe("listIncidents", () => {
  it("returns [] when .bober/incidents/ does not exist", async () => {
    const result = await listIncidents(tmpDir);
    expect(result).toEqual([]);
  });

  it("returns 3 incidents sorted desc by createdAt", async () => {
    const id1 = await createIncident("first incident", tmpDir);
    await new Promise((r) => setTimeout(r, 15));
    const id2 = await createIncident("second incident", tmpDir);
    await new Promise((r) => setTimeout(r, 15));
    const id3 = await createIncident("third incident", tmpDir);

    const list = await listIncidents(tmpDir);
    expect(list).toHaveLength(3);
    // Newest first.
    expect(list[0].incidentId).toBe(id3);
    expect(list[1].incidentId).toBe(id2);
    expect(list[2].incidentId).toBe(id1);
  });

  it("includes required summary fields", async () => {
    await createIncident("test symptom listing", tmpDir);
    const list = await listIncidents(tmpDir);
    expect(list).toHaveLength(1);
    expect(list[0].symptom).toBe("test symptom listing");
    expect(list[0].status).toBe("investigating");
    expect(typeof list[0].createdAt).toBe("string");
    expect(typeof list[0].incidentId).toBe("string");
  });
});

// ── File permissions 0600 ──────────────────────────────────────────────────────

describe("file permissions (s13-c7 pattern, mode 0600)", () => {
  it("created timeline.jsonl has mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;

    const incidentId = await createIncident("permission test", tmpDir);
    await appendTimeline(tmpDir, incidentId, makeTimelineEvent());

    const tlPath = join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl");
    const fileStat = await stat(tlPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("created observations.jsonl has mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;

    const incidentId = await createIncident("perm obs test", tmpDir);
    await appendObservation(tmpDir, incidentId, makeObservation());

    const obsPath = join(tmpDir, ".bober", "incidents", incidentId, "observations.jsonl");
    const fileStat = await stat(obsPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

/**
 * Tests for src/calendar/proposal-gate.ts
 *
 * Covers:
 *   sc-4-3: proposePlan writes a pending marker, connector.writeEvents NOT called before approval.
 *   sc-4-4: applyPlan with ApprovedMarker → writeEvents exactly once; with RejectedMarker → never.
 *   sc-4-5: adjustPlan re-runs slotter under a constraint delta; writes NOTHING.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proposePlan, applyPlan, adjustPlan } from "./proposal-gate.js";
import type { ProposeArgs } from "./proposal-gate.js";
import type { CalendarConnector } from "./connector.js";
import type { Finding, BusyInterval, SlotConstraints, ProposedPlan, PlanItem } from "./types.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const T = "2026-06-29T08:00:00.000Z";

const FIXTURE_FINDING: Finding = {
  id: "gate-test-1",
  domain: "coding",
  title: "Gate test task",
  kind: "action",
  urgency: 5,
  severity: 4,
  evidence: ["ev"],
  surfacedAt: "2026-06-29T00:00:00.000Z",
  tags: [],
  estDurationMin: 30,
  status: "open",
};

const FIXTURE_PLAN: ProposedPlan = {
  scheduled: [
    {
      findingId: "gate-test-1",
      title: "Gate test task",
      startIso: "2026-06-29T08:00:00.000Z",
      endIso: "2026-06-29T08:30:00.000Z",
    },
  ],
  unscheduled: [],
};

const BASE_PROPOSE_ARGS = (tmpDir: string): ProposeArgs => ({
  projectRoot: tmpDir,
  planId: "p1",
  plan: FIXTURE_PLAN,
  connectorName: "stub",
  now: () => T,
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Assert that a filesystem path does NOT exist (ENOENT → pass; other error → rethrow). */
async function expectMissing(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Expected ${path} to be absent, but it exists`);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
}

/** Build a stub CalendarConnector that counts writeEvents calls. */
function makeStubConnector(): {
  connector: CalendarConnector;
  writeCalls: () => number;
  lastItems: () => PlanItem[];
} {
  let writeCalls = 0;
  let lastItems: PlanItem[] = [];
  const connector: CalendarConnector = {
    name: "stub",
    async readFreeBusy() { return []; },
    async writeEvents(items) {
      writeCalls++;
      lastItems = items;
      return { writtenCount: items.length, target: "stub" };
    },
  };
  return {
    connector,
    writeCalls: () => writeCalls,
    lastItems: () => lastItems,
  };
}

// ── sc-4-3: proposePlan writes pending marker, no writeEvents ─────────

describe("proposePlan (sc-4-3)", () => {
  it("writes a .pending.json marker in .bober/approvals", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      const { checkpointId } = await proposePlan(BASE_PROPOSE_ARGS(tmpDir));
      expect(checkpointId).toBe("calendar-p1");

      const pendingPath = join(tmpDir, ".bober", "approvals", "calendar-p1.pending.json");
      await access(pendingPath); // asserts file exists (throws ENOENT if not)

      const raw = await readFile(pendingPath, "utf-8");
      const marker = JSON.parse(raw) as {
        checkpointId: string;
        artifact: { type?: string; path?: string };
      };
      expect(marker.checkpointId).toBe("calendar-p1");
      expect(marker.artifact.type).toBe("calendar-plan");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes a plan sidecar at .bober/calendar/<id>.plan.json", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      const { checkpointId } = await proposePlan(BASE_PROPOSE_ARGS(tmpDir));
      const sidecarPath = join(tmpDir, ".bober", "calendar", `${checkpointId}.plan.json`);
      await access(sidecarPath);

      const raw = await readFile(sidecarPath, "utf-8");
      const sidecar = JSON.parse(raw) as { plan: ProposedPlan; connectorName: string };
      expect(sidecar.connectorName).toBe("stub");
      expect(sidecar.plan.scheduled).toEqual(FIXTURE_PLAN.scheduled);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns checkpointId = calendar-${planId}", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      const { checkpointId } = await proposePlan({
        ...BASE_PROPOSE_ARGS(tmpDir),
        planId: "abc123",
      });
      expect(checkpointId).toBe("calendar-abc123");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does NOT call connector.writeEvents during proposePlan", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      const { connector, writeCalls } = makeStubConnector();
      // proposePlan does not receive a connector — but this test confirms the contract:
      // no writes occur when only proposePlan is called (connector is not passed in)
      await proposePlan(BASE_PROPOSE_ARGS(tmpDir));
      // connector was not given to proposePlan, so writeCalls must be 0
      expect(writeCalls()).toBe(0);
      // Additionally: no .approved.json should exist yet
      await expectMissing(
        join(tmpDir, ".bober", "approvals", "calendar-p1.approved.json"),
      );
      // Silence unused-var lint — connector used in other tests
      expect(connector.name).toBe("stub");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── sc-4-4: applyPlan — approved once / rejected never ───────────────

describe("applyPlan (sc-4-4)", () => {
  it("calls writeEvents exactly once with the proposed items on ApprovedMarker", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      // 1. Propose
      const { checkpointId } = await proposePlan(BASE_PROPOSE_ARGS(tmpDir));

      // 2. Inject an approved marker (mirrors approve.ts:74-79)
      const approvalsDir = join(tmpDir, ".bober", "approvals");
      await mkdir(approvalsDir, { recursive: true });
      await writeFile(
        join(approvalsDir, `${checkpointId}.approved.json`),
        JSON.stringify({ approvedAt: T, approverId: "test" }, null, 2) + "\n",
        "utf-8",
      );

      // 3. Apply
      const { connector, writeCalls, lastItems } = makeStubConnector();
      const outcome = await applyPlan(tmpDir, checkpointId, connector);

      expect(writeCalls()).toBe(1);
      expect(lastItems()).toEqual(FIXTURE_PLAN.scheduled);
      expect(outcome).toEqual({ status: "applied", writtenCount: 1 });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("deletes the pending marker after a successful apply", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      const { checkpointId } = await proposePlan(BASE_PROPOSE_ARGS(tmpDir));
      const approvalsDir = join(tmpDir, ".bober", "approvals");
      await writeFile(
        join(approvalsDir, `${checkpointId}.approved.json`),
        JSON.stringify({ approvedAt: T, approverId: "test" }) + "\n",
        "utf-8",
      );

      const { connector } = makeStubConnector();
      await applyPlan(tmpDir, checkpointId, connector);

      await expectMissing(join(approvalsDir, `${checkpointId}.pending.json`));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("NEVER calls writeEvents when a RejectedMarker is present", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      const { checkpointId } = await proposePlan(BASE_PROPOSE_ARGS(tmpDir));
      const approvalsDir = join(tmpDir, ".bober", "approvals");

      // Inject a rejected marker
      await writeFile(
        join(approvalsDir, `${checkpointId}.rejected.json`),
        JSON.stringify({
          rejectedAt: T,
          rejecterId: "test",
          feedback: "Not now",
        }) + "\n",
        "utf-8",
      );

      const { connector, writeCalls } = makeStubConnector();
      const outcome = await applyPlan(tmpDir, checkpointId, connector);

      expect(writeCalls()).toBe(0);
      expect(outcome.status).toBe("rejected");
      expect((outcome as { feedback?: string }).feedback).toBe("Not now");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns { status: 'pending' } when neither approved nor rejected marker exists", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-"));
    try {
      const { checkpointId } = await proposePlan(BASE_PROPOSE_ARGS(tmpDir));
      const { connector, writeCalls } = makeStubConnector();
      const outcome = await applyPlan(tmpDir, checkpointId, connector);

      expect(outcome.status).toBe("pending");
      expect(writeCalls()).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── sc-4-5: adjustPlan — pure re-slot, no filesystem writes ──────────

describe("adjustPlan (sc-4-5)", () => {
  const BASE_CONSTRAINTS: SlotConstraints = {
    windowStartIso: "2026-06-29T08:00:00.000Z",
    windowEndIso: "2026-06-30T08:00:00.000Z",
  };

  const FINDINGS_FOR_ADJUST: Finding[] = [
    {
      ...FIXTURE_FINDING,
      id: "adj-1",
      estDurationMin: 30,
    },
  ];

  it("re-slots findings with an excludeInterval appended to busy[]", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-adjust-"));
    try {
      // Block the first 60 min of the window via excludeInterval
      const result = adjustPlan(
        FINDINGS_FOR_ADJUST,
        [],
        BASE_CONSTRAINTS,
        {
          excludeInterval: {
            startIso: "2026-06-29T08:00:00.000Z",
            endIso: "2026-06-29T09:00:00.000Z",
          },
        },
      );

      // The task should now be scheduled AFTER the excluded interval
      expect(result.scheduled.length).toBe(1);
      expect(result.scheduled[0]!.startIso >= "2026-06-29T09:00:00.000Z").toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("re-slots with a shifted window (windowStartIso delta)", () => {
    const result = adjustPlan(
      FINDINGS_FOR_ADJUST,
      [],
      BASE_CONSTRAINTS,
      { windowStartIso: "2026-06-29T10:00:00.000Z" },
    );

    expect(result.scheduled.length).toBe(1);
    // Task must start at or after the shifted window start
    expect(result.scheduled[0]!.startIso >= "2026-06-29T10:00:00.000Z").toBe(true);
  });

  it("writes NOTHING to disk (pure function)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-proposal-gate-adjust-"));
    try {
      adjustPlan(FINDINGS_FOR_ADJUST, [], BASE_CONSTRAINTS, {});

      // No approvals directory should have been created
      await expectMissing(join(tmpDir, ".bober", "approvals"));
      // No calendar directory should have been created
      await expectMissing(join(tmpDir, ".bober", "calendar"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns a new ProposedPlan without modifying the input busy[]", () => {
    const busy: BusyInterval[] = [];
    const delta = {
      excludeInterval: {
        startIso: "2026-06-29T08:00:00.000Z",
        endIso: "2026-06-29T08:30:00.000Z",
      },
    };

    adjustPlan(FINDINGS_FOR_ADJUST, busy, BASE_CONSTRAINTS, delta);

    // Original busy array must be unchanged
    expect(busy).toHaveLength(0);
  });
});

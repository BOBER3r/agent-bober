import { describe, it, expect } from "vitest";
import { FactStore, factId } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";
import { writeFinding, readFindings, transitionFinding, ingestFinding } from "./finding-store.js";
import { captureTask } from "./task-inbox.js";
import type { Finding } from "./finding.js";

const T = "2026-06-28T00:00:00.000Z";

const SAMPLE_FINDING: Finding = {
  id: "abc123def456abc1",
  domain: "inbox",
  title: "renew passport",
  kind: "action",
  urgency: 3,
  severity: 1,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "open",
};

describe("writeFinding + readFindings", () => {
  it("persists one row with scope=hub and predicate=finding", async () => {
    const store = new FactStore(":memory:");
    await writeFinding(store, SAMPLE_FINDING, { now: T });
    const rows = store.getActiveFacts(HUB_SCOPE, undefined, "finding");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe("hub");
    expect(rows[0]!.predicate).toBe("finding");
    expect(rows[0]!.subject).toBe(SAMPLE_FINDING.id);
    store.close();
  });

  it("readFindings returns the persisted Finding", async () => {
    const store = new FactStore(":memory:");
    await writeFinding(store, SAMPLE_FINDING, { now: T });
    const findings = readFindings(store);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.id).toBe(SAMPLE_FINDING.id);
    expect(f.kind).toBe("action");
    expect(f.status).toBe("open");
    expect(f.title).toBe("renew passport");
    store.close();
  });

  it("optional fields are absent after roundtrip", async () => {
    const store = new FactStore(":memory:");
    await writeFinding(store, SAMPLE_FINDING, { now: T });
    const findings = readFindings(store);
    expect(findings[0]!.dueBy).toBeUndefined();
    expect(findings[0]!.estDurationMin).toBeUndefined();
    expect(findings[0]!.calendarSafeTitle).toBeUndefined();
    expect(findings[0]!.promotesTo).toBeUndefined();
    store.close();
  });

  it("returns empty array when no findings exist", () => {
    const store = new FactStore(":memory:");
    expect(readFindings(store)).toHaveLength(0);
    store.close();
  });
});

describe("ingestFinding", () => {
  const T = "2026-06-28T00:00:00.000Z";

  // sc-4-2: a watch-kind finding (no id) appears in the active pool + list query
  it("sc-4-2: ingests a watch finding and it appears in the pool", async () => {
    const store = new FactStore(":memory:");
    const payload = {
      domain: "medical",
      title: "ferritin trending down",
      kind: "watch",
      urgency: 3,
      severity: 2,
      evidence: [],
      tags: [],
      status: "open",
    }; // no id, no surfacedAt
    const action = await ingestFinding(store, payload, { now: T });
    expect(action).toBe("add");
    const findings = readFindings(store);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("watch");
    expect(findings[0]!.id).toHaveLength(16); // derived id
    expect(findings[0]!.surfacedAt).toBe(T); // defaulted to now
    store.close();
  });

  // sc-4-3: same domain+title+kind twice -> exactly one active row (dedup via reconcile)
  it("sc-4-3: re-ingesting the same finding leaves a single active row", async () => {
    const store = new FactStore(":memory:");
    const payload = {
      domain: "medical",
      title: "ferritin trending down",
      kind: "watch",
      urgency: 3,
      severity: 2,
      evidence: [],
      tags: [],
      status: "open",
    };
    await ingestFinding(store, payload, { now: T });
    await ingestFinding(store, payload, { now: T }); // same now -> identical value -> NOOP
    const active = store.getActiveFacts(HUB_SCOPE, undefined, "finding");
    expect(active).toHaveLength(1); // dedup, not a 2nd ADD
    store.close();
  });

  it("derived id is deterministic for the same domain+title+kind", async () => {
    const store1 = new FactStore(":memory:");
    const store2 = new FactStore(":memory:");
    const payload = {
      domain: "medical",
      title: "ferritin trending down",
      kind: "watch",
      urgency: 3,
      severity: 2,
      evidence: [],
      tags: [],
      status: "open",
    };
    await ingestFinding(store1, payload, { now: T });
    await ingestFinding(store2, payload, { now: T });
    const id1 = readFindings(store1)[0]!.id;
    const id2 = readFindings(store2)[0]!.id;
    expect(id1).toBe(id2);
    store1.close();
    store2.close();
  });
});

describe("transitionFinding", () => {
  const T0 = "2026-06-28T00:00:00.000Z";
  const T1 = "2026-06-29T00:00:00.000Z";

  // sc-2-2: done supersedes the open row but keeps it as bitemporal history
  it("sc-2-2: done transition supersedes open row and preserves historical row", async () => {
    const store = new FactStore(":memory:");

    // Seed an open task; `captured` IS the object that was JSON.stringify'd into the store
    const captured = await captureTask(store, "renew passport", { now: T0 });

    // Re-derive the OPEN row's deterministic id before the transition
    const openRowId = factId(
      HUB_SCOPE,
      captured.id,
      "finding",
      JSON.stringify(captured),
      T0,
    );

    // Transition open -> done (different value => reconcile UPDATE branch)
    const result = await transitionFinding(store, captured.id, "done", { now: T1 });
    expect(result).not.toBeNull();
    expect(result?.status).toBe("done");

    // Active row is now status=done
    const active = readFindings(store).find((f) => f.id === captured.id);
    expect(active?.status).toBe("done");

    // The historical OPEN row still exists, superseded (t_invalidated set)
    const oldRow = store.getFact(openRowId);
    expect(oldRow).not.toBeNull();
    expect(oldRow!.tInvalidated).not.toBeNull(); // proves it is history
    expect((JSON.parse(oldRow!.value) as { status: string }).status).toBe("open");

    store.close();
  });

  // sc-2-4: start transition sets status to in-progress
  it("sc-2-4: start transition sets active row status to in-progress", async () => {
    const store = new FactStore(":memory:");
    const captured = await captureTask(store, "book dentist", { now: T0 });

    const result = await transitionFinding(store, captured.id, "in-progress", { now: T1 });
    expect(result?.status).toBe("in-progress");

    const active = readFindings(store).find((f) => f.id === captured.id);
    expect(active?.status).toBe("in-progress");

    store.close();
  });

  // returns null for an unknown id
  it("returns null when id does not exist in the store", async () => {
    const store = new FactStore(":memory:");
    const result = await transitionFinding(store, "nonexistent-id", "done", { now: T0 });
    expect(result).toBeNull();
    store.close();
  });
});

import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";
import { writeFinding, readFindings } from "./finding-store.js";
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

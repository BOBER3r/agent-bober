import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FactStore } from "../../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "../../hub/finding-source.js";
import { runHubList } from "./hub.js";

// ── Fixtures ─────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";

const FINDING_A = {
  id: "fa-001",
  domain: "medical",
  title: "Schedule cardiology follow-up",
  kind: "action" as const,
  urgency: 4,
  severity: 5,
  evidence: ["Elevated troponin"],
  surfacedAt: T,
  tags: ["cardiology"],
  status: "open" as const,
};

const FINDING_B = {
  id: "fb-002",
  domain: "health",
  title: "Watch vitamin D levels",
  kind: "watch" as const,
  urgency: 2,
  severity: 2,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "open" as const,
};

// ── Lifecycle ─────────────────────────────────────────────────────────

const originalExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

// ── Tests: sc-1-4 ────────────────────────────────────────────────────

describe("runHubList", () => {
  it("prints two findings with title, kind, urgency, severity (sc-1-4)", () => {
    const store = new FactStore(":memory:");
    for (const f of [FINDING_A, FINDING_B]) {
      store.insertFact({
        scope: HUB_SCOPE,
        subject: f.id,
        predicate: "finding",
        value: JSON.stringify(f),
        confidence: 1,
        sourceRunId: null,
        tValid: T,
        tCreated: T,
      });
    }

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    runHubList(new FactStoreFindingSource(store, HUB_SCOPE));

    const out = writes.join("");

    // titles
    expect(out).toContain(FINDING_A.title);
    expect(out).toContain(FINDING_B.title);

    // kind
    expect(out).toContain(`[${FINDING_A.kind}]`);
    expect(out).toContain(`[${FINDING_B.kind}]`);

    // urgency
    expect(out).toContain(`urgency=${FINDING_A.urgency}`);
    expect(out).toContain(`urgency=${FINDING_B.urgency}`);

    // severity
    expect(out).toContain(`severity=${FINDING_A.severity}`);
    expect(out).toContain(`severity=${FINDING_B.severity}`);

    store.close();
  });

  it("prints 'No findings found.' when the store is empty", () => {
    const store = new FactStore(":memory:");

    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    runHubList(new FactStoreFindingSource(store, HUB_SCOPE));

    const out = writes.join("");
    expect(out).toContain("No findings found.");

    store.close();
  });

  it("accepts an arbitrary FindingSource (DI interface is stable)", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => {
      writes.push(String(d));
      return true;
    });

    // Inline FindingSource implementation to verify the DI seam
    const inlineSource = {
      read: () => [FINDING_A],
    };

    runHubList(inlineSource);

    const out = writes.join("");
    expect(out).toContain(FINDING_A.title);
  });
});

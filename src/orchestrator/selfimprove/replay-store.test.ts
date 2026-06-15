import { describe, it, expect, afterEach } from "vitest";
import { ReplayStore, caseId } from "./replay-store.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const T_FIXED = "2026-06-15T00:00:00.000Z";

function makeCaseInput(overrides: Partial<{
  contractId: string;
  iteration: number;
  baselineVerdict: "pass" | "fail";
  diffDigest: string;
  evalDetailsJson: string;
  tCaptured: string;
}> = {}) {
  return {
    contractId: "c1",
    iteration: 1,
    baselineVerdict: "pass" as const,
    diffDigest: "abc123",
    evalDetailsJson: "[]",
    tCaptured: T_FIXED,
    ...overrides,
  };
}

// ── ReplayStore (in-memory) ───────────────────────────────────────────

describe("ReplayStore (in-memory)", () => {
  let store: ReplayStore;

  afterEach(() => {
    store?.close();
  });

  it("putCase then getCase returns the row with correct fields", () => {
    store = new ReplayStore(":memory:");
    const input = makeCaseInput();
    const rec = store.putCase(input);

    expect(rec.caseId).toBe(caseId("c1", 1, "abc123"));
    expect(rec.contractId).toBe("c1");
    expect(rec.iteration).toBe(1);
    expect(rec.baselineVerdict).toBe("pass");
    expect(rec.diffDigest).toBe("abc123");
    expect(rec.evalDetailsJson).toBe("[]");
    expect(rec.tCaptured).toBe(T_FIXED);

    const fetched = store.getCase(rec.caseId);
    expect(fetched).not.toBeNull();
    expect(fetched?.caseId).toBe(rec.caseId);
    expect(fetched?.contractId).toBe("c1");
    expect(fetched?.iteration).toBe(1);
    expect(fetched?.baselineVerdict).toBe("pass");
  });

  it("getCase returns null for unknown id", () => {
    store = new ReplayStore(":memory:");
    expect(store.getCase("nonexistent")).toBeNull();
  });

  it("listCases returns all inserted cases", () => {
    store = new ReplayStore(":memory:");
    store.putCase(makeCaseInput({ contractId: "c1", iteration: 1, diffDigest: "d1" }));
    store.putCase(makeCaseInput({ contractId: "c2", iteration: 2, diffDigest: "d2" }));
    const cases = store.listCases();
    expect(cases).toHaveLength(2);
    const ids = cases.map((c) => c.contractId);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
  });

  it("listCases returns empty array when no cases exist", () => {
    store = new ReplayStore(":memory:");
    expect(store.listCases()).toHaveLength(0);
  });

  it("caseId is deterministic for identical (contractId|iteration|diffDigest)", () => {
    const id1 = caseId("c1", 1, "abc123");
    const id2 = caseId("c1", 1, "abc123");
    expect(id1).toBe(id2);
  });

  it("caseId differs when diffDigest changes", () => {
    const id1 = caseId("c1", 1, "abc123");
    const id2 = caseId("c1", 1, "def456");
    expect(id1).not.toBe(id2);
  });

  it("caseId is 16 hex characters", () => {
    const id = caseId("c1", 1, "abc123");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("getBaselineVerdict returns 'pass' for a passing case", () => {
    store = new ReplayStore(":memory:");
    const rec = store.putCase(makeCaseInput({ baselineVerdict: "pass" }));
    expect(store.getBaselineVerdict(rec.caseId)).toBe("pass");
  });

  it("getBaselineVerdict returns 'fail' for a failing case", () => {
    store = new ReplayStore(":memory:");
    const rec = store.putCase(makeCaseInput({ baselineVerdict: "fail", diffDigest: "fail-digest" }));
    expect(store.getBaselineVerdict(rec.caseId)).toBe("fail");
  });

  it("getBaselineVerdict returns null for unknown id", () => {
    store = new ReplayStore(":memory:");
    expect(store.getBaselineVerdict("nonexistent")).toBeNull();
  });

  it("putCase validates input and throws on invalid data", () => {
    store = new ReplayStore(":memory:");
    expect(() =>
      store.putCase({
        contractId: "",  // empty string — fails min(1)
        iteration: 1,
        baselineVerdict: "pass",
        diffDigest: "abc123",
        evalDetailsJson: "[]",
        tCaptured: T_FIXED,
      }),
    ).toThrow("Invalid replay case input");
  });

  it("putCase is idempotent — INSERT OR REPLACE on same caseId", () => {
    store = new ReplayStore(":memory:");
    const input = makeCaseInput();
    store.putCase(input);
    store.putCase(input);
    expect(store.listCases()).toHaveLength(1);
  });
});

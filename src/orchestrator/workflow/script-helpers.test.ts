// ── script-helpers.test.ts ───────────────────────────────────────────
//
// Unit tests for the pure exported helpers in .claude/workflows/bober-pipeline.js.
// Importing the module also proves it parses as a valid ES module (C1).
//
// Cross-boundary import pattern mirrors reconcile-conformance.test.ts:3.

import { describe, it, expect } from "vitest";
import {
  meta,
  chunk,
  skipCompleted,
  decideOutcome,
} from "../../../.claude/workflows/bober-pipeline.js";

// ── meta literal ────────────────────────────────────────────────────────────

describe("meta literal (C1)", () => {
  it("meta is a plain object", () => {
    expect(typeof meta).toBe("object");
    expect(meta).not.toBeNull();
  });

  it("meta.name is 'bober-pipeline'", () => {
    expect(meta.name).toBe("bober-pipeline");
  });

  it("meta.description is a non-empty string", () => {
    expect(typeof meta.description).toBe("string");
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("meta.phases is an array", () => {
    expect(Array.isArray(meta.phases)).toBe(true);
  });

  it("meta.phases contains at least one phase with a title", () => {
    expect(meta.phases.length).toBeGreaterThan(0);
    for (const phase of meta.phases) {
      expect(typeof phase.title).toBe("string");
      expect(phase.title.length).toBeGreaterThan(0);
    }
  });
});

// ── chunk ────────────────────────────────────────────────────────────────────

describe("chunk (C2 — panel fan-out ≤16)", () => {
  it("splits 40-item array into groups of ≤16", () => {
    const items = Array.from({ length: 40 }, (_, i) => `lens${i}`);
    const groups = chunk(items, 16);
    for (const g of groups) {
      expect(g.length).toBeLessThanOrEqual(16);
    }
  });

  it("covers all items — no item lost or duplicated", () => {
    const items = Array.from({ length: 35 }, (_, i) => i);
    const groups = chunk(items, 16);
    const flat = groups.flat();
    expect(flat).toHaveLength(items.length);
    expect(flat).toEqual(items);
  });

  it("single group when items.length <= size", () => {
    const items = [1, 2, 3];
    const groups = chunk(items, 16);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([1, 2, 3]);
  });

  it("empty array yields empty groups array", () => {
    expect(chunk([], 16)).toEqual([]);
  });

  it("size-1 splits into individual elements", () => {
    const items = ["a", "b", "c"];
    const groups = chunk(items, 1);
    expect(groups).toHaveLength(3);
    for (const g of groups) {
      expect(g).toHaveLength(1);
    }
  });

  it("exactly-size array yields one group", () => {
    const items = Array.from({ length: 16 }, (_, i) => i);
    const groups = chunk(items, 16);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(16);
  });
});

// ── skipCompleted ────────────────────────────────────────────────────────────

describe("skipCompleted (C2 — resume cursor)", () => {
  it("filters out contracts whose sprintNumber is in the completed list", () => {
    const contracts = [
      { sprintNumber: 1, contractId: "c1" },
      { sprintNumber: 2, contractId: "c2" },
      { sprintNumber: 3, contractId: "c3" },
    ];
    const result = skipCompleted(contracts, [1, 3]);
    expect(result.map((c) => c.sprintNumber)).toEqual([2]);
  });

  it("returns all contracts when none are completed", () => {
    const contracts = [
      { sprintNumber: 1 },
      { sprintNumber: 2 },
    ];
    expect(skipCompleted(contracts, [])).toHaveLength(2);
  });

  it("returns empty array when all contracts are completed", () => {
    const contracts = [{ sprintNumber: 1 }, { sprintNumber: 2 }];
    expect(skipCompleted(contracts, [1, 2])).toHaveLength(0);
  });

  it("ignores completed numbers that do not match any contract", () => {
    const contracts = [{ sprintNumber: 5 }];
    const result = skipCompleted(contracts, [1, 2, 3, 4]);
    expect(result).toHaveLength(1);
  });
});

// ── decideOutcome ────────────────────────────────────────────────────────────

describe("decideOutcome (C2 — retry branch logic)", () => {
  const passedVerdict = { passed: true };
  const failedVerdict = { passed: false };

  it("returns 'passed' when reconciled.passed is true", () => {
    expect(decideOutcome(passedVerdict, 1, 3)).toBe("passed");
  });

  it("returns 'needs-rework' when not passed and iteration < maxIterations", () => {
    expect(decideOutcome(failedVerdict, 1, 3)).toBe("needs-rework");
    expect(decideOutcome(failedVerdict, 2, 3)).toBe("needs-rework");
  });

  it("returns 'failed' when not passed and iteration === maxIterations (exhausted)", () => {
    expect(decideOutcome(failedVerdict, 3, 3)).toBe("failed");
  });

  it("returns 'failed' when iteration > maxIterations (over-run guard)", () => {
    expect(decideOutcome(failedVerdict, 5, 3)).toBe("failed");
  });
});

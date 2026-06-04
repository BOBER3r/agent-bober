import { describe, it, expect } from "vitest";
import { reconcile } from "./reconciler.js";
import { EvalResultSchema } from "../../contracts/eval-result.js";
import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";

const TS = "2026-01-01T00:00:00.000Z"; // sentinel timestamp

// ── Helpers ────────────────────────────────────────────────────────

function lens(passed: boolean, over: Partial<EvalResult> = {}): EvalResult {
  return {
    evaluator: passed ? "lens-a" : "lens-b",
    passed,
    details: [],
    summary: passed ? "ok" : "nope",
    feedback: passed ? "" : "needs work",
    timestamp: TS,
    ...over,
  };
}

function failingDetail(criterion: string, message: string): EvalDetail {
  return { criterion, passed: false, message, severity: "error" };
}

// ── reconcile ─────────────────────────────────────────────────────

describe("reconcile", () => {
  // C4: empty input throws
  it("throws when lensVerdicts is empty", () => {
    expect(() => reconcile("s", 1, [], TS)).toThrow(
      "reconcile: lensVerdicts must be non-empty",
    );
  });

  // C4: single-lens input is re-stamped as evaluator='panel'
  it("n=1 passing lens → evaluator='panel', passed=true", () => {
    const result = reconcile("s", 1, [lens(true)], TS);
    expect(result.evaluator).toBe("panel");
    expect(result.passed).toBe(true);
  });

  it("n=1 failing lens → evaluator='panel', passed=false", () => {
    const result = reconcile("s", 1, [lens(false)], TS);
    expect(result.evaluator).toBe("panel");
    expect(result.passed).toBe(false);
  });

  // C2: unanimous pass
  it("unanimous pass (3/3) → passed=true", () => {
    const result = reconcile("s", 1, [lens(true), lens(true), lens(true)], TS);
    expect(result.passed).toBe(true);
  });

  // C2: unanimous fail
  it("unanimous fail (0/3) → passed=false", () => {
    const result = reconcile("s", 1, [lens(false), lens(false), lens(false)], TS);
    expect(result.passed).toBe(false);
  });

  // C2: majority pass
  it("majority pass (3/5) → passed=true", () => {
    const result = reconcile(
      "s",
      1,
      [lens(true), lens(true), lens(true), lens(false), lens(false)],
      TS,
    );
    expect(result.passed).toBe(true);
  });

  // C2: majority fail
  it("majority fail (2/5) → passed=false", () => {
    const result = reconcile(
      "s",
      1,
      [lens(true), lens(true), lens(false), lens(false), lens(false)],
      TS,
    );
    expect(result.passed).toBe(false);
  });

  // C2: 2v2 tie → fail-closed
  it("2v2 tie → passed=false (fail-closed)", () => {
    const result = reconcile(
      "s",
      1,
      [lens(true), lens(true), lens(false), lens(false)],
      TS,
    );
    expect(result.passed).toBe(false);
  });

  // C3: timestamp echo
  it("echoes the injected timestamp verbatim", () => {
    const customTs = "2099-12-31T23:59:59.000Z";
    const result = reconcile("s", 1, [lens(true)], customTs);
    expect(result.timestamp).toBe(customTs);
  });

  // C3: evaluator field
  it("always sets evaluator='panel'", () => {
    const result = reconcile("s", 1, [lens(true), lens(false)], TS);
    expect(result.evaluator).toBe("panel");
  });

  // C3: empty-detail lenses → details=[] in output, no crash
  it("lenses with empty details → output details=[]", () => {
    const result = reconcile(
      "s",
      1,
      [lens(true, { details: [] }), lens(false, { details: [] })],
      TS,
    );
    expect(result.details).toEqual([]);
  });

  // C3: detail union de-dup
  it("de-duplicates failing details by (criterion, message)", () => {
    const shared = failingDetail("c1", "same message");
    const unique = failingDetail("c2", "other message");

    const lensA = lens(false, { details: [shared, unique] });
    const lensB = lens(false, { details: [shared] }); // shared is a duplicate

    const result = reconcile("s", 1, [lensA, lensB], TS);
    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toEqual(shared);
    expect(result.details[1]).toEqual(unique);
  });

  // C3: passing details are NOT included in the union
  it("excludes passing details from the union", () => {
    const passing = { criterion: "c1", passed: true, message: "fine", severity: "info" as const };
    const failing = failingDetail("c2", "broken");

    const lensA = lens(false, { details: [passing, failing] });
    const result = reconcile("s", 1, [lensA], TS);

    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toEqual(failing);
  });

  // C3: feedback from failing lenses
  it("aggregates feedback from failing lenses only", () => {
    const lensPass = lens(true, { feedback: "ignored" });
    const lensFail1 = lens(false, { feedback: "issue A" });
    const lensFail2 = lens(false, { feedback: "issue B" });

    const result = reconcile("s", 1, [lensPass, lensFail1, lensFail2], TS);
    expect(result.feedback).toBe("issue A\nissue B");
  });

  it("returns 'All lenses passed.' feedback when all lenses pass", () => {
    const result = reconcile("s", 1, [lens(true), lens(true)], TS);
    expect(result.feedback).toBe("All lenses passed.");
  });

  // C5: Zod schema validation
  it("output validates against EvalResultSchema", () => {
    const result = reconcile(
      "s",
      1,
      [lens(true), lens(false, { details: [failingDetail("c1", "msg")] })],
      TS,
    );
    const parsed = EvalResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("output from unanimous-pass validates against EvalResultSchema", () => {
    const result = reconcile("s", 1, [lens(true), lens(true), lens(true)], TS);
    const parsed = EvalResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("output from 2v2 tie validates against EvalResultSchema", () => {
    const result = reconcile(
      "s",
      1,
      [lens(true), lens(true), lens(false), lens(false)],
      TS,
    );
    const parsed = EvalResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  // C1: sprintId and round are accepted but not included in output
  it("does not include sprintId or round fields in the output", () => {
    const result = reconcile("my-sprint", 42, [lens(true)], TS) as Record<
      string,
      unknown
    >;
    expect("sprintId" in result).toBe(false);
    expect("round" in result).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { EvalResultSchema } from "./eval-result.js";

// ── Fixtures ────────────────────────────────────────────────────────

const base = {
  evaluator: "panel",
  passed: true,
  details: [],
  summary: "ok",
  feedback: "",
  timestamp: "2026-01-01T00:00:00.000Z",
};

// ── EvalResultSchema ─────────────────────────────────────────────────

describe("EvalResultSchema", () => {
  it("parses a result WITHOUT lensVerdicts (lensVerdicts is undefined)", () => {
    const parsed = EvalResultSchema.parse(base);
    expect(parsed.lensVerdicts).toBeUndefined();
  });

  it("parses a result WITH a 2-entry lensVerdicts array and preserves it", () => {
    const withVerdicts = {
      ...base,
      lensVerdicts: [
        { lens: "correctness", passed: true, summary: "all criteria met" },
        { lens: "security", passed: false, summary: "injection risk found" },
      ],
    };
    const parsed = EvalResultSchema.parse(withVerdicts);
    expect(parsed.lensVerdicts).toEqual([
      { lens: "correctness", passed: true, summary: "all criteria met" },
      { lens: "security", passed: false, summary: "injection risk found" },
    ]);
  });
});

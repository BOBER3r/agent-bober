import { describe, it, expect } from "vitest";
import { synthesize } from "./synthesizer.js";
import type { SynthesisResult } from "./synthesizer.js";

// ── synthesize ────────────────────────────────────────────────────────

describe("synthesize", () => {
  // Guard: empty approaches throws
  it("throws when approaches is empty", () => {
    expect(() => synthesize([], [])).toThrow(
      "synthesize: approaches must be non-empty",
    );
  });

  // C1: clear winner
  it("clear winner — returns the approach with the highest total", () => {
    const approaches = ["approach-A", "approach-B", "approach-C"];
    const lensScores = [
      { lens: "scalability", scores: { "approach-A": 8, "approach-B": 5, "approach-C": 3 } },
      { lens: "security", scores: { "approach-A": 9, "approach-B": 4, "approach-C": 2 } },
    ];

    const result: SynthesisResult = synthesize(approaches, lensScores);

    expect(result.winner).toBe("approach-A");
    expect(result.ranking[0].approach).toBe("approach-A");
    expect(result.ranking[0].total).toBe(17); // 8+9
    expect(result.ranking[1].approach).toBe("approach-B");
    expect(result.ranking[1].total).toBe(9); // 5+4
    expect(result.ranking[2].approach).toBe("approach-C");
    expect(result.ranking[2].total).toBe(5); // 3+2
  });

  // C1: winner equals ranking[0].approach
  it("winner always equals ranking[0].approach", () => {
    const approaches = ["X", "Y"];
    const lensScores = [
      { lens: "cost", scores: { X: 2, Y: 10 } },
    ];

    const result = synthesize(approaches, lensScores);

    expect(result.winner).toBe(result.ranking[0].approach);
    expect(result.winner).toBe("Y");
  });

  // C1: deterministic tie-break — lower original index wins
  it("tie-break: lower original approach index wins on equal total", () => {
    const approaches = ["alpha", "beta", "gamma"];
    // all tied at 5
    const lensScores = [
      { lens: "cost", scores: { alpha: 5, beta: 5, gamma: 5 } },
    ];

    const result = synthesize(approaches, lensScores);

    // "alpha" is index 0 so it wins; "beta" (1) beats "gamma" (2)
    expect(result.winner).toBe("alpha");
    expect(result.ranking[0].approach).toBe("alpha");
    expect(result.ranking[1].approach).toBe("beta");
    expect(result.ranking[2].approach).toBe("gamma");
  });

  it("tie-break: second place tie resolved by index", () => {
    const approaches = ["alpha", "beta", "gamma"];
    // alpha wins outright; beta and gamma tied at 2
    const lensScores = [
      { lens: "cost", scores: { alpha: 10, beta: 2, gamma: 2 } },
    ];

    const result = synthesize(approaches, lensScores);

    expect(result.winner).toBe("alpha");
    expect(result.ranking[1].approach).toBe("beta");  // index 1 < index 2
    expect(result.ranking[2].approach).toBe("gamma");
  });

  // C1: dissent capture — lens whose top pick differs from winner
  it("dissent: records lenses whose individual top pick differs from winner", () => {
    const approaches = ["approach-A", "approach-B"];
    const lensScores = [
      // lens1 prefers approach-A (agrees with winner)
      { lens: "scalability", scores: { "approach-A": 10, "approach-B": 3 } },
      // lens2 prefers approach-B (disagrees — dissent)
      { lens: "security", scores: { "approach-A": 1, "approach-B": 9 } },
    ];

    const result = synthesize(approaches, lensScores);

    // aggregate: approach-A = 11, approach-B = 12 → approach-B wins
    expect(result.winner).toBe("approach-B");
    expect(result.dissent).toHaveLength(1);
    expect(result.dissent[0]).toContain("scalability");
    expect(result.dissent[0]).toContain("approach-A");
  });

  it("dissent is empty when all lenses agree with the winner", () => {
    const approaches = ["approach-A", "approach-B"];
    const lensScores = [
      { lens: "scalability", scores: { "approach-A": 10, "approach-B": 3 } },
      { lens: "security", scores: { "approach-A": 8, "approach-B": 2 } },
    ];

    const result = synthesize(approaches, lensScores);

    expect(result.winner).toBe("approach-A");
    expect(result.dissent).toHaveLength(0);
  });

  it("dissent: multiple lenses may dissent independently", () => {
    const approaches = ["A", "B", "C"];
    const lensScores = [
      // A gets total 0+0+10=10; B gets 5+5+0=10; C gets 0+0+0=0
      // A and B tie at 10 — A wins (lower index)
      { lens: "lens1", scores: { A: 0, B: 5, C: 0 } },
      { lens: "lens2", scores: { A: 0, B: 5, C: 0 } },
      { lens: "lens3", scores: { A: 10, B: 0, C: 0 } },
    ];

    const result = synthesize(approaches, lensScores);

    // A total=10, B total=10 → A wins (lower index)
    expect(result.winner).toBe("A");
    // lens1 top pick is B (score 5 vs A=0) → dissents
    // lens2 top pick is B → dissents
    // lens3 top pick is A → no dissent
    expect(result.dissent.length).toBeGreaterThanOrEqual(2);
    const lens1Dissent = result.dissent.find((d) => d.startsWith("lens1"));
    const lens2Dissent = result.dissent.find((d) => d.startsWith("lens2"));
    expect(lens1Dissent).toBeDefined();
    expect(lens2Dissent).toBeDefined();
    expect(lens1Dissent).toContain("B");
    expect(lens2Dissent).toContain("B");
  });

  // graftedIdeas
  it("graftedIdeas contains runner-up approach names (all but winner)", () => {
    const approaches = ["A", "B", "C"];
    const lensScores = [
      { lens: "cost", scores: { A: 10, B: 5, C: 2 } },
    ];

    const result = synthesize(approaches, lensScores);

    expect(result.graftedIdeas).toEqual(["B", "C"]);
  });

  it("graftedIdeas is empty when only one approach", () => {
    const result = synthesize(["only"], [{ lens: "cost", scores: { only: 7 } }]);
    expect(result.graftedIdeas).toHaveLength(0);
  });

  // perLensScores
  it("perLensScores reflects the scores for each lens", () => {
    const approaches = ["A", "B"];
    const lensScores = [
      { lens: "scalability", scores: { A: 6, B: 3 } },
      { lens: "security", scores: { A: 4, B: 7 } },
    ];

    const result = synthesize(approaches, lensScores);

    const aEntry = result.ranking.find((r) => r.approach === "A");
    expect(aEntry?.perLensScores).toEqual({ scalability: 6, security: 4 });
    expect(aEntry?.total).toBe(10);

    const bEntry = result.ranking.find((r) => r.approach === "B");
    expect(bEntry?.perLensScores).toEqual({ scalability: 3, security: 7 });
    expect(bEntry?.total).toBe(10);
  });

  // Missing scores default to 0
  it("missing approach in a lens scores dict defaults to 0", () => {
    const approaches = ["A", "B"];
    const lensScores = [
      { lens: "cost", scores: { A: 5 } }, // B is absent → treated as 0
    ];

    const result = synthesize(approaches, lensScores);

    expect(result.winner).toBe("A");
    const bEntry = result.ranking.find((r) => r.approach === "B");
    expect(bEntry?.perLensScores["cost"]).toBe(0);
    expect(bEntry?.total).toBe(0);
  });

  // Empty lensScores array — no lens data, all totals 0, tie-break by index
  it("no lens scores → all totals 0, winner is first approach by index", () => {
    const result = synthesize(["first", "second"], []);
    expect(result.winner).toBe("first");
    expect(result.ranking[0].total).toBe(0);
    expect(result.dissent).toHaveLength(0);
  });

  // Ranking is ordered descending by total
  it("ranking is strictly ordered descending by total", () => {
    const approaches = ["A", "B", "C", "D"];
    const lensScores = [
      { lens: "x", scores: { A: 1, B: 4, C: 2, D: 3 } },
    ];

    const result = synthesize(approaches, lensScores);

    const totals = result.ranking.map((r) => r.total);
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]).toBeLessThanOrEqual(totals[i - 1]);
    }
  });
});

import { describe, it, expect } from "vitest";
import { resolveLensFocus } from "./eval-lenses.js";

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveLensFocus — built-in lenses (C1)", () => {
  const BUILT_INS = ["correctness", "security", "regression", "quality"] as const;

  it("each built-in lens resolves to a non-empty string", () => {
    for (const lens of BUILT_INS) {
      const fragment = resolveLensFocus(lens);
      expect(fragment.length, `${lens} fragment must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("all four built-in fragments are mutually distinct", () => {
    const fragments = BUILT_INS.map((lens) => resolveLensFocus(lens));
    const unique = new Set(fragments);
    expect(unique.size).toBe(4);
  });
});

describe("resolveLensFocus — unknown lens fallback (C1)", () => {
  it("unknown lens returns a generic fallback containing the lens name", () => {
    const result = resolveLensFocus("made-up");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("made-up");
  });

  it("unknown lens does not throw", () => {
    expect(() => resolveLensFocus("completely-unknown-lens-xyz")).not.toThrow();
  });

  it("generic fallback is non-empty for any string", () => {
    const result = resolveLensFocus("some-custom-lens");
    expect(result.length).toBeGreaterThan(0);
  });
});

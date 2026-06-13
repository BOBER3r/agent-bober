import { describe, it, expect } from "vitest";
import { resolveArchLensFocus } from "./arch-lenses.js";

// ── Tests ────────────────────────────────────────────────────────────

describe("resolveArchLensFocus — built-in lenses (C2)", () => {
  const BUILT_INS = [
    "scalability",
    "security",
    "cost",
    "operability",
    "maintainability",
    "reversibility",
    "simplicity",
  ] as const;

  it("each built-in lens resolves to a non-empty string", () => {
    for (const lens of BUILT_INS) {
      const fragment = resolveArchLensFocus(lens);
      expect(fragment.length, `${lens} fragment must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("all seven built-in fragments are mutually distinct", () => {
    const fragments = BUILT_INS.map((lens) => resolveArchLensFocus(lens));
    const unique = new Set(fragments);
    expect(unique.size).toBe(7);
  });
});

describe("resolveArchLensFocus — unknown lens fallback (C2)", () => {
  it("unknown lens returns a generic fallback containing the lens name", () => {
    const result = resolveArchLensFocus("disaster-recovery");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("disaster-recovery");
  });

  it("unknown lens does not throw", () => {
    expect(() => resolveArchLensFocus("completely-unknown-lens-xyz")).not.toThrow();
  });

  it("generic fallback is non-empty for any string", () => {
    const result = resolveArchLensFocus("some-custom-arch-lens");
    expect(result.length).toBeGreaterThan(0);
  });

  it("fallback for unknown lens is distinct from all built-in fragments", () => {
    const unknownResult = resolveArchLensFocus("not-a-built-in");
    const BUILT_INS = [
      "scalability",
      "security",
      "cost",
      "operability",
      "maintainability",
      "reversibility",
      "simplicity",
    ] as const;
    for (const lens of BUILT_INS) {
      expect(resolveArchLensFocus(lens)).not.toBe(unknownResult);
    }
  });
});

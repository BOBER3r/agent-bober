import { describe, it, expect } from "vitest";
import { DisclaimerComposer } from "./disclaimer.js";

// ── DisclaimerComposer (sc-2-8) ─────────────────────────────────────

describe("DisclaimerComposer", () => {
  it("footer() returns a non-empty string", () => {
    const composer = new DisclaimerComposer();
    const footer = composer.footer();
    expect(typeof footer).toBe("string");
    expect(footer.length).toBeGreaterThan(0);
  });

  it("footer() contains the disclaimerVersion (sc-2-8)", () => {
    const composer = new DisclaimerComposer();
    expect(composer.footer()).toContain(composer.disclaimerVersion);
  });

  it("disclaimerVersion is a non-empty string", () => {
    const composer = new DisclaimerComposer();
    expect(typeof composer.disclaimerVersion).toBe("string");
    expect(composer.disclaimerVersion.length).toBeGreaterThan(0);
  });

  it("footer() carries wellness wording — general-wellness, non-prescriptive posture", () => {
    const composer = new DisclaimerComposer();
    const footer = composer.footer();
    expect(footer).toContain("wellness");
    // Explicitly states it is NOT advice/diagnosis/treatment (GW-safe-harbor posture).
    expect(footer.toLowerCase()).toContain("not medical advice");
  });

  it("footer() is stable across instances", () => {
    const a = new DisclaimerComposer();
    const b = new DisclaimerComposer();
    expect(a.footer()).toBe(b.footer());
    expect(a.disclaimerVersion).toBe(b.disclaimerVersion);
  });
});

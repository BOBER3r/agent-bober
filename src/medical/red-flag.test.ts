import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RedFlagDetector, PATTERNSET_VERSION } from "./red-flag.js";

// ── sc-3-5: Pure/synchronous/deterministic ───────────────────────────

describe("RedFlagDetector — determinism (sc-3-5)", () => {
  it("identical input yields identical RedFlagMatch (deep-equal)", () => {
    const d = new RedFlagDetector();
    const a = d.detect("I have crushing chest pain radiating to my left arm");
    const b = d.detect("I have crushing chest pain radiating to my left arm");
    expect(a).toEqual(b);
    expect(a.category).toBe("cardiac");
  });

  it("detect is synchronous — does NOT return a Promise", () => {
    const result = new RedFlagDetector().detect("I want to kill myself");
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("benign prompt returns category 'none' synchronously", () => {
    const result = new RedFlagDetector().detect("what is blood pressure?");
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.category).toBe("none");
  });

  it("exposes patternsetVersion constant", () => {
    const d = new RedFlagDetector();
    expect(d.patternsetVersion).toBe(PATTERNSET_VERSION);
    expect(typeof PATTERNSET_VERSION).toBe("string");
    expect(PATTERNSET_VERSION.length).toBeGreaterThan(0);
  });
});

// ── sc-3-5 / sc-3-4: Category hits ──────────────────────────────────

describe("RedFlagDetector — category hits", () => {
  it("detects cardiac (chest pain + radiating)", () => {
    const match = new RedFlagDetector().detect(
      "I have crushing chest pain radiating to my left arm",
    );
    expect(match.category).toBe("cardiac");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects cardiac (heart attack phrase)", () => {
    const match = new RedFlagDetector().detect("I think I am having a heart attack");
    expect(match.category).toBe("cardiac");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects stroke (face droop)", () => {
    const match = new RedFlagDetector().detect(
      "My face is drooping and I have slurred speech",
    );
    // face droop fires before slurred speech; both are stroke
    expect(match.category).toBe("stroke");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects stroke (slurred speech)", () => {
    const match = new RedFlagDetector().detect("sudden face droop and slurred speech");
    expect(match.category).toBe("stroke");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects stroke (sudden numbness)", () => {
    const match = new RedFlagDetector().detect("I have sudden numbness on my right side");
    expect(match.category).toBe("stroke");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects anaphylaxis (throat closing)", () => {
    const match = new RedFlagDetector().detect(
      "my throat is closing after a bee sting",
    );
    expect(match.category).toBe("anaphylaxis");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects anaphylaxis (explicit word)", () => {
    const match = new RedFlagDetector().detect("I am having an anaphylactic reaction");
    expect(match.category).toBe("anaphylaxis");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects self-harm (kill myself)", () => {
    const match = new RedFlagDetector().detect("I want to kill myself");
    expect(match.category).toBe("self-harm");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects self-harm (suicidal)", () => {
    const match = new RedFlagDetector().detect("I am feeling suicidal");
    expect(match.category).toBe("self-harm");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects overdose (explicit phrase)", () => {
    const match = new RedFlagDetector().detect(
      "I think I took too many pills, an overdose",
    );
    expect(match.category).toBe("overdose");
    expect(match.ruleId).toBeTruthy();
  });

  it("detects overdose (too many)", () => {
    const match = new RedFlagDetector().detect("I took too many sleeping pills");
    expect(match.category).toBe("overdose");
    expect(match.ruleId).toBeTruthy();
  });
});

// ── sc-3-6: Benign prompts return 'none' ────────────────────────────

describe("RedFlagDetector — benign prompts return 'none'", () => {
  const benignCases = [
    "what is blood pressure?",
    "what vitamins should I take?",
    "test",
    "test prompt",
    "what was my average resting heart rate last week",
    "how many calories should I eat per day?",
    "I have a mild headache",
    "can I exercise with a cold?",
  ];

  for (const prompt of benignCases) {
    it(`returns 'none' for: "${prompt}"`, () => {
      const match = new RedFlagDetector().detect(prompt);
      expect(match.category).toBe("none");
      expect(match.ruleId).toBeUndefined();
    });
  }
});

// ── sc-3-8: No provider/network imports ─────────────────────────────

describe("RedFlagDetector — no provider/network imports (sc-3-8)", () => {
  it("red-flag.ts does NOT import from src/providers", async () => {
    const src = await readFile(
      fileURLToPath(new URL("./red-flag.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toMatch(/from\s+["'].*providers/);
  });

  it("red-flag.ts does NOT import node:http or node:net or any network module", async () => {
    const src = await readFile(
      fileURLToPath(new URL("./red-flag.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toContain("node:http");
    expect(src).not.toContain("node:net");
    expect(src).not.toContain("node:https");
    expect(src).not.toContain("fetch(");
  });
});

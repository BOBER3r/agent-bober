import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RefusalDetector, REFUSAL_PATTERNSET_VERSION, REFUSAL_REASONS } from "./refusal.js";

// ── Purity + determinism ─────────────────────────────────────────────

describe("RefusalDetector — purity and determinism", () => {
  it("detect is synchronous — does NOT return a Promise", () => {
    const result = new RefusalDetector().detect("can you prescribe me antibiotics?");
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("exposes patternsetVersion matching the REFUSAL_PATTERNSET_VERSION constant", () => {
    expect(new RefusalDetector().patternsetVersion).toBe(REFUSAL_PATTERNSET_VERSION);
  });

  it("identical input produces identical output (deterministic)", () => {
    const detector = new RefusalDetector();
    const prompt = "can you prescribe me amoxicillin?";
    const first = detector.detect(prompt);
    const second = detector.detect(prompt);
    expect(first).toEqual(second);
  });
});

// ── Category: prescription ────────────────────────────────────────────

describe("RefusalDetector — category: prescription (sc-1-3)", () => {
  it("detects 'can you prescribe me' as prescription", () => {
    const m = new RefusalDetector().detect("can you prescribe me antibiotics?");
    expect(m.category).toBe("prescription");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'prescribe me amoxicillin' as prescription", () => {
    const m = new RefusalDetector().detect("can you prescribe me amoxicillin?");
    expect(m.category).toBe("prescription");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'write me a prescription' as prescription", () => {
    const m = new RefusalDetector().detect("write me a prescription for lisinopril");
    expect(m.category).toBe("prescription");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'prescription for me' phrase as prescription", () => {
    const m = new RefusalDetector().detect("I need a prescription for me from you");
    expect(m.category).toBe("prescription");
    expect(m.ruleId).toBeTruthy();
  });
});

// ── Category: specific-dosing ─────────────────────────────────────────

describe("RefusalDetector — category: specific-dosing (sc-1-3)", () => {
  it("detects 'how many mg' as specific-dosing", () => {
    const m = new RefusalDetector().detect("how many mg of ibuprofen should I take?");
    expect(m.category).toBe("specific-dosing");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'what dose' as specific-dosing", () => {
    const m = new RefusalDetector().detect("what dose of metformin should I take?");
    expect(m.category).toBe("specific-dosing");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'what dosage' as specific-dosing", () => {
    const m = new RefusalDetector().detect("what dosage of aspirin is safe for me?");
    expect(m.category).toBe("specific-dosing");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'how much ... should I take' as specific-dosing", () => {
    const m = new RefusalDetector().detect("how much ibuprofen should I take for a headache?");
    expect(m.category).toBe("specific-dosing");
    expect(m.ruleId).toBeTruthy();
  });
});

// ── Category: individualized-treatment-plan ───────────────────────────

describe("RefusalDetector — category: individualized-treatment-plan (sc-1-3)", () => {
  it("detects 'treatment plan for me' as individualized-treatment-plan", () => {
    const m = new RefusalDetector().detect("what's the treatment plan for me?");
    expect(m.category).toBe("individualized-treatment-plan");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'my treatment plan' as individualized-treatment-plan", () => {
    const m = new RefusalDetector().detect("Can you outline my treatment plan for diabetes?");
    expect(m.category).toBe("individualized-treatment-plan");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'what should I do to treat my' as individualized-treatment-plan", () => {
    const m = new RefusalDetector().detect("what should I do to treat my hypertension?");
    expect(m.category).toBe("individualized-treatment-plan");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'care plan for my' as individualized-treatment-plan", () => {
    const m = new RefusalDetector().detect("can you write a care plan for my condition?");
    expect(m.category).toBe("individualized-treatment-plan");
    expect(m.ruleId).toBeTruthy();
  });

  it("detects 'personalized treatment' as individualized-treatment-plan", () => {
    const m = new RefusalDetector().detect("I need a personalized treatment for my diabetes");
    expect(m.category).toBe("individualized-treatment-plan");
    expect(m.ruleId).toBeTruthy();
  });
});

// ── Benign prompts return 'none' ──────────────────────────────────────

describe("RefusalDetector — benign prompts return 'none' (sc-1-3)", () => {
  const BENIGN_CASES = [
    "what is blood pressure?",
    "what vitamins should I take?",
    "test",
    "what was my average resting heart rate last week",
    "what is hypertension?",
    "how does metformin work?",
    "what are the side effects of ibuprofen?",
    "tell me about type 2 diabetes",
  ];

  for (const prompt of BENIGN_CASES) {
    it(`returns 'none' for: "${prompt}"`, () => {
      const m = new RefusalDetector().detect(prompt);
      expect(m.category).toBe("none");
      expect(m.ruleId).toBeUndefined();
    });
  }
});

// ── REFUSAL_REASONS exported and byte-fixed ───────────────────────────

describe("REFUSAL_REASONS — fixed constants (not model-generated)", () => {
  it("REFUSAL_REASONS.prescription is a non-empty string", () => {
    expect(typeof REFUSAL_REASONS.prescription).toBe("string");
    expect(REFUSAL_REASONS.prescription.length).toBeGreaterThan(0);
  });

  it("REFUSAL_REASONS['specific-dosing'] is a non-empty string", () => {
    expect(typeof REFUSAL_REASONS["specific-dosing"]).toBe("string");
    expect(REFUSAL_REASONS["specific-dosing"].length).toBeGreaterThan(0);
  });

  it("REFUSAL_REASONS['individualized-treatment-plan'] is a non-empty string", () => {
    expect(typeof REFUSAL_REASONS["individualized-treatment-plan"]).toBe("string");
    expect(REFUSAL_REASONS["individualized-treatment-plan"].length).toBeGreaterThan(0);
  });

  it("refuse text does NOT contain '911' or '988' (distinct from escalation text)", () => {
    for (const reason of Object.values(REFUSAL_REASONS)) {
      expect(reason).not.toContain("911");
      expect(reason).not.toContain("988");
      expect(reason.toLowerCase()).not.toContain("emergency");
    }
  });
});

// ── No-network source-scan (sc-1-8) ─────────────────────────────────

describe("refusal.ts — no provider/network imports (sc-1-8)", () => {
  it("refusal.ts does NOT import from src/providers", async () => {
    const src = await readFile(
      fileURLToPath(new URL("./refusal.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toMatch(/from\s+["'].*providers/);
  });

  it("refusal.ts does NOT import node:http, node:net, node:https, or fetch", async () => {
    const src = await readFile(
      fileURLToPath(new URL("./refusal.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toContain("node:http");
    expect(src).not.toContain("node:net");
    expect(src).not.toContain("node:https");
    expect(src).not.toContain("fetch(");
  });

  it("refusal.ts does NOT import @anthropic-ai/sdk or openai", async () => {
    const src = await readFile(
      fileURLToPath(new URL("./refusal.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toContain("@anthropic-ai/sdk");
    expect(src).not.toContain("openai");
  });
});

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MedicalGuardrails, GUARDRAIL_RULESET_VERSION } from "./guardrails.js";
import { PATTERNSET_VERSION } from "./red-flag.js";
import { REFUSAL_REASONS, REFUSAL_PATTERNSET_VERSION } from "./refusal.js";

// ── sc-3-8: empty prompt throws ──────────────────────────────────────

describe("MedicalGuardrails.evaluate — throws on empty prompt (sc-3-8)", () => {
  it("throws on empty string", () => {
    const g = new MedicalGuardrails();
    expect(() => g.evaluate("", {})).toThrow();
  });

  it("throws on whitespace-only string", () => {
    const g = new MedicalGuardrails();
    expect(() => g.evaluate("   ", {})).toThrow();
    expect(() => g.evaluate("\t\n", {})).toThrow();
  });
});

// ── sc-3-4 / sc-3-5: 5-category short-circuit with correct hotline ───

describe("MedicalGuardrails.evaluate — red-flag short-circuit (sc-3-4)", () => {
  const CASES: { cat: string; prompt: string; hotline: string }[] = [
    {
      cat: "cardiac",
      prompt: "I have crushing chest pain radiating to my left arm",
      hotline: "911",
    },
    {
      cat: "stroke",
      prompt: "sudden face droop and slurred speech",
      hotline: "911",
    },
    {
      cat: "anaphylaxis",
      prompt: "my throat is closing after a bee sting",
      hotline: "911",
    },
    {
      cat: "self-harm",
      prompt: "I want to kill myself",
      hotline: "988",
    },
    {
      cat: "overdose",
      prompt: "I think I took too many pills, an overdose",
      hotline: "988",
    },
  ];

  for (const { cat, prompt, hotline } of CASES) {
    it(`returns short-circuit for ${cat} with hotline ${hotline}`, () => {
      const g = new MedicalGuardrails();
      const verdict = g.evaluate(prompt, {});
      expect(verdict.kind).toBe("short-circuit");
      if (verdict.kind === "short-circuit") {
        expect(verdict.cannedResponse).toContain(hotline);
        expect(verdict.rule).toBeTruthy();
      }
    });
  }
});

// ── sc-3-6: benign prompt returns allow ─────────────────────────────

describe("MedicalGuardrails.evaluate — benign allow (sc-3-6)", () => {
  it("returns allow for a non-emergency prompt", () => {
    const g = new MedicalGuardrails();
    const verdict = g.evaluate("what is blood pressure?", {});
    expect(verdict.kind).toBe("allow");
  });

  it("returns allow for health question that doesn't match any category", () => {
    const g = new MedicalGuardrails();
    const verdict = g.evaluate("what vitamins should I take?", {});
    expect(verdict.kind).toBe("allow");
  });
});

// ── Version fields ────────────────────────────────────────────────────

describe("MedicalGuardrails — version fields", () => {
  it("exposes rulesetVersion string", () => {
    const g = new MedicalGuardrails();
    expect(typeof g.rulesetVersion).toBe("string");
    expect(g.rulesetVersion).toBe(GUARDRAIL_RULESET_VERSION);
  });

  it("exposes patternsetVersion matching the detector constant", () => {
    const g = new MedicalGuardrails();
    expect(g.patternsetVersion).toBe(PATTERNSET_VERSION);
  });
});

// ── sc-1-4: Refuse verdict with fixed byte-equal reason text ────────

describe("MedicalGuardrails.evaluate — refuse verdict (sc-1-4)", () => {
  it("returns refuse with byte-equal fixed reason for prescription", () => {
    const g = new MedicalGuardrails();
    const v = g.evaluate("can you prescribe me antibiotics?", {});
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") {
      expect(v.reason).toBe(REFUSAL_REASONS.prescription);
      expect(v.rule).toBeTruthy();
    }
  });

  it("returns refuse with byte-equal fixed reason for specific-dosing", () => {
    const g = new MedicalGuardrails();
    const v = g.evaluate("how many mg of ibuprofen should I take?", {});
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") {
      expect(v.reason).toBe(REFUSAL_REASONS["specific-dosing"]);
      expect(v.rule).toBeTruthy();
    }
  });

  it("returns refuse with byte-equal fixed reason for individualized-treatment-plan", () => {
    const g = new MedicalGuardrails();
    const v = g.evaluate("what's the treatment plan for me?", {});
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") {
      expect(v.reason).toBe(REFUSAL_REASONS["individualized-treatment-plan"]);
      expect(v.rule).toBeTruthy();
    }
  });

  it("still returns allow for a benign prompt (no false-positive into refuse, sc-1-4)", () => {
    const g = new MedicalGuardrails();
    expect(g.evaluate("what is blood pressure?", {}).kind).toBe("allow");
    expect(g.evaluate("what vitamins should I take?", {}).kind).toBe("allow");
    expect(g.evaluate("what was my average resting heart rate last week", {}).kind).toBe("allow");
  });
});

// ── sc-1-5: Red-flag wins over refuse (emergency precedence) ─────────

describe("MedicalGuardrails.evaluate — red-flag precedence over refuse (sc-1-5)", () => {
  it("short-circuit wins when prompt matches BOTH red-flag and refuse patterns", () => {
    // Overdose matches red-flag (988); "how many mg should I take" matches specific-dosing.
    // Red-flag must win — safety > content policy.
    const v = new MedicalGuardrails().evaluate(
      "I think I overdosed — how many mg should I take next?",
      {},
    );
    expect(v.kind).toBe("short-circuit");
  });

  it("another combined prompt: self-harm + dosing → short-circuit, not refuse", () => {
    // "kill myself" fires self-harm red-flag; "what dose" fires dosing refuse.
    const v = new MedicalGuardrails().evaluate(
      "I want to kill myself — what dose of pills should I take?",
      {},
    );
    expect(v.kind).toBe("short-circuit");
  });
});

// ── refusalPatternsetVersion getter ──────────────────────────────────

describe("MedicalGuardrails — refusalPatternsetVersion getter", () => {
  it("exposes refusalPatternsetVersion matching REFUSAL_PATTERNSET_VERSION", () => {
    const g = new MedicalGuardrails();
    expect(g.refusalPatternsetVersion).toBe(REFUSAL_PATTERNSET_VERSION);
  });

  it("red-flag patternsetVersion getter is unchanged (returns PATTERNSET_VERSION, not refusal)", () => {
    const g = new MedicalGuardrails();
    expect(g.patternsetVersion).toBe(PATTERNSET_VERSION);
    // Must NOT equal the refusal version
    expect(g.patternsetVersion).not.toBe(REFUSAL_PATTERNSET_VERSION);
  });
});

// ── sc-3-8: No provider/network imports ─────────────────────────────

describe("MedicalGuardrails — no provider/network imports (sc-3-8)", () => {
  it("guardrails.ts does NOT import from src/providers", async () => {
    const src = await readFile(
      fileURLToPath(new URL("./guardrails.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toMatch(/from\s+["'].*providers/);
  });

  it("guardrails.ts does NOT import node:http or any network module", async () => {
    const src = await readFile(
      fileURLToPath(new URL("./guardrails.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toContain("node:http");
    expect(src).not.toContain("node:net");
    expect(src).not.toContain("node:https");
    expect(src).not.toContain("fetch(");
  });
});

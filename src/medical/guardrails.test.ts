import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MedicalGuardrails, GUARDRAIL_RULESET_VERSION } from "./guardrails.js";
import { PATTERNSET_VERSION } from "./red-flag.js";

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

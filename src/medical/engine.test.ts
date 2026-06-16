import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Silence logger output (resolveRoleProviders logs info lines on team load).
vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

// Mock eligibility so tests are deterministic.
vi.mock("../orchestrator/workflow/eligibility.js", () => ({
  isWorkflowEligible: vi.fn(() => false),
}));

import { MedicalSopEngine } from "./engine.js";
import { selectPipelineEngineForTeam, selectPipelineEngine } from "../orchestrator/workflow/selector.js";
import { buildMedicalTeam } from "./team.js";
import { createDefaultConfig } from "../config/schema.js";
import { TsPipelineEngine } from "../orchestrator/workflow/ts-engine.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";
import { AuditLog } from "./audit.js";
import { ConsentGate } from "./consent.js";
import { DisclaimerComposer } from "./disclaimer.js";
import type { MedicalAnswer } from "./types.js";
import type { LLMClient } from "../providers/types.js";
import { PATTERNSET_VERSION } from "./red-flag.js";

// ── sc-1-4: MedicalSopEngine.name ──────────────────────────────────

describe("MedicalSopEngine — name and interface (sc-1-4, sc-1-5)", () => {
  it("has name === 'medical-sop'", () => {
    const engine = new MedicalSopEngine();
    expect(engine.name).toBe("medical-sop");
  });

  it("satisfies the PipelineEngine interface (has run method)", () => {
    const engine = new MedicalSopEngine();
    expect(typeof engine.run).toBe("function");
  });
});

// ── sc-1-5: selectPipelineEngineForTeam returns MedicalSopEngine ────

describe("selectPipelineEngineForTeam — medical team (sc-1-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a MedicalSopEngine instance for the built-in medical team", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = buildMedicalTeam(config);
    vi.clearAllMocks();

    const engine = selectPipelineEngineForTeam(team, config);
    expect(engine).toBeInstanceOf(MedicalSopEngine);
    expect(engine.name).toBe("medical-sop");
  });

  it("selectPipelineEngine for engine 'ts' still returns TsPipelineEngine (regression, sc-1-7)", () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const engine = selectPipelineEngine(config);
    expect(engine).toBeInstanceOf(TsPipelineEngine);
    expect(engine.name).toBe("ts");
  });
});

// ── stub run() resolves to a valid PipelineResult ──────────────────
// NOTE (Sprint 2): engine now requires consent. We inject a fake ConsentGate
// that returns true so the Sprint 1 shape invariant is preserved.

let tmpDir2: string;
beforeEach(async () => {
  tmpDir2 = await mkdtemp(join(tmpdir(), "bober-medical-eng-"));
});
afterEach(async () => {
  await rm(tmpDir2, { recursive: true, force: true });
});

describe("MedicalSopEngine.run — stub result shape (consent present)", () => {
  it("resolves to a PipelineResult with required fields when consent is present", async () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    // Pre-record consent so Gate 1 passes.
    const auditLog = new AuditLog(tmpDir2);
    const gate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();
    await gate.recordConsent(
      {
        consentVersion: "1.0.0",
        acceptedAtIso: "2026-06-16T10:00:00.000Z",
        rulesetVersion: "0.0.0",
        disclaimerVersion: disclaimer.disclaimerVersion,
      },
      "2026-06-16T10:00:00.000Z",
    );

    const engine = new MedicalSopEngine({ auditLog, consentGate: gate, disclaimer });
    const result: PipelineResult = await engine.run("test prompt", tmpDir2, config, {
      now: "2026-06-16T10:00:00.000Z",
    });

    expect(result.success).toBe(true);
    expect(result.spec).toBeDefined();
    expect(result.spec.title).toBeTruthy();
    expect(Array.isArray(result.completedSprints)).toBe(true);
    expect(Array.isArray(result.failedSprints)).toBe(true);
    expect(typeof result.duration).toBe("number");
  });
});

// ── sc-2-4: Fail-closed consent — zero downstream calls ────────────

describe("MedicalSopEngine.run — fail-closed (no consent) (sc-2-4)", () => {
  it("returns a refuse verdict and makes ZERO downstream calls when no consent on disk", async () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    // Spy fakes for "downstream" work that MUST NOT be called.
    const llmSpy = { chat: vi.fn() };
    const numericsSpy = vi.fn();

    // No consent recorded in tmpDir2 → gate returns false.
    const auditLog = new AuditLog(tmpDir2);
    const consentGate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();

    const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer });

    const result = await engine.run(
      "my blood pressure is 180",
      tmpDir2,
      config,
      { now: "2026-06-16T10:00:00.000Z" },
    );

    // Gate 1 must produce success: false
    expect(result.success).toBe(false);

    // The MedicalAnswer attached to the result must be a refuse/short-circuit answer.
    const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
    expect(answer).toBeDefined();
    expect(answer.shortCircuit).toBe(true);
    expect(answer.disclaimerFooter).toBeTruthy();

    // Downstream spies must never have been called.
    expect(llmSpy.chat).not.toHaveBeenCalled();
    expect(numericsSpy).not.toHaveBeenCalled();
  });

  it("refuse result still has a valid PipelineResult shape", async () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const auditLog = new AuditLog(tmpDir2);
    const consentGate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();
    const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer });

    const result = await engine.run("test", tmpDir2, config, {
      now: "2026-06-16T10:00:00.000Z",
    });

    expect(result.spec).toBeDefined();
    expect(Array.isArray(result.completedSprints)).toBe(true);
    expect(Array.isArray(result.failedSprints)).toBe(true);
    expect(typeof result.duration).toBe("number");
  });
});

// ── sc-2-7: PHI-leak — audit file must not contain prompt or health values ──

describe("MedicalSopEngine.run — PHI-free audit (sc-2-7)", () => {
  it("does NOT write prompt text or health value to the audit file", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const auditLog = new AuditLog(tmpDir2);
    const consentGate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();
    const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer });

    // Inject a prompt with a distinctive token + numeric health value.
    await engine.run(
      "SECRETBP=180 my blood pressure is 180",
      tmpDir2,
      config,
      { now: "2026-06-16T10:00:00.000Z" },
    );

    const bytes = await readFile(
      join(tmpDir2, ".bober", "medical", "audit-2026-06-16.jsonl"),
      "utf-8",
    );

    expect(bytes).not.toContain("SECRETBP");
    expect(bytes).not.toContain("blood pressure");

    for (const line of bytes.split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const allowed = new Set(["tIso", "event", "rulesetVersion", "patternsetVersion", "ruleId"]);
      for (const key of Object.keys(parsed)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });
});

// ── sc-2-8: Disclaimer footer present in all answers ────────────────

describe("MedicalSopEngine.run — disclaimer footer (sc-2-8)", () => {
  it("refuse answer carries a non-empty disclaimerFooter", async () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const auditLog = new AuditLog(tmpDir2);
    const consentGate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();
    const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer });

    const result = await engine.run("test", tmpDir2, config, {
      now: "2026-06-16T10:00:00.000Z",
    });

    const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
    expect(answer.disclaimerFooter).toBeTruthy();
    expect(answer.disclaimerFooter).toContain(disclaimer.disclaimerVersion);
  });

  it("consented answer also carries a non-empty disclaimerFooter", async () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const auditLog = new AuditLog(tmpDir2);
    const gate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();

    await gate.recordConsent(
      {
        consentVersion: "1.0.0",
        acceptedAtIso: "2026-06-16T10:00:00.000Z",
        rulesetVersion: "0.0.0",
        disclaimerVersion: disclaimer.disclaimerVersion,
      },
      "2026-06-16T10:00:00.000Z",
    );

    const engine = new MedicalSopEngine({ auditLog, consentGate: gate, disclaimer });
    const result = await engine.run("what vitamins should I take?", tmpDir2, config, {
      now: "2026-06-16T11:00:00.000Z",
    });

    expect(result.success).toBe(true);
    const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
    expect(answer.disclaimerFooter).toBeTruthy();
    expect(answer.disclaimerFooter).toContain(disclaimer.disclaimerVersion);
  });
});

// ── sc-2-8: Deterministic timestamps ────────────────────────────────

describe("MedicalSopEngine.run — deterministic timestamps (sc-2-8)", () => {
  it("injected now appears verbatim in audit entries (no wall-clock read)", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const injectedTs = "2026-06-16T10:00:00.000Z";
    const auditLog = new AuditLog(tmpDir2);
    const consentGate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();
    const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer });

    await engine.run("test", tmpDir2, config, { now: injectedTs });

    const bytes = await readFile(
      join(tmpDir2, ".bober", "medical", "audit-2026-06-16.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(bytes.split("\n").filter(Boolean)[0]!) as { tIso: string };
    expect(entry.tIso).toBe(injectedTs);
  });
});

// ── sc-3-4: Parametrized 5-category short-circuit with zero spy calls ──

/** Helper: record consent so Gate 1 passes. */
async function recordTestConsent(dir: string): Promise<{ auditLog: AuditLog; gate: ConsentGate; disclaimer: DisclaimerComposer }> {
  const auditLog = new AuditLog(dir);
  const gate = new ConsentGate(dir, auditLog);
  const disclaimer = new DisclaimerComposer();
  await gate.recordConsent(
    {
      consentVersion: "1.0.0",
      acceptedAtIso: "2026-06-16T10:00:00.000Z",
      rulesetVersion: "0.0.0",
      disclaimerVersion: disclaimer.disclaimerVersion,
    },
    "2026-06-16T10:00:00.000Z",
  );
  return { auditLog, gate, disclaimer };
}

const RED_FLAG_CASES: { cat: string; prompt: string; hotline: string }[] = [
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

describe("MedicalSopEngine.run — Gate 2: red-flag short-circuit (sc-3-4, sc-3-7)", () => {
  for (const { cat, prompt, hotline } of RED_FLAG_CASES) {
    it(`short-circuits ${cat} with 0 LLM/numerics calls and correct hotline ${hotline} (sc-3-4)`, async () => {
      const config = createDefaultConfig("test", "greenfield");
      vi.clearAllMocks();

      const { auditLog, gate, disclaimer } = await recordTestConsent(tmpDir2);

      // INJECTED spies — these are REAL: the engine now has slots for them in MedicalSopDeps.
      // If the engine ever calls llmSpy.chat or numericsSpy, the assertions below will FAIL.
      const llmSpy: LLMClient = { chat: vi.fn() };
      const numericsSpy = vi.fn();

      const engine = new MedicalSopEngine({
        auditLog,
        consentGate: gate,
        disclaimer,
        llmClient: llmSpy,
        numerics: numericsSpy,
      });

      const result = await engine.run(prompt, tmpDir2, config, {
        now: "2026-06-16T10:00:00.000Z",
      });

      // sc-3-4: short-circuit must be true and body must contain the hotline
      const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
      expect(answer.shortCircuit).toBe(true);
      expect(answer.body).toContain(hotline);
      expect(answer.disclaimerFooter).toBeTruthy();

      // sc-3-4: ZERO calls to injected spies (now real, not hollow)
      expect(llmSpy.chat).not.toHaveBeenCalled();
      expect(numericsSpy).not.toHaveBeenCalled();

      // sc-3-7: audit file must have a 'short-circuit' entry with ruleId + versions, no prompt text
      const auditPath = join(tmpDir2, ".bober", "medical", `audit-2026-06-16.jsonl`);
      const bytes = await readFile(auditPath, "utf-8");
      const entries = bytes
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const scEntry = entries.find((e) => e["event"] === "short-circuit");

      expect(scEntry).toBeDefined();
      expect(scEntry?.["ruleId"]).toBeTruthy();
      expect(scEntry?.["rulesetVersion"]).toBeTruthy();
      expect(scEntry?.["patternsetVersion"]).toBe(PATTERNSET_VERSION);

      // sc-3-7: no prompt text in the audit file
      expect(bytes).not.toContain(prompt.slice(0, 8));
    });
  }
});

// ── sc-3-6: Benign prompt proceeds to allow path ─────────────────────

describe("MedicalSopEngine.run — Gate 2: benign allow (sc-3-6)", () => {
  it("non-emergency prompt passes Gate 2 and proceeds to allow path (success: true)", async () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const { auditLog, gate, disclaimer } = await recordTestConsent(tmpDir2);

    const llmSpy: LLMClient = { chat: vi.fn() };
    const numericsSpy = vi.fn();

    const engine = new MedicalSopEngine({
      auditLog,
      consentGate: gate,
      disclaimer,
      llmClient: llmSpy,
      numerics: numericsSpy,
    });

    const result = await engine.run(
      "what was my average resting heart rate last week",
      tmpDir2,
      config,
      { now: "2026-06-16T11:00:00.000Z" },
    );

    // allow path: success=true and shortCircuit=false on the answer
    expect(result.success).toBe(true);
    const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
    expect(answer.shortCircuit).toBe(false);
    expect(answer.disclaimerFooter).toBeTruthy();
  });
});

// ── Consent ordering: Gate 1 fires before Gate 2 ────────────────────

describe("MedicalSopEngine.run — consent ordering invariant (sc-2-4 retroactive)", () => {
  it("no-consent emergency prompt is refused by Gate 1 before reaching Gate 2", async () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    // No consent recorded → Gate 1 refuses.
    const auditLog = new AuditLog(tmpDir2);
    const consentGate = new ConsentGate(tmpDir2, auditLog);
    const disclaimer = new DisclaimerComposer();

    const llmSpy: LLMClient = { chat: vi.fn() };
    const numericsSpy = vi.fn();

    const engine = new MedicalSopEngine({
      auditLog,
      consentGate,
      disclaimer,
      llmClient: llmSpy,
      numerics: numericsSpy,
    });

    // Emergency prompt — if Gate 2 were reached, it would short-circuit.
    // Gate 1 must fire first, returning success:false.
    const result = await engine.run(
      "I want to kill myself",
      tmpDir2,
      config,
      { now: "2026-06-16T10:00:00.000Z" },
    );

    // Gate 1 refuses, not Gate 2 short-circuits — success must be false.
    expect(result.success).toBe(false);
    const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
    expect(answer.shortCircuit).toBe(true);
    // The body must be the consent message, not the 988 escalation.
    expect(answer.body).toContain("Consent is required");
    expect(answer.body).not.toContain("988");

    // Spies never called even on Gate 1 refusal.
    expect(llmSpy.chat).not.toHaveBeenCalled();
    expect(numericsSpy).not.toHaveBeenCalled();
  });
});

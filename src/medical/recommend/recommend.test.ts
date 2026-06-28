/**
 * Tests for generateRecommendation (sc-3-2..sc-3-6).
 *
 * All tests inject deps to avoid real network / fs.
 * Patterns: judge-panel.test.ts (ScriptedClient), inference.test.ts (factory spy),
 *           review-pass.test.ts (temp vault dir + readFile assertions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import type { GuardrailContext, GuardrailSet } from "../types.js";
import { EgressGuard } from "../egress.js";
import { AuditLog } from "../audit.js";
import { FactStore } from "../../state/facts.js";
import { writeFinding } from "../analysis/finding-writer.js";
import type { MedicalFinding } from "../analysis/finding.js";
import type { BoberConfig } from "../../config/schema.js";
import type { LensClients } from "./types.js";
import { generateRecommendation } from "./recommend.js";
import type { UrgencyResult } from "./urgency.js";

// -- ScriptedClient (mirrors judge-panel.test.ts:20-30) ------------------

class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}

// -- Shared fake data ----------------------------------------------------

const APPROVE = '{"verdict":"approve","feedback":""}';
const APPROVE_CC = '{"verdict":"approve","veto":false,"feedback":"no contraindication"}';
const REJECT = '{"verdict":"reject","feedback":"insufficient evidence"}';
const REJECT_CC = '{"verdict":"reject","veto":false,"feedback":"possible contraindication"}';

const NOW = "2026-06-28T12:00:00.000Z";
const QUESTION = "What should I do about my high LDL?";
const CANDIDATE = "Increase dietary fibre and reduce saturated fat intake to lower LDL naturally.";

const EMPTY_CONFIG = {} as BoberConfig;

// -- Helpers -------------------------------------------------------------

function makeApproveClient(): ScriptedClient {
  return new ScriptedClient(Array(10).fill(APPROVE));
}

function makeApproveContraClient(): ScriptedClient {
  return new ScriptedClient(Array(10).fill(APPROVE_CC));
}

function makeRejectClient(): ScriptedClient {
  return new ScriptedClient(Array(10).fill(REJECT));
}

function makeRejectContraClient(): ScriptedClient {
  return new ScriptedClient(Array(10).fill(REJECT_CC));
}

function makeAllApproveLensClients(): LensClients {
  return {
    evidenceGrader: { client: makeApproveClient(), model: "test-model" },
    contraindicationChecker: { client: makeApproveContraClient(), model: "test-model" },
    conservativeClinician: { client: makeApproveClient(), model: "test-model" },
    optimizationLens: { client: makeApproveClient(), model: "test-model" },
  };
}

function makeAllRejectLensClients(): LensClients {
  return {
    evidenceGrader: { client: makeRejectClient(), model: "test-model" },
    contraindicationChecker: { client: makeRejectContraClient(), model: "test-model" },
    conservativeClinician: { client: makeRejectClient(), model: "test-model" },
    optimizationLens: { client: makeRejectClient(), model: "test-model" },
  };
}

const allowGuard: GuardrailSet = {
  rulesetVersion: "test-1",
  evaluate: (_prompt: string, _ctx: GuardrailContext) => ({ kind: "allow" }),
};

const shortCircuitGuard: GuardrailSet = {
  rulesetVersion: "test-1",
  evaluate: (_prompt: string, _ctx: GuardrailContext) => ({
    kind: "short-circuit",
    rule: "cardiac",
    cannedResponse: "Call 911 immediately.",
  }),
};

/** Fixed urgency assigner returning controlled values (avoids LLM call in tests). */
const fixedUrgencyFn = async (
  _llm: LLMClient,
  _model: string,
  _candidate: string,
  _context: string,
): Promise<UrgencyResult> => ({ urgency: 3, severity: 2, confidence: 0.8 });

/** No-op AuditLog that captures entries without touching disk. */
class InMemoryAuditLog extends AuditLog {
  readonly entries: Array<{ tIso: string; event: string; ruleId?: string }> = [];
  constructor() {
    super("/nonexistent-project-root");
  }
  override async append(entry: { tIso: string; event: string; ruleId?: string }): Promise<void> {
    this.entries.push(entry);
  }
}

/** writeFinding that actually writes to a temp vault dir (allows readFile assertions). */
function makeVaultWriter(vaultDir: string): typeof writeFinding {
  return async (_, finding: MedicalFinding): Promise<string> =>
    writeFinding(vaultDir, finding);
}

// -- Tests ---------------------------------------------------------------

describe("sc-3-2: accepted path → action Finding, no refer-out hedging", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-rec-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes kind=action Finding and body contains no hedging phrase", async () => {
    const vaultDir = join(tmpRoot, "vault");
    const auditLog = new InMemoryAuditLog();

    const outcome = await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        lensClients: makeAllApproveLensClients(),
        generateCandidate: async () => CANDIDATE,
        redFlag: allowGuard,
        assignUrgency: fixedUrgencyFn,
        writeFindingFn: makeVaultWriter(vaultDir),
        egress: new EgressGuard(false, false),
        auditLog,
        facts: new FactStore(":memory:"),
      },
    );

    expect(outcome.kind).toBe("accepted");
    expect(outcome.findingPath).toBeDefined();

    // Read the written markdown and assert kind=action + no hedging
    const findingsDir = join(vaultDir, "findings");
    const files = await readdir(findingsDir);
    expect(files.length).toBeGreaterThan(0);

    const notePath = join(findingsDir, files[0]!);
    const noteContent = await readFile(notePath, "utf-8");

    // Must have kind: action in frontmatter
    expect(noteContent).toContain("kind: action");

    // sc-3-2: NO refer-out hedging phrase
    expect(noteContent).not.toContain("consult a licensed healthcare professional");
    expect(noteContent).not.toContain("consult your doctor");
    expect(noteContent).not.toContain("see your doctor");
    expect(noteContent).not.toContain("seek professional advice");

    // Recommendation text must appear directly
    expect(noteContent).toContain("LDL");
  });

  it("appends 'answer' audit entry on acceptance", async () => {
    const auditLog = new InMemoryAuditLog();

    await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        lensClients: makeAllApproveLensClients(),
        generateCandidate: async () => CANDIDATE,
        redFlag: allowGuard,
        assignUrgency: fixedUrgencyFn,
        writeFindingFn: makeVaultWriter(join(tmpRoot, "vault")),
        egress: new EgressGuard(false, false),
        auditLog,
        facts: new FactStore(":memory:"),
      },
    );

    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0]?.event).toBe("answer");
  });
});

describe("sc-3-3: no-consensus path → question Finding with dissent, no action Finding", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-rec-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("writes kind=question Finding with title containing 'flagged for your review'", async () => {
    const vaultDir = join(tmpRoot, "vault");
    const auditLog = new InMemoryAuditLog();

    const outcome = await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        lensClients: makeAllRejectLensClients(),
        generateCandidate: async () => CANDIDATE,
        redFlag: allowGuard,
        assignUrgency: fixedUrgencyFn,
        writeFindingFn: makeVaultWriter(vaultDir),
        egress: new EgressGuard(false, false),
        auditLog,
        facts: new FactStore(":memory:"),
      },
    );

    expect(outcome.kind).toBe("question");
    expect(outcome.findingPath).toBeDefined();

    const findingsDir = join(vaultDir, "findings");
    const files = await readdir(findingsDir);
    expect(files.length).toBe(1);

    const noteContent = await readFile(join(findingsDir, files[0]!), "utf-8");

    // sc-3-3: title must contain "flagged for your review"
    expect(noteContent).toContain("flagged for your review");

    // sc-3-3: kind=question in frontmatter
    expect(noteContent).toContain("kind: question");

    // sc-3-3: no kind=action Finding written
    expect(noteContent).not.toContain("kind: action");

    // Dissent text must appear in evidence
    expect(noteContent).toContain("insufficient evidence");
  });

  it("appends 'abstain' audit entry on no-consensus", async () => {
    const auditLog = new InMemoryAuditLog();

    await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        lensClients: makeAllRejectLensClients(),
        generateCandidate: async () => CANDIDATE,
        redFlag: allowGuard,
        assignUrgency: fixedUrgencyFn,
        writeFindingFn: makeVaultWriter(join(tmpRoot, "vault")),
        egress: new EgressGuard(false, false),
        auditLog,
        facts: new FactStore(":memory:"),
      },
    );

    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0]?.event).toBe("abstain");
  });
});

describe("sc-3-4: red-flag path → canned escalation + short-circuit audit, no Finding", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-rec-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns escalated outcome with cannedResponse and writes no finding", async () => {
    const vaultDir = join(tmpRoot, "vault");
    const auditLog = new InMemoryAuditLog();

    // writeFindingFn would throw if called — but it MUST NOT be called on red-flag
    const writeFindingFnSpy = vi.fn(makeVaultWriter(vaultDir));

    const outcome = await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        lensClients: makeAllApproveLensClients(),
        generateCandidate: async () => CANDIDATE,
        redFlag: shortCircuitGuard,
        assignUrgency: fixedUrgencyFn,
        writeFindingFn: writeFindingFnSpy,
        egress: new EgressGuard(false, false),
        auditLog,
        facts: new FactStore(":memory:"),
      },
    );

    expect(outcome.kind).toBe("escalated");
    expect(outcome.cannedResponse).toBe("Call 911 immediately.");

    // sc-3-4: no Finding written
    expect(writeFindingFnSpy).not.toHaveBeenCalled();

    // sc-3-4: 'short-circuit' audit entry
    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0]?.event).toBe("short-circuit");
    expect(auditLog.entries[0]?.ruleId).toBe("cardiac");
  });
});

describe("sc-3-5: cloud-inference OFF → all clients local, no cloud client constructed", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-rec-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("spy is called only with local openai-compat localhost, never with cloud provider", async () => {
    const auditLog = new InMemoryAuditLog();

    // Factory spy — mirrors inference.test.ts:18-56
    const factorySpy = vi.fn(
      (_p?: string | null, _e?: string | null, _pc?: unknown, _m?: string): LLMClient => ({
        chat: vi.fn().mockResolvedValue({
          text: APPROVE,
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 3, outputTokens: 5 },
        }),
      }),
    );

    // Cloud-inference OFF egress
    const cloudOffEgress = new EgressGuard(false, false);

    // generateCandidate + urgency injected so factory spy is not needed for those
    const outcome = await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        // NO lensClients injected — force recommend.ts to build them via factory
        generateCandidate: async () => CANDIDATE,
        redFlag: allowGuard,
        assignUrgency: fixedUrgencyFn,
        writeFindingFn: makeVaultWriter(join(tmpRoot, "vault")),
        egress: cloudOffEgress,
        clientFactory: factorySpy,
        auditLog,
        facts: new FactStore(":memory:"),
      },
    );

    // All clients built — lenses AND the generator (for buildMedicalInferenceClient call)
    expect(factorySpy).toHaveBeenCalled();

    // Every call must use the local openai-compat localhost endpoint
    for (const call of factorySpy.mock.calls) {
      const [provider, endpoint] = call;
      expect(provider).toBe("openai-compat");
      expect(endpoint).toBe("http://localhost:11434/v1");
    }

    // sc-3-5: no cloud provider ever called
    expect(factorySpy).not.toHaveBeenCalledWith(
      "anthropic",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(factorySpy).not.toHaveBeenCalledWith(
      "openai-compat",
      expect.stringContaining("api.x.ai"),
      expect.anything(),
      expect.anything(),
    );
    expect(factorySpy).not.toHaveBeenCalledWith(
      "openai-compat",
      expect.stringContaining("api.deepseek.com"),
      expect.anything(),
      expect.anything(),
    );

    // Outcome should be accepted (all-approve factory returns APPROVE json)
    expect(outcome.kind).toBe("accepted");
  });
});

describe("sc-3-6: accepted Finding carries urgency/severity 1..5 + confidence in tags", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-rec-"));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("urgency and severity are integers 1..5, confidence recorded in tags", async () => {
    const vaultDir = join(tmpRoot, "vault");

    const customUrgency = async (): Promise<UrgencyResult> => ({
      urgency: 4,
      severity: 3,
      confidence: 0.92,
    });

    await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        lensClients: makeAllApproveLensClients(),
        generateCandidate: async () => CANDIDATE,
        redFlag: allowGuard,
        assignUrgency: customUrgency,
        writeFindingFn: makeVaultWriter(vaultDir),
        egress: new EgressGuard(false, false),
        auditLog: new InMemoryAuditLog(),
        facts: new FactStore(":memory:"),
      },
    );

    const findingsDir = join(vaultDir, "findings");
    const files = await readdir(findingsDir);
    const noteContent = await readFile(join(findingsDir, files[0]!), "utf-8");

    // urgency: 4 in frontmatter
    expect(noteContent).toContain("urgency: 4");
    // severity: 3 in frontmatter
    expect(noteContent).toContain("severity: 3");
    // confidence recorded in tags
    expect(noteContent).toContain("confidence:0.92");
  });

  it("urgency and severity values from urgencyFn are within 1..5 range", async () => {
    // Test that clamping works even if the assigner returns border values
    const borderUrgency = async (): Promise<UrgencyResult> => ({
      urgency: 5,
      severity: 1,
      confidence: 0.5,
    });

    const vaultDir = join(tmpRoot, "vault");
    const outcome = await generateRecommendation(
      tmpRoot,
      EMPTY_CONFIG,
      { question: QUESTION, now: NOW },
      {
        lensClients: makeAllApproveLensClients(),
        generateCandidate: async () => CANDIDATE,
        redFlag: allowGuard,
        assignUrgency: borderUrgency,
        writeFindingFn: makeVaultWriter(vaultDir),
        egress: new EgressGuard(false, false),
        auditLog: new InMemoryAuditLog(),
        facts: new FactStore(":memory:"),
      },
    );

    expect(outcome.kind).toBe("accepted");

    const findingsDir = join(vaultDir, "findings");
    const files = await readdir(findingsDir);
    const noteContent = await readFile(join(findingsDir, files[0]!), "utf-8");

    expect(noteContent).toContain("urgency: 5");
    expect(noteContent).toContain("severity: 1");
  });
});

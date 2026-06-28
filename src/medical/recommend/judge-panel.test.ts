import { describe, it, expect, vi } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import type { GuardrailSet, GuardrailContext } from "../types.js";
import {
  reconcilePanel,
  runJudgeLoop,
} from "./judge-panel.js";
import {
  MEDICAL_PANEL_MAX_TOTAL_CALLS,
  MEDICAL_PANEL_MAX_ROUNDS,
  LENS_MAX_LLM_CALLS,
  type LensClients,
  type LensName,
  type LensVerdict,
} from "./types.js";

// ── ScriptedClient ────────────────────────────────────────────────────

/** Returns scripted responses in order; repeats the last once exhausted. Records every ChatParams. */
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

/** A client that always throws on chat (simulate sc-2-7 — network error). */
const throwingClient: LLMClient = {
  async chat(_p: ChatParams): Promise<ChatResponse> {
    throw new Error("Network timeout");
  },
};

// ── Shared fake data ──────────────────────────────────────────────────

const APPROVE = '{"verdict":"approve","feedback":""}';
const REJECT = '{"verdict":"reject","feedback":"not sufficient evidence"}';
const APPROVE_VETO = '{"verdict":"approve","veto":true,"feedback":"interacts w/ med X"}';

function makeApproveClient(): ScriptedClient {
  // LENS_MAX_LLM_CALLS responses to handle any coercion retries (but should only need 1)
  return new ScriptedClient(Array(LENS_MAX_LLM_CALLS).fill(APPROVE));
}

function makeRejectClient(): ScriptedClient {
  return new ScriptedClient(Array(LENS_MAX_LLM_CALLS).fill(REJECT));
}

function makeVetoClient(): ScriptedClient {
  return new ScriptedClient(Array(LENS_MAX_LLM_CALLS).fill(APPROVE_VETO));
}

function makeAllApproveLensClients(): LensClients {
  return {
    evidenceGrader: { client: makeApproveClient(), model: "test-model" },
    contraindicationChecker: { client: makeApproveClient(), model: "test-model" },
    conservativeClinician: { client: makeApproveClient(), model: "test-model" },
    optimizationLens: { client: makeApproveClient(), model: "test-model" },
  };
}

function makeAllRejectLensClients(): LensClients {
  return {
    evidenceGrader: { client: makeRejectClient(), model: "test-model" },
    contraindicationChecker: { client: makeRejectClient(), model: "test-model" },
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

const refuseGuard: GuardrailSet = {
  rulesetVersion: "test-1",
  evaluate: (_prompt: string, _ctx: GuardrailContext) => ({
    kind: "refuse",
    rule: "liability",
    reason: "Cannot provide prescriptions.",
  }),
};

// ── reconcilePanel tests ──────────────────────────────────────────────

describe("reconcilePanel", () => {
  const makeVerdicts = (
    overrides: Partial<Record<LensName, Partial<LensVerdict>>>,
  ): Record<LensName, LensVerdict> => {
    const base: Record<LensName, LensVerdict> = {
      "evidence-grader": { verdict: "approve", feedback: "" },
      "contraindication-checker": { verdict: "approve", feedback: "", veto: false },
      "conservative-clinician": { verdict: "approve", feedback: "" },
      "optimization-lens": { verdict: "approve", feedback: "" },
    };
    for (const [key, override] of Object.entries(overrides)) {
      base[key as LensName] = { ...base[key as LensName], ...override } as LensVerdict;
    }
    return base;
  };

  it("returns accepted:true when all four approve and no veto", () => {
    const result = reconcilePanel(makeVerdicts({}));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns accepted:false with reason:contraindication-veto when veto is present (sc-2-3)", () => {
    const result = reconcilePanel(
      makeVerdicts({ "contraindication-checker": { verdict: "approve", veto: true, feedback: "interacts w/ med X" } }),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("contraindication-veto");
  });

  it("veto overrides even when 3 other lenses approve (critical: veto checked before vote)", () => {
    // 3 approve + 1 veto (contraindication-checker) — must be REJECTED
    const result = reconcilePanel(
      makeVerdicts({ "contraindication-checker": { verdict: "approve", veto: true, feedback: "danger" } }),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("contraindication-veto");
  });

  it("returns accepted:false on a 2-2 tie (fail-closed) (sc-2-4)", () => {
    const result = reconcilePanel(
      makeVerdicts({
        "conservative-clinician": { verdict: "reject", feedback: "too aggressive" },
        "optimization-lens": { verdict: "reject", feedback: "not specific enough" },
      }),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("no-consensus");
  });

  it("returns accepted:false on a 1-3 majority reject", () => {
    const result = reconcilePanel(
      makeVerdicts({
        "evidence-grader": { verdict: "reject", feedback: "x" },
        "conservative-clinician": { verdict: "reject", feedback: "y" },
        "optimization-lens": { verdict: "reject", feedback: "z" },
      }),
    );
    expect(result.accepted).toBe(false);
  });

  it("returns accepted:true on a 3-1 majority approve (not a tie)", () => {
    const result = reconcilePanel(
      makeVerdicts({ "optimization-lens": { verdict: "reject", feedback: "minor issue" } }),
    );
    expect(result.accepted).toBe(true);
  });
});

// ── sc-2-2: all approve, no veto → accepted, rounds=1 ────────────────

describe("sc-2-2: all-approve → accepted with rounds=1", () => {
  it("returns accepted:true, recommendation from round 1, rounds===1", async () => {
    const generateCandidate = vi.fn(async (_prevFeedback?: string) =>
      "Take vitamin D 1000 IU daily.",
    );
    const lensClients = makeAllApproveLensClients();

    const outcome = await runJudgeLoop({
      question: "Should I take vitamin D?",
      generateCandidate,
      lensClients,
      context: "healthy adult",
      redFlag: allowGuard,
    });

    expect(outcome.outcome).toBe("accepted");
    if (outcome.outcome === "accepted") {
      expect(outcome.accepted).toBe(true);
      expect(outcome.recommendation).toBe("Take vitamin D 1000 IU daily.");
      expect(outcome.rounds).toBe(1);
    }
    expect(generateCandidate).toHaveBeenCalledTimes(1);
  });
});

// ── sc-2-3: contraindication veto overrides majority approve ──────────

describe("sc-2-3: contraindication veto overrides majority", () => {
  it("returns accepted:false with reason:contraindication-veto even if 3 lenses approve", async () => {
    const generateCandidate = vi.fn(async () => "Take ibuprofen 800mg.");
    const lensClients: LensClients = {
      evidenceGrader: { client: makeApproveClient(), model: "test-model" },
      contraindicationChecker: { client: makeVetoClient(), model: "test-model" },
      conservativeClinician: { client: makeApproveClient(), model: "test-model" },
      optimizationLens: { client: makeApproveClient(), model: "test-model" },
    };

    const outcome = await runJudgeLoop({
      question: "Can I take ibuprofen?",
      generateCandidate,
      lensClients,
      context: "patient on blood thinners",
      redFlag: allowGuard,
    });

    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected") {
      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toBe("contraindication-veto");
    }
  });
});

// ── sc-2-4: 2-approve / 2-reject tie → fail-closed ───────────────────

describe("sc-2-4: 2-2 tie → accepted:false (fail-closed)", () => {
  it("returns accepted:false when two lenses approve and two reject", async () => {
    const generateCandidate = vi.fn(async () => "Some recommendation.");
    const lensClients: LensClients = {
      evidenceGrader: { client: makeApproveClient(), model: "test-model" },
      contraindicationChecker: {
        client: new ScriptedClient(
          Array(LENS_MAX_LLM_CALLS).fill('{"verdict":"approve","veto":false,"feedback":""}'),
        ),
        model: "test-model",
      },
      conservativeClinician: { client: makeRejectClient(), model: "test-model" },
      optimizationLens: { client: makeRejectClient(), model: "test-model" },
    };

    const outcome = await runJudgeLoop({
      question: "What should I do?",
      generateCandidate,
      lensClients,
      context: "general",
      redFlag: allowGuard,
      maxRounds: 1,
    });

    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected") {
      expect(outcome.accepted).toBe(false);
    }
  });
});

// ── sc-2-5: red-flag fires first, generateCandidate never called ──────

describe("sc-2-5: red-flag short-circuit fires before generateCandidate", () => {
  it("returns short-circuit outcome and never calls generateCandidate", async () => {
    const generateCandidate = vi.fn(async () => "Should not be called.");
    const lensClients = makeAllApproveLensClients();

    const outcome = await runJudgeLoop({
      question: "I am having a heart attack",
      generateCandidate,
      lensClients,
      context: "emergency",
      redFlag: shortCircuitGuard,
    });

    expect(outcome.outcome).toBe("short-circuit");
    expect(generateCandidate).not.toHaveBeenCalled();
    if (outcome.outcome === "short-circuit") {
      expect(outcome.rule).toBe("cardiac");
      expect(outcome.cannedResponse).toBe("Call 911 immediately.");
    }
  });

  it("returns refuse outcome and never calls generateCandidate", async () => {
    const generateCandidate = vi.fn(async () => "Should not be called.");
    const lensClients = makeAllApproveLensClients();

    const outcome = await runJudgeLoop({
      question: "Prescribe me something",
      generateCandidate,
      lensClients,
      context: "general",
      redFlag: refuseGuard,
    });

    expect(outcome.outcome).toBe("refuse");
    expect(generateCandidate).not.toHaveBeenCalled();
    if (outcome.outcome === "refuse") {
      expect(outcome.rule).toBe("liability");
    }
  });
});

// ── sc-2-6: lenses reject every round → no-consensus with dissent ─────

describe("sc-2-6: reject every round → no-consensus with dissent", () => {
  it("stops at maxRounds and returns accepted:false with reason:no-consensus and dissent", async () => {
    const maxRounds = 2;
    const generateCandidate = vi.fn(async () => "Some recommendation.");
    const lensClients = makeAllRejectLensClients();

    const outcome = await runJudgeLoop({
      question: "What supplements should I take?",
      generateCandidate,
      lensClients,
      context: "general",
      redFlag: allowGuard,
      maxRounds,
    });

    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected") {
      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toBe("no-consensus");
      expect(outcome.rounds).toBe(maxRounds);
      // dissent should have feedback from all four lenses
      expect(outcome.dissent["evidence-grader"]).toBeTruthy();
      expect(outcome.dissent["contraindication-checker"]).toBeTruthy();
      expect(outcome.dissent["conservative-clinician"]).toBeTruthy();
      expect(outcome.dissent["optimization-lens"]).toBeTruthy();
    }
    // generateCandidate should be called once per round
    expect(generateCandidate).toHaveBeenCalledTimes(maxRounds);
  });
});

// ── sc-2-7: throwing lens counts as reject, loop resolves ─────────────

describe("sc-2-7: throwing lens client counts as reject, runJudgeLoop resolves", () => {
  it("runJudgeLoop resolves when one lens throws (does not propagate the throw)", async () => {
    const generateCandidate = vi.fn(async () => "Some recommendation.");
    const lensClients: LensClients = {
      evidenceGrader: { client: throwingClient, model: "test-model" },
      contraindicationChecker: {
        client: new ScriptedClient(
          Array(LENS_MAX_LLM_CALLS).fill('{"verdict":"approve","veto":false,"feedback":""}'),
        ),
        model: "test-model",
      },
      conservativeClinician: { client: makeApproveClient(), model: "test-model" },
      optimizationLens: { client: makeApproveClient(), model: "test-model" },
    };

    // Should resolve (not reject) despite the throwing lens
    await expect(
      runJudgeLoop({
        question: "What should I do?",
        generateCandidate,
        lensClients,
        context: "general",
        redFlag: allowGuard,
        maxRounds: 1,
      }),
    ).resolves.toBeDefined();
  });

  it("a throwing lens is counted as reject in reconciliation", async () => {
    // All four throw → all count as reject → no-consensus
    const allThrowLensClients: LensClients = {
      evidenceGrader: { client: throwingClient, model: "test-model" },
      contraindicationChecker: { client: throwingClient, model: "test-model" },
      conservativeClinician: { client: throwingClient, model: "test-model" },
      optimizationLens: { client: throwingClient, model: "test-model" },
    };

    const outcome = await runJudgeLoop({
      question: "Should I exercise?",
      generateCandidate: vi.fn(async () => "Go for a walk."),
      lensClients: allThrowLensClients,
      context: "general",
      redFlag: allowGuard,
      maxRounds: 1,
    });

    expect(outcome.outcome).toBe("rejected");
    if (outcome.outcome === "rejected") {
      expect(outcome.accepted).toBe(false);
    }
  });
});

// ── Budget cap: MEDICAL_PANEL_MAX_TOTAL_CALLS ─────────────────────────

describe("MEDICAL_PANEL_MAX_TOTAL_CALLS budget", () => {
  it("constant equals the closed-form expression (not a magic number)", () => {
    expect(MEDICAL_PANEL_MAX_TOTAL_CALLS).toBe(
      MEDICAL_PANEL_MAX_ROUNDS * (1 + 4 * LENS_MAX_LLM_CALLS),
    );
  });

  it("worst-case all-reject loop stays within MEDICAL_PANEL_MAX_TOTAL_CALLS", async () => {
    // Track how many times generateCandidate is called
    let generateCount = 0;
    const generateCandidate = vi.fn(async () => {
      generateCount++;
      return "recommendation";
    });

    // Track total chat calls across all lenses
    const trackingClient: LLMClient & { callCount: number } = {
      callCount: 0,
      async chat(_p: ChatParams): Promise<ChatResponse> {
        this.callCount++;
        return {
          text: REJECT,
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 3, outputTokens: 5 },
        };
      },
    };

    const lensClients: LensClients = {
      evidenceGrader: { client: trackingClient, model: "test-model" },
      contraindicationChecker: { client: trackingClient, model: "test-model" },
      conservativeClinician: { client: trackingClient, model: "test-model" },
      optimizationLens: { client: trackingClient, model: "test-model" },
    };

    await runJudgeLoop({
      question: "q",
      generateCandidate,
      lensClients,
      context: "ctx",
      redFlag: allowGuard,
      maxRounds: MEDICAL_PANEL_MAX_ROUNDS,
    });

    const totalCalls = generateCount + trackingClient.callCount;
    expect(totalCalls).toBeLessThanOrEqual(MEDICAL_PANEL_MAX_TOTAL_CALLS);
  });
});

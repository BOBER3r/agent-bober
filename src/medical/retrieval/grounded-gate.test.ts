/**
 * Tests for synthesizeGrounded — fail-closed gate:
 *   synthesize → critic → one re-synth → abstain.
 *
 * Covers sc-2-3 (approve-first), sc-2-4 (reject→approve, reject→reject→abstain),
 * sc-2-5 (throw→abstain), sc-2-7 (call-cap <= GROUNDED_GATE_MAX_LLM_CALLS).
 *
 * Sprint 3 update: synthesizeGrounded now returns {answer, verdict} — all assertions
 * below destructure `.answer` to remain semantically identical to the Sprint-2 baseline.
 */
import { describe, it, expect, vi } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";
import type { Passage, RetrievalOutcome } from "./medline-source.js";
import { synthesizeGrounded, GROUNDED_GATE_MAX_LLM_CALLS } from "./literature.js";

// ── ScriptedClient ─────────────────────────────────────────────────────
// Copied from grounding-critic.test.ts — returns queued strings in order;
// repeats the last response once exhausted; records every call.

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

// ── Fixtures ──────────────────────────────────────────────────────────

const SAMPLE_PASSAGES: Passage[] = [
  {
    title: "Metformin",
    url: "https://medlineplus.gov/druginfo/meds/a696005.html",
    text: "Metformin is used to treat type 2 diabetes. Common side effects include nausea and diarrhea.",
    source: "medlineplus",
  },
];

const GROUNDED_OUTCOME: RetrievalOutcome = { kind: "grounded", passages: SAMPLE_PASSAGES };

const FOOTER =
  "This is general wellness information, not medical advice. Consult a healthcare professional.";

const APPROVE_JSON = '{"verdict":"approve","feedback":""}';
const REJECT_JSON = '{"verdict":"reject","feedback":"Claim not supported by passages."}';

// ── sc-2-3: approve-first ─────────────────────────────────────────────

describe("synthesizeGrounded — approve on first critique (sc-2-3)", () => {
  it("returns the original grounded answer with >=1 citations when the critic approves immediately", async () => {
    // Queue: [synth body, approve verdict]
    const client = new ScriptedClient([
      "Metformin commonly causes gastrointestinal side effects including nausea and diarrhea.",
      APPROVE_JSON,
    ]);

    const { answer, verdict } = await synthesizeGrounded("what are the side effects of metformin?", GROUNDED_OUTCOME, client, FOOTER);

    expect(answer.abstained).toBe(false);
    expect(answer.body).toContain("Metformin");
    expect(answer.citations.length).toBeGreaterThanOrEqual(1);
    expect(answer.disclaimerFooter).toBe(FOOTER);
    expect(answer.shortCircuit).toBe(false);
    expect(verdict).toBe("approve");
  });
});

// ── sc-2-4a: reject → approve ─────────────────────────────────────────

describe("synthesizeGrounded — reject then approve (sc-2-4a)", () => {
  it("returns the RE-synthesized answer (distinct body) with >=1 citations when re-critique approves", async () => {
    // Queue: [synth body 1, reject verdict, synth body 2 (revised), approve verdict]
    const client = new ScriptedClient([
      "body one (initial)",
      REJECT_JSON,
      "body two (revised after feedback)",
      APPROVE_JSON,
    ]);

    const { answer, verdict } = await synthesizeGrounded("q", GROUNDED_OUTCOME, client, FOOTER);

    expect(answer.abstained).toBe(false);
    expect(answer.body).toBe("body two (revised after feedback)");
    expect(answer.citations.length).toBeGreaterThanOrEqual(1);
    expect(answer.disclaimerFooter).toBe(FOOTER);
    expect(answer.shortCircuit).toBe(false);
    expect(verdict).toBe("approve");
  });
});

// ── sc-2-4b: reject → reject → abstain ────────────────────────────────

describe("synthesizeGrounded — reject both critiques → abstain (sc-2-4b)", () => {
  it("returns abstained:true, citations:[], footer when both critiques reject", async () => {
    // Queue: [synth body 1, reject, synth body 2, reject]
    const client = new ScriptedClient([
      "body one",
      REJECT_JSON,
      "body two",
      '{"verdict":"reject","feedback":"still not supported"}',
    ]);

    const { answer, verdict } = await synthesizeGrounded("q", GROUNDED_OUTCOME, client, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toEqual([]);
    expect(answer.disclaimerFooter).toBe(FOOTER);
    expect(answer.shortCircuit).toBe(false);
    expect(verdict).toBe("reject-abstained");
  });
});

// ── sc-2-5a: synthesize throws → abstain ─────────────────────────────

describe("synthesizeGrounded — synth throws → abstain (sc-2-5a)", () => {
  it("returns abstained answer (no thrown exception) when the first synthesize call throws", async () => {
    const throwingLlm: LLMClient = { chat: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };

    const { answer, verdict } = await synthesizeGrounded("q", GROUNDED_OUTCOME, throwingLlm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toEqual([]);
    expect(answer.disclaimerFooter).toBe(FOOTER);
    expect(verdict).toBe("error-abstained");
  });
});

// ── sc-2-5b: first synth succeeds but critic throws → abstain ─────────

describe("synthesizeGrounded — critic throws → abstain (sc-2-5b)", () => {
  it("returns abstained answer when synth succeeds but the first critic call throws", async () => {
    // First call returns a synth body; second call (critic) throws.
    const llm: LLMClient = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          text: "A grounded answer body.",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 3, outputTokens: 5 },
        })
        .mockRejectedValueOnce(new Error("network timeout")),
    };

    const { answer, verdict } = await synthesizeGrounded("q", GROUNDED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toEqual([]);
    expect(answer.disclaimerFooter).toBe(FOOTER);
    expect(verdict).toBe("error-abstained");
  });
});

// ── sc-2-5c: re-synth throws → abstain ───────────────────────────────

describe("synthesizeGrounded — re-synth throws → abstain (sc-2-5c)", () => {
  it("returns abstained answer when synth+critic(reject) succeed but re-synth throws", async () => {
    // First: synth body; second: critic rejects; third: re-synth throws.
    const llm: LLMClient = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          text: "body one",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 3, outputTokens: 5 },
        })
        .mockResolvedValueOnce({
          text: REJECT_JSON,
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 3, outputTokens: 5 },
        })
        .mockRejectedValueOnce(new Error("model crashed")),
    };

    const { answer, verdict } = await synthesizeGrounded("q", GROUNDED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toEqual([]);
    expect(verdict).toBe("error-abstained");
  });
});

// ── sc-2-5d: re-critic throws → abstain ──────────────────────────────

describe("synthesizeGrounded — re-critic throws → abstain (sc-2-5d)", () => {
  it("returns abstained answer when synth+reject+re-synth succeed but second critic throws", async () => {
    const llm: LLMClient = {
      chat: vi
        .fn()
        .mockResolvedValueOnce({ text: "body one", toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } })
        .mockResolvedValueOnce({ text: REJECT_JSON, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } })
        .mockResolvedValueOnce({ text: "body two revised", toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } })
        .mockRejectedValueOnce(new Error("second critic timeout")),
    };

    const { answer, verdict } = await synthesizeGrounded("q", GROUNDED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toEqual([]);
    expect(verdict).toBe("error-abstained");
  });
});

// ── sc-2-7: call-cap ──────────────────────────────────────────────────

describe("synthesizeGrounded — call cap <= GROUNDED_GATE_MAX_LLM_CALLS (sc-2-7)", () => {
  it("makes at most GROUNDED_GATE_MAX_LLM_CALLS LLM calls on a reject→reject path", async () => {
    // reject→reject path with valid JSON verdicts (no parse retries needed):
    // calls = 1 (synth) + 1 (critic, valid reject) + 1 (re-synth) + 1 (re-critic, valid reject) = 4
    // 4 <= GROUNDED_GATE_MAX_LLM_CALLS (=6).
    const client = new ScriptedClient([
      "body one",
      REJECT_JSON,
      "body two",
      '{"verdict":"reject","feedback":"still not grounded"}',
    ]);

    await synthesizeGrounded("q", GROUNDED_OUTCOME, client, FOOTER);

    expect(client.calls.length).toBeLessThanOrEqual(GROUNDED_GATE_MAX_LLM_CALLS);
  });

  it("GROUNDED_GATE_MAX_LLM_CALLS is computed from GROUNDING_MAX_LLM_CALLS (not a literal)", () => {
    // Value should be 6 today (1 + 2 + 1 + 2).
    expect(GROUNDED_GATE_MAX_LLM_CALLS).toBe(6);
  });
});

// ── Non-grounded delegation ────────────────────────────────────────────

describe("synthesizeGrounded — non-grounded outcome delegates to synthesize", () => {
  it("returns abstained answer for disabled outcome without calling critic", async () => {
    const disabledOutcome: RetrievalOutcome = { kind: "disabled" };
    // synthesize catches disabled and returns abstained without calling llm.chat.
    const llm: LLMClient = { chat: vi.fn() };

    const { answer, verdict } = await synthesizeGrounded("q", disabledOutcome, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect((llm.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(verdict).toBe("error-abstained");
  });

  it("returns abstained answer for abstain outcome without calling critic", async () => {
    const abstainOutcome: RetrievalOutcome = { kind: "abstain", reason: "source-error" };
    const llm: LLMClient = { chat: vi.fn() };

    const { answer, verdict } = await synthesizeGrounded("q", abstainOutcome, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect((llm.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(verdict).toBe("error-abstained");
  });
});

// ── synthesize abstains → gate returns it unchanged ───────────────────

describe("synthesizeGrounded — synthesize abstains → return unchanged (no critic call)", () => {
  it("returns the abstained answer from synthesize when the model returns ABSTAIN", async () => {
    // Synthesize returns ABSTAIN signal → gate returns that abstained answer immediately.
    const client = new ScriptedClient(["ABSTAIN"]);

    const { answer, verdict } = await synthesizeGrounded("q", GROUNDED_OUTCOME, client, FOOTER);

    expect(answer.abstained).toBe(true);
    // Only 1 LLM call — the gate did NOT proceed to the critic.
    expect(client.calls.length).toBe(1);
    expect(verdict).toBe("error-abstained");
  });
});

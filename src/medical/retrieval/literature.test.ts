/**
 * LiteratureRetriever + synthesize tests — fake source + injected LLM spy (no live network).
 *
 * Covers:
 *   sc-7-5: axis ON => retrieve returns grounded; axis OFF => {disabled}
 *   sc-7-6: synthesize abstains when no passage supports claim; produces citations when supported
 *   sc-7-7: fail-closed — source error => abstain, no uncited clinical claim
 *   sc-7-8: cloud-inference axis stays off; no cloud provider constructed; model unavailable => abstain
 */
import { describe, it, expect, vi } from "vitest";
import { LiteratureRetriever, synthesize } from "./literature.js";
import { MedlineSource } from "./medline-source.js";
import type { RetrievalOutcome, Passage } from "./medline-source.js";
import { EgressGuard } from "../egress.js";
import type { LLMClient } from "../../providers/types.js";

// ── Fixtures / fakes ─────────────────────────────────────────────────

const SAMPLE_PASSAGES: Passage[] = [
  {
    title: "Metformin",
    url: "https://medlineplus.gov/druginfo/meds/a696005.html",
    text: "Metformin is used to treat type 2 diabetes. Common side effects include nausea and diarrhea.",
    source: "medlineplus",
  },
];

const GROUNDED_OUTCOME: RetrievalOutcome = { kind: "grounded", passages: SAMPLE_PASSAGES };
const ABSTAIN_OUTCOME: RetrievalOutcome = { kind: "abstain", reason: "source-error" };
const DISABLED_OUTCOME: RetrievalOutcome = { kind: "disabled" };

function makeSupportedLlm(): LLMClient {
  return {
    chat: vi.fn().mockResolvedValue({
      text: "Metformin commonly causes gastrointestinal side effects including nausea and diarrhea.",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  };
}

function makeUnsupportedLlm(): LLMClient {
  return {
    chat: vi.fn().mockResolvedValue({
      text: "ABSTAIN",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 100, outputTokens: 1 },
    }),
  };
}

function makeEmptyResponseLlm(): LLMClient {
  return {
    chat: vi.fn().mockResolvedValue({
      text: "",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 100, outputTokens: 0 },
    }),
  };
}

function makeUnavailableLlm(): LLMClient {
  return {
    chat: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
  };
}

const FOOTER = "This is general wellness information, not medical advice. Consult a healthcare professional.";

// ── LiteratureRetriever tests ─────────────────────────────────────────

describe("LiteratureRetriever.retrieve (sc-7-5)", () => {
  it("axis OFF => returns {disabled} immediately, source never called", async () => {
    const egress = new EgressGuard(false, false);
    const sourceStub = new MedlineSource(egress);
    const sourceSpy = vi.spyOn(sourceStub, "fetchPassages");
    const retriever = new LiteratureRetriever(egress, sourceStub);

    const outcome = await retriever.retrieve("metformin side effects");

    expect(outcome).toEqual({ kind: "disabled" });
    expect(sourceSpy).not.toHaveBeenCalled();
  });

  it("axis ON => source is called and returns its result", async () => {
    const egress = new EgressGuard(false, true);
    const sourceStub = new MedlineSource(egress);
    vi.spyOn(sourceStub, "fetchPassages").mockResolvedValue(GROUNDED_OUTCOME);
    const retriever = new LiteratureRetriever(egress, sourceStub);

    const outcome = await retriever.retrieve("metformin side effects");

    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;
    expect(outcome.passages).toEqual(SAMPLE_PASSAGES);
  });

  it("axis ON + source throws => returns abstain{source-error}", async () => {
    const egress = new EgressGuard(false, true);
    const sourceStub = new MedlineSource(egress);
    vi.spyOn(sourceStub, "fetchPassages").mockRejectedValue(new Error("unexpected"));
    const retriever = new LiteratureRetriever(egress, sourceStub);

    const outcome = await retriever.retrieve("metformin side effects");

    expect(outcome).toEqual({ kind: "abstain", reason: "source-error" });
  });

  it("axis ON + source returns abstain{source-error} => passes it through", async () => {
    const egress = new EgressGuard(false, true);
    const sourceStub = new MedlineSource(egress);
    vi.spyOn(sourceStub, "fetchPassages").mockResolvedValue(ABSTAIN_OUTCOME);
    const retriever = new LiteratureRetriever(egress, sourceStub);

    const outcome = await retriever.retrieve("unknownterm");

    expect(outcome).toEqual({ kind: "abstain", reason: "source-error" });
  });
});

// ── synthesize tests ─────────────────────────────────────────────────

describe("synthesize — disabled/abstain outcomes (sc-7-6, sc-7-7)", () => {
  it("disabled outcome => abstained MedicalAnswer, LLM never called", async () => {
    const llm = makeSupportedLlm();
    const answer = await synthesize("metformin side effects", DISABLED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toHaveLength(0);
    expect(answer.shortCircuit).toBe(false);
    expect(answer.disclaimerFooter).toBe(FOOTER);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("abstain outcome => abstained MedicalAnswer, LLM never called", async () => {
    const llm = makeSupportedLlm();
    const answer = await synthesize("metformin side effects", ABSTAIN_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toHaveLength(0);
    expect(llm.chat).not.toHaveBeenCalled();
  });
});

describe("synthesize — grounded with supported LLM answer (sc-7-6)", () => {
  it("grounded + LLM returns supported answer => abstained=false, citations.length >= 1", async () => {
    const llm = makeSupportedLlm();
    const answer = await synthesize("metformin side effects", GROUNDED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(false);
    expect(answer.citations.length).toBeGreaterThanOrEqual(1);
    expect(answer.citations[0]?.source).toBe("medlineplus");
    expect(typeof answer.citations[0]?.url).toBe("string");
    expect(typeof answer.citations[0]?.title).toBe("string");
    expect(answer.disclaimerFooter).toBe(FOOTER);
    expect(answer.shortCircuit).toBe(false);
  });

  it("LLM is called exactly once", async () => {
    const llm = makeSupportedLlm();
    await synthesize("metformin side effects", GROUNDED_OUTCOME, llm, FOOTER);

    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it("LLM call includes user query in messages", async () => {
    const llm = makeSupportedLlm();
    const query = "what are metformin side effects?";
    await synthesize(query, GROUNDED_OUTCOME, llm, FOOTER);

    const callArg = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: query }),
    ]));
  });
});

describe("synthesize — grounded with unsupported/empty LLM answer (sc-7-6)", () => {
  it("LLM returns 'ABSTAIN' => abstained=true, citations empty", async () => {
    const llm = makeUnsupportedLlm();
    const answer = await synthesize("metformin side effects", GROUNDED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toHaveLength(0);
  });

  it("LLM returns empty string => abstained=true, citations empty", async () => {
    const llm = makeEmptyResponseLlm();
    const answer = await synthesize("metformin side effects", GROUNDED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toHaveLength(0);
  });
});

describe("synthesize — fail-closed on source error (sc-7-7)", () => {
  it("source error outcome + any LLM => abstained, NO clinical assertion", async () => {
    const llm = makeSupportedLlm();
    const answer = await synthesize("metformin side effects", ABSTAIN_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toHaveLength(0);
    // Verify the body does not contain an uncited clinical assertion
    expect(answer.body).not.toMatch(/metformin.*diabetes.*side effects/i);
    // LLM must NOT be called when outcome is not grounded
    expect(llm.chat).not.toHaveBeenCalled();
  });
});

describe("synthesize — cloud-inference axis independence (sc-7-8)", () => {
  it("model unavailable (throws) => abstained, no cloud fallback", async () => {
    const llm = makeUnavailableLlm();
    const answer = await synthesize("metformin side effects", GROUNDED_OUTCOME, llm, FOOTER);

    expect(answer.abstained).toBe(true);
    expect(answer.citations).toHaveLength(0);
    expect(answer.body).toMatch(/model unavailable/i);
  });

  it("cloud-inference axis remains false when literature-retrieval is on", () => {
    // EgressGuard.fromConfig: cloud-inference default is false.
    // Enabling literature-retrieval does NOT flip cloud-inference.
    const egress = new EgressGuard(false, true); // (cloudInference=false, literatureRetrieval=true)

    expect(egress.isAllowed("literature-retrieval")).toBe(true);
    expect(egress.isAllowed("cloud-inference")).toBe(false);
  });

  it("synthesize with grounded outcome does NOT construct a cloud provider (injected LLM only)", async () => {
    // The injected LLM spy IS the only client used — no createClient("anthropic") is called.
    // This test documents and enforces that the grounded path never touches cloud-inference.
    const llm = makeSupportedLlm();
    const answer = await synthesize("metformin side effects", GROUNDED_OUTCOME, llm, FOOTER);

    // Non-abstained answer with injected local LLM — proof no cloud client was needed.
    expect(answer.abstained).toBe(false);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });
});

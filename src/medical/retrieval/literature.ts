/** LiteratureRetriever — checks the literature-retrieval axis; returns {disabled} sync when off (ADR-6). */
import type { EgressGuard } from "../egress.js";
import { MedlineSource, type RetrievalOutcome, type Passage } from "./medline-source.js";
import type { LLMClient } from "../../providers/types.js";
import type { MedicalAnswer, Citation, CriticVerdict } from "../types.js";
import { getGroundingVerdict, GROUNDING_MAX_LLM_CALLS, type GroundingVerdict } from "./grounding-critic.js";

// ── LiteratureRetriever ──────────────────────────────────────────────

/**
 * Orchestrates literature retrieval behind the literature-retrieval egress gate.
 *
 * SYNCHRONOUS short-circuit: if the axis is off, return {disabled} — NO network
 * attempt and NO MedlineSource method is called. This is the zero-egress proof.
 */
export class LiteratureRetriever {
  constructor(
    private readonly egress: EgressGuard,
    private readonly source = new MedlineSource(egress),
  ) {}

  /**
   * Retrieve literature passages for the given query.
   *
   * When literature-retrieval is OFF: returns { kind: "disabled" } IMMEDIATELY,
   * before MedlineSource is consulted — guarantees zero outbound bytes.
   *
   * When literature-retrieval is ON: delegates to MedlineSource.fetchPassages.
   * Any throw from the source is caught and maps to abstain{source-error} (belt-and-braces;
   * MedlineSource.fetchPassages itself is already fail-closed).
   */
  async retrieve(query: string): Promise<RetrievalOutcome> {
    // isAllowed check MUST precede source call — proves zero-egress when axis is off.
    if (!this.egress.isAllowed("literature-retrieval")) {
      return { kind: "disabled" };
    }
    try {
      return await this.source.fetchPassages(query);
    } catch {
      return { kind: "abstain", reason: "source-error" };
    }
  }
}

// ── synthesize ───────────────────────────────────────────────────────

const SYNTHESIS_MODEL = "ollama/llama3";

// ── GroundedResult ───────────────────────────────────────────────────

/** Return type for synthesizeGrounded — widens MedicalAnswer with the critic gate verdict (Sprint 3). */
export interface GroundedResult {
  answer: MedicalAnswer;
  verdict: CriticVerdict;
}
const SYNTHESIS_MAX_TOKENS = 512;

/**
 * Build the system prompt that pins the model to the retrieved passages.
 * The model is instructed to reply with exactly "ABSTAIN" if the passages
 * do not support the query — synthesize treats that as an abstain signal.
 */
function buildSynthesisSystem(passages: Passage[]): string {
  const passageBlock = passages
    .map((p, i) => `[${i + 1}] ${p.title}\n${p.text}\nSource: ${p.url}`)
    .join("\n\n");

  return (
    "You are a medical information assistant. Answer the user's question using ONLY " +
    "the following retrieved passages from MedlinePlus. " +
    "If the passages do not contain information that supports a specific answer, " +
    "reply with exactly the single word: ABSTAIN\n\n" +
    "Retrieved passages:\n" +
    passageBlock
  );
}

/**
 * Derive citations from grounded passages that were actually used in synthesis.
 * For simplicity (all passages are pinned in the system prompt), all passages
 * become citations when the model produces a non-abstained answer.
 * This ensures citations.length >= 1 for every non-abstained answer.
 */
function passagesToCitations(passages: Passage[]): Citation[] {
  return passages.map((p) => ({
    title: p.title,
    url: p.url,
    source: "medlineplus" as const,
  }));
}

/**
 * synthesize — single LLM call that grounds the answer in retrieved passages.
 *
 * Rules (non-negotiable, enforced here):
 * - disabled/abstain outcome => abstained MedicalAnswer, citations: [], no clinical assertion.
 * - grounded outcome => one llm.chat call; if the model abstains or returns empty => abstained.
 * - Every non-abstained answer carries >= 1 citation derived from the passages.
 * - LLM error (e.g. Ollama unreachable) => abstained + "model unavailable" footer, NO cloud fallback.
 * - Never emits an uncited clinical claim.
 *
 * @param query - The original user question.
 * @param outcome - The RetrievalOutcome from LiteratureRetriever.retrieve.
 * @param llm - Injectable LLMClient (tests pass {chat: vi.fn()}).
 * @param footer - DisclaimerComposer footer string included in every answer.
 * @param model - Model identifier to use for synthesis (default: SYNTHESIS_MODEL).
 */
export async function synthesize(
  query: string,
  outcome: RetrievalOutcome,
  llm: LLMClient,
  footer: string,
  model: string = SYNTHESIS_MODEL,
): Promise<MedicalAnswer> {
  // ── Abstain immediately on disabled / no-passages ────────────────
  if (outcome.kind === "disabled" || outcome.kind === "abstain") {
    return {
      body:
        "I cannot ground an answer in retrieved literature. " +
        "For evidence-based guidance, please consult a licensed healthcare professional.",
      abstained: true,
      citations: [],
      disclaimerFooter: footer,
      shortCircuit: false,
    };
  }

  // outcome.kind === "grounded"
  const passages = outcome.passages;

  if (passages.length === 0) {
    return {
      body:
        "No supporting passages were retrieved. " +
        "For evidence-based guidance, please consult a licensed healthcare professional.",
      abstained: true,
      citations: [],
      disclaimerFooter: footer,
      shortCircuit: false,
    };
  }

  // ── Single LLM call ──────────────────────────────────────────────
  let responseText: string;
  try {
    const response = await llm.chat({
      model,
      system: buildSynthesisSystem(passages),
      messages: [{ role: "user", content: query }],
      maxTokens: SYNTHESIS_MAX_TOKENS,
    });
    responseText = response.text.trim();
  } catch {
    // Local model unavailable — abstain, NO cloud fallback.
    return {
      body:
        "I cannot ground an answer at this time (model unavailable). " +
        "For evidence-based guidance, please consult a licensed healthcare professional.",
      abstained: true,
      citations: [],
      disclaimerFooter: footer,
      shortCircuit: false,
    };
  }

  // ── Abstain if the model said so or returned empty ───────────────
  if (!responseText || responseText.toUpperCase() === "ABSTAIN") {
    return {
      body:
        "The retrieved passages do not sufficiently support a specific answer to your question. " +
        "For evidence-based guidance, please consult a licensed healthcare professional.",
      abstained: true,
      citations: [],
      disclaimerFooter: footer,
      shortCircuit: false,
    };
  }

  // ── Non-abstained: attach citations (>= 1 guaranteed by passages.length > 0) ─
  const citations = passagesToCitations(passages);
  return {
    body: responseText,
    abstained: false,
    citations,
    disclaimerFooter: footer,
    shortCircuit: false,
  };
}

// ── synthesizeGrounded ────────────────────────────────────────────────

/**
 * Worst-case LLM call budget for the grounded gate:
 *   1 synth + GROUNDING_MAX_LLM_CALLS critic + 1 re-synth + GROUNDING_MAX_LLM_CALLS re-critic
 * Computed from the imported constant so it tracks future changes to the critic budget.
 */
export const GROUNDED_GATE_MAX_LLM_CALLS =
  1 + GROUNDING_MAX_LLM_CALLS + 1 + GROUNDING_MAX_LLM_CALLS; // = 6 today (1+2+1+2)

/**
 * Canned abstain answer used throughout the gate when the answer cannot be
 * sufficiently grounded in the retrieved literature.
 */
function abstainAnswer(footer: string): MedicalAnswer {
  return {
    body:
      "I cannot provide a sufficiently-supported answer grounded in the retrieved literature. " +
      "For evidence-based guidance, please consult a licensed healthcare professional.",
    abstained: true,
    citations: [],
    disclaimerFooter: footer,
    shortCircuit: false,
  };
}

/**
 * Re-synthesize with critic feedback appended to the system prompt.
 * A near-copy of the grounded branch inside synthesize, with one extra instruction line.
 * Module-private — only synthesizeGrounded calls this.
 */
async function synthesizeWithFeedback(
  query: string,
  outcome: Extract<RetrievalOutcome, { kind: "grounded" }>,
  llm: LLMClient,
  footer: string,
  feedback: string,
  model: string = SYNTHESIS_MODEL,
): Promise<MedicalAnswer> {
  const passages = outcome.passages;
  if (passages.length === 0) return abstainAnswer(footer); // mirrors synthesize:120-130
  const system =
    buildSynthesisSystem(passages) +
    `\n\nAddress this reviewer feedback while staying grounded ONLY in the passages: ${feedback}`;
  let responseText: string;
  try {
    const response = await llm.chat({
      model,
      system,
      messages: [{ role: "user", content: query }],
      maxTokens: SYNTHESIS_MAX_TOKENS,
    });
    responseText = response.text.trim();
  } catch {
    return abstainAnswer(footer);
  }
  if (!responseText || responseText.toUpperCase() === "ABSTAIN") return abstainAnswer(footer);
  return {
    body: responseText,
    abstained: false,
    citations: passagesToCitations(passages),
    disclaimerFooter: footer,
    shortCircuit: false,
  };
}

/**
 * synthesizeGrounded — fail-closed gate: synthesize → critic → one re-synth → abstain.
 *
 * For non-grounded outcomes, delegates to synthesize (disabled/abstain handled there).
 * For grounded outcomes:
 *   1. synthesize → if abstained, return it
 *   2. getGroundingVerdict → if approve, return answer
 *   3. synthesizeWithFeedback (one re-synth with critic feedback)
 *   4. getGroundingVerdict again → if approve, return re-synth answer
 *   5. else → return abstainAnswer (fail-closed)
 *
 * Any thrown error from synthesize or the critic maps to abstainAnswer (fail-closed).
 * Bounded by GROUNDED_GATE_MAX_LLM_CALLS (= 6 worst case today).
 *
 * Returns { answer, verdict } where verdict is one of:
 *   'approve'          — gate returned an approved answer
 *   'reject-abstained' — gate abstained after a critic reject (second reject)
 *   'error-abstained'  — gate abstained due to a thrown error or model unavailable
 *
 * @param model - Model identifier to use (default: SYNTHESIS_MODEL for back-compat).
 */
export async function synthesizeGrounded(
  query: string,
  outcome: RetrievalOutcome,
  llm: LLMClient,
  footer: string,
  model: string = SYNTHESIS_MODEL,
): Promise<GroundedResult> {
  // Non-grounded outcomes are already handled by synthesize (disabled/abstain → abstained).
  if (outcome.kind !== "grounded") {
    const answer = await synthesize(query, outcome, llm, footer, model);
    return { answer, verdict: "error-abstained" };
  }

  // 1) First synthesis.
  let answer: MedicalAnswer;
  try {
    answer = await synthesize(query, outcome, llm, footer, model);
  } catch {
    return { answer: abstainAnswer(footer), verdict: "error-abstained" };
  }
  if (answer.abstained) return { answer, verdict: "error-abstained" }; // synthesize abstained (empty/ABSTAIN/no-passages/model-unavailable)

  // 2) First critique. getGroundingVerdict PROPAGATES transport errors → wrap.
  let verdict: GroundingVerdict;
  try {
    verdict = await getGroundingVerdict({
      llm,
      model,
      question: query,
      answerBody: answer.body,
      passages: outcome.passages,
    });
  } catch {
    return { answer: abstainAnswer(footer), verdict: "error-abstained" };
  }
  if (verdict.verdict === "approve") return { answer, verdict: "approve" };

  // 3) ONE re-synthesis with critic feedback appended to the system prompt.
  let answer2: MedicalAnswer;
  try {
    answer2 = await synthesizeWithFeedback(query, outcome, llm, footer, verdict.feedback, model);
  } catch {
    return { answer: abstainAnswer(footer), verdict: "error-abstained" };
  }
  if (answer2.abstained) return { answer: answer2, verdict: "error-abstained" };

  // 4) Re-critique.
  let verdict2: GroundingVerdict;
  try {
    verdict2 = await getGroundingVerdict({
      llm,
      model,
      question: query,
      answerBody: answer2.body,
      passages: outcome.passages,
    });
  } catch {
    return { answer: abstainAnswer(footer), verdict: "error-abstained" };
  }
  // Approved on re-critique => 'approve'. Not approved => 'reject-abstained' (critic ran and rejected).
  return verdict2.verdict === "approve"
    ? { answer: answer2, verdict: "approve" }
    : { answer: abstainAnswer(footer), verdict: "reject-abstained" };
}

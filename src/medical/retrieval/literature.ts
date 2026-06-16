/** LiteratureRetriever — checks the literature-retrieval axis; returns {disabled} sync when off (ADR-6). */
import type { EgressGuard } from "../egress.js";
import { MedlineSource, type RetrievalOutcome, type Passage } from "./medline-source.js";
import type { LLMClient } from "../../providers/types.js";
import type { MedicalAnswer, Citation } from "../types.js";

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
 */
export async function synthesize(
  query: string,
  outcome: RetrievalOutcome,
  llm: LLMClient,
  footer: string,
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
      model: SYNTHESIS_MODEL,
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

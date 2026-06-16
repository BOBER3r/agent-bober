/** LiteratureRetriever — checks the literature-retrieval axis; returns {disabled} sync when off (ADR-6). */
import type { EgressGuard } from "../egress.js";
import { MedlineSource, type RetrievalOutcome } from "./medline-source.js";

/**
 * Orchestrates literature retrieval behind the literature-retrieval egress gate.
 *
 * SYNCHRONOUS short-circuit: if the axis is off, return {disabled} — NO network
 * attempt and NO MedlineSource method is called. This is the zero-egress proof.
 *
 * bober: MedlineSource is a stub this sprint; real MedlinePlus call arrives in S7.
 */
export class LiteratureRetriever {
  constructor(
    private readonly egress: EgressGuard,
    private readonly source = new MedlineSource(),
  ) {}

  /**
   * Retrieve literature passages for the given query.
   *
   * When literature-retrieval is OFF: returns { kind: "disabled" } IMMEDIATELY,
   * before MedlineSource is consulted — guarantees zero outbound bytes.
   *
   * When literature-retrieval is ON: delegates to MedlineSource.fetchPassages
   * (stub abstains; S7 adds the real MedlinePlus call).
   */
  async retrieve(query: string): Promise<RetrievalOutcome> {
    // isAllowed check MUST precede source call — proves zero-egress when axis is off.
    if (!this.egress.isAllowed("literature-retrieval")) {
      return { kind: "disabled" };
    }
    return this.source.fetchPassages(query);
  }
}

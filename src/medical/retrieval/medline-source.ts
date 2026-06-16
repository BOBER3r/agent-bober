/** MedlineSource — the ONLY medical file allowed network imports (ADR-6 exception). S7 adds the real call. */
// NO network import yet — Sprint 7 adds the MedlinePlus fetch here under EgressGuard.assertAllowed.

/**
 * Discriminated union for retrieval outcomes.
 * disabled — the egress axis is off; no attempt was made.
 * abstain  — the axis is on but the source could not produce passages (stub or error).
 * grounded — passages retrieved from MedlinePlus (Sprint 7 only).
 */
export type RetrievalOutcome =
  | { kind: "disabled" }
  | { kind: "abstain"; reason: string }
  | { kind: "grounded"; passages: string[] }; // S7 only

/**
 * MedlinePlus retrieval source.
 *
 * This sprint: stub only — returns abstain. Sprint 7 adds the real network call
 * behind EgressGuard.assertAllowed("literature-retrieval").
 *
 * This is the ONE file the ESLint no-restricted-imports exception permits to hold
 * network imports (src/medical/retrieval/medline-source.ts — ADR-6).
 *
 * bober: stub returns abstain; real MedlinePlus fetch lands in S7 with assertAllowed gate.
 */
export class MedlineSource {
  /** Stub this sprint: no network. Returns abstain. The live source call lands in S7. */
  async fetchPassages(_query: string): Promise<RetrievalOutcome> {
    return { kind: "abstain", reason: "literature source not implemented (Sprint 7)" };
  }
}

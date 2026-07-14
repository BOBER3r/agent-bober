/** MedlineSource — the ONLY medical file allowed network imports (ADR-6 exception). S7 adds the real call. */
// Real MedlinePlus fetch lands HERE — the single ESLint-excepted file (src/medical/retrieval/medline-source.ts).
// assertAllowed("literature-retrieval") is called BEFORE any fetch attempt (runtime defense-in-depth over ESLint).
import type { EgressGuard } from "../egress.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * A single retrieved passage from MedlinePlus.
 * title + url form the citation; text is the passage body for synthesis grounding.
 */
export interface Passage {
  title: string;
  url: string;
  text: string;
  source: "medlineplus";
}

/**
 * Discriminated union for retrieval outcomes.
 * disabled — the egress axis is off; no attempt was made.
 * abstain  — the axis is on but the source could not produce passages (error or empty).
 * grounded — passages retrieved from MedlinePlus (Sprint 7).
 */
export type RetrievalOutcome =
  | { kind: "disabled" }
  | { kind: "abstain"; reason: string }
  | { kind: "grounded"; passages: Passage[] };

/**
 * Injectable transport type — a minimal fetch-like function.
 * Tests pass a fake returning recorded fixture data; production defaults to the global fetch.
 * Using a plain duck-typed return rather than the global Response to stay testable
 * without the global fetch in test files (global fetch is banned in other medical files).
 * No AbortSignal in the signature — tests inject synchronous fakes that don't need it.
 */
export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ── MedlinePlus Web Service URL builder ─────────────────────────────

// bober: MedlinePlus Web Service (health-topics JSON, no-auth) — https://wsearch.nlm.nih.gov/ws/query
// Returns nlmSearchResult.list.document[] with content fields (title, FullSummary, link).
// CI uses the committed fixture at __fixtures__/medlineplus-sample.json; live endpoint skipped by default.
const MEDLINEPLUS_BASE = "https://wsearch.nlm.nih.gov/ws/query";

function buildMedlineUrl(query: string): string {
  // Build query string manually — URLSearchParams is not declared as a global in the ESLint config.
  const encodedTerm = encodeURIComponent(query);
  return `${MEDLINEPLUS_BASE}?db=healthTopics&term=${encodedTerm}&rettype=brief&retmax=5&retformat=json`;
}

// ── MedlinePlus response parser ──────────────────────────────────────

/**
 * Parse the MedlinePlus Web Service JSON response into Passage[].
 * Accepts unknown shape; returns [] on any structural mismatch (fail-closed).
 */
function parseMedline(raw: unknown): Passage[] {
  if (!raw || typeof raw !== "object") return [];

  const result = raw as Record<string, unknown>;
  const nlmResult = result["nlmSearchResult"] as Record<string, unknown> | undefined;
  if (!nlmResult) return [];

  const list = nlmResult["list"] as Record<string, unknown> | undefined;
  if (!list) return [];

  const documents = list["document"];
  if (!Array.isArray(documents)) return [];

  const passages: Passage[] = [];
  for (const doc of documents) {
    if (!doc || typeof doc !== "object") continue;
    const d = doc as Record<string, unknown>;

    // title: from content[] where name === "title"
    let title = "";
    let text = "";
    let url = "";

    const url_ = d["@url"];
    if (typeof url_ === "string") url = url_;

    const contents = d["content"];
    if (Array.isArray(contents)) {
      for (const item of contents) {
        if (!item || typeof item !== "object") continue;
        const c = item as Record<string, unknown>;
        const name = c["@name"];
        const value = c["#text"];
        if (name === "title" && typeof value === "string") title = value;
        if (name === "FullSummary" && typeof value === "string") text = value;
      }
    }

    if (title && url) {
      passages.push({ title, url, text: text || title, source: "medlineplus" });
    }
  }

  return passages;
}

// ── MedlineSource class ──────────────────────────────────────────────

/**
 * MedlinePlus retrieval source.
 *
 * This is the ONE file the ESLint no-restricted-imports exception permits to hold
 * network imports (src/medical/retrieval/medline-source.ts — ADR-6).
 *
 * assertAllowed("literature-retrieval") is called BEFORE any fetch attempt — this
 * is the runtime defense-in-depth that backs the static ESLint boundary.
 *
 * The injectable fetchImpl transport means tests NEVER reach the live MedlinePlus
 * endpoint — they pass a fake FetchLike returning committed fixture data.
 *
 * bober: single source (MedlinePlus/NIH, no-auth); add PubMed in a future sprint
 *        if multi-source support is needed — keep each source in its own file.
 */
export class MedlineSource {
  constructor(
    private readonly egress: EgressGuard,
    // bober: global fetch is the default ONLY in this file (ESLint exception);
    //        tests inject a FetchLike returning fixture data so CI stays offline.
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
  ) {}

  /**
   * Fetch passages from MedlinePlus for the given query.
   *
   * Order:
   * 1. assertAllowed — throws (and is caught below) if the axis is off.
   * 2. fetchImpl(url) — injectable transport; default = global fetch.
   * 3. Parse response into Passage[].
   * 4. Return grounded | abstain{no-passages} | abstain{source-error}.
   *
   * NEVER throws out of this method — all errors map to abstain{source-error}.
   */
  async fetchPassages(query: string): Promise<RetrievalOutcome> {
    try {
      // MUST be first — runtime defense-in-depth over the ESLint boundary.
      this.egress.assertAllowed("literature-retrieval");

      const url = buildMedlineUrl(query);
      const res = await this.fetchImpl(url);

      if (!res.ok) {
        return { kind: "abstain", reason: "source-error" };
      }

      const json = await res.json();
      const passages = parseMedline(json);
      return passages.length > 0
        ? { kind: "grounded", passages }
        : { kind: "abstain", reason: "no-passages" };
    } catch {
      // Includes: assertAllowed throws (axis off), network error, parse error.
      // NEVER fail-open — abstain with source-error.
      return { kind: "abstain", reason: "source-error" };
    }
  }
}

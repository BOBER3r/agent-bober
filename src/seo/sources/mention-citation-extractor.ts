/**
 * MentionCitationExtractor — deterministic host/brand matcher over a
 * grounded-search answer (in-house-ai-visibility, Sprint 2;
 * arch-20260717-in-house-oss-ai-visibility-architecture.md:148-159,240-245).
 *
 * PURE, synchronous, network-free transform: given `{target, answerText,
 * citations}` it decides `{mentioned, rank?, citationPresent, sourceUrls}`
 * by string/host matching alone — no LLM judge (that is Sprint 8, a
 * nonGoal here) and no `CitationVerifier` call (Sprint 4, also a nonGoal —
 * `sourceUrls` here are candidate URLs, not verified ones).
 *
 * Matching strategy (deterministic only, per the architecture):
 *   1. Normalize `target` to a bare host (strip scheme, `www.`) via the
 *      local `safeHost` guard — mirrors `safeOrigin`
 *      (`damcrawler-crawl-engine.ts:122-129`) and the "no shared URL/host
 *      util exists in `src`" note (`citation-gate.ts:30-32`).
 *   2. `mentioned` = the target's brand token (the host's first label) OR
 *      its full bare host appears, case-insensitive and on a word
 *      boundary, in `answerText` OR in any citation's `title`. Word-
 *      boundary matching (not naive `includes`) avoids substring false
 *      positives (e.g. brand "ace" must not match inside "space").
 *   3. `sourceUrls` = citation URLs whose host equals the target host (or
 *      is a subdomain of it) — candidate URLs only, never verified.
 *   4. `citationPresent` = `sourceUrls.length > 0`.
 *   5. `rank` is never derivable deterministically this sprint, so the key
 *      is always omitted (never `rank: undefined`) — sc-2-1 does not
 *      require it.
 *
 * Empty/whitespace/malformed input (empty `target`, empty/whitespace
 * `answerText`, empty `citations`) always yields
 * `{ mentioned: false, citationPresent: false, sourceUrls: [] }` — this
 * class NEVER fabricates a positive observation (sc-2-1, stopConditions).
 */
import type { GroundedCitation } from "../../providers/grounded-search.js";

/** Locked output shape — MUST match the architecture data model exactly (feeds `AiVisibilityRow`). */
export type SampleObservation = {
  mentioned: boolean;
  rank?: number;
  citationPresent: boolean;
  sourceUrls: string[];
};

export interface MentionCitationExtractor {
  extract(input: { target: string; answerText: string; citations: GroundedCitation[] }): SampleObservation;
}

/**
 * `try { new URL(...).hostname } catch { "" }` — URL parsing must never
 * throw here. Accepts both a full URL (`https://target.example/page`) and
 * a bare domain (`target.example`, `www.target.example`) by prefixing a
 * scheme when one is absent, mirroring `safeOrigin`
 * (`damcrawler-crawl-engine.ts:122-129`).
 */
function safeHost(raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const candidate = hasScheme ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Strips a leading `www.` label — hosts are compared without it. */
function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Bare, `www.`-stripped host for `raw` — `""` when `raw` is empty/malformed. */
function bareHost(raw: string): string {
  return stripWww(safeHost(raw));
}

/** The host's first label — the brand token (e.g. `"target"` from `"target.example"`). */
function brandToken(host: string): string {
  const [first] = host.split(".");
  return first ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive, word-boundary substring test. Word-boundary (not
 * `includes`) prevents a brand token from matching inside an unrelated
 * larger word (e.g. `"ace"` must not match `"space"`).
 */
function containsWordBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i");
  return pattern.test(haystack);
}

/** `true` when `citationHost` is exactly `targetHost` or a subdomain of it. Both inputs are already bare/`www.`-stripped. */
function hostMatches(citationHost: string, targetHost: string): boolean {
  if (!citationHost || !targetHost) return false;
  return citationHost === targetHost || citationHost.endsWith(`.${targetHost}`);
}

export class DeterministicMentionCitationExtractor implements MentionCitationExtractor {
  extract({
    target,
    answerText,
    citations,
  }: {
    target: string;
    answerText: string;
    citations: GroundedCitation[];
  }): SampleObservation {
    const targetHost = bareHost(target);
    const brand = brandToken(targetHost);
    const safeCitations = Array.isArray(citations) ? citations : [];

    // -- sourceUrls / citationPresent: candidate URLs whose host matches the target's host --
    const sourceUrls = targetHost
      ? safeCitations.filter((c) => hostMatches(bareHost(c.url), targetHost)).map((c) => c.url)
      : [];
    const citationPresent = sourceUrls.length > 0;

    // -- mentioned: brand/host in answerText or any citation title, word-boundary matched --
    const hasAnswerText = typeof answerText === "string" && answerText.trim().length > 0;
    const mentionedInAnswer =
      targetHost.length > 0 &&
      hasAnswerText &&
      (containsWordBoundary(answerText, brand) || containsWordBoundary(answerText, targetHost));
    const mentionedInCitationTitle =
      targetHost.length > 0 &&
      safeCitations.some(
        (c) => containsWordBoundary(c.title, brand) || containsWordBoundary(c.title, targetHost),
      );

    return {
      mentioned: mentionedInAnswer || mentionedInCitationTitle,
      citationPresent,
      sourceUrls,
    };
  }
}

/**
 * MentionCitationExtractor — deterministic host/brand matcher over a
 * grounded-search answer (in-house-ai-visibility, Sprint 2;
 * arch-20260717-in-house-oss-ai-visibility-architecture.md:148-159,240-245),
 * with an OPTIONAL injected LLM-as-judge fuzzy-mention path added in
 * Sprint 8.
 *
 * PURE, synchronous, network-free transform: given `{target, answerText,
 * citations}` it decides `{mentioned, rank?, citationPresent, sourceUrls}`
 * by string/host matching alone — no `CitationVerifier` call (Sprint 4,
 * a nonGoal here — `sourceUrls` here are candidate URLs, not verified
 * ones).
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
 *
 * Sprint 8 — LLM-as-judge fuzzy-mention path (`LlmJudgeMentionCitationExtractor`):
 * an OPTIONAL, injected-`llm` extractor that COMPOSES the deterministic one.
 * It runs the deterministic pass first; only when that pass left
 * `mentioned:false` (cost control, evaluatorNotes) does it sanitize the
 * answer text and ask a bounded, schema-parsed LLM judge whether the
 * answer fuzzily/paraphrasedly mentions the target. The judge FAILS SAFE
 * to the deterministic result on any transport error or unparseable
 * verdict — it never fabricates `mentioned:true` (sc-8-3). Production
 * wiring (`ai-visibility-provider.ts`, `runner.ts`) still constructs the
 * plain `DeterministicMentionCitationExtractor` with no `llm`, so the
 * deterministic-only path remains byte-identical and this class is opt-in
 * (sc-8-2, nonGoals: judge is NOT the default).
 */
import { z } from "zod";

import type { GroundedCitation } from "../../providers/grounded-search.js";
import type { LLMClient } from "../../providers/types.js";
import type { ContentSanitizer } from "../content-sanitizer.js";

/** Locked output shape — MUST match the architecture data model exactly (feeds `AiVisibilityRow`). */
export type SampleObservation = {
  mentioned: boolean;
  rank?: number;
  citationPresent: boolean;
  sourceUrls: string[];
};

export interface MentionCitationExtractor {
  extract(input: {
    target: string;
    answerText: string;
    citations: GroundedCitation[];
  }): SampleObservation | Promise<SampleObservation>;
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

// ── Sprint 8 — LLM-as-judge fuzzy-mention path (opt-in) ─────────────────

/** Bounded judge verdict — the ONLY shape the judge is allowed to return. */
export const JudgeVerdictSchema = z.object({
  mentioned: z.boolean(),
  rank: z.number().int().positive().optional(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export type ParseJudgeVerdictResult = { ok: true; verdict: JudgeVerdict } | { ok: false; error: string };

/**
 * Never-throws 3-tier verdict parser — mirrors
 * `validateGroundingVerdict` (`src/medical/retrieval/grounding-critic.ts:40-88`):
 * try a direct parse, then a fenced ```json block, then the first
 * `{...}` span; `safeParse` at the end never throws. On total failure
 * returns `{ ok: false, error }` so the caller can fail SAFE to the
 * deterministic result (sc-8-3) rather than propagate a throw.
 */
export function parseJudgeVerdict(rawText: string): ParseJudgeVerdictResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    if (!parsed) {
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1));
        } catch {
          return { ok: false, error: `No valid JSON object found in judge response. Raw: ${rawText.slice(0, 200)}` };
        }
      } else {
        return { ok: false, error: `No JSON object found in judge response. Raw: ${rawText.slice(0, 200)}` };
      }
    }
  }

  const result = JudgeVerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    return { ok: false, error: issues };
  }

  return { ok: true, verdict: result.data };
}

function buildJudgeSystemPrompt(target: string): string {
  return (
    `You are an independent fact-checker judging whether a search-engine answer ` +
    `mentions a specific brand/website, INCLUDING fuzzy/paraphrased references ` +
    `that clearly refer to it without using its exact name or domain.\n\n` +
    `Target brand/site: ${target}\n\n` +
    `Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:\n` +
    `{"mentioned": boolean, "rank": number}\n\n` +
    `Rules:\n` +
    `- "mentioned" must be true ONLY if the answer text meaningfully refers to the target brand/site (fuzzy/paraphrased mentions count; a coincidental or unrelated similar word does not).\n` +
    `- "rank" is OPTIONAL: include it ONLY as a positive integer giving the target's approximate position among ranked/listed items in the answer; omit the key entirely if the answer has no ranking or you are unsure.\n` +
    `- If the answer text is empty, unrelated, or you are unsure whether it refers to the target, "mentioned" must be false.\n` +
    `- Output the JSON object and nothing else.`
  );
}

function buildJudgeUserContent(sanitizedAnswerText: string, citations: GroundedCitation[]): string {
  const citationBlock =
    citations.length > 0 ? citations.map((c, i) => `[${i + 1}] ${c.title} — ${c.url}`).join("\n") : "(no citations)";
  return `Answer text to judge:\n${sanitizedAnswerText}\n\nCitations:\n${citationBlock}`;
}

/**
 * OPTIONAL, injected LLM-as-judge fuzzy-mention extractor (Sprint 8;
 * sc-8-1..sc-8-4). COMPOSES `DeterministicMentionCitationExtractor` —
 * always runs the deterministic pass first and returns it verbatim
 * (no judge call, cost control) when it already found a mention. Only
 * when the deterministic pass left `mentioned:false` on a non-empty
 * answer does this class sanitize the text (sc-8-4) and ask a bounded,
 * schema-parsed judge whether the answer fuzzily mentions the target.
 *
 * FAIL-SAFE (sc-8-3): a thrown `llm.chat` transport error or an
 * unparseable/malformed verdict falls back to the deterministic result
 * VERBATIM — this class never fabricates `mentioned:true`. The judge
 * only ever overrides `mentioned`/`rank`; `citationPresent`/`sourceUrls`
 * always come from the deterministic pass (the judge does not re-derive
 * URLs — nonGoals: not used for citation URL verification).
 *
 * NOT wired into production callers this sprint (`ai-visibility-provider.ts`,
 * `runner.ts` still construct the plain `DeterministicMentionCitationExtractor`
 * with no `llm`) — this class is exercised via unit tests injecting a
 * scripted `LLMClient`, keeping the deterministic-only path byte-identical
 * (sc-8-2).
 */
export class LlmJudgeMentionCitationExtractor implements MentionCitationExtractor {
  constructor(
    private readonly deterministic: DeterministicMentionCitationExtractor,
    private readonly llm: LLMClient,
    private readonly model: string,
    private readonly sanitizer: ContentSanitizer,
  ) {}

  async extract(input: {
    target: string;
    answerText: string;
    citations: GroundedCitation[];
  }): Promise<SampleObservation> {
    const { target, answerText, citations } = input;
    const deterministicResult = this.deterministic.extract(input);

    // Cost control (evaluatorNotes): the judge only runs on answers the
    // deterministic pass did NOT already mark mentioned.
    if (deterministicResult.mentioned) return deterministicResult;

    // Never spend an LLM call on an empty/whitespace answer, and never let
    // a judge turn one into `mentioned:true` (sc-8-3).
    const hasAnswerText = typeof answerText === "string" && answerText.trim().length > 0;
    if (!hasAnswerText) return deterministicResult;

    // sc-8-4: sanitize BEFORE building the judge prompt. A sanitizer that
    // drops the text entirely (fail-closed, e.g. threats detected) leaves
    // nothing for the judge to reason about — fail safe without calling it.
    const sanitizedAnswerText = this.sanitizer.clean(answerText, target).content;
    if (sanitizedAnswerText.trim().length === 0) return deterministicResult;

    let rawText: string;
    try {
      const response = await this.llm.chat({
        model: this.model,
        system: buildJudgeSystemPrompt(target),
        messages: [{ role: "user", content: buildJudgeUserContent(sanitizedAnswerText, citations) }],
        jsonObjectMode: true,
      });
      rawText = response.text;
    } catch {
      return deterministicResult; // fail-safe: transport error -> deterministic result (sc-8-3)
    }

    const parsed = parseJudgeVerdict(rawText);
    if (!parsed.ok) return deterministicResult; // fail-safe: unparseable verdict -> deterministic result (sc-8-3)

    const result: SampleObservation = {
      mentioned: parsed.verdict.mentioned,
      citationPresent: deterministicResult.citationPresent,
      sourceUrls: deterministicResult.sourceUrls,
    };
    if (parsed.verdict.rank !== undefined) result.rank = parsed.verdict.rank; // never `rank: undefined`
    return result;
  }
}

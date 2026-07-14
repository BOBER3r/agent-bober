/**
 * Two-pass hub prioritization judge.
 *
 * Pass 1 (relevance): For filtered scope, applies pure-JS applyFilter with zero LLM calls.
 * For general/decision scopes, calls the injected LLM per finding and parses with
 * validateRelevanceVerdict (fail-closed: null drops the finding; decision scope additionally
 * drops findings whose relevantTo is "neither" or undefined).
 *
 * Pass 2 (prioritization): For each survivor, fans out the four hub lenses (urgency, impact,
 * effort, deadline-risk). Aggregate score = SUM of per-lens scores (0–40; 4 × 0–10). Reconcile:
 * STRICT MAJORITY, FAIL-CLOSED ON TIE: passVotes > failVotes → normal ranking;
 * passVotes ≤ failVotes → kept but tagged "flagged-for-review" (immutable copy, never mutate input).
 *
 * Final order: deterministic JS sort — aggregate score DESC, urgency DESC, severity DESC,
 * dueBy ASC (undefined LAST, treated as +Infinity), id ASC. LLM never emits the final order.
 */
import type { LLMClient, TextMessage } from "../providers/types.js";
import type { Finding } from "./finding.js";
import { type Scope, applyFilter } from "./scope.js";
import {
  HUB_LENS_NAMES,
  resolveHubLensFocus,
  validateRelevanceVerdict,
  validateLensScore,
} from "./lenses.js";

// ── Prompt helper ─────────────────────────────────────────────────────

function buildFindingSummary(finding: Finding): string {
  const dueStr = finding.dueBy !== undefined ? `\nDue by: ${finding.dueBy}` : "";
  const tagsStr = finding.tags.length > 0 ? `\nTags: ${finding.tags.join(", ")}` : "";
  return (
    `ID: ${finding.id}\n` +
    `Title: ${finding.title}\n` +
    `Domain: ${finding.domain}\n` +
    `Kind: ${finding.kind}\n` +
    `Urgency: ${finding.urgency}/5\n` +
    `Severity: ${finding.severity}/5\n` +
    `Evidence: ${finding.evidence.join("; ")}` +
    dueStr +
    tagsStr
  );
}

// ── Pass 1: LLM relevance (general and decision scopes only) ──────────

/**
 * Ask the injected LLM for a per-finding relevance verdict.
 * Returns null on parse failure (fail-closed: caller treats null as "drop").
 * For filtered scope this function is never called (caller fast-paths).
 */
async function askRelevance(finding: Finding, scope: Scope, llm: LLMClient) {
  const summary = buildFindingSummary(finding);
  let system: string;
  let userContent: string;

  if (scope.mode === "decision") {
    system =
      "You are a relevance filter for a personal priority hub helping evaluate a decision. " +
      "Determine which named option (if any) this finding informs. " +
      'Respond ONLY with a JSON object: ' +
      '{ "relevant": boolean, "relevantTo": "optionA" | "optionB" | "both" | "neither", "reason": string }';
    userContent =
      `Decision:\nOption A: ${scope.optionA}\nOption B: ${scope.optionB}\n\n` +
      `Finding:\n${summary}\n\n` +
      "Which option does this finding inform, if any? Respond with JSON only.";
  } else {
    // general (filtered is handled by caller fast path and never reaches here)
    system =
      "You are a relevance filter for a personal priority hub. " +
      "Evaluate whether this finding deserves attention in a general priority review. " +
      'Respond ONLY with a JSON object: { "relevant": boolean, "reason": string }';
    userContent =
      `Finding:\n${summary}\n\n` +
      "Is this finding relevant for a general priority review? Respond with JSON only.";
  }

  const messages: TextMessage[] = [{ role: "user", content: userContent }];
  const response = await llm.chat({
    model: "hub-relevance",
    system,
    messages,
    jsonObjectMode: true,
  });
  return validateRelevanceVerdict(response.text);
}

// ── Pass 2: hub lens fan-out ──────────────────────────────────────────

/**
 * Fan out all hub prioritization lenses for a single finding.
 * Aggregate score = SUM of per-lens scores (range 0–40 across 4 lenses).
 * Null lens response → {include:false, score:0} (fail-closed, contributes to failVotes).
 */
async function scoreFindingWithLenses(
  finding: Finding,
  llm: LLMClient,
): Promise<{ passVotes: number; failVotes: number; aggregateScore: number }> {
  const summary = buildFindingSummary(finding);
  let passVotes = 0;
  let failVotes = 0;
  let aggregateScore = 0;

  for (const lens of HUB_LENS_NAMES) {
    const lensFocus = resolveHubLensFocus(lens);
    const system =
      `${lensFocus} ` +
      "You are evaluating a finding for a personal priority hub. " +
      'Respond ONLY with a JSON object: { "include": boolean, "score": number, "reason": string } ' +
      "where score is an integer 0–10 (0 = lowest priority, 10 = highest priority).";
    const userContent =
      `Finding:\n${summary}\n\n` +
      "Should this finding be prioritized? Provide a score and reason. Respond with JSON only.";

    const messages: TextMessage[] = [{ role: "user", content: userContent }];
    const response = await llm.chat({
      model: "hub-lens",
      system,
      messages,
      jsonObjectMode: true,
    });

    // null → fail-closed default: contribute to failVotes, add 0 to aggregate
    const lensScore = validateLensScore(response.text) ?? { include: false, score: 0 };
    aggregateScore += lensScore.score;
    if (lensScore.include) {
      passVotes += 1;
    } else {
      failVotes += 1;
    }
  }

  return { passVotes, failVotes, aggregateScore };
}

// ── Deterministic sort comparator ──────────────────────────────────────

/**
 * Deterministic comparator for the final sort step.
 * Order: aggregateScore DESC → urgency DESC → severity DESC →
 *        dueBy ASC (undefined treated as +Infinity → LAST) → id ASC.
 */
function compareFindings(
  a: { finding: Finding; aggregateScore: number },
  b: { finding: Finding; aggregateScore: number },
): number {
  // 1. aggregateScore DESC
  if (b.aggregateScore !== a.aggregateScore) return b.aggregateScore - a.aggregateScore;
  // 2. urgency DESC
  if (b.finding.urgency !== a.finding.urgency) return b.finding.urgency - a.finding.urgency;
  // 3. severity DESC
  if (b.finding.severity !== a.finding.severity) return b.finding.severity - a.finding.severity;
  // 4. dueBy ASC; undefined → +Infinity → sorts LAST
  const dueA = a.finding.dueBy !== undefined ? Date.parse(a.finding.dueBy) : Infinity;
  const dueB = b.finding.dueBy !== undefined ? Date.parse(b.finding.dueBy) : Infinity;
  if (dueA !== dueB) return dueA - dueB;
  // 5. id ASC (lexicographic)
  if (a.finding.id < b.finding.id) return -1;
  if (a.finding.id > b.finding.id) return 1;
  return 0;
}

// ── rankFindings ───────────────────────────────────────────────────────

/**
 * Two-pass hub prioritization judge.
 *
 * @param findings  Pool of Finding[] to rank (input array and Finding objects are never mutated).
 * @param scope     Ephemeral query scope — not persisted anywhere.
 * @param llm       Injected LLMClient. Tests pass a ScriptedClient fake; Sprint 4 passes a real client.
 * @param now       Injected clock for dueWithinDays math in filtered mode. Never call Date.now() here.
 * @returns         Ranked Finding[]; tie-voted findings carry the "flagged-for-review" tag.
 */
export async function rankFindings(
  findings: Finding[],
  scope: Scope,
  llm: LLMClient,
  now: Date,
): Promise<Finding[]> {
  // ── Filtered fast path: pure JS, ZERO LLM calls ────────────────────
  if (scope.mode === "filtered") {
    const filtered = applyFilter(findings, scope, now);
    // Sort deterministically without aggregate score (no lens pass for filtered mode)
    return [...filtered].sort((a, b) =>
      compareFindings({ finding: a, aggregateScore: 0 }, { finding: b, aggregateScore: 0 }),
    );
  }

  // ── Pass 1: LLM relevance filter (general / decision) ─────────────
  const survivors: Finding[] = [];
  for (const finding of findings) {
    const verdict = await askRelevance(finding, scope, llm);

    // null → fail-closed: drop the finding
    if (verdict === null || !verdict.relevant) continue;

    // Decision scope: drop "neither" and undefined relevantTo
    if (scope.mode === "decision") {
      const rt = verdict.relevantTo;
      if (rt !== "optionA" && rt !== "optionB" && rt !== "both") continue;
    }

    survivors.push(finding);
  }

  // ── Pass 2: lens scoring + strict-majority reconcile ──────────────
  const scored: Array<{ finding: Finding; aggregateScore: number }> = [];

  for (const finding of survivors) {
    const { passVotes, failVotes, aggregateScore } = await scoreFindingWithLenses(finding, llm);

    // Reconcile: strict majority, fail-closed on tie.
    // bober: hub inverts the eval/medical panel DROP: a tie/fail-majority keeps the finding
    //        and tags it "flagged-for-review" rather than dropping it (lens-panel.md:80-84).
    let out: Finding;
    if (passVotes > failVotes) {
      out = finding; // strict majority → normal ranking, no tag change
    } else {
      // Tie or fail-majority → keep but tag; append to a COPY to avoid mutating input
      out = finding.tags.includes("flagged-for-review")
        ? finding
        : { ...finding, tags: [...finding.tags, "flagged-for-review"] };
    }

    scored.push({ finding: out, aggregateScore });
  }

  // ── Deterministic sort: LLM never emits the final order ───────────
  return [...scored].sort(compareFindings).map((s) => s.finding);
}

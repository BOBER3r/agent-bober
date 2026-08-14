import type { GraphMessage } from "../state/overall.js";

/**
 * Token estimation, behind an interface, with no tokenizer in the dependency tree.
 *
 * ── Why an interface and not a function ──
 *
 * Every threshold this sprint's Engram layer computes — the 15% successor-context ratio,
 * the 85% compression trigger, the 10% re-injection budget, the digest's token ceiling —
 * is a fraction of a token count, and there is no tokenizer here to produce one. The
 * architecture risk row states the resolution directly: "Put estimation behind a
 * `TokenEstimator` interface and pin acceptance tests to tolerance bands well clear of
 * each boundary; the interface admits a real tokenizer as an optional peer without
 * touching call sites."
 *
 * So every threshold-computing export in `digest.ts`, `handoff.ts` and `compactor.ts`
 * takes a {@link TokenEstimator} as a REQUIRED parameter. None of them reads a module
 * default, and none of them calls {@link createCharsPerTokenEstimator} internally. That is
 * what makes sc-10-10 checkable rather than asserted: a test swaps the estimator and the
 * computed threshold moves, which is only possible if the arithmetic genuinely flows
 * through the injected object.
 *
 * ── The chars/4 arithmetic is RESTATED, not imported ──
 *
 * `estimateTokens` at `src/graph/preflight-budgets.ts:38` already computes
 * `Math.ceil(text.length / 4)` and already carries the "replace chars/4 with tiktoken
 * when available" note. It is not imported: `src/graph/**` is the code-graph/tokensave
 * layer that spawns processes through execa, and `src/pge/lint-boundary.test.ts` names it
 * as a forbidden import for the guarded subtree. One line of arithmetic is restated here
 * for the same reason `FileRead` is restated in `scratch.ts` rather than pulled out of the
 * topology serializer — a primitive is cheaper to duplicate than a dependency edge is to
 * carry.
 */

// ── Interface ───────────────────────────────────────────────────────

/**
 * An estimate of how many tokens a string occupies.
 *
 * `id` exists so a trace, a decision record or a failing assertion can say WHICH
 * estimator produced a number. Two estimators disagreeing is normal and expected; two
 * estimators disagreeing invisibly is the bug.
 */
export interface TokenEstimator {
  readonly id: string;
  estimate(text: string): number;
}

/** The divisor the shipped default uses. Four characters to the token, the usual rule. */
export const DEFAULT_CHARS_PER_TOKEN = 4;

/** A `charsPerToken` that is not a positive finite number. Always a wiring bug. */
export class InvalidCharsPerTokenError extends Error {
  readonly charsPerToken: number;

  constructor(charsPerToken: number) {
    super(
      `charsPerToken must be a finite number greater than zero; received ${String(charsPerToken)}.`,
    );
    this.name = "InvalidCharsPerTokenError";
    this.charsPerToken = charsPerToken;
  }
}

/**
 * `Math.ceil(text.length / charsPerToken)`, and nothing else.
 *
 * `ceil` rather than `round`, so a non-empty string never estimates to zero tokens: a
 * budget that admits an unbounded number of "free" short messages is not a budget.
 */
export function createCharsPerTokenEstimator(
  charsPerToken: number = DEFAULT_CHARS_PER_TOKEN,
): TokenEstimator {
  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new InvalidCharsPerTokenError(charsPerToken);
  }
  return {
    id: `chars/${String(charsPerToken)}`,
    estimate(text: string): number {
      return Math.ceil(text.length / charsPerToken);
    },
  };
}

// ── Aggregation ─────────────────────────────────────────────────────

/** Sum of the estimator's answer over each string. */
export function estimateTexts(
  texts: readonly string[],
  estimator: TokenEstimator,
): number {
  let total = 0;
  for (const text of texts) total += estimator.estimate(text);
  return total;
}

/**
 * The estimated context cost of a message list.
 *
 * ── `GraphMessage.tokens` is deliberately NOT read ──
 *
 * `GraphMessageSchema` (`../state/overall.ts`) requires a `tokens` field, and both
 * existing runtime fixtures populate it with `text.length` — raw characters, not tokens.
 * It is provider-reported metadata: whatever produced the message said so. A compactor
 * that summed it would compute a threshold that no injected estimator could move, and
 * sc-10-10 would become a test of nothing. Thresholds are computed over the message TEXT,
 * through the estimator the caller supplied.
 *
 * A message carrying only a `textRef` contributes zero, which is correct rather than
 * lossy: those bytes live in the scratch store and are NOT in the context window. That is
 * the entire point of offloading them.
 */
export function estimateMessages(
  messages: readonly GraphMessage[],
  estimator: TokenEstimator,
): number {
  let total = 0;
  for (const message of messages) total += estimator.estimate(message.text ?? "");
  return total;
}

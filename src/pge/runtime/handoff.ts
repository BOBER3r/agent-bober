import { renderDigest } from "./digest.js";
import type { PhaseDigest } from "./digest.js";
import type { TokenEstimator } from "./token-estimator.js";

/**
 * The clean-context handoff: what a successor node starts from.
 *
 * ── Construction, not filtration ──
 *
 * The obvious implementation of "the successor gets a fresh context" is to take the
 * predecessor's message list and strip it down. That is the implementation this module
 * deliberately cannot express, and the reason is stated in the sprint's generator notes:
 * a filter can leak and a construction cannot.
 *
 * {@link assembleSuccessorPrompt} accepts a {@link PhaseDigest} and the successor node's
 * OWN declared input ports. There is no parameter of type `GraphMessage[]`, no
 * `OverallState`, and no `messages` field anywhere in {@link SuccessorContextInputs}. So
 * "the assembled prompt contains zero predecessor message ids" is not a property this
 * module is careful to maintain — it is a property the type system makes it impossible to
 * violate, because no message ever enters the function. {@link AssembledPrompt.sourceMessageIds}
 * is frozen and empty for exactly that reason: it is a witness, not a filtered result.
 *
 * ── There is no digest-missing branch ──
 *
 * `digest` is required and non-nullable. A caller that has no digest cannot call this
 * function, and `readDigest` (`digest.ts`) is the only way to obtain the value — and it
 * throws on absent, on unreadable and on invalid. The fallback that the non-goal forbids
 * ("a missing digest is a failure, not a reason to fall back to the transcript") has
 * nowhere to live.
 */

/**
 * The fraction of the predecessor's final context a successor may occupy.
 *
 * From the source documents (R14), and configurable through
 * {@link AssembleOptions.ratio}. The default is the documented 15%.
 */
export const SUCCESSOR_CONTEXT_RATIO = 0.15;

/** One declared input port, with the value bound to it for this execution. */
export interface SuccessorPort {
  readonly key: string;
  readonly schemaRef: string;
  readonly value: unknown;
}

/**
 * Everything the successor's prompt is built FROM.
 *
 * Note what is absent, and note that its absence is the specification: no message list,
 * no transcript, no state snapshot.
 */
export interface SuccessorContextInputs {
  readonly digest: PhaseDigest;
  readonly nodeId: string;
  readonly ports: readonly SuccessorPort[];
}

export interface AssembleOptions {
  /** The predecessor's final context size, in the SAME estimator's tokens. */
  readonly predecessorTokens: number;
  /** Default {@link SUCCESSOR_CONTEXT_RATIO}. */
  readonly ratio?: number;
}

export interface AssembledPrompt {
  readonly text: string;
  /** Estimated size of `text`, through the injected estimator. */
  readonly tokens: number;
  /** The ceiling `tokens` was checked against. */
  readonly budget: number;
  readonly estimatorId: string;
  /**
   * Always empty, and structurally so: no message list is reachable from this module.
   * Present as an assertable witness rather than as a value that could be non-empty.
   */
  readonly sourceMessageIds: readonly string[];
}

/** The assembled prompt did not fit the successor's share of the context. */
export class SuccessorPromptTooLargeError extends Error {
  readonly tokens: number;
  readonly budget: number;
  readonly nodeId: string;

  constructor(nodeId: string, tokens: number, budget: number, estimatorId: string) {
    super(
      `Successor "${nodeId}" assembled a ${String(tokens)}-token prompt under estimator "${estimatorId}", above its budget of ${String(budget)}. Shrink the digest or offload port payloads to the scratch store.`,
    );
    this.name = "SuccessorPromptTooLargeError";
    this.tokens = tokens;
    this.budget = budget;
    this.nodeId = nodeId;
  }
}

/** A ratio outside `(0, 1]`. A successor may not be granted more context than its predecessor had. */
export class InvalidContextRatioError extends Error {
  readonly ratio: number;

  constructor(ratio: number) {
    super(`Successor context ratio must be in (0, 1]; received ${String(ratio)}.`);
    this.name = "InvalidContextRatioError";
    this.ratio = ratio;
  }
}

/**
 * `floor(predecessorTokens * ratio)`.
 *
 * `floor`, so a budget is never rounded UP past the fraction the documents specify — the
 * cheap direction to be wrong in is the one that fails the handoff loudly rather than the
 * one that quietly grants a successor more context than the ratio allows.
 */
export function successorTokenBudget(
  predecessorTokens: number,
  ratio: number = SUCCESSOR_CONTEXT_RATIO,
): number {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new InvalidContextRatioError(ratio);
  return Math.floor(Math.max(0, predecessorTokens) * ratio);
}

const PORT_HEADING = "## Declared input ports";

function renderPorts(ports: readonly SuccessorPort[]): string {
  if (ports.length === 0) return `${PORT_HEADING}\n\n- (none declared)\n`;
  const lines = [PORT_HEADING, ""];
  // Sorted by key so the prompt is a function of the port SET, not of declaration order:
  // two runs binding the same ports must produce the same bytes, or the semantic cache
  // key derived from this prompt would miss for no reason.
  for (const port of [...ports].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    lines.push(`- ${port.key} (${port.schemaRef}): ${JSON.stringify(port.value)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the successor's entire starting context.
 *
 * The digest comes FIRST — the successor reads what the phase learned before it reads
 * what it was handed — then the node's own declared input ports. Nothing else exists to
 * include.
 *
 * Throws {@link SuccessorPromptTooLargeError} when the result does not fit
 * `predecessorTokens * ratio`. Throwing rather than truncating is deliberate: a truncated
 * digest is a digest with a section silently missing, which is the exact failure the
 * schema in `digest.ts` exists to prevent.
 */
export function assembleSuccessorPrompt(
  inputs: SuccessorContextInputs,
  estimator: TokenEstimator,
  options: AssembleOptions,
): AssembledPrompt {
  const budget = successorTokenBudget(
    options.predecessorTokens,
    options.ratio ?? SUCCESSOR_CONTEXT_RATIO,
  );
  const text = [
    `# Context for ${inputs.nodeId}`,
    "",
    "Read the phase digest below first. It is the only record of the preceding phase;",
    "the predecessor's transcript is not available and is not summarised here.",
    "",
    renderDigest(inputs.digest),
    renderPorts(inputs.ports),
  ].join("\n");

  const tokens = estimator.estimate(text);
  if (tokens > budget) {
    throw new SuccessorPromptTooLargeError(inputs.nodeId, tokens, budget, estimator.id);
  }

  return {
    text,
    tokens,
    budget,
    estimatorId: estimator.id,
    sourceMessageIds: Object.freeze([]),
  };
}

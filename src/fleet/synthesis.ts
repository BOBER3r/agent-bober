// ── fleet/synthesis.ts ────────────────────────────────────────────────
//
// SynthesisStep (CP3): PURE data assembly. After the rounds complete,
// bundle the final-round child results + ALL blackboard findings + the
// round count for the head/dynamic-workflow to synthesize.
//
// NO LLM call. NO network. NO provider/client construction.

import type { SharedBlackboard } from "./shared-blackboard.js";
import type { PortfolioReport } from "./reporter.js";
import type { FactRecord } from "../state/facts.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface SynthesisBundle {
  rounds: number;
  childResults: PortfolioReport; // the same report the reporter built
  findings: FactRecord[]; // blackboard.readAll() (all active 'finding' facts)
}

// ── collect ───────────────────────────────────────────────────────────

/**
 * Assemble a SynthesisBundle from the final-round child results, the round
 * count, and (if a blackboard was used) all of its findings.
 * PURE: no LLM, no network, no IO — just shapes existing data into JSON.
 * When blackboard is null, findings is [].
 */
export function collect(
  blackboard: SharedBlackboard | null,
  childResults: PortfolioReport,
  rounds: number,
): SynthesisBundle {
  return {
    rounds,
    childResults,
    findings: blackboard ? blackboard.readAll() : [],
  };
}

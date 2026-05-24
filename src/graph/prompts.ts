/**
 * AgentGraphPrompts — ADR-5.
 *
 * Per-role system-prompt fragments that teach agents when to prefer graph_* tools.
 * All fragments are static top-level const strings (no interpolation, no I/O).
 *
 * Invariants (ADR-5):
 * - RESEARCHER-PHASE2 fragment is a literal const with ZERO template interpolation.
 *   The snapshot test in tests/researcher-phase2-prompt-isolation.test.ts pins
 *   the exact bytes. Any edit forces an explicit snapshot update + reviewer ack.
 * - All fragments are <100 words and contain no feature/task/sprint references.
 * - 'disabled' mode returns "" for every role.
 * - decorate() is pure and synchronous — no I/O, no async.
 */

import type { BoberAgentRole } from "./preflight-injector.js";

// ── Types ──────────────────────────────────────────────────────────

export type AgentPromptMode = "gated" | "dual" | "disabled";

// ── Fragments (top-level const strings — see ADR-5) ───────────────

const RESEARCHER_PHASE2_GATED = "For codebase exploration use graph_search, graph_query, graph_review_context, and read_file. Bash, grep, and glob are unavailable for this role.";

const CURATOR_GATED = "You have graph_search, graph_query, graph_review_context. Use them for ALL exploration. read_file is only for reading specific known files. Prefer graph_query(pattern: \"callers_of\", target: <symbol>) over grep when looking for who calls a function.";

const ARCHITECT_GATED = "You have graph_search, graph_query, graph_review_context. Use them for ALL exploration. Prefer graph_query(pattern: \"imports_of\", target: <symbol>) to map module boundaries and graph_search for high-level structure discovery.";

const GENERATOR_DUAL = "You have BOTH grep and graph_* tools. Prefer graph_impact(target: <symbol>) before editing any function with callers. Use grep for line-precise edits and known-file inspection.";

const EVALUATOR_DUAL = "You have BOTH grep and graph_* tools. Prefer graph_changes(since: <baseline>) and graph_impact(target: <symbol>) to triage the diff. Use grep when you need a literal-string search across the working tree.";

// ── Lookup table ──────────────────────────────────────────────────

const FRAGMENTS: Record<BoberAgentRole, Partial<Record<AgentPromptMode, string>>> = {
  "planner": {},
  "researcher-phase1": {},
  "researcher-phase2": { gated: RESEARCHER_PHASE2_GATED },
  "curator": { gated: CURATOR_GATED },
  "architect": { gated: ARCHITECT_GATED },
  "generator": { dual: GENERATOR_DUAL },
  "evaluator": { dual: EVALUATOR_DUAL },
};

// ── Public API ────────────────────────────────────────────────────

export class AgentGraphPrompts {
  /**
   * Return the prompt fragment for a (role, mode) pair. Returns "" when no
   * fragment exists (e.g. planner, or 'disabled' mode). Callers MUST treat
   * the empty string as "no decoration".
   */
  static fragmentFor(role: BoberAgentRole, mode: AgentPromptMode): string {
    return FRAGMENTS[role]?.[mode] ?? "";
  }

  /**
   * Append the role's graph-prompt fragment to baseSystemPrompt.
   *
   * Returns baseSystemPrompt UNCHANGED when:
   *  - graph is not enabled, OR
   *  - engine health is not 'ready', OR
   *  - the fragment for (role, modeForRole(role)) is empty.
   *
   * Otherwise returns `baseSystemPrompt + "\n\n---\n\n" + fragment`.
   *
   * Gating predicate mirrors src/orchestrator/tools/index.ts:204-211 exactly
   * so the prompt surface and tool surface flip atomically.
   */
  static decorate(
    role: BoberAgentRole,
    baseSystemPrompt: string,
    ctx: { graphEnabled: boolean; engineHealth: string },
  ): string {
    if (!ctx.graphEnabled || ctx.engineHealth !== "ready") return baseSystemPrompt;
    const mode = modeForRole(role);
    const fragment = AgentGraphPrompts.fragmentFor(role, mode);
    if (fragment.length === 0) return baseSystemPrompt;
    return `${baseSystemPrompt}\n\n---\n\n${fragment}`;
  }
}

// ── Per-role mode selection ───────────────────────────────────────

function modeForRole(role: BoberAgentRole): AgentPromptMode {
  switch (role) {
    case "researcher-phase2":
    case "curator":
    case "architect":
      return "gated";
    case "generator":
    case "evaluator":
      return "dual";
    case "planner":
    case "researcher-phase1":
    default:
      return "disabled";
  }
}

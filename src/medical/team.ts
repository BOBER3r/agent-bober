/**
 * Medical team builder (Phase 6, Sprint 1).
 *
 * buildMedicalTeam returns the built-in 'medical' Team with pipelineShape
 * 'medical-sop' and a concrete (stub) GuardrailSet in the guardrails slot.
 * Real GuardrailSet.evaluate logic lands in S3.
 */
import type { BoberConfig } from "../config/schema.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import type { Role, Team } from "../teams/types.js";
import type { GuardrailContext, GuardrailSet, GuardrailVerdict } from "./types.js";

// ── Role descriptors ────────────────────────────────────────────────

/**
 * The 7 role descriptors reused for the medical team.
 * Mirrors DEFAULT_ROLES in registry.ts — kept separate to avoid a circular
 * import (registry.ts → medical/team.ts → registry.ts).
 * bober: inline copy; if roles diverge between teams, extract to a shared module.
 */
const MEDICAL_ROLES: Role[] = [
  { name: "planner",    displayName: "Planner" },
  { name: "researcher", displayName: "Researcher" },
  { name: "chat",       displayName: "Chat" },
  { name: "curator",    displayName: "Curator" },
  { name: "generator",  displayName: "Generator" },
  { name: "evaluator",  displayName: "Evaluator" },
  { name: "codeReview", displayName: "Code Reviewer" },
];

// ── Built-in medical guardrails (stub allow-all; real logic S3) ─────

const MEDICAL_RULESET_VERSION = "0.0.0";

/**
 * Builds a stub GuardrailSet that allows all prompts.
 * Real evaluate logic (red-flag detection, refusals, canned responses) lands in S3.
 * bober: stub allow-all; swap for real ruleset in S3 when red-flag detection is implemented.
 */
function buildMedicalGuardrails(): GuardrailSet {
  return {
    rulesetVersion: MEDICAL_RULESET_VERSION,
    evaluate(_prompt: string, _ctx: GuardrailContext): GuardrailVerdict {
      return { kind: "allow" };
    },
  };
}

// ── buildMedicalTeam ────────────────────────────────────────────────

/**
 * Builds the built-in 'medical' Team.
 * Registered in loadTeam (registry.ts) before the config.teams lookup.
 */
export function buildMedicalTeam(config: BoberConfig): Team {
  return {
    id: "medical",
    displayName: "Medical team",
    memoryNamespace: "medical",
    providers: resolveRoleProviders(config),
    pipelineShape: "medical-sop",
    roles: MEDICAL_ROLES,
    guardrails: buildMedicalGuardrails(),
  };
}

/**
 * Team registry + resolver (Phase 4, Sprint 1).
 *
 * loadTeam(config, teamId?) returns a resolved Team. With no id (or 'programming')
 * it returns the built-in programming team, reproducing today's provider routing
 * (resolveRoleProviders), engine (resolveEngineName), and memory path (sentinel '').
 */
import type { BoberConfig } from "../config/schema.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import type { RoleName } from "../config/role-providers.js";
import { resolveEngineName } from "../orchestrator/workflow/selector.js";
import { buildMedicalTeam } from "../medical/team.js";
import type { Role, Team } from "./types.js";

// ── Role descriptors ─────────────────────────────────────────────────

/** The 7 RoleName values as descriptors. Order mirrors ALL_ROLES (role-providers.ts:38). */
const DEFAULT_ROLES: Role[] = [
  { name: "planner",    displayName: "Planner" },
  { name: "researcher", displayName: "Researcher" },
  { name: "chat",       displayName: "Chat" },
  { name: "curator",    displayName: "Curator" },
  { name: "generator",  displayName: "Generator" },
  { name: "evaluator",  displayName: "Evaluator" },
  { name: "codeReview", displayName: "Code Reviewer" },
];

// ── Resolver ─────────────────────────────────────────────────────────

/**
 * Resolve a Team from config. With no id (or id === 'programming') returns the
 * built-in programming team. A config-declared team is built from its entry with
 * partial provider overrides merged over the resolved defaults. An unknown id throws.
 */
export function loadTeam(config: BoberConfig, teamId?: string): Team {
  // Built-in default path: no id or 'programming' -> programming team
  if (teamId === undefined || teamId === "programming") {
    return buildProgrammingTeam(config);
  }

  // Built-in medical team
  if (teamId === "medical") {
    return buildMedicalTeam(config);
  }

  // Built-in hub team (data): default pipeline, dedicated 'hub' memory namespace.
  if (teamId === "hub") {
    return {
      id: "hub",
      displayName: "Priority hub",
      memoryNamespace: "hub",
      providers: resolveRoleProviders(config),
      pipelineShape: resolveEngineName(config),
      roles: DEFAULT_ROLES,
      guardrails: undefined,
    };
  }

  const entry = config.teams?.[teamId];
  if (!entry) {
    throw new Error(
      `Unknown team '${teamId}'. Declare it under config.teams or use the built-in 'programming' team.`,
    );
  }

  const resolvedDefaults = resolveRoleProviders(config);
  return {
    id: teamId,
    displayName: entry.displayName ?? teamId,
    memoryNamespace: entry.memoryNamespace ?? teamId,
    // partial override: unspecified roles keep the resolved default
    providers: { ...resolvedDefaults, ...(entry.providers ?? {}) } as Record<RoleName, string>,
    pipelineShape: entry.pipelineShape ?? resolveEngineName(config),
    roles: DEFAULT_ROLES,
    guardrails: entry.guardrails,
  };
}

// ── Built-in teams ───────────────────────────────────────────────────

function buildProgrammingTeam(config: BoberConfig): Team {
  return {
    id: "programming",
    displayName: "Programming team",
    memoryNamespace: "", // bober: sentinel for current .bober/memory/ path; Sprint 2 maps '' -> that path
    providers: resolveRoleProviders(config),
    pipelineShape: resolveEngineName(config),
    roles: DEFAULT_ROLES,
    guardrails: undefined,
  };
}

/**
 * Team data model for the domain-agnostic team abstraction (Phase 4).
 *
 * Sprint 1: pure data types only. A Team is the resolved shape the pipeline
 * needs; loadTeam (registry.ts) builds it from a BoberConfig. No execution
 * logic lives here.
 */
import type { RoleName, RoleProviderMap } from "../config/role-providers.js";
import type { PipelineEngineName } from "../orchestrator/workflow/engine.js";

// ── Role descriptor ──────────────────────────────────────────────────

/** Descriptor metadata for one of the 7 RoleName values. Does NOT drive execution this sprint. */
export interface Role {
  name: RoleName;
  displayName: string;
}

// ── Team ─────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  displayName: string;
  /** Sentinel ('' for the built-in programming team) that Sprint 2 maps to .bober/memory/. */
  memoryNamespace: string;
  providers: RoleProviderMap;
  pipelineShape: PipelineEngineName;
  roles: Role[];
  guardrails?: unknown;
}

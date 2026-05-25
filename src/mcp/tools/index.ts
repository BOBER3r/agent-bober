// ── Tool Registration ───────────────────────────────────────────────
//
// This file is the central place where all MCP tools are registered.
// Import each tool module's register function here and call it once.

import { registerInitTool } from "./init.js";
import { registerPlanTool } from "./plan.js";
import { registerSprintTool } from "./sprint.js";
import { registerEvalTool } from "./eval.js";
import { registerRunTool } from "./run.js";
import { registerStatusTool } from "./status.js";
import { registerContractsTool } from "./contracts.js";
import { registerSpecTool } from "./spec.js";
import { registerPrinciplesTool } from "./principles.js";
import { registerConfigTool } from "./config.js";
import { registerArchitectTool } from "./architect.js";
import { registerResearchTool } from "./research.js";
import { registerBrownfieldTool } from "./brownfield.js";
import { registerReactTool } from "./react.js";
import { registerSolidityTool } from "./solidity.js";
import { registerAnchorTool } from "./anchor.js";
import { registerPlaywrightTool } from "./playwright.js";
import { registerListActiveRunsTool } from "./list-active-runs.js";
import { registerGetRunStatusTool } from "./get-run-status.js";
import { registerAbortRunTool } from "./abort-run.js";
import { registerSubscribeEventsTool } from "./subscribe-events.js";
import { registerUnsubscribeEventsTool } from "./unsubscribe-events.js";
import { registerRunInWorktreeTool } from "./run-in-worktree.js";
import { registerListPendingApprovalsTool } from "./list-pending-approvals.js";
import { registerApproveCheckpointTool } from "./approve-checkpoint.js";
import { registerRejectCheckpointTool } from "./reject-checkpoint.js";
import { registerListProjectsTool } from "./list-projects.js";
import { registerListSpecsTool } from "./list-specs.js";
import { registerGetProjectStateTool } from "./get-project-state.js";
import { registerIncidentTools } from "./incident.js";
import { registerRollbackTool } from "./rollback.js";
import { registerPostmortemTool } from "./postmortem.js";
import { registerPlaybookTools } from "./playbook.js";

/**
 * Registers all built-in agent-bober MCP tools into the global registry.
 * Call this once before starting the MCP server.
 *
 * Registered tools (37 total):
 *   1. bober_init                   – Initialise a project
 *   2. bober_plan                   – Generate a sprint plan
 *   3. bober_sprint                 – Execute the next sprint cycle
 *   4. bober_eval                   – Evaluate a sprint
 *   5. bober_run                    – Start the full pipeline asynchronously
 *   6. bober_status                 – Poll pipeline status
 *   7. bober_contracts              – List/read sprint contracts
 *   8. bober_spec                   – Read the latest plan spec
 *   9. bober_principles             – Read/write .bober/principles.md
 *  10. bober_config                 – Read/update bober.config.json
 *  11. bober_architect              – Solution architecture (5-checkpoint flow + ADRs)
 *  12. bober_research               – Two-phase codebase research (fact-only)
 *  13. bober_brownfield             – Brownfield pipeline (existing codebase)
 *  14. bober_react                  – React web application pipeline
 *  15. bober_solidity               – EVM smart contract pipeline
 *  16. bober_anchor                 – Solana program pipeline (Anchor)
 *  17. bober_playwright             – Playwright E2E setup and runner
 *  18. bober_list_active_runs       – List all runs by status
 *  19. bober_get_run_status         – Get one run by runId
 *  20. bober_abort_run              – Abort a run by runId
 *  21. bober_subscribe_events       – Subscribe to runId-scoped event notifications
 *  22. bober_unsubscribe_events     – Unsubscribe from a runId-scoped event stream
 *  23. bober_run_in_worktree        – Start the pipeline in an isolated git worktree
 *  24. bober_list_pending_approvals – List pending careful-flow checkpoints
 *  25. bober_approve_checkpoint     – Approve a pending checkpoint (writes .approved.json)
 *  26. bober_reject_checkpoint      – Reject a pending checkpoint with feedback
 *  27. bober_list_projects          – Enumerate projects under one or more search roots
 *  28. bober_list_specs             – List PlanSpecs in a project
 *  29. bober_get_project_state      – Aggregate per-project counts for the cockpit sidebar
 *  30. bober_incident_start         – Create a new incident from a symptom
 *  31. bober_incident_status        – Read the current status of an incident
 *  32. bober_incident_list          – List all incidents sorted by createdAt descending
 *  33. bober_incident_abort         – Abort an incident at any phase (terminal)
 *  34. bober_rollback_start         – Plan and execute rollback for an incident
 *  35. bober_postmortem_get         – Read incident postmortem.md and return parsed content
 *  36. bober_playbook_list          – List all playbooks from .bober/playbooks/
 *  37. bober_playbook_search        – Search playbooks matching a symptom
 */
export function registerAllTools(): void {
  // ── Core workflow tools ─────────────────────────────────────────
  registerInitTool();
  registerPlanTool();
  registerSprintTool();
  registerEvalTool();
  registerArchitectTool();
  registerResearchTool();

  // ── Async pipeline tools ────────────────────────────────────────
  registerRunTool();
  registerRunInWorktreeTool();
  registerBrownfieldTool();
  registerReactTool();
  registerSolidityTool();
  registerAnchorTool();
  registerStatusTool();

  // ── Utility tools ──────────────────────────────────────────────
  registerPlaywrightTool();

  // ── Multi-run management tools ─────────────────────────────────
  registerListActiveRunsTool();
  registerGetRunStatusTool();
  registerAbortRunTool();

  // ── Event stream tools (cockpit-integration sprint 3) ──────────
  registerSubscribeEventsTool();
  registerUnsubscribeEventsTool();

  // ── Cockpit careful-flow + discovery tools (cockpit-integration sprint 5) ──
  registerListPendingApprovalsTool();
  registerApproveCheckpointTool();
  registerRejectCheckpointTool();
  registerListProjectsTool();
  registerListSpecsTool();
  registerGetProjectStateTool();

  // ── Vision-era incident/rollback/postmortem/playbook (cockpit-integration sprint 6) ──
  registerIncidentTools();
  registerRollbackTool();
  registerPostmortemTool();
  registerPlaybookTools();

  // ── Read / configuration tools ──────────────────────────────────
  registerContractsTool();
  registerSpecTool();
  registerPrinciplesTool();
  registerConfigTool();
}

export { registerTool, getAllTools, getTool } from "./registry.js";
export type {
  BoberToolDefinition,
  JsonSchemaObject,
  JsonSchemaProperty,
} from "./registry.js";

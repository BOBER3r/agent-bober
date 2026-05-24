import type { ToolDef } from "../../providers/types.js";

import { TOOL_SCHEMAS } from "./schemas.js";
import { createToolHandlers } from "./handlers.js";
import type { ToolHandler } from "./handlers.js";
import type { GraphClient } from "../../graph/client.js";
import type { GraphFallback } from "../../graph/fallback.js";
import { createGraphTools } from "../../mcp/tools/graph.js";
import type { BoberToolDefinition } from "../../mcp/tools/registry.js";
import { graphPipelineLifecycle } from "../../graph/pipeline-lifecycle.js";
import { logger } from "../../utils/logger.js";
import type { BoberConfig } from "../../config/schema.js";

export type { ToolHandler } from "./handlers.js";

// ── Types ──────────────────────────────────────────────────────────

/**
 * All agent roles understood by the orchestrator.
 * The original 3 roles (planner, generator, evaluator) are preserved for backcompat.
 * The 5 extended roles are used by sprint 5 GraphToolGate.
 */
export type AgentRole =
  | "planner"
  | "researcher-phase1"
  | "researcher-phase2"
  | "curator"
  | "architect"
  | "generator"
  | "evaluator";

export interface ToolSet {
  /** Tool schemas to pass to the LLM client. Provider-agnostic ToolDef format. */
  schemas: ToolDef[];
  /** Handler functions keyed by tool name. */
  handlers: Map<string, ToolHandler>;
}

/**
 * Graph-gating context snapshot for resolveRoleTools.
 * Produced by getGraphState() — all deps are passed in (pure function).
 */
export interface GraphState {
  graphEnabled: boolean;
  engineHealth: "ready" | "starting" | "restarting" | "broken" | "disabled";
}

// ── Role → tool mapping ────────────────────────────────────────────

/**
 * Static baseline tool-name map for each agent role.
 *
 * @deprecated Use `resolveRoleTools(role, projectRoot, ctx, graphDeps?)` for
 *   new code. This map is kept as a backcompat export (0.12.0 surface).
 *   Its three original entries (planner / generator / evaluator) MUST NOT be
 *   modified — external consumers depend on the exact array contents.
 *   The 4 new entries (researcher-phase1, researcher-phase2, curator, architect)
 *   reflect the ungated (graph-disabled) tool surface for those roles.
 */
export const ROLE_TOOLS: Record<AgentRole, string[]> = {
  planner: ["read_file", "glob", "grep"],
  "researcher-phase1": ["read_file", "glob", "grep"],
  "researcher-phase2": ["read_file", "glob", "grep"],
  curator: ["read_file", "glob", "grep"],
  architect: ["bash", "read_file", "write_file", "edit_file", "glob", "grep"],
  generator: ["bash", "read_file", "write_file", "edit_file", "glob", "grep"],
  evaluator: ["bash", "read_file", "glob", "grep"],
};

// ── Builder ────────────────────────────────────────────────────────

/**
 * Build a tool set for a specific agent role.
 *
 * Returns only the tools appropriate for that role:
 * - **planner**: read_file, glob, grep (read-only, no execution)
 * - **generator**: all 6 tools (full filesystem + bash access)
 * - **evaluator**: bash, read_file, glob, grep (can run commands, cannot write/edit files)
 *
 * @deprecated Prefer `resolveRoleTools(role, projectRoot, ctx, graphDeps?)` for new
 *   call sites — it supports graph-gated tool selection (ADR-8). `buildToolSet`
 *   is kept for backcompat and always returns the ungated (static) tool set.
 */
export function buildToolSet(
  role: AgentRole,
  projectRoot: string,
): ToolSet {
  const toolNames = ROLE_TOOLS[role];
  const allHandlers = createToolHandlers(projectRoot);

  const schemas: ToolDef[] = [];
  const handlers = new Map<string, ToolHandler>();

  for (const name of toolNames) {
    const schema = TOOL_SCHEMAS[name];
    const handler = allHandlers.get(name);

    if (schema && handler) {
      schemas.push(schema);
      handlers.set(name, handler);
    }
  }

  return { schemas, handlers };
}

// ── Graph tool helper (used by GraphToolGate — ADR-8) ─────────────

/**
 * Returns the 6 graph_* tool definitions for use by the internal
 * orchestrator. DRY: consumes the same factory as the external MCP server.
 */
export function getGraphInternalTools(
  client: GraphClient,
  fallback: GraphFallback,
): BoberToolDefinition[] {
  return createGraphTools({ client, fallback });
}

// ── GraphState snapshot helper ────────────────────────────────────

/**
 * Snapshot the current graph-pipeline state for tool-surface gating.
 *
 * Safe to call before `graphPipelineLifecycle.start()` — returns
 * `{graphEnabled: false, engineHealth: 'disabled'}` in that case.
 *
 * @param config  Optional bober configuration. When absent, graphEnabled=false.
 */
export function getGraphState(config?: BoberConfig): GraphState {
  const graphEnabled = config?.graph?.enabled === true;
  const rawHealth = graphPipelineLifecycle.engineHealth();
  const validHealth: GraphState["engineHealth"] =
    rawHealth === "ready" ||
    rawHealth === "starting" ||
    rawHealth === "restarting" ||
    rawHealth === "broken" ||
    rawHealth === "disabled"
      ? (rawHealth as GraphState["engineHealth"])
      : "disabled";
  return { graphEnabled, engineHealth: validHealth };
}

/**
 * Return the graph client + fallback when the engine is 'ready', otherwise null.
 * Convenience wrapper over graphPipelineLifecycle.getGraphDeps().
 */
export function getGraphDeps(): { client: GraphClient; fallback: GraphFallback } | null {
  return graphPipelineLifecycle.getGraphDeps();
}

// ── resolveRoleTools ──────────────────────────────────────────────

/**
 * Build the runtime tool set for a given agent role.
 *
 * When `ctx.graphEnabled === true` AND `ctx.engineHealth === 'ready'`,
 * applies ADR-8 gating:
 *   - Roles `researcher-phase2`, `curator`, `architect`: removes bash/grep/glob,
 *     adds the 6 graph_* tools (read_file is retained).
 *   - Roles `generator`, `evaluator`: UNION — keeps all original tools AND adds
 *     the 6 graph_* tools (agent chooses which to use).
 *
 * All other conditions return the unchanged static ROLE_TOOLS set (zero
 * behavior change from 0.12.0).
 *
 * @param role         Agent role string.
 * @param projectRoot  Absolute project root for filesystem-tool sandboxing.
 * @param ctx          Graph-gating context from getGraphState(). When absent,
 *                     defaults to ungated (defensive).
 * @param graphDeps    Required only when ctx triggers gating: { client, fallback }.
 *                     If omitted while gated, falls back to ungated (defensive).
 * @returns A ToolSet with schemas + handlers.
 * @throws If role is not in ROLE_TOOLS (unknown role).
 */
export function resolveRoleTools(
  role: AgentRole,
  projectRoot: string,
  ctx?: { graphEnabled: boolean; engineHealth?: string },
  graphDeps?: { client: GraphClient; fallback: GraphFallback },
): ToolSet {
  // 1. Validate role — throw a clear, listable error for unknown roles.
  const staticToolNames = ROLE_TOOLS[role];
  if (!staticToolNames) {
    throw new Error(
      `resolveRoleTools: unknown agent role "${role}". ` +
        `Known roles: ${Object.keys(ROLE_TOOLS).join(", ")}.`,
    );
  }

  // 2. Build the ungated base ToolSet using the same resolution pattern as buildToolSet.
  const allFsHandlers = createToolHandlers(projectRoot);
  const baseSchemas: ToolDef[] = [];
  const baseHandlers = new Map<string, ToolHandler>();
  for (const name of staticToolNames) {
    const schema = TOOL_SCHEMAS[name];
    const handler = allFsHandlers.get(name);
    if (schema && handler) {
      baseSchemas.push(schema);
      baseHandlers.set(name, handler);
    }
  }

  // 3. Determine if gating applies. Treat undefined engineHealth as 'disabled'.
  const engineHealth = ctx?.engineHealth ?? "disabled";
  const gated = ctx?.graphEnabled === true && engineHealth === "ready";

  // 4. Not gated → return base set unchanged (zero behavior change from 0.12.0).
  if (!gated) {
    return { schemas: baseSchemas, handlers: baseHandlers };
  }

  // 5. Defensive: gating triggered but graphDeps missing → fall back to ungated.
  if (!graphDeps) {
    logger.warn(
      `resolveRoleTools(${role}): gated but graphDeps not supplied — falling back to ungated set.`,
    );
    return { schemas: baseSchemas, handlers: baseHandlers };
  }

  // 6. Adapt the 6 graph_* tools (BoberToolDefinition[] → ToolDef + ToolHandler).
  const graphBobTools = getGraphInternalTools(graphDeps.client, graphDeps.fallback);
  const graphSchemas: ToolDef[] = graphBobTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as ToolDef["input_schema"],
  }));
  const graphHandlerMap = new Map<string, ToolHandler>(
    graphBobTools.map((t) => [
      t.name,
      async (input: Record<string, unknown>) => {
        try {
          const output = await t.handler(input);
          return { output, isError: false };
        } catch (err) {
          return {
            output: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
      },
    ]),
  );

  // 7. Per-role compose strategy.
  const REMOVE_FOR_GATED = new Set(["bash", "grep", "glob"]);
  const gatedRemovalRoles = new Set<AgentRole>([
    "researcher-phase2",
    "curator",
    "architect",
  ]);

  let outSchemas: ToolDef[];
  let outHandlers: Map<string, ToolHandler>;

  if (gatedRemovalRoles.has(role)) {
    // Remove bash/grep/glob; keep the rest (read_file, write_file, edit_file retained).
    outSchemas = baseSchemas.filter((s) => !REMOVE_FOR_GATED.has(s.name));
    outHandlers = new Map(
      [...baseHandlers.entries()].filter(([n]) => !REMOVE_FOR_GATED.has(n)),
    );
  } else {
    // generator / evaluator → UNION; keep ALL original tools.
    outSchemas = [...baseSchemas];
    outHandlers = new Map(baseHandlers);
  }

  // 8. Append graph tools, deduping by name.
  for (const gs of graphSchemas) {
    if (!outHandlers.has(gs.name)) outSchemas.push(gs);
  }
  for (const [n, h] of graphHandlerMap) {
    if (!outHandlers.has(n)) outHandlers.set(n, h);
  }

  return { schemas: outSchemas, handlers: outHandlers };
}

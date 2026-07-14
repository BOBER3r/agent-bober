/**
 * In-process scoped subagents (agent-loop-capability-port sprint 10).
 *
 * Builds the `spawn_subagent` ToolDef + handler for `AgenticLoopParams.subagents`.
 * The handler resolves a configured `SubagentDef` by name and runs it as a
 * NESTED `runAgenticLoop` call with a fresh message history, a scoped tool
 * subset, optional per-agent model/effort/maxTurns overrides, and the SAME
 * parent `Budget` instance — combined spend stays visible and a child can
 * never out-spend a parent ceiling. Only the child's `finalText` returns to
 * the parent (as this tool's result); the parent's own context grows by that
 * summary alone.
 *
 * One-level hard cap (nonGoal #1): the child ALWAYS gets `subagents: undefined`
 * — recursive subagent nesting is not supported.
 *
 * Import-cycle note: this module imports the loop's TYPES only
 * (`AgenticLoopParams`/`AgenticLoopResult`), never the `runAgenticLoop`
 * VALUE. The loop passes its own (hoisted) function reference in via
 * `BuildSubagentOpts.runLoop`, keeping runtime dependencies one-directional
 * (agentic-loop.ts -> subagents.ts, never the reverse).
 */

import type { LLMClient, ToolDef } from "../providers/types.js";
import type { ToolHandler } from "./tools/index.js";
import type { AgenticLoopParams, AgenticLoopResult } from "./agentic-loop.js";
import { resolveModel } from "./model-resolver.js";
import { createClient } from "../providers/factory.js";

// ── Types ──────────────────────────────────────────────────────────

/** A programmatically-declared subagent a parent loop can delegate a bounded subtask to. */
export interface SubagentDef {
  name: string;
  description: string;
  systemPrompt: string;
  /** Subset of the PARENT's tool NAMES this subagent may use. */
  tools: string[];
  /** Model shorthand override (e.g. "sonnet", "haiku"). Absent => inherit the parent's client/model. */
  model?: string;
  effort?: AgenticLoopParams["effort"];
  /** Max nested-loop turns. Defaults to 10 when omitted. */
  maxTurns?: number;
}

export interface BuildSubagentOpts {
  /**
   * REQUIRED to break the subagents.ts <-> agentic-loop.ts import cycle — the
   * loop passes its own `runAgenticLoop` function reference; tests pass a fake.
   */
  runLoop: (params: AgenticLoopParams) => Promise<AgenticLoopResult>;
  /**
   * Injected for tests so `def.model` needs no real provider/API key.
   * Defaults to the real `createClient` factory (provider inferred from the
   * model shorthand — mirrors how role entry points build their own clients).
   */
  clientFactory?: (model: string) => LLMClient;
}

const DEFAULT_MAX_TURNS = 10;

function defaultClientFactory(model: string): LLMClient {
  return createClient(undefined, undefined, undefined, model);
}

// ── Result -> tool-result mapping ────────────────────────────────────

/**
 * Map a completed child run to the parent's tool-result shape. A child
 * refusal/budget/error/abort surfaces as an `isError` result naming the
 * stopReason — never a throw (sc-10-3); the parent loop continues and decides.
 */
function toToolResult(
  name: string,
  result: AgenticLoopResult,
): { output: string; isError: boolean } {
  if (result.refused === true || result.stopReason === "refusal") {
    return { output: `Subagent '${name}' refused: ${result.finalText}`, isError: true };
  }
  if (result.stopReason === "budget_exceeded") {
    return {
      output: `Subagent '${name}' stopped: budget_exceeded. ${result.finalText}`,
      isError: true,
    };
  }
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    return {
      output: `Subagent '${name}' ${result.stopReason}: ${result.finalText}`,
      isError: true,
    };
  }
  return { output: result.finalText, isError: false };
}

// ── Builder ────────────────────────────────────────────────────────

/**
 * Build the `spawn_subagent` ToolDef + handler for a parent loop's
 * `AgenticLoopParams.subagents`. `runAgenticLoop` registers the returned tool
 * BEFORE its own loop starts (when `params.subagents?.length`); the handler
 * resolves the requested subagent by name and runs it as a fresh, scoped,
 * budget-shared nested loop.
 */
export function buildSubagentTool(
  defs: SubagentDef[],
  parentParams: AgenticLoopParams,
  opts: BuildSubagentOpts,
): { tool: ToolDef; handler: ToolHandler } {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const validNames = defs.map((d) => d.name).join(", ");
  const clientFactory = opts.clientFactory ?? defaultClientFactory;

  const tool: ToolDef = {
    name: "spawn_subagent",
    // NOT readOnly — a subagent may itself use write-capable tools; unknown
    // side effects stay serial (ADR-2, mirrors nonGoal #3 for mcp__ tools).
    description:
      "Delegate a bounded subtask to a fresh-context subagent. Pass the " +
      "configured subagent `name` and the `task` text. The subagent runs " +
      "with only its own scoped tools and returns a summary as this tool's " +
      `result. Valid names: ${validNames}.`,
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: `Configured subagent to run. Valid names: ${validNames}.`,
        },
        task: {
          type: "string",
          description: "The task/instruction passed as the subagent's user message.",
        },
      },
      required: ["name", "task"],
    },
  };

  const handler: ToolHandler = async (input: Record<string, unknown>) => {
    const name = typeof input["name"] === "string" ? input["name"] : "";
    const task = typeof input["task"] === "string" ? input["task"] : "";

    const def = byName.get(name);
    if (!def) {
      return {
        output: `Unknown subagent '${name}'. Valid names: ${validNames}.`,
        isError: true,
      };
    }

    // Scoped subset — child sees ONLY these tools/handlers (sc-10-1).
    const scopedToolNames = new Set(def.tools);
    const childTools = parentParams.tools.filter((t) => scopedToolNames.has(t.name));
    const childHandlers = new Map(
      [...parentParams.toolHandlers].filter(([n]) => scopedToolNames.has(n)),
    );

    const childClient = def.model ? clientFactory(def.model) : parentParams.client;
    const childModel = def.model ? resolveModel(def.model) : parentParams.model;

    const childParams: AgenticLoopParams = {
      client: childClient,
      model: childModel,
      systemPrompt: def.systemPrompt,
      userMessage: task,
      tools: childTools,
      toolHandlers: childHandlers,
      maxTurns: def.maxTurns ?? DEFAULT_MAX_TURNS,
      ...(def.effort !== undefined ? { effort: def.effort } : {}),
      // SAME Budget instance — combined spend visible; a child cannot
      // out-spend a parent ceiling (sc-10-2).
      ...(parentParams.budget !== undefined ? { budget: parentParams.budget } : {}),
      ...(parentParams.parallelReadOnlyTools !== undefined
        ? { parallelReadOnlyTools: parentParams.parallelReadOnlyTools }
        : {}),
      ...(parentParams.abortSignal !== undefined ? { abortSignal: parentParams.abortSignal } : {}),
      ...(parentParams.maxTokens !== undefined ? { maxTokens: parentParams.maxTokens } : {}),
      // One-level hard cap (nonGoal #1) — the child NEVER gets its own subagents.
      subagents: undefined,
      // Deliberately EXCLUDED: session, compaction, onEvent, hooks, onTextDelta,
      // initialMessages, onToolUse/onTurnComplete/completionCheck/maxNudges/
      // nudgeMessage. The child is a fresh, opaque, ephemeral run — passing any
      // of these would corrupt the parent's session file, event stream, or
      // streamed text (see the sprint 10 briefing §4b for the per-field
      // rationale).
    };

    try {
      const result = await opts.runLoop(childParams);
      return toToolResult(def.name, result);
    } catch (err) {
      // Handlers must never throw (sc-10-3). runAgenticLoop itself never
      // throws, but this guards defensively against a misbehaving injected
      // `runLoop` (e.g. a test double).
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Subagent '${def.name}' error: ${message}`, isError: true };
    }
  };

  return { tool, handler };
}

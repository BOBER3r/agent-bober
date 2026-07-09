import type { ToolCall, ToolResult } from "../../providers/types.js";
import type { ToolHandler } from "./handlers.js";
import type { HookDecision } from "../loop-events.js";
import { logger } from "../../utils/logger.js";

/**
 * Delegating tool-call executor (ADR-2, agent-loop-capability-port sprint 4).
 *
 * Ports the agentic loop's per-tool serial block into a standalone function so
 * contiguous runs of read-only-annotated tool calls can run concurrently while
 * everything else (writes, unmarked tools, or `parallel: false`) stays strictly
 * sequential. Classification travels with `ToolDef.readOnly` — this module
 * never hard-codes a tool-name allow-list; the caller derives `readOnlyTools`
 * from the tool schemas it was configured with.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ToolBatch {
  /** Tool calls requested by the model this turn, in original order. */
  toolCalls: ToolCall[];
  /** Handler functions for each tool, keyed by name. */
  toolHandlers: Map<string, ToolHandler>;
  /** Names of tools annotated `readOnly: true` (derived once by the caller from `params.tools`). */
  readOnlyTools: Set<string>;
  /**
   * When `false` (or omitted), every call runs strictly serially — byte-identical
   * to the pre-change for-await loop, regardless of any `readOnly` annotation.
   */
  parallel: boolean;
  /** Called when a tool is dispatched (for logging/progress). Fires for every call, including unknown tools, before the handler lookup. */
  onToolUse?: (name: string, input: unknown) => void;
  /**
   * Dispatch-time observability event (agent-loop-capability-port sprint 5).
   * Fires synchronously, BEFORE any await — same timing guarantee as
   * `onToolUse` — so dispatch order is unaffected whether this is set or not.
   */
  onToolStart?: (call: ToolCall) => void;
  /**
   * Settle-time observability event, fired after a result (allowed, denied,
   * or errored) is built, for every call.
   */
  onToolEnd?: (call: ToolCall, result: ToolResult) => void;
  /**
   * Host-side veto gate. Evaluated BEFORE the handler runs; a `{allow:false}`
   * decision skips the handler and produces an `isError` rejection result
   * instead. Always resolves to a decision — the caller (the loop) already
   * wraps a throwing hook into a fail-closed deny before passing it in here,
   * so the executor never needs its own try/catch around this call.
   */
  preToolUse?: (call: ToolCall) => Promise<HookDecision>;
  /**
   * Observes the result after execution (allowed, denied, or errored). The
   * caller (the loop) already wraps a throwing hook in try/catch before
   * passing it in here, so the executor never needs its own try/catch
   * around this call either.
   */
  postToolUse?: (call: ToolCall, result: ToolResult) => void | Promise<void>;
}

/** The subset of `ToolBatch` that carries sprint-5's per-call hook callbacks. */
type ToolExecHooks = Pick<ToolBatch, "onToolStart" | "onToolEnd" | "preToolUse" | "postToolUse">;

// ── Single tool-call execution ───────────────────────────────────────

/**
 * Execute a single tool call, mirroring the three exact result shapes the
 * pre-change serial loop produced (unknown-tool / success / thrown-handler),
 * plus a fourth (veto-rejection) shape introduced in sprint 5. Never throws
 * — every failure/veto path returns an `isError: true` ToolResult.
 */
async function executeOne(
  toolCall: ToolCall,
  toolHandlers: Map<string, ToolHandler>,
  onToolUse?: (name: string, input: unknown) => void,
  execHooks?: ToolExecHooks,
): Promise<ToolResult> {
  const toolName = toolCall.name;
  const toolInput = toolCall.input;

  onToolUse?.(toolName, toolInput);
  execHooks?.onToolStart?.(toolCall);

  /** Fire the settle-time observers, then return the result as-is. */
  const finalize = async (result: ToolResult): Promise<ToolResult> => {
    execHooks?.onToolEnd?.(toolCall, result);
    await execHooks?.postToolUse?.(toolCall, result);
    return result;
  };

  if (execHooks?.preToolUse) {
    const decision = await execHooks.preToolUse(toolCall);
    if (!decision.allow) {
      const reason = decision.reason ?? "no reason given";
      logger.warn(`Tool call to "${toolName}" was denied by policy: ${reason}`);
      return finalize({
        toolUseId: toolCall.id,
        content: `Error: Tool call to "${toolName}" was denied by policy: ${reason}`,
        isError: true,
      });
    }
  }

  const handler = toolHandlers.get(toolName);
  if (!handler) {
    logger.warn(`Unknown tool requested: "${toolName}"`);
    return finalize({
      toolUseId: toolCall.id,
      content: `Error: Unknown tool "${toolName}". Available tools: ${[...toolHandlers.keys()].join(", ")}`,
      isError: true,
    });
  }

  try {
    const result = await handler(toolInput);
    return finalize({
      toolUseId: toolCall.id,
      content: result.output,
      isError: result.isError,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Tool "${toolName}" threw: ${message}`);
    return finalize({
      toolUseId: toolCall.id,
      content: `Error: Tool execution failed: ${message}`,
      isError: true,
    });
  }
}

// ── Batch execution ───────────────────────────────────────────────────

/**
 * Execute a turn's tool calls, delegating maximal contiguous runs of
 * read-only-annotated calls to `Promise.all` while everything else runs
 * strictly one-at-a-time (identical to the old for-await loop).
 *
 * - Results are assembled by original array position, so the returned
 *   `ToolResult[]` always matches `toolCalls` order — even when a run
 *   executed concurrently and resolved out of order.
 * - Never rejects: `executeOne` catches every failure into an in-slot
 *   `isError` ToolResult, so a thrown handler or unknown tool never
 *   propagates past its own slot.
 */
export async function executeToolBatch(batch: ToolBatch): Promise<ToolResult[]> {
  const {
    toolCalls,
    toolHandlers,
    readOnlyTools,
    parallel,
    onToolUse,
    onToolStart,
    onToolEnd,
    preToolUse,
    postToolUse,
  } = batch;
  const execHooks: ToolExecHooks = { onToolStart, onToolEnd, preToolUse, postToolUse };
  const results: ToolResult[] = new Array(toolCalls.length);

  let i = 0;
  while (i < toolCalls.length) {
    const isEligible = (idx: number): boolean =>
      parallel && readOnlyTools.has(toolCalls[idx].name);

    if (!isEligible(i)) {
      // Not eligible for concurrency (flag off, or an unmarked/write tool) —
      // execute exactly one call, in place, before moving on.
      results[i] = await executeOne(toolCalls[i], toolHandlers, onToolUse, execHooks);
      i += 1;
      continue;
    }

    // Collect the maximal contiguous run of eligible (read-only) calls.
    let j = i;
    while (j < toolCalls.length && isEligible(j)) {
      j += 1;
    }

    // Dispatch every call in the run — onToolUse/onToolStart fire
    // synchronously, in original order, for the whole run before any handler
    // settles (each async call runs synchronously up to its first `await`).
    const runResults = await Promise.all(
      toolCalls
        .slice(i, j)
        .map((call) => executeOne(call, toolHandlers, onToolUse, execHooks)),
    );
    for (let k = 0; k < runResults.length; k++) {
      results[i + k] = runResults[k];
    }
    i = j;
  }

  return results;
}

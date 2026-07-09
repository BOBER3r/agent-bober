import type { AgenticLoopResult } from "./agentic-loop.js";
import type { ToolResult } from "../providers/types.js";

/**
 * Structured observability + interception surface for `runAgenticLoop`
 * (agent-loop-capability-port sprint 5). Own, provider-agnostic types —
 * never SDK types (principles.md: "Provider-agnostic interfaces"). Hooks and
 * events run host-side and add zero tokens to the conversation.
 */

// ── Tool call info ───────────────────────────────────────────────────

/**
 * The subset of a model-requested tool call surfaced to hooks/events. Named
 * `toolUseId` (not `id`) to read naturally alongside `ToolResult.toolUseId`,
 * which it correlates with.
 */
export interface LoopToolCallInfo {
  name: string;
  input: unknown;
  toolUseId: string;
}

// ── Loop events ────────────────────────────────────────────────────

/**
 * Host-side observability event stream emitted (in order) via the optional
 * `onEvent` callback on `AgenticLoopParams`. Consuming this stream never
 * changes loop behavior — it is a pure observation channel.
 *
 * `text-delta` (sprint 8) type name is RESERVED via this comment only — do
 * NOT emit it this sprint:
 *   | { type: "text-delta"; turn: number; delta: string }
 */
export type LoopEvent =
  | { type: "init"; model: string; maxTurns: number }
  | { type: "turn-start"; turn: number }
  | { type: "tool-start"; turn: number; name: string; input: unknown; toolUseId: string }
  | { type: "tool-end"; turn: number; name: string; toolUseId: string; isError: boolean }
  | { type: "turn-end"; turn: number; toolsCalled: string[] }
  | {
      type: "compact-boundary";
      turn: number;
      /** Message count in the transcript immediately before compaction. */
      messagesBefore: number;
      /** Message count immediately after (head replaced by one summary). */
      messagesAfter: number;
      /** The per-request `response.usage.inputTokens` that crossed the threshold. */
      inputTokensAtTrigger: number;
    }
  | { type: "result"; stopReason: string; turnsUsed: number };

// ── Hooks ──────────────────────────────────────────────────────────

/** Veto/allow decision returned by `LoopHooks.preToolUse`. */
export interface HookDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Optional host-side hooks. All are plain callbacks run in the orchestrating
 * process — never SDK types, never remote calls implied by this interface.
 *
 * Veto-only this sprint: `preToolUse` may deny a call, but MUST NOT mutate
 * `call.input` (input transformation is out of scope — contract nonGoal).
 */
export interface LoopHooks {
  /**
   * Veto gate evaluated BEFORE a tool handler runs. A `{allow:false}`
   * decision skips the handler entirely; the model receives an `isError`
   * rejection `ToolResult` containing `reason`, and the loop continues to
   * the next turn rather than stopping. The caller treats a throwing
   * `preToolUse` as a deny (fail-closed) — see `runAgenticLoop`.
   */
  preToolUse?: (call: LoopToolCallInfo) => HookDecision | Promise<HookDecision>;
  /**
   * Observes a tool result after execution (allowed, denied, or errored).
   * The caller catches and logs a throw — it never crashes the loop.
   */
  postToolUse?: (call: LoopToolCallInfo, result: ToolResult) => void | Promise<void>;
  /**
   * Observes the final `AgenticLoopResult` exactly once, on every stop path
   * (completion, refusal, budget_exceeded, max_turns_exceeded, error). The
   * caller catches and logs a throw — it never crashes the loop.
   */
  onStop?: (result: AgenticLoopResult) => void | Promise<void>;
}

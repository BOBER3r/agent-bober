/**
 * Claude Code subscription provider.
 *
 * Backs the LLMClient interface with the local `claude` CLI in headless
 * print mode (`claude -p --output-format json`), so model calls bill against
 * the user's Claude Pro/Max SUBSCRIPTION credit instead of an
 * ANTHROPIC_API_KEY. No API key is read or required by this adapter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CAPABILITY BOUNDARY:
 *
 * agent-bober drives its OWN agentic loop: chat() is contracted to take MY
 * tools, return ONE model turn, stop at tool_use, and let the caller execute
 * the tool. The `claude` CLI does the OPPOSITE — it runs ITS OWN loop with
 * ITS OWN built-in tools (Read/Write/Bash) and never hands custom tool_use
 * blocks back. There is no faithful single-turn-with-my-tools mode.
 *
 * Therefore this adapter supports ONLY the no-tools case (system + messages
 * → text). That covers the pure prompt→text roles (planner, researcher
 * question-gen). If `params.tools` is non-empty it THROWS rather than
 * silently dropping the tools and corrupting the caller's loop.
 *
 * COST CAVEAT: `claude -p` injects Claude Code's full system prompt
 * (~40k cache-creation tokens) on every call, and post-2026-06-15 these calls
 * bill at standard API rates against a capped monthly subscription credit
 * (Max 5×=$100/mo, 20×=$200/mo, no rollover). This path is NOT free-unlimited.
 *
 * TERMS: programmatic subscription use via `claude -p` is permitted by
 * Anthropic as of 2026-06-15, billed from the separate Agent-SDK/CLI credit.
 * Verify current terms before relying on it at scale.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { execa } from "execa";
import type {
  LLMClient,
  ChatParams,
  ChatResponse,
  StopReason,
} from "./types.js";

/** Shape of the `claude -p --output-format json` result object (subset). */
interface ClaudeCliResult {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/** Map the CLI's stop_reason onto agent-bober's normalized StopReason. */
function mapStopReason(raw: string | undefined): StopReason {
  switch (raw) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return raw ?? "end";
  }
}

/**
 * Flatten the provider-agnostic Message[] into a single prompt string for the
 * CLI's `-p` argument. The CLI takes one prompt, not a structured transcript,
 * so we render the conversation as labelled turns. Adequate for the no-tools
 * roles this adapter targets; NOT a faithful multi-turn tool transcript.
 */
function flattenMessages(messages: ChatParams["messages"]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if ("systemUpdate" in m) {
      parts.push(`[system update]\n${m.systemUpdate}`);
    } else if ("toolResults" in m) {
      // No-tools adapter: tool results shouldn't occur, but render defensively.
      for (const r of m.toolResults) {
        parts.push(`[tool result ${r.toolUseId}]\n${r.content}`);
      }
    } else if (m.role === "assistant") {
      parts.push(`Assistant: ${m.content}`);
    } else {
      parts.push(`User: ${m.content}`);
    }
  }
  return parts.join("\n\n");
}

export class ClaudeCodeAdapter implements LLMClient {
  /**
   * @param binary    Path/name of the claude CLI (default "claude").
   * @param timeoutMs Per-call timeout. Default 180s (sprints make long calls).
   */
  constructor(
    private readonly binary: string = "claude",
    private readonly timeoutMs: number = 180_000,
  ) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    // params.onTextDelta (sprint 8, streaming): accepted but never invoked —
    // the `claude` CLI's text-only boundary stays; this adapter always shells
    // out and parses the final JSON result (documented no-op).
    const { system, messages, tools, model } = params;

    // Hard fail on tools — see SPIKE SCOPE. Silent drop would corrupt the
    // caller's agentic loop (it would wait forever for tool_use that can't come).
    if (tools && tools.length > 0) {
      throw new Error(
        "ClaudeCodeAdapter (spike) does not support custom tools: the `claude` " +
          "CLI runs its own tool loop and cannot return custom tool_use blocks. " +
          "Use this provider only for prompt→text roles (e.g. planner), or use " +
          "the anthropic/openai-compat providers for tool-driven roles.",
      );
    }

    // Hard fail on documents — the `claude` CLI accepts only a text prompt, so a
    // PDF/file would be silently dropped (the model would answer from nothing).
    if (params.documents && params.documents.length > 0) {
      throw new Error(
        "ClaudeCodeAdapter does not support `documents` (PDF/file inputs): the " +
          "`claude` CLI accepts only a text prompt, so a document would be " +
          "silently dropped. Use the anthropic, openai, or google provider for " +
          "document parsing.",
      );
    }

    const prompt = flattenMessages(messages);

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      // Disable Claude Code's built-in tools — we want pure completion, not its loop.
      "--disallowed-tools",
      "Read Edit Write Bash Glob Grep WebFetch WebSearch Task",
      // Don't inherit the project's MCP servers (keeps the call hermetic).
      "--strict-mcp-config",
    ];
    if (system && system.trim().length > 0) {
      args.push("--append-system-prompt", system);
    }
    if (model) {
      args.push("--model", model);
    }

    const result = await execa(this.binary, args, {
      reject: false,
      timeout: this.timeoutMs,
      // No stdin; everything is in args.
      input: "",
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `claude CLI exited ${String(result.exitCode)}: ${
          result.stderr || result.stdout || "no output"
        }`,
      );
    }

    let parsed: ClaudeCliResult;
    try {
      parsed = JSON.parse(result.stdout) as ClaudeCliResult;
    } catch {
      throw new Error(
        `claude CLI returned non-JSON output: ${result.stdout.slice(0, 200)}`,
      );
    }

    if (parsed.is_error) {
      throw new Error(
        `claude CLI reported an error: ${parsed.result ?? parsed.subtype ?? "unknown"}`,
      );
    }

    return {
      text: parsed.result ?? "",
      toolCalls: [],
      stopReason: mapStopReason(parsed.stop_reason),
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      },
      // Vendor-authoritative real cost (ADR-3: claude-code never estimates
      // via CostMeter). Conditional-spread so the key is ABSENT — not
      // `costUsd: undefined` — when an older CLI omits total_cost_usd.
      ...(typeof parsed.total_cost_usd === "number"
        ? { costUsd: parsed.total_cost_usd }
        : {}),
    };
  }
}

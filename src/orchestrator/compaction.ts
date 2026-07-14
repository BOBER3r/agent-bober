/**
 * In-context auto-compaction (agent-loop-capability-port sprint 7).
 *
 * A pure, testable helper that summarizes the older ("head") messages of a
 * conversation into a single replacement message via ONE extra `client.chat`
 * call, so `runAgenticLoop` can keep long runs inside the context window
 * without the coarse sprint-boundary reset (`summarizeOlderSprints` /
 * `contextReset` — a different, unrelated layer; see `context-handoff.ts`).
 *
 * Fails open: any error from the summarization call is caught, logged, and
 * surfaced as `undefined` so the caller can skip compaction for that turn
 * and continue uncompacted (sc-7-4). Never throws.
 */

import type { LLMClient, Message, TextMessage } from "../providers/types.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface CompactionParams {
  /** Provider-agnostic LLM client — the SAME client the run is using. */
  client: LLMClient;
  /** Model ID — the SAME model the run is using. */
  model: string;
  /** The HEAD messages being summarized away (older, completed turns). */
  head: Message[];
  /** Optional caller steering appended to the base summarization prompt. */
  instructions?: string;
  /** Bounded output cap for the summary call. Default 4096. */
  maxTokens?: number;
}

export interface CompactionOutcome {
  /** The single replacement message: { role:"user", content:"[Conversation summary] ..." }. */
  summaryMessage: Message;
  /** Token usage of the summarization call itself (to be charged by the caller). */
  usage: { inputTokens: number; outputTokens: number };
  /** USD cost of the summarization call, when the provider reports one. */
  costUsd?: number;
}

const SUMMARY_SYSTEM =
  "Summarize this conversation preserving: task objective, file paths touched, " +
  "decisions made, errors seen. Be concise and factual.";

// ── Serialize head so we never send tool_use/tool_result blocks without tools ──

/**
 * Render the head messages to a single plain-text transcript. The head may
 * contain `AssistantMessage`/`ToolResultMessage` entries (tool_use/tool_result
 * content), which the main loop only ever sends alongside `tools`. Sending
 * them to a no-tools summarization call risks a provider 400, so we flatten
 * everything to plain text instead.
 */
function renderTranscript(messages: Message[]): string {
  return messages
    .map((m) => {
      if ("toolResults" in m) {
        return `[tool results] ${m.toolResults.map((r) => r.content).join("\n")}`;
      }
      if ("toolCalls" in m) {
        const calls = m.toolCalls.map((c) => c.name).join(", ");
        return calls.length > 0
          ? `[assistant] ${m.content}\n[tool calls] ${calls}`
          : `[assistant] ${m.content}`;
      }
      if ("systemUpdate" in m) {
        return `[system update] ${m.systemUpdate}`;
      }
      return `[${m.role}] ${(m as TextMessage).content}`;
    })
    .join("\n\n");
}

// ── Pure helper: one summarization chat, fail-open ─────────────────

/**
 * Summarize `head` into a single replacement message via ONE `client.chat`
 * call. Passes NO `tools` and a bounded `maxTokens` — mirrors the existing
 * one-shot `coerceJsonOutput` precedent (`agentic-loop.ts`).
 *
 * @returns `undefined` on any failure (fail-open, sc-7-4) — the caller must
 *   skip compaction for that turn and continue uncompacted, never throw.
 */
export async function summarizeMessages(
  params: CompactionParams,
): Promise<CompactionOutcome | undefined> {
  const { client, model, head, instructions, maxTokens = 4096 } = params;
  const system = instructions ? `${SUMMARY_SYSTEM}\n\n${instructions}` : SUMMARY_SYSTEM;
  const messages: Message[] = [{ role: "user", content: renderTranscript(head) }];

  try {
    const response = await client.chat({ model, system, messages, maxTokens });
    const summaryMessage: Message = {
      role: "user",
      content: `[Conversation summary] ${response.text}`,
    };
    return {
      summaryMessage,
      usage: response.usage,
      ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Compaction summarization failed (skipped, continuing uncompacted): ${message}`);
    return undefined;
  }
}

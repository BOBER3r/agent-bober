// ── answerer.ts ──────────────────────────────────────────────────────
//
// Composes roster summary + memory distill + recent history into one
// LLMClient.chat call (no jsonObjectMode) and returns the text response.

import type { LLMClient, TextMessage } from "../providers/types.js";
import type { TurnRecord } from "./conversation-store.js";

// ── Answerer ──────────────────────────────────────────────────────────

export class Answerer {
  private readonly llm: LLMClient;
  private readonly model: string;

  constructor(llm: LLMClient, model: string) {
    this.llm = llm;
    this.model = model;
  }

  /**
   * Produce an answer to the user's input, given context.
   *
   * @param input - The current user message.
   * @param rosterSummary - Compact string summary of active runs.
   * @param memoryDistill - Compact string of lessons from .bober/memory/.
   * @param recentHistory - Recent prior turns for conversation context.
   */
  async answer(
    input: string,
    rosterSummary: string,
    memoryDistill: string,
    recentHistory: TurnRecord[],
  ): Promise<string> {
    const systemParts: string[] = [
      "You are bober, an AI assistant integrated with the agent-bober engineering workflow.",
      "",
      "You have access to the following context:",
      "",
      "## Active Runs",
      rosterSummary || "No runs found.",
      "",
      "## Project Memory (Lessons Learned)",
      memoryDistill || "No lessons recorded yet.",
      "",
      "Answer the user's question concisely and helpfully.",
      "If the user asks about runs or agents, use the Active Runs context above.",
      "If the user asks about past mistakes or learnings, use the Project Memory context.",
    ];
    const system = systemParts.join("\n");

    // Build message history from stored turns + current input
    const messages: TextMessage[] = [];
    for (const turn of recentHistory) {
      messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: "user", content: input });

    const response = await this.llm.chat({
      model: this.model,
      system,
      messages,
    });

    return response.text;
  }
}

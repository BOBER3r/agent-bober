// ── turn-classifier.ts ────────────────────────────────────────────────
//
// Classifies each user turn via a single jsonObjectMode LLMClient.chat call.
// Any parse failure returns { action: "answer" } — never throws.

import { z } from "zod";
import type { LLMClient } from "../providers/types.js";

// ── Types ─────────────────────────────────────────────────────────────

export type ClassifierAction =
  | { action: "answer" }
  | { action: "spawn"; task: string }
  | { action: "steer"; op: "inspect" }
  | { action: "steer"; op: "stop"; runId: string }
  | { action: "approve"; checkpointId?: string }
  | { action: "reject"; checkpointId?: string; feedback?: string }
  | { action: "tell"; runId: string; text: string };

// ── Zod discriminated union ───────────────────────────────────────────

const ClassifierActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer") }),
  z.object({ action: z.literal("spawn"), task: z.string() }),
  z.object({
    action: z.literal("steer"),
    op: z.union([
      z.literal("inspect"),
      z.object({ op: z.literal("stop"), runId: z.string() }).shape.op,
    ]),
    runId: z.string().optional(),
  }),
  z.object({ action: z.literal("approve"), checkpointId: z.string().optional() }),
  z.object({
    action: z.literal("reject"),
    checkpointId: z.string().optional(),
    feedback: z.string().optional(),
  }),
  z.object({ action: z.literal("tell"), runId: z.string(), text: z.string() }),
]);

const FALLBACK: ClassifierAction = { action: "answer" };

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Strip code fences (```json ... ``` or ``` ... ```) from a string.
 */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1").trim();
}

/**
 * Extract the first balanced {...} JSON object substring.
 * Returns null if no balanced object found.
 */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Defensively parse text into a ClassifierAction.
 * Returns FALLBACK on any error.
 */
function parseClassifierAction(text: string): ClassifierAction {
  try {
    const stripped = stripCodeFences(text);
    const extracted = extractFirstObject(stripped) ?? stripped;
    const parsed: unknown = JSON.parse(extracted);
    const result = ClassifierActionSchema.safeParse(parsed);
    if (result.success) {
      // Reconstruct steer with proper shape
      const data = result.data;
      if (data.action === "answer") return { action: "answer" };
      if (data.action === "spawn") return { action: "spawn", task: data.task };
      if (data.action === "steer") {
        const raw = parsed as Record<string, unknown>;
        if (raw["op"] === "stop" && typeof raw["runId"] === "string") {
          return { action: "steer", op: "stop", runId: raw["runId"] };
        }
        return { action: "steer", op: "inspect" };
      }
      if (data.action === "approve") {
        return { action: "approve", checkpointId: data.checkpointId };
      }
      if (data.action === "reject") {
        return {
          action: "reject",
          checkpointId: data.checkpointId,
          feedback: data.feedback,
        };
      }
      if (data.action === "tell") {
        return { action: "tell", runId: data.runId, text: data.text };
      }
    }
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// ── TurnClassifier ────────────────────────────────────────────────────

export class TurnClassifier {
  private readonly llm: LLMClient;
  private readonly model: string;

  constructor(llm: LLMClient, model: string) {
    this.llm = llm;
    this.model = model;
  }

  /**
   * Classify the user's input turn.
   * Uses jsonObjectMode:true (loose JSON mode) for provider parity.
   * Any failure in the LLM call or JSON parse returns { action: "answer" }.
   */
  async classify(input: string): Promise<ClassifierAction> {
    const system = [
      "You are a routing classifier for a chat assistant.",
      "Given the user message, decide what action to take.",
      'Return ONLY a JSON object with an "action" field.',
      'Options:',
      '  {"action":"answer"}  — answer the question directly',
      '  {"action":"spawn","task":"<task description>"}  — spawn a new agent run',
      '  {"action":"steer","op":"inspect"}  — inspect running agents',
      '  {"action":"steer","op":"stop","runId":"<id>"}  — stop a specific run',
      '  {"action":"approve","checkpointId":"<id?>"}  — approve a pending checkpoint',
      '  {"action":"reject","checkpointId":"<id?>","feedback":"<why?>"}  — reject a checkpoint',
      '  {"action":"tell","runId":"<id>","text":"<instruction>"}  — queue free-text guidance for a run',
      "Return ONLY the JSON object, no other text.",
    ].join("\n");

    try {
      const response = await this.llm.chat({
        model: this.model,
        system,
        messages: [{ role: "user", content: input }],
        jsonObjectMode: true,
      });
      return parseClassifierAction(response.text);
    } catch {
      return FALLBACK;
    }
  }
}

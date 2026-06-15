// ── fact-judge.ts ──────────────────────────────────────────────────────
//
// LLM-backed FactJudge for resolving normalized-key ambiguity during
// fact reconciliation. The ONLY place in the reconcile layer that imports
// createClient or touches the network.
//
// On ANY parse failure or thrown error, resolve() returns "add" — never
// lets the LLM corrupt the store.

import { z } from "zod";

import { createClient } from "../../providers/factory.js";
import { resolveModel } from "../model-resolver.js";
import type { LLMClient } from "../../providers/types.js";
import type { FactInput, FactRecord } from "../../state/facts.js";
import type { ReconcileAction } from "./reconcile.js";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Interface for resolving ambiguous fact collisions.
 * The judge is consulted ONLY on a deterministic normalized-key collision
 * where no exact (scope,subject,predicate) match exists.
 */
export interface FactJudge {
  resolve(incoming: FactInput, candidate: FactRecord): Promise<ReconcileAction>;
}

// ── Zod schema ─────────────────────────────────────────────────────────

const JudgeResponseSchema = z.object({
  action: z.enum(["add", "update", "delete", "noop"]),
});

const FALLBACK: ReconcileAction = "add";

// ── Helpers (mirrored from turn-classifier.ts) ─────────────────────────

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
 * Defensively parse text into a ReconcileAction.
 * Returns FALLBACK ("add") on any error.
 */
function parseJudgeAction(text: string): ReconcileAction {
  try {
    const stripped = stripCodeFences(text);
    const extracted = extractFirstObject(stripped) ?? stripped;
    const parsed: unknown = JSON.parse(extracted);
    const result = JudgeResponseSchema.safeParse(parsed);
    if (result.success) {
      return result.data.action;
    }
    return FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// ── LLMFactJudge ──────────────────────────────────────────────────────

class LLMFactJudge implements FactJudge {
  private readonly llm: LLMClient;
  private readonly model: string;

  constructor(llm: LLMClient, model: string) {
    this.llm = llm;
    this.model = model;
  }

  /**
   * Resolve an ambiguous fact collision using an LLM judgment.
   * Uses jsonObjectMode:true for provider parity.
   * On ANY failure (network, parse error), returns "add" — never corrupts the store.
   */
  async resolve(incoming: FactInput, candidate: FactRecord): Promise<ReconcileAction> {
    const system = [
      "You are a fact-reconciliation judge for a semantic knowledge store.",
      "Given an INCOMING fact and a CANDIDATE active fact with the same normalized subject+predicate,",
      "decide whether to add, update, delete, or ignore the incoming fact.",
      "",
      "Respond ONLY with a JSON object with an 'action' field:",
      '  {"action":"add"}    — insert the incoming fact as a new active fact (both will coexist)',
      '  {"action":"update"} — supersede the candidate with the incoming fact',
      '  {"action":"delete"} — invalidate the candidate, do not insert incoming',
      '  {"action":"noop"}   — discard the incoming fact, keep the candidate unchanged',
      "",
      "Return ONLY the JSON object, no other text.",
    ].join("\n");

    const userContent = [
      `INCOMING: subject="${incoming.subject}", predicate="${incoming.predicate}", value="${incoming.value}"`,
      `CANDIDATE: subject="${candidate.subject}", predicate="${candidate.predicate}", value="${candidate.value}"`,
    ].join("\n");

    try {
      const response = await this.llm.chat({
        model: this.model,
        system,
        messages: [{ role: "user", content: userContent }],
        jsonObjectMode: true,
      });
      return parseJudgeAction(response.text);
    } catch {
      return FALLBACK;
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Build an LLM-backed FactJudge.
 * Mirrors the createClient pattern from src/orchestrator/architect-agent.ts:195-203.
 * Honoring BOBER_TEST_DETERMINISTIC=1 automatically — createClient short-circuits
 * to a DeterministicStubClient whose response is non-JSON, causing parseJudgeAction
 * to return the FALLBACK "add".
 */
export function createLLMFactJudge(
  provider?: string | null,
  endpoint?: string | null,
  providerConfig?: Record<string, unknown>,
  model?: string,
): FactJudge {
  const client = createClient(
    provider ?? null,
    endpoint ?? null,
    providerConfig,
    model,
    "FactJudge",
  );
  const resolvedModel = resolveModel(model ?? "sonnet");
  return new LLMFactJudge(client, resolvedModel);
}

import { z } from "zod";
import { validateManifest } from "./decomposer.js";
import type { FleetManifest } from "./manifest.js";
import type { LLMClient, Message } from "../providers/types.js";
import { runCritiqueLoop } from "./critic-deep.js";

// ── Constants ────────────────────────────────────────────────────────

export const DEEP_PLAN_SYSTEM_PROMPT = `You are a tech-lead creating a coarse outline of independent sub-project areas for a high-level goal.

Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "areas": [
    { "name": "<free-form area name>", "intent": "<what this sub-project area covers>" }
  ]
}

Rules:
- "name" is a free-form label describing a major concern of the goal (e.g. "Authentication", "Data Layer", "Web Frontend").
- "intent" is a concise description of what this area covers and why it is independent.
- You MUST include at least 1 area.
- Do NOT include folder names, kebab-case slugs, or implementation details — this is a coarse planning outline only.
- Output the JSON object and nothing else.`;

export const DEEP_PLAN_COERCION_INSTRUCTION = `Your previous response was not a valid outline.
Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "areas": [
    { "name": "<free-form area name>", "intent": "<what this sub-project area covers>" }
  ]
}

Rules:
- "name" must be a non-empty string describing a major concern of the goal.
- "intent" must be a non-empty string describing what the area covers.
- You MUST include at least 1 area.
- Output the JSON object and nothing else.`;

export const DEEP_EXPAND_SYSTEM_PROMPT = `You are a tech-lead expanding a coarse outline into independent, buildable sub-projects.

Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "children": [
    { "folder": "<short-kebab-case-dir-name>", "task": "<self-contained build instruction>" }
  ]
}

Rules:
- "folder" must be a short kebab-case directory name (e.g. "api-server", "web-frontend", "cli-tool").
- "task" must be a complete, self-contained instruction that a code-generation agent can execute independently.
- You MUST include at least 1 child.
- Do NOT include "config", "concurrency", "rootDir", or "provider" keys anywhere in the output.
- Each child carries ONLY "folder" and "task" — no other keys.
- Output the JSON object and nothing else.`;

export const DEEP_EXPAND_COERCION_INSTRUCTION = `Your previous response was not a valid fleet manifest.
Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:
{
  "children": [
    { "folder": "<short-kebab-case-dir-name>", "task": "<self-contained build instruction>" }
  ]
}

Rules:
- "folder" must be a short kebab-case directory name.
- "task" must be a complete, self-contained build instruction.
- You MUST include at least 1 child.
- Do NOT include "config", "concurrency", "rootDir", or "provider" keys anywhere in the output.
- Each child carries ONLY "folder" and "task" — no other keys.
- Output the JSON object and nothing else.`;

export const DEEP_PLAN_MAX_RETRIES = 1;
export const DEEP_EXPAND_MAX_RETRIES = 1;
// bober: fixed budget = (1+DEEP_PLAN_MAX_RETRIES)+(1+DEEP_EXPAND_MAX_RETRIES); upgrade path: increase retries constants
export const DEEP_MAX_TOTAL_CALLS = 4;

// ── Types ────────────────────────────────────────────────────────────

export type OutlineArea = { name: string; intent: string };
export type Outline = { areas: OutlineArea[] };

export interface DecomposeDeepInput {
  goal: string;
  client: LLMClient;
  model: string;
  count?: string;
  planMaxRetries?: number;
  expandMaxRetries?: number;
  critique?: boolean; // NEW; undefined/false ⇒ Phase-3 path
}

type ValidateOutlineResult =
  | { ok: true; outline: Outline }
  | { ok: false; error: string };

// ── Local Outline schema ─────────────────────────────────────────────

const OutlineAreaSchema = z.object({
  name: z.string().min(1),
  intent: z.string(),
});

const OutlineSchema = z.object({
  areas: z.array(OutlineAreaSchema).min(1),
});

// ── validateOutline (NEVER throws) ───────────────────────────────────

export function validateOutline(rawText: string): ValidateOutlineResult {
  let parsed: unknown;

  // Try direct parse first
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    // Try finding the first { ... } block
    if (!parsed) {
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1));
        } catch {
          return {
            ok: false,
            error: `No valid JSON object found in response. Raw: ${rawText.slice(0, 200)}`,
          };
        }
      } else {
        return {
          ok: false,
          error: `No JSON object found in response. Raw: ${rawText.slice(0, 200)}`,
        };
      }
    }
  }

  const result = OutlineSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    return { ok: false, error: issues };
  }

  return { ok: true, outline: result.data };
}

// ── Internal: one PLAN call ──────────────────────────────────────────

async function callPlan(input: {
  client: LLMClient;
  model: string;
  goal: string;
  count?: string;
  priorText?: string;
  formattedError?: string;
}): Promise<string> {
  const { client, model, goal, count, priorText, formattedError } = input;

  const firstUserContent = count
    ? `${goal}\n\n(Outline into approximately ${count} areas.)`
    : goal;

  let messages: Message[];

  if (priorText !== undefined && formattedError !== undefined) {
    // Coercion retry: 3-message shape [user, assistant, user]
    messages = [
      { role: "user", content: firstUserContent },
      { role: "assistant", content: priorText },
      {
        role: "user",
        content: `${DEEP_PLAN_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}`,
      },
    ];
  } else {
    // First turn: single user message
    messages = [{ role: "user", content: firstUserContent }];
  }

  const response = await client.chat({
    model,
    system: DEEP_PLAN_SYSTEM_PROMPT,
    messages,
    jsonObjectMode: true,
  });

  return response.text;
}

// ── Internal: one EXPAND call ────────────────────────────────────────

async function callExpand(input: {
  client: LLMClient;
  model: string;
  outline: Outline;
  goal: string;
  priorText?: string;
  formattedError?: string;
  critiqueFeedback?: string; // NEW; appended to first user turn only when present
}): Promise<string> {
  const { client, model, outline, goal, priorText, formattedError } = input;

  const firstUserContent = `Goal: ${goal}\n\nOutline:\n${JSON.stringify(outline)}`;

  let messages: Message[];

  if (priorText !== undefined && formattedError !== undefined) {
    // Coercion retry: 3-message shape [user, assistant, user]
    messages = [
      { role: "user", content: firstUserContent },
      { role: "assistant", content: priorText },
      {
        role: "user",
        content: `${DEEP_EXPAND_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}`,
      },
    ];
  } else {
    // First turn: single user message
    messages = [{ role: "user", content: firstUserContent }];
  }

  // NEW: append critique feedback to the first user turn only when present
  const { critiqueFeedback } = input;
  if (critiqueFeedback && messages.length === 1) {
    messages = [{ role: "user", content: firstUserContent + `\n\nPrior reviewer feedback to address:\n${critiqueFeedback}` }];
  }

  const response = await client.chat({
    model,
    system: DEEP_EXPAND_SYSTEM_PROMPT,
    messages,
    jsonObjectMode: true,
  });

  return response.text;
}

// ── Stages ───────────────────────────────────────────────────────────

export async function runPlanStage(input: {
  client: LLMClient;
  model: string;
  goal: string;
  count?: string;
  maxRetries: number;
}): Promise<Outline> {
  const { client, model, goal, count, maxRetries } = input;
  const maxAttempts = 1 + maxRetries;

  let lastError = "Unknown error";
  let priorText: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rawText = await callPlan({
      client,
      model,
      goal,
      count,
      priorText: attempt > 0 ? priorText : undefined,
      formattedError: attempt > 0 ? lastError : undefined,
    });

    const validated = validateOutline(rawText);
    if (validated.ok) {
      return validated.outline;
    }

    lastError = validated.error;
    priorText = rawText;
  }

  throw new Error(
    `deep plan failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}:\n${lastError}`,
  );
}

export async function runExpandStage(input: {
  client: LLMClient;
  model: string;
  outline: Outline;
  goal: string;
  maxRetries: number;
  critiqueFeedback?: string; // NEW; threaded into first EXPAND user turn only
}): Promise<FleetManifest> {
  const { client, model, outline, goal, maxRetries } = input;
  const { critiqueFeedback } = input; // NEW
  const maxAttempts = 1 + maxRetries;

  let lastError = "Unknown error";
  let priorText: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rawText = await callExpand({
      client,
      model,
      outline,
      goal,
      priorText: attempt > 0 ? priorText : undefined,
      formattedError: attempt > 0 ? lastError : undefined,
      critiqueFeedback: attempt === 0 ? critiqueFeedback : undefined,
    });

    const validated = validateManifest(rawText);
    if (validated.ok) {
      return validated.manifest;
    }

    lastError = validated.error;
    priorText = rawText;
  }

  throw new Error(
    `deep expand failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}:\n${lastError}`,
  );
}

// ── Public entrypoint ────────────────────────────────────────────────

export async function decomposeGoalDeep(
  input: DecomposeDeepInput,
): Promise<FleetManifest> {
  const {
    goal,
    client,
    model,
    count,
    planMaxRetries = DEEP_PLAN_MAX_RETRIES,
    expandMaxRetries = DEEP_EXPAND_MAX_RETRIES,
  } = input;

  // PLAN strictly precedes EXPAND — never parallel
  const outline = await runPlanStage({
    client,
    model,
    goal,
    count,
    maxRetries: planMaxRetries,
  });

  const manifest = await runExpandStage({
    client,
    model,
    outline,
    goal,
    maxRetries: expandMaxRetries,
  });

  if (input.critique === true) {
    return runCritiqueLoop({ client, model, goal, outline, baseline: manifest, expandMaxRetries });
  }

  return manifest;
}

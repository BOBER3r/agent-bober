import { FleetManifestSchema } from "./manifest.js";
import type { FleetManifest } from "./manifest.js";
import type { LLMClient, Message } from "../providers/types.js";

// ── Constants ────────────────────────────────────────────────────────

export const DECOMPOSE_SYSTEM_PROMPT = `You are a tech-lead decomposing ONE high-level goal into N independent, buildable sub-projects.

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

export const DECOMPOSE_COERCION_INSTRUCTION = `Your previous response was not a valid fleet manifest.
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

export const DECOMPOSE_MAX_RETRIES = 1;

// ── Types ────────────────────────────────────────────────────────────

export interface DecomposeInput {
  goal: string;
  client: LLMClient;
  model: string;
  maxRetries?: number;
}

type ValidateResult =
  | { ok: true; manifest: FleetManifest }
  | { ok: false; error: string };

// ── Internal: one LLM call ───────────────────────────────────────────

async function callDecomposer(input: {
  client: LLMClient;
  model: string;
  goal: string;
  priorText?: string;
  formattedError?: string;
}): Promise<string> {
  const { client, model, goal, priorText, formattedError } = input;

  let messages: Message[];

  if (priorText !== undefined && formattedError !== undefined) {
    // Coercion retry: 3-message shape [user, assistant, user]
    messages = [
      { role: "user", content: goal },
      { role: "assistant", content: priorText },
      {
        role: "user",
        content: `${DECOMPOSE_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}`,
      },
    ];
  } else {
    // First turn: single user message
    messages = [{ role: "user", content: goal }];
  }

  const response = await client.chat({
    model,
    system: DECOMPOSE_SYSTEM_PROMPT,
    messages,
    jsonObjectMode: true,
  });

  return response.text;
}

// ── Internal: extract + validate + config-key guard ──────────────────

export function validateManifest(rawText: string): ValidateResult {
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

  const result = FleetManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    return { ok: false, error: issues };
  }

  // Config-key guard: children must not carry a "config" key
  // (FleetChildSchema.config is optional, so safeParse alone accepts it)
  const offending = result.data.children.find((c) =>
    Object.prototype.hasOwnProperty.call(c, "config"),
  );
  if (offending) {
    return {
      ok: false,
      error: `child "${offending.folder}": children must not carry a "config" key`,
    };
  }

  return { ok: true, manifest: result.data };
}

// ── Public entrypoint ────────────────────────────────────────────────

export async function decomposeGoal(input: DecomposeInput): Promise<FleetManifest> {
  const { goal, client, model, maxRetries = DECOMPOSE_MAX_RETRIES } = input;
  const maxAttempts = 1 + maxRetries;

  let lastError = "Unknown error";
  let priorText: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rawText = await callDecomposer({
      client,
      model,
      goal,
      priorText: attempt > 0 ? priorText : undefined,
      formattedError: attempt > 0 ? lastError : undefined,
    });

    const validated = validateManifest(rawText);
    if (validated.ok) {
      return validated.manifest;
    }

    lastError = validated.error;
    priorText = rawText;
  }

  throw new Error(
    `Fleet decomposition failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}:\n${lastError}`,
  );
}

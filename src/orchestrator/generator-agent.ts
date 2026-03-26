import Anthropic from "@anthropic-ai/sdk";

import type { BoberConfig } from "../config/schema.js";
import type { ContextHandoff } from "./context-handoff.js";
import { serializeHandoff } from "./context-handoff.js";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────

export interface GeneratorResult {
  success: boolean;
  notes: string;
  filesChanged: string[];
  commitHash?: string;
}

// ── Model mapping ──────────────────────────────────────────────────

function resolveModel(choice: string): string {
  switch (choice) {
    case "opus":
      return "claude-sonnet-4-20250514";
    case "sonnet":
      return "claude-sonnet-4-20250514";
    case "haiku":
      return "claude-haiku-4-20250414";
    default:
      return "claude-sonnet-4-20250514";
  }
}

// ── System prompt ──────────────────────────────────────────────────

const GENERATOR_SYSTEM_PROMPT = `You are the Bober Generator agent. Your job is to implement code changes according to a sprint contract.

You will receive a context handoff document containing:
- The overall plan specification
- The current sprint contract with success criteria
- History of completed sprints
- Any feedback from prior evaluation rounds

Your responsibilities:
1. Implement the changes described in the sprint contract.
2. Follow the success criteria exactly — each criterion must be met.
3. Work incrementally: make small, testable changes.
4. Self-verify before reporting completion.
5. If you received evaluation feedback, address every issue mentioned.

Output format — respond with a JSON object:
{
  "success": true/false,
  "notes": "Description of what was implemented and any issues encountered",
  "filesChanged": ["list", "of", "changed", "file", "paths"]
}

Guidelines:
- Follow existing code style and conventions in the project.
- Do not break existing functionality.
- If a task cannot be completed, set success to false and explain why in notes.
- List ALL files that were created, modified, or deleted.

Output ONLY the JSON object. No markdown fences, no explanation.`;

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the generator agent to implement changes for a sprint.
 *
 * Each invocation is a FRESH call (context reset). The handoff
 * document carries all necessary context from previous phases.
 */
export async function runGenerator(
  handoff: ContextHandoff,
  projectRoot: string,
  config: BoberConfig,
): Promise<GeneratorResult> {
  const contractId = handoff.currentContract?.id ?? "unknown";
  const feature = handoff.currentContract?.feature ?? "unknown";

  logger.sprint(contractId, `Generating: ${feature}`);

  const model = resolveModel(config.generator.model);
  const client = new Anthropic();

  const handoffJson = serializeHandoff(handoff);

  const userMessage = `# Context Handoff
${handoffJson}

# Project Root
${projectRoot}

Implement the changes described in the sprint contract. Follow every success criterion.
${handoff.issues.length > 0 ? `\n# Previous Issues to Fix\n${handoff.issues.join("\n")}` : ""}

Output ONLY a JSON object with { success, notes, filesChanged }. No markdown fences.`;

  logger.debug(`Calling generator model (${config.generator.model})...`);

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: GENERATOR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  let responseText = "";
  for (const block of response.content) {
    if (block.type === "text") {
      responseText += block.text;
    }
  }

  logger.debug("Generator response received, parsing...");

  return parseGeneratorResult(responseText);
}

/**
 * Parse the generator response text into a GeneratorResult.
 */
function parseGeneratorResult(text: string): GeneratorResult {
  let parsed: unknown;

  // Try direct parse
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Try extracting from markdown fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
      }
    }

    // Try finding { ... }
    if (!parsed) {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          // Fall through to default
        }
      }
    }
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    parsed !== null &&
    "success" in parsed
  ) {
    const obj = parsed as Record<string, unknown>;
    return {
      success: Boolean(obj.success),
      notes: typeof obj.notes === "string" ? obj.notes : "No notes provided.",
      filesChanged: Array.isArray(obj.filesChanged)
        ? (obj.filesChanged as unknown[]).filter(
            (f): f is string => typeof f === "string",
          )
        : [],
      commitHash:
        typeof obj.commitHash === "string" ? obj.commitHash : undefined,
    };
  }

  // If parsing failed entirely, return a failure result
  return {
    success: false,
    notes: `Failed to parse generator response. Raw output:\n${text.slice(0, 500)}`,
    filesChanged: [],
  };
}

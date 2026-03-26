import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import { PlanSpecSchema } from "../contracts/spec.js";
import { saveSpec } from "../state/index.js";
import { fileExists } from "../utils/fs.js";
import { logger } from "../utils/logger.js";

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

const PLANNER_SYSTEM_PROMPT = `You are the Bober Planner agent. Your job is to take a user's project description and produce a detailed plan specification (PlanSpec) as JSON.

You must output ONLY valid JSON matching this schema:
{
  "id": "spec-<timestamp>",
  "title": "Short plan title",
  "description": "Detailed description of what will be built",
  "projectType": "react-fullstack" | "brownfield" | "generic",
  "techStack": ["list", "of", "technologies"],
  "features": [
    {
      "id": "feature-1",
      "title": "Feature title",
      "description": "What this feature does",
      "priority": "must" | "should" | "could",
      "estimatedSprints": 1,
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"]
    }
  ],
  "nonFunctional": ["NFR 1", "NFR 2"],
  "constraints": ["Constraint 1"],
  "createdAt": "<ISO datetime>",
  "updatedAt": "<ISO datetime>"
}

Guidelines:
- Break the project into small, independently testable features.
- Each feature should be completable in 1-3 sprints.
- Order features by dependency — foundational features first.
- "must" priority features are the MVP. "should" are important. "could" are nice-to-have.
- Acceptance criteria must be specific and verifiable.
- Consider the project's existing tech stack and configuration.
- Keep sprint sizes reasonable — each sprint should produce a working increment.

Output ONLY the JSON object. No markdown fences, no explanation, just the JSON.`;

// ── Context gathering ──────────────────────────────────────────────

async function gatherProjectContext(
  projectRoot: string,
  config: BoberConfig,
): Promise<string> {
  const sections: string[] = [];

  // Package.json
  const pkgPath = join(projectRoot, "package.json");
  if (await fileExists(pkgPath)) {
    const content = await readFile(pkgPath, "utf-8");
    sections.push(`## package.json\n\`\`\`json\n${content}\n\`\`\``);
  }

  // CLAUDE.md
  const claudeMdPath = join(projectRoot, "CLAUDE.md");
  if (await fileExists(claudeMdPath)) {
    const content = await readFile(claudeMdPath, "utf-8");
    sections.push(`## CLAUDE.md\n${content}`);
  }

  // bober.config.json
  sections.push(
    `## bober.config.json\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``,
  );

  // Additional context files from config
  if (config.planner.contextFiles) {
    for (const relPath of config.planner.contextFiles) {
      const fullPath = join(projectRoot, relPath);
      if (await fileExists(fullPath)) {
        try {
          const content = await readFile(fullPath, "utf-8");
          sections.push(`## ${relPath}\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  return sections.join("\n\n");
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the planner agent to produce a PlanSpec from a user prompt.
 *
 * Uses the Anthropic SDK to create a single-turn message with the
 * planner system prompt and project context.
 */
export async function runPlanner(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
): Promise<PlanSpec> {
  logger.phase("Planning Phase");
  logger.info("Gathering project context...");

  const context = await gatherProjectContext(projectRoot, config);
  const model = resolveModel(config.planner.model);

  const client = new Anthropic();

  const userMessage = `# Task Description
${userPrompt}

# Project Context
${context}

Produce a PlanSpec JSON for this project. Remember: output ONLY valid JSON, no markdown fences.`;

  logger.info(`Calling planner model (${config.planner.model})...`);
  logger.debug(`Using model: ${model}`);

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: PLANNER_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  // Extract text content from the response
  let responseText = "";
  for (const block of response.content) {
    if (block.type === "text") {
      responseText += block.text;
    }
  }

  logger.debug("Raw planner response received, parsing...");

  // Try to extract JSON from the response
  const spec = parsePlanSpec(responseText);

  // Save to .bober/specs/
  await saveSpec(projectRoot, spec);
  logger.success(`Plan saved: ${spec.title} (${spec.features.length} features)`);

  return spec;
}

/**
 * Parse the planner response text into a validated PlanSpec.
 */
function parsePlanSpec(text: string): PlanSpec {
  // Try direct parse first
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through to error
      }
    }

    // Try finding the first { ... } block
    if (!parsed) {
      const braceStart = text.indexOf("{");
      const braceEnd = text.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          throw new Error(
            "Failed to parse planner response as JSON. Raw response:\n" +
              text.slice(0, 500),
          );
        }
      } else {
        throw new Error(
          "No JSON object found in planner response. Raw response:\n" +
            text.slice(0, 500),
        );
      }
    }
  }

  const result = PlanSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Planner produced invalid PlanSpec:\n${issues}\n\nRaw:\n${JSON.stringify(parsed, null, 2).slice(0, 1000)}`,
    );
  }

  return result.data;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import { PlanSpecSchema } from "../contracts/spec.js";
import { createClient } from "../providers/factory.js";
import { saveSpec } from "../state/index.js";
import { fileExists } from "../utils/fs.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { buildToolSet } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import type { ResearchDoc } from "./research-agent.js";

// ── Constants ──────────────────────────────────────────────────────

const PLANNER_MAX_TURNS = 15;

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
 * Uses a multi-turn agentic loop with read-only tools so the planner
 * can explore the codebase. The system prompt is loaded from
 * `agents/bober-planner.md`.
 */
export async function runPlanner(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  researchDoc?: ResearchDoc,
): Promise<PlanSpec> {
  logger.phase("Planning Phase");
  logger.info("Gathering project context...");

  const context = await gatherProjectContext(projectRoot, config);

  // Load agent definition (system prompt from .md file)
  const agentDef = await loadAgentDefinition("bober-planner", projectRoot);
  const model = resolveModel(config.planner.model);

  // Build tool set (planner gets read-only tools)
  const toolSet = buildToolSet("planner", projectRoot);

  const client = createClient(
    config.planner.provider ?? null,
    config.planner.endpoint ?? null,
    config.planner.providerConfig,
    config.planner.model,
  );

  const researchSection = researchDoc
    ? `\n\n## Research Findings\n${researchDoc.findings}`
    : "";

  const userMessage = `# Task Description
${userPrompt}

# Project Root
${projectRoot}

# Project Context
${context}${researchSection}

Explore the codebase using your tools if you need more context, then produce a PlanSpec JSON.
Your final response must contain ONLY valid JSON matching the PlanSpec schema (no markdown fences, no explanation).`;

  logger.info(`Calling planner model (${config.planner.model} → ${model})...`);

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt: agentDef.systemPrompt,
    userMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: PLANNER_MAX_TURNS,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inputStr =
        typeof input === "object" && input !== null
          ? JSON.stringify(input).slice(0, 100)
          : String(input);
      logger.debug(`  [planner] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Planner completed in ${result.turnsUsed} turns (tools: ${result.toolsCalled.length})`,
  );

  // Parse the final response for PlanSpec JSON
  const spec = parsePlanSpec(result.finalText);

  // Save to .bober/specs/
  await saveSpec(projectRoot, spec);
  logger.success(
    `Plan saved: ${spec.title} (${spec.features.length} features)`,
  );

  return spec;
}

// ── JSON parser ────────────────────────────────────────────────────

/**
 * Parse the planner response text into a validated PlanSpec.
 */
function parsePlanSpec(text: string): PlanSpec {
  let parsed: unknown;

  // Try direct parse first
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // Fall through
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

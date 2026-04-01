import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import { createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { buildToolSet } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";

// ── Constants ──────────────────────────────────────────────────────

const CURATOR_MAX_TURNS = 25;

// ── Types ──────────────────────────────────────────────────────────

/**
 * A Sprint Briefing produced by the curator agent.
 * Contains curated codebase context for a specific sprint contract.
 */
export interface SprintBriefing {
  /** The contract ID this briefing was produced for. */
  contractId: string;
  /** ISO-8601 timestamp of when the briefing was produced. */
  timestamp: string;
  /** Full markdown briefing content. */
  briefing: string;
  /** File paths the curator actually read during analysis. */
  filesAnalyzed: string[];
  /** Number of codebase patterns identified. */
  patternsFound: number;
  /** Number of existing utilities identified for reuse. */
  utilsIdentified: number;
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the curator agent to produce a Sprint Briefing for a contract.
 *
 * The curator explores the codebase using read-only tools, analyzes
 * the files relevant to the sprint, extracts patterns and utilities,
 * and produces a focused context document for the generator.
 *
 * @param contract       The sprint contract to curate for.
 * @param spec           The parent PlanSpec for broader context.
 * @param completedSprints  Previously completed sprint contracts.
 * @param projectRoot    Absolute path to the project root.
 * @param config         The resolved bober configuration.
 * @returns A SprintBriefing with curated codebase context.
 */
export async function runCurator(
  contract: SprintContract,
  spec: PlanSpec,
  completedSprints: SprintContract[],
  projectRoot: string,
  config: BoberConfig,
): Promise<SprintBriefing> {
  const contractId = contract.id;
  logger.sprint(contractId, `Curating: ${contract.feature}`);

  // Load agent definition (system prompt from .md file)
  const agentDef = await loadAgentDefinition("bober-curator", projectRoot);

  // Curator uses its own model config, falling back to planner model
  const curatorConfig = config.curator;
  const curatorModel = curatorConfig?.model ?? config.planner.model;
  const model = resolveModel(curatorModel);
  const curatorMaxTurns = curatorConfig?.maxTurns ?? CURATOR_MAX_TURNS;

  // Curator gets read-only tools (same as planner)
  const toolSet = buildToolSet("planner", projectRoot);

  const client = createClient(
    curatorConfig?.provider ?? config.planner.provider ?? null,
    curatorConfig?.endpoint ?? config.planner.endpoint ?? null,
    curatorConfig?.providerConfig ?? config.planner.providerConfig,
    curatorModel,
    "Curator",
  );

  // Build the completed sprints summary
  const completedSummary = completedSprints.length > 0
    ? completedSprints
        .map((s) => `- Sprint "${s.feature}" (${s.id}): ${s.description}`)
        .join("\n")
    : "No prior sprints completed.";

  // Build the contract JSON for the curator's context
  const contractJson = JSON.stringify(contract, null, 2);

  const userMessage = `# Sprint Contract

${contractJson}

# Project Overview

**Plan:** ${spec.title}
**Description:** ${spec.description}
**Tech Stack:** ${spec.techStack.join(", ") || "Not specified"}
**Project Type:** ${spec.projectType}

# Completed Sprints

${completedSummary}

# Project Root

${projectRoot}

# Your Task

Produce a Sprint Briefing for this contract. Use your tools to:

1. Read every file in the contract's estimatedFiles list
2. For each "modify" file: extract the specific functions/sections that will change
3. For each "create" file: find the most similar existing file as a template
4. Search for existing utilities the generator should reuse (check src/utils/, src/lib/, src/helpers/, src/shared/, src/common/)
5. Find and read 1-2 test files similar to what this sprint needs
6. Read .bober/principles.md, architecture docs, README.md if they exist
7. Determine the correct implementation sequence based on file dependencies

Save the Sprint Briefing to .bober/briefings/${contractId}-briefing.md

Your final response must contain ONLY a JSON object (no markdown fences):
{
  "contractId": "${contractId}",
  "briefingPath": ".bober/briefings/${contractId}-briefing.md",
  "filesAnalyzed": ["<list of files you read>"],
  "patternsFound": <number>,
  "utilsIdentified": <number>,
  "summary": "<2-3 sentence summary>"
}`;

  logger.info(`Calling curator model (${curatorModel} → ${model})...`);

  const filesRead = new Set<string>();

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt: agentDef.systemPrompt,
    userMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns: curatorMaxTurns,
    maxTokens: 16384,
    onToolUse: (name, input) => {
      const inp = input as Record<string, unknown>;
      if (name === "read_file") {
        const path = inp.file_path as string;
        if (path) filesRead.add(path);
      }
      const inputStr = JSON.stringify(inp).slice(0, 120);
      logger.debug(`  [curator] ${name}(${inputStr})`);
    },
  });

  logger.debug(
    `Curator completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
  );

  return parseCuratorResult(result.finalText, contractId, filesRead);
}

// ── JSON parser ────────────────────────────────────────────────────

/**
 * Parse the curator's response into a SprintBriefing.
 */
function parseCuratorResult(
  text: string,
  contractId: string,
  filesRead: Set<string>,
): SprintBriefing {
  const timestamp = new Date().toISOString();
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

  if (parsed && typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;

    const filesAnalyzed = Array.isArray(obj.filesAnalyzed)
      ? (obj.filesAnalyzed as unknown[]).filter(
          (f): f is string => typeof f === "string",
        )
      : [...filesRead];

    return {
      contractId,
      timestamp,
      briefing: typeof obj.briefingPath === "string" ? obj.briefingPath : "",
      filesAnalyzed,
      patternsFound:
        typeof obj.patternsFound === "number" ? obj.patternsFound : 0,
      utilsIdentified:
        typeof obj.utilsIdentified === "number" ? obj.utilsIdentified : 0,
    };
  }

  // Fallback — curator ran but response wasn't parseable
  return {
    contractId,
    timestamp,
    briefing: "",
    filesAnalyzed: [...filesRead],
    patternsFound: 0,
    utilsIdentified: 0,
  };
}

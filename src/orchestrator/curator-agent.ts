import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { PlanSpec } from "../contracts/spec.js";
import { createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { loadAgentDefinition } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { PreflightContextInjector } from "../graph/preflight-injector.js";
import { graphPipelineLifecycle } from "../graph/pipeline-lifecycle.js";
import { ensureDir } from "../utils/fs.js";

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
  const contractId = contract.contractId;
  logger.sprint(contractId, `Curating: ${contract.title}`);

  // Load agent definition (system prompt from .md file)
  const agentDef = await loadAgentDefinition("bober-curator", projectRoot);

  // Curator uses its own model config, falling back to planner model
  const curatorConfig = config.curator;
  const curatorModel = curatorConfig?.model ?? config.planner.model;
  const model = resolveModel(curatorModel);
  const curatorMaxTurns = curatorConfig?.maxTurns ?? CURATOR_MAX_TURNS;

  // Curator gets read-only tools. When graph is enabled and ready,
  // bash/grep/glob are removed and graph_* tools are added (ADR-8).
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("curator", projectRoot, graphState, graphDeps ?? undefined);

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
        .map(
          (s) => `- Sprint "${s.title}" (${s.contractId}): ${s.description}`,
        )
        .join("\n")
    : "No prior sprints completed.";

  // Build the contract JSON for the curator's context
  const contractJson = JSON.stringify(contract, null, 2);

  const baseUserMessage = `# Sprint Contract

${contractJson}

# Project Overview

**Plan:** ${spec.title}
**Description:** ${spec.description}
**Tech Stack:** ${spec.techStack.join(", ") || "Not specified"}
**Project Type:** ${spec.mode}

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

  // Pre-flight graph context injection (ADR-9 — special Curator case).
  // Curator: write pre-flight content to .bober/briefings/<contractId>-briefing.md
  // and reference it in the user message. The curator's own exploration output
  // appends to the same file during the agentic loop.
  const graphClient = graphPipelineLifecycle.getGraphClient();
  const preflightInjector = new PreflightContextInjector(graphClient, config.graph);
  const preflightPath = `.bober/briefings/${contractId}-briefing.md`;
  // Pass "" as firstMessage — we only want the pre-flight content itself (not prepended to anything).
  const preflightContent = await preflightInjector.inject("curator", contract, "");
  let preflightNotice = "";
  if (preflightContent.trim().length > 0) {
    try {
      const absPath = resolve(projectRoot, preflightPath);
      await ensureDir(resolve(absPath, ".."));
      await writeFile(absPath, preflightContent, "utf-8");
      preflightNotice = `\n\n# Graph Pre-Flight Context\n\nA graph pre-flight analysis has been prepared at ${preflightPath} — read it FIRST as part of your codebase exploration. It contains relevant graph queries (callers, tests, search results) to accelerate your analysis.\n`;
      logger.debug(`[curator] Pre-flight graph context written to ${preflightPath}`);
    } catch (err) {
      logger.debug(`[curator] Pre-flight write failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const userMessage = `${baseUserMessage}${preflightNotice}`;

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

  // Token-usage capture (graph integration sprint 2, s2-c8).
  // Mirrors the cumulative-usage pattern from src/orchestrator/agentic-loop.ts:117-118.
  // Failure to write must NOT break curation — swallow errors.
  try {
    const { TokenUsageLog } = await import("../graph/token-usage.js");
    await new TokenUsageLog(projectRoot).append({
      agent: "curator",
      runId: contractId,
      timestamp: new Date().toISOString(),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      graphEnabled: config.graph?.enabled === true,
    });
  } catch (err) {
    logger.debug(`Token usage capture failed (curator): ${err instanceof Error ? err.message : String(err)}`);
  }

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

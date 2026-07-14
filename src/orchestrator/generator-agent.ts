import type { BoberConfig } from "../config/schema.js";
import type { ContextHandoff } from "./context-handoff.js";
import { serializeHandoff } from "./context-handoff.js";
import { createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { budgetFromMaxUsd } from "./workflow/budget.js";
import { PreflightContextInjector } from "../graph/preflight-injector.js";
import { graphPipelineLifecycle } from "../graph/pipeline-lifecycle.js";
import { emit } from "../telemetry/emit.js";

// ── Types ──────────────────────────────────────────────────────────

export interface GeneratorResult {
  success: boolean;
  notes: string;
  filesChanged: string[];
  commitHash?: string;
  /** Number of agentic loop turns used. */
  turnsUsed?: number;
  /** Tools called during generation. */
  toolsCalled?: string[];
  /** Token usage. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Cumulative USD cost for this generation run, when known. Absent otherwise. */
  costUsd?: number;
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Run the generator agent to implement changes for a sprint.
 *
 * Uses a multi-turn agentic loop with full tool access (bash, read/write/edit
 * files, glob, grep). The agent actually reads the codebase, writes code,
 * runs tests, and commits — all via tools.
 *
 * The system prompt is loaded from `agents/bober-generator.md`.
 */
export async function runGenerator(
  handoff: ContextHandoff,
  projectRoot: string,
  config: BoberConfig,
): Promise<GeneratorResult> {
  const contractId = handoff.currentContract?.contractId ?? "unknown";
  const title = handoff.currentContract?.title ?? "unknown";

  logger.sprint(contractId, `Generating: ${title}`);
  // Sprint 28 — telemetry: emit agent-spawn at entry (fire-and-forget)
  void emit(projectRoot, config, "agent-spawn", { agentName: "generator", contractId });

  const model = resolveModel(config.generator.model);
  const maxTurns = config.generator.maxTurnsPerSprint;
  const effort = config.generator.effort;
  const budget = budgetFromMaxUsd(config.generator.budget?.maxUsd);
  const parallelReadOnly = config.generator.parallelReadOnlyTools;

  // Build tool set (generator gets full access — UNION mode when gated:
  // all original tools retained AND graph_* tools added).
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("generator", projectRoot, graphState, graphDeps ?? undefined);
  // Assemble system prompt with graph-prompt decoration (ADR-5, Sprint 7).
  const systemPrompt = await assembleSystemPrompt("generator", "bober-generator", projectRoot, graphState);

  const client = createClient(
    config.generator.provider ?? null,
    config.generator.endpoint ?? null,
    config.generator.providerConfig,
    config.generator.model,
  );
  const handoffJson = serializeHandoff(handoff);

  // Check if a Sprint Briefing exists for this contract
  const briefingPath = `.bober/briefings/${contractId}-briefing.md`;

  const userMessage = `# Context Handoff
${handoffJson}

# Project Root
${projectRoot}
${briefingPath ? `\n# Sprint Briefing\nA curated Sprint Briefing has been prepared at ${briefingPath} — read it FIRST before starting implementation. It contains the exact code patterns to follow, utilities to reuse, testing patterns, affected files, and step-by-step implementation sequence.\n` : ""}
Implement the changes described in the sprint contract. Follow every success criterion.
Use your tools to read the codebase, write code, run tests, and verify your work.
${handoff.issues.length > 0 ? `\n# Previous Issues to Fix\n${handoff.issues.join("\n\n")}` : ""}

When you are done, your final response must contain ONLY a JSON object with this structure (no markdown fences):
{
  "contractId": "${contractId}",
  "status": "complete | partial | blocked",
  "criteriaResults": [
    {"criterionId": "sc-X-Y", "met": true/false, "evidence": "<how you verified>"}
  ],
  "filesChanged": [
    {"path": "<file path>", "action": "created | modified | deleted", "description": "<what changed>"}
  ],
  "testsAdded": ["<test file paths>"],
  "commits": ["<hash> - <message>"],
  "blockers": ["<any unresolved issues>"],
  "notes": "<additional context for the evaluator>"
}`;

  // Pre-flight graph context injection (ADR-9): prepend graph context to userMessage.
  // On failure or timeout, userMessage is returned unchanged (spawn not blocked).
  const graphClient = graphPipelineLifecycle.getGraphClient();
  const preflightInjector = new PreflightContextInjector(graphClient, config.graph);
  const enhancedMessage = await preflightInjector.inject(
    "generator",
    handoff.currentContract ?? null,
    userMessage,
  );

  logger.info(`Calling generator model (${config.generator.model} → ${model})...`);

  // Track which files were written/edited via tools
  const filesWritten = new Set<string>();

  const result = await runAgenticLoop({
    client,
    model,
    systemPrompt,
    userMessage: enhancedMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns,
    maxTokens: 16384,
    ...(effort !== undefined ? { effort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(parallelReadOnly !== undefined ? { parallelReadOnlyTools: parallelReadOnly } : {}),
    onToolUse: (name, input) => {
      const inp = input as Record<string, unknown>;
      if (name === "write_file" || name === "edit_file") {
        const path = inp.file_path as string;
        if (path) filesWritten.add(path);
      }
      const inputStr = JSON.stringify(inp).slice(0, 120);
      logger.debug(`  [generator] ${name}(${inputStr})`);
    },
    // DeepSeek-style models sometimes narrate ("let me write the files...") and
    // stop without calling any tool, which would end the sprint with no work
    // done. Treat a tool-less turn as complete ONLY if it carries the JSON
    // report; otherwise nudge the model to actually call its tools.
    completionCheck: (text) => looksLikeGeneratorReport(text),
    nudgeMessage:
      "You stopped without calling any tool and without producing the final " +
      "JSON report. If implementation work remains, CALL write_file / edit_file " +
      "/ your other tools NOW to make the changes — do not just describe them. " +
      "Only once everything is implemented and verified, output ONLY the final " +
      "JSON report object described in the instructions.",
    maxNudges: 3,
  });

  logger.debug(
    `Generator completed in ${result.turnsUsed} turns (${result.toolsCalled.length} tool calls)`,
  );

  return parseGeneratorResult(result.finalText, filesWritten, result);
}

/**
 * True when the text contains a JSON object that looks like the generator's
 * completion report (has a "status" or "success" field). Used as the agentic
 * loop's completion predicate so a tool-less "I'll write the files" narration
 * is treated as incomplete (and nudged) rather than as a finished sprint.
 */
function looksLikeGeneratorReport(text: string): boolean {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return false;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
    return (
      typeof obj === "object" &&
      obj !== null &&
      ("status" in obj || "success" in obj)
    );
  } catch {
    return false;
  }
}

// ── JSON parser ────────────────────────────────────────────────────

/**
 * Parse the generator response text into a GeneratorResult.
 *
 * Exported for direct unit testing of the refusal fail-closed guard (sc-1-4).
 */
export function parseGeneratorResult(
  text: string,
  filesWritten: Set<string>,
  loopResult: {
    turnsUsed: number;
    toolsCalled: string[];
    usage: { inputTokens: number; outputTokens: number };
    /** Set by runAgenticLoop when the provider refused (ADR-5). */
    refused?: boolean;
    /** Set by runAgenticLoop when at least one turn reported a cost. */
    costUsd?: number;
  },
): GeneratorResult {
  // Fail closed on a refusal BEFORE any JSON parsing or the filesWritten
  // success shortcut below — a refusal after partial writes must never be
  // reported as success:true (ADR-5).
  if (loopResult.refused === true) {
    return {
      success: false,
      notes: `model refused: ${text.slice(0, 300)}`,
      filesChanged: [...filesWritten],
      turnsUsed: loopResult.turnsUsed,
      toolsCalled: loopResult.toolsCalled,
      usage: loopResult.usage,
      ...(loopResult.costUsd !== undefined ? { costUsd: loopResult.costUsd } : {}),
    };
  }

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
    ("success" in parsed || "status" in parsed)
  ) {
    const obj = parsed as Record<string, unknown>;

    // Support both old format (success: bool) and new format (status: string)
    const success =
      "success" in obj
        ? Boolean(obj.success)
        : obj.status === "complete";

    // Merge file paths from tool tracking and from the report
    const reportFiles = Array.isArray(obj.filesChanged)
      ? (obj.filesChanged as unknown[])
          .map((f) => {
            if (typeof f === "string") return f;
            if (typeof f === "object" && f !== null && "path" in f)
              return String((f as Record<string, unknown>).path);
            return null;
          })
          .filter((f): f is string => f !== null)
      : [];

    const allFiles = [...new Set([...filesWritten, ...reportFiles])];

    return {
      success,
      notes:
        typeof obj.notes === "string"
          ? obj.notes
          : "No notes provided.",
      filesChanged: allFiles,
      commitHash:
        typeof obj.commitHash === "string" ? obj.commitHash : undefined,
      turnsUsed: loopResult.turnsUsed,
      toolsCalled: loopResult.toolsCalled,
      usage: loopResult.usage,
      ...(loopResult.costUsd !== undefined ? { costUsd: loopResult.costUsd } : {}),
    };
  }

  // If parsing failed entirely, check if we at least wrote files
  if (filesWritten.size > 0) {
    return {
      success: true,
      notes: `Generator wrote ${filesWritten.size} files but did not produce a structured report. Files: ${[...filesWritten].join(", ")}`,
      filesChanged: [...filesWritten],
      turnsUsed: loopResult.turnsUsed,
      toolsCalled: loopResult.toolsCalled,
      usage: loopResult.usage,
      ...(loopResult.costUsd !== undefined ? { costUsd: loopResult.costUsd } : {}),
    };
  }

  return {
    success: false,
    notes: `Failed to parse generator response. Raw output:\n${text.slice(0, 500)}`,
    filesChanged: [],
    turnsUsed: loopResult.turnsUsed,
    toolsCalled: loopResult.toolsCalled,
    usage: loopResult.usage,
    ...(loopResult.costUsd !== undefined ? { costUsd: loopResult.costUsd } : {}),
  };
}
